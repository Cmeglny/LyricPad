import hashlib
import json
import os
import sys
import re
import syncedlyrics
import requests

# Fix SSL certificate issues for PyInstaller executable on other computers
if getattr(sys, 'frozen', False):
    import certifi
    os.environ['SSL_CERT_FILE'] = certifi.where()
    os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".lyrics_cache")

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
    ad_patterns = [
        r"lyrics\s*by", r"synced\s*by", r"sync\s*corrected", r"www\.",
        r"qq\s*music", r"netease", r"translated\s*by", r"çeviri",
        r"edit\s*by", r"music\s*by", r"writer\(s\):", r"arranged\s*by",
        r"produced\s*by"
    ]
    for line in lines:
        for pat in ad_patterns:
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
    ad_patterns = [
        r"lyrics\s*by", r"synced\s*by", r"sync\s*corrected", r"www\.",
        r"qq\s*music", r"netease", r"translated\s*by", r"çeviri",
        r"edit\s*by", r"music\s*by", r"writer\(s\):", r"arranged\s*by",
        r"produced\s*by"
    ]
    for line in lrc_text.splitlines():
        # Check if the content portion after the timestamp bracket matches an ad pattern
        content_match = re.match(r'^\[\d+:\d+(?:\.\d+)?\](.*)$', line.strip())
        if content_match:
            content = content_match.group(1).strip()
            is_ad = False
            for pat in ad_patterns:
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
        plain_content = None
        
        # 1. Try querying LRCLIB's /api/get endpoint directly using the song signature (including duration)
        if artist and title and duration > 0.0:
            try:
                print(f"[LRCLIB] Querying exact duration match for '{title}' by '{artist}' (duration: {int(duration)}s)...")
                url = "https://lrclib.net/api/get"
                params = {
                    "artist_name": artist,
                    "track_name": title,
                    "duration": int(duration)
                }
                headers = {"User-Agent": "LyricsNotepad/1.0 (https://github.com/gemini/antigravity)"}
                resp = requests.get(url, params=params, headers=headers, timeout=6.0)
                if resp.status_code == 200:
                    data = resp.json()
                    lrc_content = data.get("syncedLyrics")
                    plain_content = data.get("plainLyrics")
                    if lrc_content and lrc_content.strip() != "":
                        print("[LRCLIB] Successfully matched exact version by duration!")
                        lrc_content = clean_lrc_content(lrc_content)
                    else:
                        print("[LRCLIB] Exact match found, but no synced lyrics available. Falling back to multi-source...")
                        lrc_content = None
                else:
                    print(f"[LRCLIB] No exact duration match found (Status: {resp.status_code})")
            except Exception as e:
                print(f"[LRCLIB] Duration match query failed: {e}")
                
        # 2. Fallback to standard provider searches if duration query fails or not provided
        if not lrc_content:
            providers = ["Lrclib", "Musixmatch", "NetEase", "Megalobiz"]
            print(f"[MULTISOURCE] Fetching from providers in parallel: {providers}")
            
            import concurrent.futures
            
            def fetch_single(provider):
                try:
                    res = syncedlyrics.search(query, enhanced=True, providers=[provider])
                    return provider, res
                except Exception as ex:
                    print(f"[MULTISOURCE] Provider '{provider}' failed: {ex}")
                    return provider, None
            
            results = {}
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=7) as executor:
                    future_to_provider = {executor.submit(fetch_single, p): p for p in providers}
                    try:
                        for future in concurrent.futures.as_completed(future_to_provider, timeout=12.0):
                            provider, content = future.result()
                            if content:
                                results[provider] = content
                    except concurrent.futures.TimeoutError:
                        print("[MULTISOURCE] One or more providers timed out, proceeding with collected results.")
            except Exception as e:
                print(f"[MULTISOURCE] ThreadPoolExecutor error: {e}")
                        
            # Score each provider's result
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
                print("[MULTISOURCE] No synced lyrics found from any provider.")
                if plain_content:
                    print("Falling back to plain text lyrics from LRCLIB.")
                    lrc_content = plain_content

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

