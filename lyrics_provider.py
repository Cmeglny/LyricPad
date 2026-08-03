import hashlib
import json
import os
import sys
import re
import time
import syncedlyrics
import requests

# Fix SSL certificate issues for PyInstaller executable on other computers
if getattr(sys, 'frozen', False):
    import certifi
    os.environ['SSL_CERT_FILE'] = certifi.where()
    os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lyrics_cache")

# Cached "no lyrics found" results are retried after this many seconds, so a transient
# network/provider failure doesn't permanently mark a song as having no lyrics.
EMPTY_CACHE_TTL = 24 * 3600

# Advertisement, translation credit, and sync contribution line patterns
# shared by the scorer and the cleaner.
AD_PATTERNS = [
    r"lyrics\s*by", r"synced\s*by", r"sync\s*corrected", r"www\.",
    r"qq\s*music", r"netease", r"translated\s*by", r"çeviri",
    r"edit\s*by", r"music\s*by", r"writer\(s\):", r"arranged\s*by",
    r"produced\s*by", r"作词", r"作曲", r"编曲", r"制作人", r"词曲",
    r"混音", r"演唱", r"原唱", r"和声", r"母带", r"出品", r"发行",
    r"lyricist\s*[:：]", r"composer\s*[:：]", r"vocals\s*[:：]"
]

def get_cache_path(category: str, key: str) -> str:
    """Returns absolute path to a cache file inside CACHE_DIR, creating it if needed."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    # Generate md5 hash of lowercase trimmed key for filename safety
    safe_key = hashlib.md5(key.lower().strip().encode('utf-8')).hexdigest()
    return os.path.join(CACHE_DIR, f"{category}_{safe_key}.json")

def parse_lrc(lrc_text: str):
    """
    Parses LRC text into a list of dicts:
    [
        {
            "time": 32.43, 
            "text": "Did I drive you away?",
            "words": [
                {"time": 32.43, "text": "Did "},
                ...
            ]
        },
        ...
    ]
    """
    if not lrc_text:
        return []
        
    lines = []
    # Match stamps like [00:32.43] or [01:02.1] or [02:15]
    line_pattern = re.compile(r'^\[(\d+):(\d+(?:\.\d+)?)\](.*)$')
    word_pattern = re.compile(r'<(\d+):(\d+(?:\.\d+)?)>\s*([^<]+)')
    
    for line in lrc_text.splitlines():
        line = line.strip()
        match = line_pattern.match(line)
        if match:
            try:
                minutes = int(match.group(1))
                seconds = float(match.group(2))
                content = match.group(3).strip()
                line_time = minutes * 60 + seconds
                
                # Check for word-level timestamps in content (Enhanced LRC format)
                word_matches = list(word_pattern.finditer(content))
                words_list = []
                
                if word_matches:
                    for i, m in enumerate(word_matches):
                        w_min = int(m.group(1))
                        w_sec = float(m.group(2))
                        w_text = m.group(3).strip()
                        w_time = w_min * 60 + w_sec
                        if w_text:
                            # Add trailing space except for the last word
                            suffix = " " if i < len(word_matches) - 1 else ""
                            words_list.append({
                                "time": w_time,
                                "text": w_text + suffix
                            })
                
                # Clean all <...> tags from the main text display
                clean_text = re.sub(r'<[^>]+>', '', content).strip()
                clean_text = re.sub(r'\s+', ' ', clean_text)
                
                lines.append({
                    "time": line_time,
                    "text": clean_text,
                    "words": words_list
                })
            except ValueError:
                continue
                
    # Sort lines by time
    lines.sort(key=lambda x: x["time"])
    return lines

def score_lyrics(lrc_text: str) -> float:
    """Scores an LRC lyric content string based on formatting, sync details, and lack of advertisements."""
    if not lrc_text:
        return -9999.0
        
    score = 0.0
    
    # Check for standard LRC timestamps. If missing, it's unsynced plain text.
    line_timestamps = len(re.findall(r'\[\d+:\d+(?:\.\d+)?\]', lrc_text))
    if line_timestamps < 3:
        return -9999.0
        
    # Base score on number of synced lines
    score += line_timestamps * 1.5
    
    # Check for enhanced word-level timestamps (e.g. <00:12.34>)
    word_tags = len(re.findall(r'<\d+:\d+(?:\.\d+)?>', lrc_text))
    if word_tags > 0:
        score += 200.0 + word_tags * 0.5
        
    lines = lrc_text.splitlines()

    # Deduct points for advertisements or credit headers/footers
    for line in lines:
        for pat in AD_PATTERNS:
            if re.search(pat, line.lower()):
                score -= 40.0
                
    # Deduct for unbalanced parenthesis
    open_p = lrc_text.count("(")
    close_p = lrc_text.count(")")
    if open_p != close_p:
        score -= abs(open_p - close_p) * 5.0
        
    return score

def clean_lrc_content(lrc_text: str) -> str:
    """Removes typical advertisement, translation credits, and sync contribution lines from LRC text."""
    if not lrc_text:
        return ""
        
    cleaned_lines = []
    for line in lrc_text.splitlines():
        # Check if the content portion after the timestamp bracket matches an ad pattern
        content_match = re.match(r'^\[\d+:\d+(?:\.\d+)?\](.*)$', line.strip())
        if content_match:
            content = content_match.group(1).strip()
            is_ad = False
            for pat in AD_PATTERNS:
                if re.search(pat, content.lower()):
                    is_ad = True
                    break
            if is_ad:
                continue # Skip ad lines
        cleaned_lines.append(line)
        
    return "\n".join(cleaned_lines)

def fetch_synced_lyrics(query: str, duration: float = 0.0, artist: str = None, title: str = None):
    """
    Fetches synchronized lyrics for a query (e.g. 'Coldplay Sparks')
    and returns a parsed dictionary containing offset and lines list.
    Checks disk cache first.
    """
    # Incorporate duration into cache key to separate single/album/radio edit cuts
    cache_key = query
    if duration > 0.0:
        cache_key = f"{query}_{int(duration)}"
        
    cache_path = get_cache_path("lyrics", cache_key)
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
                if isinstance(cached_data, dict):
                    # Empty results may stem from a transient failure — retry after the TTL expires
                    is_empty = not cached_data.get("lyrics") and not cached_data.get("plain_lyrics")
                    if is_empty and (time.time() - os.path.getmtime(cache_path)) > EMPTY_CACHE_TTL:
                        print(f"[CACHE] Stale empty lyrics cache for '{cache_key}', retrying fetch...")
                    else:
                        print(f"[CACHE HIT] Loaded lyrics from cache for: '{cache_key}' (offset={cached_data.get('offset', 0.0):.2f}s)")
                        return cached_data
                elif isinstance(cached_data, list):
                    print(f"[CACHE HIT] Loaded old format lyrics from cache for: '{cache_key}' (converting and migrating to dict on disk)")
                    migrated = {"offset": 0.0, "lyrics": cached_data}
                    try:
                        with open(cache_path, "w", encoding="utf-8") as f:
                            json.dump(migrated, f, indent=4, ensure_ascii=False)
                    except Exception as ex:
                        print(f"Failed to migrate cache file: {ex}")
                    return migrated
        except Exception as e:
            print(f"Failed to read lyrics cache: {e}")

    try:
        print(f"[CACHE MISS] Fetching synced lyrics for: '{cache_key}'...")
        lrc_content = None
        plain_holder = {"plain": None}

        import concurrent.futures

        def fetch_lrclib_exact():
            """Duration-exact LRCLIB lookup — returns cleaned synced lyrics or None."""
            try:
                print(f"[LRCLIB] Querying exact duration match for '{title}' by '{artist}' (duration: {int(duration)}s)...")
                url = "https://lrclib.net/api/get"
                params = {
                    "artist_name": artist,
                    "track_name": title,
                    "duration": int(duration)
                }
                headers = {"User-Agent": "LyricsNotepad/1.0 (https://github.com/gemini/antigravity)"}
                resp = requests.get(url, params=params, headers=headers, timeout=5.0)
                if resp.status_code == 200:
                    data = resp.json()
                    plain_holder["plain"] = data.get("plainLyrics")
                    synced = data.get("syncedLyrics")
                    if synced and synced.strip() != "":
                        print("[LRCLIB] Exact duration match found.")
                        return clean_lrc_content(synced)
                    print("[LRCLIB] Exact match found, but no synced lyrics available.")
                else:
                    print(f"[LRCLIB] No exact duration match found (Status: {resp.status_code})")
            except Exception as e:
                print(f"[LRCLIB] Duration match query failed: {e}")
            return None

        def fetch_single(provider):
            try:
                res = syncedlyrics.search(query, enhanced=True, providers=[provider])
                return provider, res
            except Exception as ex:
                print(f"[SEARCH] Provider '{provider}' failed: {ex}")
                return provider, None

        # Everything runs in PARALLEL: the duration-exact LRCLIB lookup and all generic
        # provider searches start at once (the old sequential flow stalled the whole
        # fetch whenever a single upstream was slow). Early exits:
        #   - a word-level (enhanced) result is unbeatable -> take it immediately
        #   - once a usable synced result is in hand, slower providers only get a
        #     short grace window instead of holding up the lyrics display
        providers = ["Lrclib", "Musixmatch", "NetEase", "Megalobiz"]
        print(f"[SEARCH] Querying LRCLIB exact match and providers in parallel: {providers}")

        results = {}
        lrclib_exact = None
        try:
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=8)
            try:
                pending = set()
                exact_future = None
                if artist and title and duration > 0.0:
                    exact_future = executor.submit(fetch_lrclib_exact)
                    pending.add(exact_future)
                for p in providers:
                    pending.add(executor.submit(fetch_single, p))

                overall_deadline = time.time() + 10.0
                grace_deadline = None
                while pending:
                    effective_deadline = min(overall_deadline, grace_deadline) if grace_deadline else overall_deadline
                    wait_timeout = effective_deadline - time.time()
                    if wait_timeout <= 0:
                        print("[SEARCH] Deadline reached, proceeding with collected results.")
                        break
                    done, pending = concurrent.futures.wait(
                        pending, timeout=wait_timeout,
                        return_when=concurrent.futures.FIRST_COMPLETED
                    )
                    got_word_level = False
                    for future in done:
                        if future is exact_future:
                            lrclib_exact = future.result()
                            if lrclib_exact and grace_deadline is None:
                                # Solid result in hand — wait only briefly for word-level
                                grace_deadline = time.time() + 3.0
                            continue
                        provider, content = future.result()
                        if content:
                            results[provider] = content
                            sc = score_lyrics(content)
                            if sc >= 200.0:
                                got_word_level = True
                            elif sc > 0 and grace_deadline is None:
                                grace_deadline = time.time() + 2.5
                    if got_word_level:
                        print("[SEARCH] Word-level lyrics received — proceeding immediately.")
                        break
            finally:
                # Don't wait for hung provider threads; they finish in the background
                executor.shutdown(wait=False, cancel_futures=True)
        except Exception as e:
            print(f"[SEARCH] Parallel search error: {e}")

        # Selection: word-level lyrics beat everything (they follow the vocalist word by
        # word); otherwise the duration-exact LRCLIB match wins; otherwise best score.
        word_level = {
            p: c for p, c in results.items()
            if re.search(r'<\d+:\d+(?:\.\d+)?>', c) and score_lyrics(c) > 0
        }
        if word_level:
            best_provider = max(word_level, key=lambda p: score_lyrics(word_level[p]))
            print(f"[SEARCH] Selected word-level lyrics from '{best_provider}' (exact vocal sync).")
            lrc_content = clean_lrc_content(word_level[best_provider])
        elif lrclib_exact:
            print("[SEARCH] Selected LRCLIB exact-duration lyrics.")
            lrc_content = lrclib_exact
        else:
            best_provider = None
            best_score = -9999.0
            best_content = None
            for provider, content in results.items():
                score = score_lyrics(content)
                print(f"[SCORER] Provider '{provider}' scored: {score:.1f}")
                if score > best_score:
                    best_score = score
                    best_provider = provider
                    best_content = content

            if best_content:
                print(f"[SCORER] Selected best provider: '{best_provider}' (Score: {best_score:.1f})")
                lrc_content = clean_lrc_content(best_content)
            else:
                print("[SEARCH] No synced lyrics found from any provider.")
                if plain_holder["plain"]:
                    print("Falling back to plain text lyrics from LRCLIB.")
                    lrc_content = plain_holder["plain"]

        if lrc_content:
            parsed = parse_lrc(lrc_content)
            if len(parsed) == 0 and len(lrc_content.strip()) > 0:
                print("Returning plain text lyrics (no sync).")
                result = {"offset": 0.0, "lyrics": [], "plain_lyrics": clean_lrc_content(lrc_content)}
            else:
                print(f"Successfully fetched {len(parsed)} synced lyric lines.")
                result = {"offset": 0.0, "lyrics": parsed}
            # Cache the result
            try:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(result, f, indent=4, ensure_ascii=False)
            except Exception as e:
                print(f"Failed to write lyrics cache: {e}")
            return result
        else:
            print("No lyrics found.")
            result = {"offset": 0.0, "lyrics": []}
            # Cache empty list to avoid repeating failed searches
            try:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(result, f, indent=4, ensure_ascii=False)
            except Exception as e:
                pass
            return result
    except Exception as e:
        print(f"Error fetching lyrics: {e}")
        return {"offset": 0.0, "lyrics": []}

