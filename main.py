import asyncio
import json
import os
import re
import sys
import threading
import time
import traceback
import websockets
import webview
import signal

# Safe signal handler wrapper to prevent background thread signal errors on Windows
_orig_signal = signal.signal
def _safe_signal(sig, action):
    try:
        return _orig_signal(sig, action)
    except ValueError as e:
        if "signal only works in main thread" in str(e):
            return None
        raise
signal.signal = _safe_signal

from media_session import MediaSessionTracker
from lyrics_provider import fetch_synced_lyrics
from bpm_provider import BPMProvider
from audio_analyzer import AudioAnalyzer
from cover_manager import CoverManager

cover_manager = CoverManager()

def resolve_lyrics_cache_path(artist: str, title: str, duration: float = 0.0) -> str:
    """Resolves the on-disk lyrics cache file, preferring duration-specific keys."""
    from lyrics_provider import get_cache_path
    query = f"{artist} {title}"
    if duration > 0.0:
        duration_path = get_cache_path("lyrics", f"{query}_{int(duration)}")
        if os.path.exists(duration_path):
            return duration_path
    return get_cache_path("lyrics", query)

# Global States
connected_clients = set()
last_track_payload = None
last_position_payload = None
force_sync_trigger = False
current_track_offset = 0.0  # Real-time timing offset in seconds
is_client_fullscreen = False


# Music sync globals for desktop window shake and pulse physics
current_song_bpm = 120.0
current_song_energy = 0.5
current_playback_position = 0.0
last_position_update_time = time.time()
is_playback_paused = True

def save_offset_to_cache(artist: str, title: str, offset: float, duration: float = 0.0):
    """Saves the user adjusted lyric sync offset back to the song's JSON cache."""
    try:
        cache_path = resolve_lyrics_cache_path(artist, title, duration)
        if os.path.exists(cache_path):
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                data["offset"] = offset
            else:
                data = {"offset": offset, "lyrics": data}
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
            print(f"[CACHE] Saved offset {offset:.2f}s for '{title}' by '{artist}'")
    except Exception as e:
        print(f"Error saving offset to cache: {e}")

def save_line_media_to_cache(artist: str, title: str, duration: float, line_index: int, media_path: str):
    """Updates the 'media' property of a specific lyric line in the cache."""
    try:
        from lyrics_provider import get_cache_path
        query = f"{artist} {title}"
        cache_key = query
        if duration > 0.0:
            cache_key = f"{query}_{int(duration)}"
            
        cache_path = get_cache_path("lyrics", cache_key)
        if not os.path.exists(cache_path):
            cache_path_fallback = get_cache_path("lyrics", query)
            if os.path.exists(cache_path_fallback):
                cache_path = cache_path_fallback
            else:
                return False
                
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        if isinstance(data, dict) and "lyrics" in data:
            if 0 <= line_index < len(data["lyrics"]):
                if media_path is None:
                    data["lyrics"][line_index].pop("media", None)
                else:
                    data["lyrics"][line_index]["media"] = media_path
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=4, ensure_ascii=False)
                print(f"[CACHE] Updated media for line {line_index} of '{title}'")
                return True
        return False
    except Exception as e:
        print(f"Error saving line media to cache: {e}")
        return False

def save_edited_lyrics(artist: str, title: str, duration: float, edited_text: str) -> bool:
    """Aligns edited text lines with cached lyric structures to preserve times, and saves to cache."""
    try:
        import difflib
        from lyrics_provider import get_cache_path
        
        # Incorporate duration into cache key matching fetch_synced_lyrics behavior
        query = f"{artist} {title}"
        cache_key = query
        if duration > 0.0:
            cache_key = f"{query}_{int(duration)}"
            
        cache_path = get_cache_path("lyrics", cache_key)
        print(f"[CACHE] Target cache path for saving edited lyrics: {cache_path}")
        
        if not os.path.exists(cache_path):
            # If duration-based file doesn't exist, fallback to general key
            cache_path_fallback = get_cache_path("lyrics", query)
            if os.path.exists(cache_path_fallback):
                cache_path = cache_path_fallback
            else:
                print(f"[CACHE] No cached lyrics file found to edit for '{title}' by '{artist}'")
                return False
                
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        if isinstance(data, dict):
            old_lyrics = data.get("lyrics", [])
        else:
            old_lyrics = data
            data = {"offset": 0.0, "lyrics": old_lyrics}
            
        from lyrics_provider import parse_lrc
        if re.search(r'\[\d+:\d+(?:\.\d+)?\]', edited_text):
            updated_lyrics = parse_lrc(edited_text)
            data["lyrics"] = updated_lyrics
            if "plain_lyrics" in data:
                del data["plain_lyrics"]
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
            print(f"[CACHE] Successfully saved raw LRC edited lyrics to cache for '{title}' by '{artist}' ({len(updated_lyrics)} lines)")
            return True
            
        new_lines = [line.strip() for line in edited_text.splitlines()]
        old_lines = [l.get("text", "").strip() for l in old_lyrics]
        
        # Align old lines with new lines using difflib
        matcher = difflib.SequenceMatcher(None, old_lines, new_lines)
        updated_lyrics = []
        
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'equal':
                # Match 1-to-1, update text, preserve original times and words
                for old_idx, new_idx in zip(range(i1, i2), range(j1, j2)):
                    old_lyric = old_lyrics[old_idx]
                    new_text = new_lines[new_idx]
                    if old_lyric["text"] != new_text:
                        old_lyric["text"] = new_text
                        old_words = old_lyric.get("words", [])
                        new_words = new_text.split()
                        if len(old_words) != len(new_words):
                            old_lyric["words"] = []
                    updated_lyrics.append(old_lyric)
                    
            elif tag == 'replace':
                # If block size is identical, map 1-to-1
                if (i2 - i1) == (j2 - j1):
                    for old_idx, new_idx in zip(range(i1, i2), range(j1, j2)):
                        old_lyric = old_lyrics[old_idx]
                        new_text = new_lines[new_idx]
                        if old_lyric["text"] != new_text:
                            old_lyric["text"] = new_text
                            old_words = old_lyric.get("words", [])
                            new_words = new_text.split()
                            if len(old_words) != len(new_words):
                                old_lyric["words"] = []
                        updated_lyrics.append(old_lyric)
                else:
                    # Distribute the time range of old_lyrics[i1:i2] proportionally across new_lines[j1:j2]
                    start_time = old_lyrics[i1]["time"] if i1 < len(old_lyrics) else 0.0
                    end_time = old_lyrics[i2-1]["time"] + 4.0 if i2-1 < len(old_lyrics) else start_time + 4.0
                    
                    total_duration = max(1.0, end_time - start_time)
                    num_new = j2 - j1
                    for idx, new_idx in enumerate(range(j1, j2)):
                        fraction = idx / num_new
                        new_time = start_time + fraction * total_duration
                        updated_lyrics.append({
                            "time": round(new_time, 2),
                            "text": new_lines[new_idx],
                            "words": []
                        })
                        
            elif tag == 'delete':
                pass
                
            elif tag == 'insert':
                # Inserted lines, interpolate times
                prev_time = old_lyrics[i1-1]["time"] if i1 > 0 and i1-1 < len(old_lyrics) else 0.0
                next_time = old_lyrics[i1]["time"] if i1 < len(old_lyrics) else prev_time + 10.0
                
                gap = max(1.0, next_time - prev_time)
                num_new = j2 - j1
                for idx, new_idx in enumerate(range(j1, j2)):
                    fraction = (idx + 1) / (num_new + 1)
                    new_time = prev_time + fraction * gap
                    updated_lyrics.append({
                        "time": round(new_time, 2),
                        "text": new_lines[new_idx],
                        "words": []
                    })
                    
        updated_lyrics.sort(key=lambda x: x["time"])
        
        data["lyrics"] = updated_lyrics
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
            
        print(f"[CACHE] Successfully saved edited lyrics to cache for '{title}' by '{artist}' ({len(updated_lyrics)} lines)")
        return True
    except Exception as e:
        print(f"Error saving edited lyrics: {e}")
        traceback.print_exc()
        return False

# Providers
tracker = None
bpm_provider = None
audio_analyzer = None

async def register(websocket):
    """Registers a new WebSocket client and syncs the current state immediately."""
    global force_sync_trigger, current_track_offset, last_track_payload, is_client_fullscreen
    connected_clients.add(websocket)
    print(f"Client connected. Total clients: {len(connected_clients)}")
    
    # Sync current song and timeline position immediately to new client
    try:
        if last_track_payload:
            await websocket.send(json.dumps(last_track_payload))
        if last_position_payload:
            await websocket.send(json.dumps(last_position_payload))
            
        async for message in websocket:
            try:
                data = json.loads(message)
                if data.get("action") == "force_sync":
                    print("Force sync requested by client.")
                    force_sync_trigger = True
                elif data.get("action") == "save_lyrics":
                    edited_text = data.get("lyrics", "")
                    print("WS save_lyrics action received.")
                    if last_track_payload:
                        success = save_edited_lyrics(
                            last_track_payload["artist"],
                            last_track_payload["title"],
                            last_track_payload.get("duration", 0.0),
                            edited_text
                        )
                        if success:
                            force_sync_trigger = True
                elif data.get("action") == "set_line_media":
                    line_index = data.get("index")
                    media_path = data.get("media_path")
                    print(f"WS set_line_media action received for index {line_index}")
                    if last_track_payload and line_index is not None:
                        success = save_line_media_to_cache(
                            last_track_payload["artist"],
                            last_track_payload["title"],
                            last_track_payload.get("duration", 0.0),
                            line_index,
                            media_path
                        )
                        if success:
                            force_sync_trigger = True
                elif data.get("action") == "clear_line_media":
                    line_index = data.get("index")
                    print(f"WS clear_line_media action received for index {line_index}")
                    if last_track_payload and line_index is not None:
                        success = save_line_media_to_cache(
                            last_track_payload["artist"],
                            last_track_payload["title"],
                            last_track_payload.get("duration", 0.0),
                            line_index,
                            None
                        )
                        if success:
                            force_sync_trigger = True
                elif data.get("action") == "set_offset":
                    new_offset = float(data.get("offset", 0.0))
                    current_track_offset = new_offset
                    print(f"WS Offset change received: {new_offset:.2f}s")
                    if last_track_payload:
                        last_track_payload["offset"] = new_offset
                        # Save to cache
                        save_offset_to_cache(
                            last_track_payload["artist"],
                            last_track_payload["title"],
                            new_offset,
                            last_track_payload.get("duration", 0.0),
                        )
                    # Broadcast the offset update to all clients
                    await broadcast({"type": "offset", "offset": new_offset})
                elif data.get("action") == "settings":
                    global enable_popups, enable_shake
                    settings = data.get("settings", {})
                    enable_popups = settings.get("popups", True)
                    enable_shake = settings.get("shake", True)
                    print(f"WS Settings updated: Popups={enable_popups}, Shake={enable_shake}")
                elif data.get("action") == "set_fullscreen":
                    global is_client_fullscreen
                    is_client_fullscreen = data.get("state", False)
                    print(f"WS Fullscreen state updated: {is_client_fullscreen}")
                    if is_client_fullscreen:
                        close_all_popups("fullscreen_entered")
                elif data.get("action") == "log":
                    print(f"[FRONTEND LOG] {data.get('message')}")
            except Exception as e:
                pass
    except Exception as e:
        pass
    finally:
        connected_clients.remove(websocket)
        print(f"Client disconnected. Total clients: {len(connected_clients)}")

async def broadcast(message_dict):
    """Broadcasts a JSON message to all connected clients."""
    if not connected_clients:
        return
    message_str = json.dumps(message_dict)
    await asyncio.gather(
        *[client.send(message_str) for client in connected_clients],
        return_exceptions=True
    )

# Climax Popup Window Management (Multi-window stacking collage)
popup_windows = []
popup_close_task = None
should_shake_windows = False
enable_popups = True
enable_shake = True
last_popup_spawn_time = 0.0

async def shake_windows_loop():
    """Shakes popup windows in sync with real-time bass/kick energy from system audio.
    Falls back to BPM-based simulation if audio capture is unavailable."""
    global should_shake_windows, audio_analyzer
    import random

    def do_moves(moves):
        for win, x, y in moves:
            try:
                win.move(x, y)
            except Exception:
                pass

    while True:
        try:
            moves = []
            if should_shake_windows and enable_shake and popup_windows:
                # Read real bass energy from the audio analyzer
                bass = 0.0
                if audio_analyzer and audio_analyzer.available:
                    bass = audio_analyzer.get_bass_energy()
                
                # Only shake if bass energy is significant (threshold filters silence/calm)
                if bass > 0.12:
                    wins = list(popup_windows)
                    for win in wins:
                        if hasattr(win, "orig_x") and hasattr(win, "orig_y"):
                            base_amt = 10.0 if getattr(win, "is_ultimate_climax", False) else 5.0
                            amt = base_amt * bass
                            dx = (random.random() * 2 - 1) * amt
                            dy = (random.random() * 2 - 1) * amt
                            moves.append((win, int(win.orig_x + dx), int(win.orig_y + dy)))
                else:
                    # Bass too low — restore original positions smoothly
                    wins = list(popup_windows)
                    for win in wins:
                        if hasattr(win, "orig_x") and hasattr(win, "orig_y"):
                            moves.append((win, win.orig_x, win.orig_y))
            else:
                # Not shaking — restore original positions
                wins = list(popup_windows)
                for win in wins:
                    if hasattr(win, "orig_x") and hasattr(win, "orig_y"):
                        moves.append((win, win.orig_x, win.orig_y))
                        
            if moves:
                await asyncio.to_thread(do_moves, moves)
                
        except Exception:
            pass
        await asyncio.sleep(0.025)  # ~40 FPS


async def audio_broadcast_loop():
    """Broadcasts real-time bass and kick energy data to all connected WebSocket clients at ~25 FPS."""
    global audio_analyzer
    while True:
        try:
            if audio_analyzer and audio_analyzer.available and connected_clients:
                bass = audio_analyzer.get_bass_energy()
                kick = audio_analyzer.get_kick_intensity()
                await broadcast({
                    "type": "audio",
                    "bass": round(bass, 4),
                    "kick": round(kick, 4)
                })
        except Exception:
            pass
        await asyncio.sleep(0.08)  # ~12 FPS broadcast rate (frontend smooths values)

def stretch_word_text(word_text: str, duration: float) -> str:
    """Stretches vowels in a word if it is sung for a long time (low characters per second),
    and appends '...' dots for long pauses."""
    stripped = word_text.rstrip()
    if not stripped:
        return word_text
        
    # Separate prefix, core word, and suffix (punctuation)
    # e.g., "away?!" -> prefix="", core="away", suffix="?!"
    match = re.match(r'^([^a-zA-Z]*)(.*?)([^a-zA-Z]*)$', stripped)
    if not match:
        return word_text
        
    prefix, core, suffix = match.groups()
    if not core:
        return word_text
        
    char_count = len(core)
    cps = char_count / duration if duration > 0 else 999.0
    
    stretched_core = core
    if duration > 0.6 and cps < 6.0:
        # Determine extra characters to add
        extra_count = int(duration * 5.0) - char_count
        extra_count = min(8, max(1, extra_count))  # Cap extra characters between 1 and 8
        
        # Find the last vowel
        vowels = "aeiouAEIOU"
        vowel_indices = [i for i, c in enumerate(core) if c in vowels]
        
        if vowel_indices:
            last_vowel_idx = vowel_indices[-1]
            vowel_char = core[last_vowel_idx]
            repeat_char = vowel_char
            if vowel_char.isupper() and not core.isupper():
                repeat_char = vowel_char.lower()
            stretched_core = core[:last_vowel_idx + 1] + (repeat_char * extra_count) + core[last_vowel_idx + 1:]
        else:
            # No vowel, repeat last letter
            last_char = core[-1]
            repeat_char = last_char
            if last_char.isupper() and not core.isupper():
                repeat_char = last_char.lower()
            stretched_core = core + (repeat_char * extra_count)
            
    # Add dots "..." if the duration of the word/pause is very long (e.g. > 1.5 seconds)
    dots = ""
    if duration > 1.5:
        dots = "..."
        
    # Re-assemble preserving trailing whitespace
    trailing_spaces = word_text[len(stripped):]
    return prefix + stretched_core + suffix + dots + trailing_spaces

def get_popup_html(words: list, title_text: str, target_unix_time: float, is_climax: bool = False) -> str:
    """Generates a dynamic HTML string for the lightweight Notepad pop-up window."""
    title_upper = title_text.strip().upper()
    words_json = json.dumps(words)
    target_unix_time_ms = int(target_unix_time * 1000)
    
    if is_climax:
        # Ultimate Climax — dramatic dark with magenta/violet neon glow
        return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@700&display=swap');
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #030108;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 100vh;
            width: 100vw;
        }}
        .popup-window {{
            width: 100vw;
            height: 100vh;
            display: flex;
            flex-direction: column;
            background: radial-gradient(ellipse at center, #0a0515 0%, #030108 70%);
            border: 2px solid #8b5cf6;
            box-shadow: 
                0 0 30px rgba(139, 92, 246, 0.3),
                0 0 60px rgba(236, 72, 153, 0.1),
                inset 0 0 40px rgba(139, 92, 246, 0.05);
            animation: glow-pulse 0.8s infinite ease-in-out;
        }}
        .title-strip {{
            height: 28px;
            background: linear-gradient(90deg, rgba(139, 92, 246, 0.15) 0%, rgba(236, 72, 153, 0.1) 100%);
            border-bottom: 1px solid rgba(139, 92, 246, 0.3);
            display: flex;
            align-items: center;
            padding: 0 12px;
        }}
        .title-label {{
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px;
            font-weight: 700;
            color: rgba(236, 72, 153, 0.8);
            letter-spacing: 0.15em;
            text-transform: uppercase;
        }}
        .content-area {{
            flex-grow: 1;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }}
        .lyric-text {{
            font-family: 'JetBrains Mono', monospace;
            font-size: 32px;
            font-weight: 700;
            color: #ffffff;
            text-align: center;
            white-space: pre-wrap;
            line-height: 1.4;
            text-shadow: 
                0 0 15px rgba(139, 92, 246, 0.7),
                0 0 40px rgba(236, 72, 153, 0.3);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }}
        .cursor-glow {{
            color: #ec4899;
            font-weight: 700;
            animation: blink-fast 0.3s step-end infinite;
            text-shadow: 0 0 12px rgba(236, 72, 153, 0.8);
        }}
        @keyframes blink-fast {{
            50% {{ opacity: 0; }}
        }}
        @keyframes glow-pulse {{
            0%, 100% {{ 
                box-shadow: 0 0 25px rgba(139, 92, 246, 0.25), 0 0 50px rgba(236, 72, 153, 0.08), inset 0 0 40px rgba(139, 92, 246, 0.03);
                border-color: #8b5cf6;
            }}
            50% {{ 
                box-shadow: 0 0 45px rgba(139, 92, 246, 0.4), 0 0 80px rgba(236, 72, 153, 0.15), inset 0 0 60px rgba(139, 92, 246, 0.06);
                border-color: #ec4899;
            }}
        }}
        </style>
    </head>
    <body>
        <div class="popup-window">
            <div class="title-strip">
                <span class="title-label">🔥 {title_upper}.txt — climax</span>
            </div>
            <div class="content-area">
                <div class="lyric-text"><span id="lyric-content"></span><span class="cursor-glow">│</span></div>
            </div>
        </div>
        <script>
            const words = {words_json};
            const targetTimeMs = {target_unix_time_ms};
            const contentSpan = document.getElementById('lyric-content');
            
            // Adjust start time if the window loaded late to ensure we always show the typing animation from the beginning
            let startTime = targetTimeMs;
            const now = Date.now();
            if (now > targetTimeMs) {{
                startTime = now;
            }}
            
            function updateWords() {{
                const elapsed = (Date.now() - startTime) / 1000.0;
                let text = "";
                for (let i = 0; i < words.length; i++) {{
                    if (elapsed < words[i].time) break;
                    let nextTime = (i + 1 < words.length) ? words[i + 1].time : (words.length > 1 ? words[i].time + Math.min(2.0, ((words[i].time - words[0].time) / (words.length - 1)) * 1.5) : words[i].time + 1.0);
                    let wordDuration = Math.max(0.05, nextTime - words[i].time);
                    let wordText = words[i].text.toUpperCase();
                    let typingDuration = wordDuration;
                    let wordElapsed = elapsed - words[i].time;
                    let fraction = Math.min(1.0, wordElapsed / typingDuration);
                    text += wordText.slice(0, Math.ceil(wordText.length * fraction));
                }}
                contentSpan.innerText = text.replace(/^\\s+/, "");
                requestAnimationFrame(updateWords);
            }}
            requestAnimationFrame(updateWords);
        </script>
    </body>
    </html>
    """
    else:
        # Normal popup — sleek dark glassmorphic with violet accent
        return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&display=swap');
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #0f1117;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 100vh;
            width: 100vw;
        }}
        .popup-window {{
            width: 100vw;
            height: 100vh;
            display: flex;
            flex-direction: column;
            background: linear-gradient(145deg, #0f1117 0%, #161822 100%);
            border: 1px solid rgba(139, 92, 246, 0.2);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        }}
        .title-strip {{
            height: 26px;
            background: rgba(139, 92, 246, 0.06);
            border-bottom: 1px solid rgba(139, 92, 246, 0.1);
            display: flex;
            align-items: center;
            padding: 0 10px;
        }}
        .title-label {{
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            font-weight: 600;
            color: rgba(139, 92, 246, 0.6);
            letter-spacing: 0.12em;
            text-transform: uppercase;
        }}
        .content-area {{
            flex-grow: 1;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 12px;
        }}
        .lyric-text {{
            font-family: 'JetBrains Mono', monospace;
            font-size: 16px;
            font-weight: 600;
            color: #e2e8f0;
            text-align: center;
            white-space: pre-wrap;
            line-height: 1.5;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            text-shadow: 0 0 8px rgba(139, 92, 246, 0.2);
        }}
        .cursor-dim {{
            color: rgba(139, 92, 246, 0.6);
            font-weight: 600;
            animation: blink 0.8s step-end infinite;
        }}
        @keyframes blink {{
            50% {{ opacity: 0; }}
        }}
        </style>
    </head>
    <body>
        <div class="popup-window">
            <div class="title-strip">
                <span class="title-label">♫ {title_upper}.txt</span>
            </div>
            <div class="content-area">
                <div class="lyric-text"><span id="lyric-content"></span><span class="cursor-dim">│</span></div>
            </div>
        </div>
        <script>
            const words = {words_json};
            const targetTimeMs = {target_unix_time_ms};
            const contentSpan = document.getElementById('lyric-content');
            
            // Adjust start time if the window loaded late to ensure we always show the typing animation from the beginning
            let startTime = targetTimeMs;
            const now = Date.now();
            if (now > targetTimeMs) {{
                startTime = now;
            }}
            
            function updateWords() {{
                const elapsed = (Date.now() - startTime) / 1000.0;
                let text = "";
                for (let i = 0; i < words.length; i++) {{
                    if (elapsed < words[i].time) break;
                    let nextTime = (i + 1 < words.length) ? words[i + 1].time : (words.length > 1 ? words[i].time + Math.min(2.0, ((words[i].time - words[0].time) / (words.length - 1)) * 1.5) : words[i].time + 1.0);
                    let wordDuration = Math.max(0.05, nextTime - words[i].time);
                    let wordText = words[i].text.toUpperCase();
                    let typingDuration = wordDuration;
                    let wordElapsed = elapsed - words[i].time;
                    let fraction = Math.min(1.0, wordElapsed / typingDuration);
                    text += wordText.slice(0, Math.ceil(wordText.length * fraction));
                }}
                contentSpan.innerText = text.replace(/^\\s+/, "");
                requestAnimationFrame(updateWords);
            }}
            requestAnimationFrame(updateWords);
        </script>
    </body>
    </html>
    """


# Zone-based placement system to prevent popup overlap
# The screen is divided into zones around the edges, avoiding the center
# where the main window (850x600) typically sits
popup_zone_index = 0
active_ultimate_climax_win = None  # Only one ultimate climax window at a time

def get_popup_zones(screen_w: int, screen_h: int, popup_w: int, popup_h: int):
    """Returns a list of (x, y) positions for popup zones positioned closely
    around the centered main window (850x600)."""
    main_w = 850
    main_h = 600
    main_x = (screen_w - main_w) // 2
    main_y = (screen_h - main_h) // 2
    
    gap = 20
    
    zones = [
        # Left side column (stacked vertically next to the Notepad window)
        (main_x - popup_w - gap, main_y),
        (main_x - popup_w - gap, main_y + (main_h - popup_h) // 2),
        (main_x - popup_w - gap, main_y + main_h - popup_h),
        
        # Right side column (stacked vertically next to the Notepad window)
        (main_x + main_w + gap, main_y),
        (main_x + main_w + gap, main_y + (main_h - popup_h) // 2),
        (main_x + main_w + gap, main_y + main_h - popup_h),
    ]
    
    # Filter out zones that go off-screen
    safe_zones = []
    margin = 10
    for (zx, zy) in zones:
        if (margin <= zx <= screen_w - popup_w - margin) and \
           (margin <= zy <= screen_h - popup_h - margin - 45):  # -45 to account for Windows taskbar
            safe_zones.append((zx, zy))
            
    # Fallback if screen is too small to cluster around the main window
    if not safe_zones:
        margin = 15
        safe_zones = [
            (margin, margin),
            (screen_w - popup_w - margin, margin),
            (margin, screen_h - popup_h - margin - 45),
            (screen_w - popup_w - margin, screen_h - popup_h - margin - 45),
        ]
        
    return safe_zones

def find_parenthesis_closing_line(lyrics_data: list, start_idx: int) -> int:
    """Scans forward from start_idx to find the line where the unclosed parentheses on start_idx are closed.
    Returns the closing line index, or start_idx if they close on the same line or are not unclosed."""
    if not lyrics_data or start_idx < 0 or start_idx >= len(lyrics_data):
        return start_idx
        
    depth = 0
    # First, run the state machine on the start_idx line to see if it ends with depth > 0
    for char in lyrics_data[start_idx]["text"]:
        if char == '(':
            depth += 1
        elif char == ')':
            if depth > 0:
                depth -= 1
                
    # If the starting line has no unclosed parentheses, no merge is needed
    if depth == 0:
        return start_idx
        
    # Scan subsequent lines to find where depth drops back to 0
    for idx in range(start_idx + 1, len(lyrics_data)):
        for char in lyrics_data[idx]["text"]:
            if char == '(':
                depth += 1
            elif char == ')':
                if depth > 0:
                    depth -= 1
                    if depth == 0:
                        return idx
                        
    # If we reach the end and it never fully closed, return the last line index
    return len(lyrics_data) - 1

def extract_parenthetical_words(line_text: str, words: list) -> tuple:
    """Extracts only the parenthetical parts from the line text and matches the corresponding words list."""
    parenthetical_parts = re.findall(r'\(.*?\)', line_text, re.DOTALL)
    if not parenthetical_parts:
        return line_text, words
        
    target_text = " ".join(parenthetical_parts)
    
    def clean_tok(t):
        return re.sub(r'[^a-zA-Z0-9]', '', t.lower())
        
    target_tokens = [clean_tok(t) for t in target_text.split() if clean_tok(t)]
    if not target_tokens:
        return target_text, words
        
    word_tokens = [clean_tok(w["text"]) for w in words]
    
    match_idx = -1
    n_target = len(target_tokens)
    for i in range(len(word_tokens) - n_target, -1, -1):
        if word_tokens[i:i+n_target] == target_tokens:
            match_idx = i
            break
            
    if match_idx != -1:
        filtered_words = words[match_idx : match_idx + n_target]
        return target_text, filtered_words
    else:
        n_words = len(words)
        if n_words >= n_target:
            return target_text, words[-n_target:]
        return target_text, words

def spawn_popup_window(line: dict, artist: str, title: str, target_unix_time: float, end_time: float, lyrics_data: list = None, line_index: int = -1):
    """Spawns a new popup window in a non-overlapping zone on the screen.
    If lyrics_data and line_index are provided, looks ahead for multi-line parenthetical groups."""
    global popup_windows, popup_zone_index, active_ultimate_climax_win, last_popup_spawn_time, is_client_fullscreen
    
    if is_client_fullscreen:
        return
    
    is_climax = line.get("is_ultimate_climax", False)
    
    # Rate limit regular popups to prevent dense overlapping spawns (at most 1 every 1.0s)
    if not is_climax:
        if time.time() - last_popup_spawn_time < 1.0:
            return
            
    last_popup_spawn_time = time.time()
    
    # Get screen dimensions
    screens = webview.screens
    screen_w = screens[0].width if screens else 1920
    screen_h = screens[0].height if screens else 1080
    
    if is_climax:
        width = 650
        height = 320
        
        # Get currently active ultimate climax windows
        active_ultimates = [w for w in popup_windows if getattr(w, "is_ultimate_climax", False)]
        
        # Keep at most 2 ultimate climax windows open simultaneously to prevent overlapping cuts
        if len(active_ultimates) >= 2:
            old_ultimate = active_ultimates[0]
            safe_destroy_window(old_ultimate)
            if old_ultimate in popup_windows:
                popup_windows.remove(old_ultimate)
            # Update the list
            active_ultimates = [w for w in popup_windows if getattr(w, "is_ultimate_climax", False)]
            
        # Alternating positions for up to 2 ultimate climax windows:
        # Slot 1 is top-center, Slot 2 is bottom-center
        slot1 = ((screen_w - width) // 2, 30)
        slot2 = ((screen_w - width) // 2, screen_h - height - 50)
        
        occupied = {(w.orig_x, w.orig_y) for w in active_ultimates if hasattr(w, "orig_x") and hasattr(w, "orig_y")}
        
        if slot1 not in occupied:
            x, y = slot1
        else:
            x, y = slot2
    else:
        width = 300
        height = 180
        
        # Keep at most 4 regular popups open
        MAX_POPUPS = 4
        regular_popups = [w for w in popup_windows if not getattr(w, "is_ultimate_climax", False)]
        if len(regular_popups) >= MAX_POPUPS:
            old_win = regular_popups[0]
            safe_destroy_window(old_win)
            if old_win in popup_windows:
                popup_windows.remove(old_win)
        
        # Get safe zones and pick the next one in round-robin
        zones = get_popup_zones(screen_w, screen_h, width, height)
        
        # Avoid zones already occupied by existing popups
        occupied = set()
        for w in popup_windows:
            if hasattr(w, "orig_x") and hasattr(w, "orig_y"):
                occupied.add((w.orig_x, w.orig_y))
        
        # Find first unoccupied zone
        chosen_zone = None
        for i in range(len(zones)):
            zone_idx = (popup_zone_index + i) % len(zones)
            if zones[zone_idx] not in occupied:
                chosen_zone = zones[zone_idx]
                popup_zone_index = (zone_idx + 1) % len(zones)
                break
        
        # If all zones occupied, cycle through anyway
        if chosen_zone is None:
            chosen_zone = zones[popup_zone_index % len(zones)]
            popup_zone_index = (popup_zone_index + 1) % len(zones)
        
        x, y = chosen_zone
    
    line_text = line["text"]
    words_list = line.get("words", [])
    
    # Handle multi-line parenthetical groups: if this line opens a parenthesis
    # but doesn't close it on the same line, look ahead line-by-line until the closing paren is found
    # and combine them into one popup. If the line has both '(' and ')', do not merge.
    if lyrics_data is not None and line_index >= 0:
        closing_idx = find_parenthesis_closing_line(lyrics_data, line_index)
        if closing_idx > line_index:
            combined_text_parts = []
            combined_words = []
            for j in range(line_index, closing_idx + 1):
                next_l = lyrics_data[j]
                next_text = next_l["text"]
                combined_text_parts.append(next_text)
                
                next_words = next_l.get("words", [])
                if next_words and combined_words:
                    # Insert space between word boundary if not already present
                    last_word_text = combined_words[-1]["text"]
                    if not last_word_text.endswith(" ") and not next_words[0]["text"].startswith(" "):
                        combined_words[-1] = combined_words[-1].copy()
                        combined_words[-1]["text"] += " "
                combined_words.extend(next_words)
                
            line_text = "\n".join(combined_text_parts)
            words_list = combined_words
            
            # Update end_time to cover the full group
            last_group_line = lyrics_data[closing_idx]
            if closing_idx + 1 < len(lyrics_data):
                end_time = lyrics_data[closing_idx + 1]["time"]
            else:
                end_time = last_group_line["time"] + last_group_line.get("duration", 5.0)
    
    # If the line has parentheses, extract only the parenthetical text and matching words
    if "(" in line_text and ")" in line_text:
        line_text, words_list = extract_parenthetical_words(line_text, words_list)
        
    words = line_text.split()
    title_word = words[0] if words else "CLIMAX"
    # Clean win title from punctuation/parentheses
    title_word = re.sub(r'[^a-zA-Z0-9]', '', title_word)
    win_title = f"{title_word.upper()}"
    
    # Prepare relative word timings
    line_time = line["time"]
    relative_words = []
    for w in words_list:
        relative_words.append({
            "text": w["text"],
            "time": max(0.0, w["time"] - line_time)
        })
        
    html_content = get_popup_html(relative_words, win_title, target_unix_time, is_climax)
    
    try:
        try:
            if is_climax:
                print(f"Spawning ULTIMATE CLIMAX window at ({x}, {y})")
            else:
                print(f"Spawning Climax window '{win_title}' at ({x}, {y})")
        except Exception:
            pass
            
        def do_create_window():
            return webview.create_window(
                title=f"🔥 {win_title}.txt" if is_climax else f"📄 {win_title}.txt",
                html=html_content,
                width=width,
                height=height,
                x=x,
                y=y,
                resizable=True,
                text_select=True
            )
            
        win = do_create_window()
        win.orig_x = x
        win.orig_y = y
        win.is_ultimate_climax = is_climax
        win.end_time = end_time
        popup_windows.append(win)
        
        if is_climax:
            active_ultimate_climax_win = win
    except Exception as e:
        print(f"Failed to spawn popup window: {e}")

def safe_destroy_window(win):
    """Safely destroys a pywebview window using standard destroy."""
    if win not in webview.windows:
        return
    def do_destroy():
        try:
            win.destroy()
        except Exception:
            pass
    # We can just call it directly as destroy() handles threading gracefully in pywebview
    # but to be safe we can use a thread
    threading.Thread(target=do_destroy, daemon=True).start()

def close_all_popups(reason="unknown"):
    """Destroys all open popup windows immediately."""
    global popup_windows, should_shake_windows, popup_zone_index, active_ultimate_climax_win
    should_shake_windows = False
    popup_zone_index = 0
    active_ultimate_climax_win = None
    if not popup_windows:
        return
    print(f"Closing all {len(popup_windows)} climax windows... (reason: {reason})")
    for win in list(popup_windows):
        safe_destroy_window(win)
    popup_windows.clear()

async def monitor_media():
    """Background task to poll media player status and broadcast updates."""
    global last_track_payload, last_position_payload, popup_windows, popup_close_task, current_track_offset, last_popup_spawn_time
    global current_song_bpm, current_song_energy, current_playback_position, last_position_update_time, is_playback_paused
    
    print("Starting media monitor loop...")
    last_title = None
    last_artist = None
    last_position = None
    last_is_paused = None
    
    lyrics_data = []
    spawned_climax_times = set()
    song_bpm = 120.0
    song_energy = 0.5
    song_valence = 0.5
    source_app = "Unknown"
    duration = 0.0
    current_line_index = -1
    
    # Position extrapolation variables
    local_position = 0.0
    last_raw_position = 0.0
    last_clock_time = time.time()
    
    lyrics_load_task = None
    consecutive_none_reads = 0
    last_full_fetch_time = 0.0

    async def fetch_and_process_track_details(target_title, target_artist, target_source, target_duration):
        nonlocal lyrics_data, song_bpm, song_energy, song_valence
        global last_track_payload, last_position_payload, current_track_offset, current_song_bpm, current_song_energy
        
        async def download_and_notify_cover():
            success = await cover_manager.download_cover(target_artist, target_title)
            if success:
                import base64
                try:
                    with open(cover_manager.cover_path, "rb") as f:
                        b64_data = base64.b64encode(f.read()).decode('utf-8')
                    print(f"Broadcasting base64 cover image to frontend ({len(b64_data)} bytes)")
                    await broadcast({
                        "type": "cover_ready", 
                        "base64": f"data:image/jpeg;base64,{b64_data}"
                    })
                except Exception as e:
                    print(f"Error encoding cover: {e}")

        try:
            # Trigger background download of album cover
            asyncio.create_task(download_and_notify_cover())
            
            # Broadcast loading state immediately to the client
            await broadcast({
                "type": "lyrics_loading",
                "title": target_title,
                "artist": target_artist
            })
            
            # 1. Fetch synced lyrics dictionary (offload to thread pool with a timeout of 5.0 seconds)
            try:
                lyrics_dict = await asyncio.wait_for(
                    asyncio.to_thread(
                        fetch_synced_lyrics, 
                        f"{target_artist} {target_title}", 
                        duration=target_duration, 
                        artist=target_artist, 
                        title=target_title
                    ),
                    timeout=25.0
                )
            except asyncio.TimeoutError:
                print(f"Lyrics fetch timed out after 25.0s for: '{target_title}' by '{target_artist}'")
                lyrics_dict = {"offset": 0.0, "lyrics": []}
                
            raw_lyrics = lyrics_dict.get("lyrics", [])
            track_offset = lyrics_dict.get("offset", 0.0)
            current_track_offset = track_offset
            
            # 2. Analyze lyrics metrics (offload to thread pool)
            h_bpm, h_energy, h_valence = await asyncio.to_thread(
                bpm_provider.analyze_lyrics_metrics, raw_lyrics
            )
            
            # 3. Fetch Spotify features (offload to thread pool)
            s_bpm, s_energy, s_valence = await asyncio.to_thread(
                bpm_provider.fetch_spotify_audio_features, target_title, target_artist
            )
            
            # Use Spotify features if valid, otherwise fallback to heuristics
            if s_bpm != 120.0 or s_energy != 0.5:
                bpm_val, energy_val, valence_val = s_bpm, s_energy, s_valence
            else:
                bpm_val, energy_val, valence_val = h_bpm, h_energy, h_valence
                
            # Pre-calculate line intensity metadata and generate word timestamps
            processed_lyrics = []
            for i, line in enumerate(raw_lyrics):
                next_line = raw_lyrics[i + 1] if i + 1 < len(raw_lyrics) else None
                next_time = next_line["time"] if next_line else (line["time"] + 5.0)
                
                # Calculate a realistic duration of the line to prevent typing/stretching trailing over instrumental gaps
                gap_to_next = next_time - line["time"]
                text_words = line["text"].split()
                # Use a tighter estimation (approx 0.35s per word + 0.8s) to type slightly faster than the singer.
                # This prevents the "falling behind" effect when the singer finishes a sentence quickly.
                estimated_dur = len(text_words) * 0.35 + 0.8
                
                # If the line already has word timestamps, ensure line_duration covers all of them
                pre_words = line.get("words", [])
                if pre_words:
                    max_word_offset = max(0.0, pre_words[-1]["time"] - line["time"])
                    estimated_dur = max(estimated_dur, max_word_offset + 1.0)
                    
                line_duration = max(0.5, min(gap_to_next, estimated_dur))
                line_end_time = line["time"] + line_duration
                
                # Populate word-level list for sub-line sync
                words = line.get("words")
                if not words:
                    words = []
                    if text_words:
                        play_duration = line_duration  # Flow perfectly to the end of the line
                        word_gap = play_duration / len(text_words)
                        for idx, w in enumerate(text_words):
                            suffix = " " if idx < len(text_words) - 1 else ""
                            words.append({
                                "time": line["time"] + (idx * word_gap),
                                "text": w + suffix
                            })
                
                # Apply stretching and dots to words
                stretched_words = []
                reconstructed_text_parts = []
                for idx, w in enumerate(words):
                    w_time = w["time"]
                    w_text = w["text"]
                    
                    # Determine duration of this word
                    if idx + 1 < len(words):
                        w_duration = words[idx + 1]["time"] - w_time
                    else:
                        w_duration = line_end_time - w_time
                    
                    # Cap duration to a maximum of 4.0 seconds to avoid infinite stretching
                    w_duration = min(4.0, max(0.0, w_duration))
                    
                    new_text = stretch_word_text(w_text, w_duration)
                    stretched_words.append({
                        "time": w_time,
                        "text": new_text
                    })
                    reconstructed_text_parts.append(new_text)
                    
                # Reconstruct the line text from the stretched words
                line_text = "".join(reconstructed_text_parts).strip()
                
                intensity = bpm_provider.get_line_intensity(line, next_line, bpm_val)
                processed_lyrics.append({
                    "time": line["time"],
                    "text": line_text if line_text else line["text"],
                    "words": stretched_words,
                    "intensity": intensity,
                    "duration": line_duration
                })
            
            # Second pass: compute climax scores and mark ultimate climax lines dynamically
            if processed_lyrics:
                scores = []
                for line in processed_lyrics:
                    text = line["text"]  # This is the STRETCHED text
                    intensity = line["intensity"]
                    
                    # Base score from CPS and level
                    score = intensity["cps"] + (intensity["level"] * 3.0)
                    
                    # Keyword density boost (each matched keyword adds points)
                    keyword_count = intensity.get("matched_keywords", 0)
                    score += keyword_count * 2.5
                    
                    # Elongated vowels detection on BOTH original (intensity flag) 
                    # AND the stretched text we display
                    has_elongation_original = intensity.get("has_elongation", False)
                    has_elongation_stretched = bool(re.search(r'([aeiouAEIOU])\1{2,}', text))
                    has_any_elongation = has_elongation_original or has_elongation_stretched
                    
                    if has_any_elongation:
                        score += 12.0
                    
                    # ALL CAPS text boost (check stretched text)
                    stripped = text.strip()
                    if stripped.isupper() and len(stripped) > 3:
                        score += 8.0
                    
                    # Exclamation marks boost
                    excl_count = text.count("!")
                    if excl_count > 0:
                        score += 2.0 + excl_count * 1.5
                    
                    # Question marks with emotional words (e.g. "WHAT ABOUT ME?")
                    if "?" in text and keyword_count >= 2:
                        score += 4.0
                    
                    # Short, punchy lines with high intensity are often climax moments
                    word_count = len(text.split())
                    if word_count <= 5 and keyword_count >= 2 and intensity["level"] >= 2:
                        score += 3.0
                    
                    # Repeated chorus lines that are also uppercase or elongated
                    norm_check = re.sub(r'[^a-z0-9\s]', '', text.lower()).strip()
                    is_repeated = norm_check in (bpm_provider.repeated_lyrics if hasattr(bpm_provider, 'repeated_lyrics') else set())
                    if is_repeated and (stripped.isupper() or has_any_elongation):
                        score += 6.0
                        
                    scores.append(score)
                
                # Debug: print top 5 scoring lines
                scored_lines = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
                print(f"\n--- Top 5 Climax Candidates ---")
                for rank, (idx, sc) in enumerate(scored_lines[:5]):
                    line_text = processed_lyrics[idx]["text"][:50]
                    lvl = processed_lyrics[idx]["intensity"]["level"]
                    print(f"  #{rank+1}: Score={sc:.1f} Level={lvl} | \"{line_text}\"")
                
                # Find the top threshold
                max_score = max(scores) if scores else 0.0
                climax_threshold = max(20.0, max_score * 0.90)
                
                # First pass: identify all candidates above threshold
                candidates = []
                for idx, line in enumerate(processed_lyrics):
                    if scores[idx] >= climax_threshold and scores[idx] >= 20.0:
                        candidates.append((idx, scores[idx]))
                
                # Cap at maximum 8 climax lines (keep only highest scoring)
                MAX_CLIMAX_LINES = 8
                if len(candidates) > MAX_CLIMAX_LINES:
                    candidates.sort(key=lambda x: x[1], reverse=True)
                    candidates = candidates[:MAX_CLIMAX_LINES]
                
                climax_indices = {idx for idx, _ in candidates}
                
                climax_count = 0
                for idx, line in enumerate(processed_lyrics):
                    if idx in climax_indices:
                        line["is_ultimate_climax"] = True
                        line["intensity"]["level"] = 3
                        climax_count += 1
                        try:
                            print(f"🔥 Ultimate Climax [{climax_count}]: '{line['text'][:60]}' (Score: {scores[idx]:.1f})")
                        except Exception:
                            print(f"Ultimate Climax [{climax_count}]: Score={scores[idx]:.1f}")
                    else:
                        line["is_ultimate_climax"] = False
                
                print(f"Total Ultimate Climax lines: {climax_count}/{len(processed_lyrics)}")
                
            # Verify track has not changed while loading in background
            if last_title == target_title and last_artist == target_artist:
                lyrics_data = processed_lyrics
                song_bpm = bpm_val
                song_energy = energy_val
                song_valence = valence_val
                
                # Update global sync variables
                current_song_bpm = bpm_val
                current_song_energy = energy_val
                
                # Build track payload
                last_track_payload = {
                    "type": "track",
                    "title": target_title,
                    "artist": target_artist,
                    "bpm": song_bpm,
                    "energy": song_energy,
                    "valence": song_valence,
                    "source_app": target_source,
                    "lyrics": lyrics_data,
                    "offset": current_track_offset,
                    "duration": target_duration
                }
                
                # Broadcast immediately
                await broadcast(last_track_payload)
                print(f"Successfully loaded lyrics for '{target_title}' and broadcasted. Offset={current_track_offset:.2f}s")
                
                # Instantly broadcast position update so clients align immediately
                last_position_payload = {
                    "type": "position",
                    "position": local_position,
                    "is_paused": is_paused
                }
                await broadcast(last_position_payload)
                
        except asyncio.CancelledError:
            print(f"Lyrics loading task cancelled for '{target_title}' by '{target_artist}'")
        except Exception as e:
            print(f"Error in lyrics loading task: {e}")
            traceback.print_exc()

    last_audio_active_time = 0.0
    last_periodic_broadcast = 0.0
    while True:
        try:
            # Check for force sync trigger
            force_sync = False
            global force_sync_trigger
            if force_sync_trigger:
                force_sync_trigger = False
                force_sync = True
                print("Processing force sync...")
                
            # 1. Fetch current playback details from Windows GSMTC
            # Decide whether to fetch full metadata or just fast position
            now_time = time.time()
            need_full_info = False
            fast_info = None

            # First, check if a media session is even active
            session = tracker.get_current_session()
            if not session:
                track_info = None
            else:
                if force_sync or last_title is None:
                    # When idle, check full info every 1.0 second to detect track changes
                    if force_sync or (now_time - last_full_fetch_time >= 1.0):
                        need_full_info = True
                else:
                    fast_info = tracker.get_current_position()
                    if fast_info is None:
                        # Fallback if fast check fails
                        need_full_info = True
                    else:
                        # Check if session/app changed or duration changed
                        if fast_info["source_app"] != source_app or abs(fast_info["duration"] - duration) > 0.1:
                            need_full_info = True
                        # Check if position jumped backwards (suggests song restarted or manually seeked)
                        elif last_position is not None and fast_info["position"] < last_position - 1.5:
                            need_full_info = True
                        # Check if too much time has passed since last full metadata fetch (fallback)
                        elif now_time - last_full_fetch_time >= 3.0:
                            need_full_info = True

                if need_full_info:
                    track_info = await tracker.get_track_info()
                    if track_info:
                        last_full_fetch_time = now_time
                    else:
                        track_info = None
                elif fast_info is not None:
                    # Construct track_info from cached metadata and fast_info
                    track_info = {
                        "title": last_title,
                        "artist": last_artist,
                        "duration": duration,
                        "position": fast_info["position"],
                        "is_paused": fast_info["is_paused"],
                        "source_app": fast_info["source_app"]
                    }
                else:
                    track_info = None
            
            if track_info:
                consecutive_none_reads = 0
                title = track_info["title"]
                raw_artist = track_info["artist"]
                
                # Sanitize artist string: take only the primary artist before commas, &, or "feat"
                artist = re.split(r',|&| feat\. | ft\. | x | \+ ', raw_artist, flags=re.IGNORECASE)[0].strip() if raw_artist else ""
                position = track_info["position"]
                is_paused = track_info["is_paused"]
                source = track_info["source_app"]
                
                # --- BUGFIX: GSMTC Spotify Bug Override ---
                # Sometimes Spotify reports paused while actually playing.
                # Only override if there's REAL-TIME evidence the song is playing.
                # When user genuinely pauses: audio stops + position freezes → override doesn't fire → lyrics stop instantly.
                if is_paused:
                    audio_active = audio_analyzer and audio_analyzer.available and audio_analyzer.get_bass_energy() > 0.002
                    position_advancing = (last_raw_position is not None) and (position > last_raw_position + 0.1)
                    
                    if audio_active or position_advancing:
                        is_paused = False
                
                # Update extrapolated local position
                current_time = time.time()
                is_seeking = False
                # Only trigger track change if the metadata is valid and not transient "Unknown" placeholder
                is_valid_track = title not in ("Unknown Title", "Unknown", "") and artist not in ("Unknown Artist", "Unknown", "")
                if is_valid_track and (title != last_title or artist != last_artist):
                    # Reset extrapolation on track change
                    local_position = position
                    last_raw_position = position
                    last_clock_time = current_time
                    
                    try:
                        print(f"\n--- Track Detected: {title} by {artist} (App: {source}) ---")
                    except Exception:
                        print("\n--- Track Detected: (Unicode characters ignored) ---")
                    last_title = title
                    last_artist = artist
                    source_app = source
                    if audio_analyzer:
                        audio_analyzer.set_target_app(source)
                    current_line_index = -1
                    
                    # Force close all climax popups on track change
                    close_all_popups("track_change")
                    cover_manager.delete_cover()
                    if popup_close_task:
                        popup_close_task.cancel()
                        popup_close_task = None
                    spawned_climax_times.clear()
                    last_popup_spawn_time = 0.0
                    
                    duration = track_info.get("duration", 0.0)
                    
                    # Load cached offset immediately to prevent sync lag in early seconds
                    current_track_offset = 0.0
                    cache_path = resolve_lyrics_cache_path(artist, title, duration)
                    if os.path.exists(cache_path):
                        try:
                            with open(cache_path, "r", encoding="utf-8") as f:
                                cached_data = json.load(f)
                                if isinstance(cached_data, dict):
                                    current_track_offset = cached_data.get("offset", 0.0)
                        except Exception:
                            pass
                    
                    # Clear lyrics and reset state immediately to show track change on client
                    lyrics_data = []
                    song_bpm = 120.0
                    song_energy = 0.5
                    song_valence = 0.5
                    
                    # Build and broadcast initial empty track payload
                    last_track_payload = {
                        "type": "track",
                        "title": title,
                        "artist": artist,
                        "bpm": song_bpm,
                        "energy": song_energy,
                        "valence": song_valence,
                        "source_app": source_app,
                        "lyrics": [],
                        "offset": current_track_offset,
                        "duration": duration
                    }
                    await broadcast(last_track_payload)
                    last_position = position
                    last_is_paused = is_paused

                    # Cancel any existing load task
                    if lyrics_load_task and not lyrics_load_task.done():
                        lyrics_load_task.cancel()
                        
                    # Start async background load task
                    lyrics_load_task = asyncio.create_task(
                        fetch_and_process_track_details(title, artist, source, duration)
                    )
                else:
                    # Standard playback tracking without blocking seeking
                    # Calculate previous extrapolated position before updating
                    previous_extrapolated = last_raw_position + (current_time - last_clock_time) if not is_paused else last_raw_position
                    
                    is_seeking = force_sync
                    
                    if position != last_raw_position or is_paused != last_is_paused:
                        # OS updated position or pause state. Detect manual scrub/rewind.
                        if last_position is not None and abs(position - previous_extrapolated) > 2.0:
                            is_seeking = True
                            
                        # Authoritative update from OS snapshot
                        local_position = position
                        last_raw_position = position
                        last_clock_time = current_time
                    else:
                        # Extrapolate playback time if not paused
                        local_position = previous_extrapolated
                        
                if is_seeking:
                    close_all_popups("seek_detected")
                    if popup_close_task:
                        popup_close_task.cancel()
                        popup_close_task = None
                    spawned_climax_times.clear()
                    last_popup_spawn_time = 0.0
                    # Reset extrapolation on seek/force_sync
                    local_position = position
                    last_raw_position = position
                    last_clock_time = current_time
                
                # Check for play/pause state updates
                state_changed = (is_paused != last_is_paused)
                
                if is_seeking or state_changed:
                    # Sync local_position to authoritative position on seek/state change
                    local_position = position
                    last_raw_position = position
                    last_clock_time = current_time
                
                # Broadcast position on seek, state change, or periodically every 5s for correction
                needs_broadcast = is_seeking or state_changed
                if not needs_broadcast:
                    if current_time - last_periodic_broadcast >= 5.0:
                        needs_broadcast = True
                
                if needs_broadcast:
                    last_periodic_broadcast = current_time
                    broadcast_position = local_position
                    last_position_payload = {
                        "type": "position",
                        "position": broadcast_position,
                        "is_paused": is_paused
                    }
                    await broadcast(last_position_payload)
                
                # Autoritative tracking state update on every tick
                last_position = position
                last_is_paused = is_paused
                
                # Close all popup windows immediately if paused
                if is_paused:
                    close_all_popups("is_paused")
                    if popup_close_task:
                        popup_close_task.cancel()
                        popup_close_task = None
                
                # Prune manually/externally closed windows to prevent referencing dead windows
                popup_windows = [w for w in popup_windows if w in webview.windows]

                # Close individual popups that have expired in audio timeline + 5.0 seconds post-typing
                current_audio_time = local_position + current_track_offset
                expired_windows = []
                for win in list(popup_windows):
                    if hasattr(win, "end_time") and current_audio_time >= (win.end_time + 5.0):
                        expired_windows.append(win)
                for win in expired_windows:
                    safe_destroy_window(win)
                    if win in popup_windows:
                        popup_windows.remove(win)
                
                # Identify currently active line based on extrapolated position + offset
                active_line_index = -1
                for i, line in enumerate(lyrics_data):
                    if (local_position + current_track_offset) >= line["time"]:
                        active_line_index = i
                    else:
                        break
                
                # Dynamically set desktop window shaking based on active intensity
                if active_line_index >= 0:
                    should_shake_windows = enable_shake and (lyrics_data[active_line_index]["intensity"]["level"] == 3) and not is_paused
                else:
                    should_shake_windows = False
                    
                # Update global playback sync states for the background shake thread
                current_playback_position = local_position
                last_position_update_time = time.time()
                is_playback_paused = is_paused
                
                # Pre-spawn climax windows 2.2 seconds in advance to avoid Edge process boot latency
                if not is_paused:
                    PRESPAWN_LEAD_TIME = 2.2
                    for idx, line in enumerate(lyrics_data):
                        # Check if this line is a continuation of a multi-line parenthetical group
                        # (i.e. a previous line opened a parenthesis that hasn't closed yet)
                        is_paren_continuation = False
                        for prev_idx in range(idx - 1, -1, -1):
                            prev_text = lyrics_data[prev_idx]["text"]
                            if ")" in prev_text:
                                if "(" in prev_text:
                                    # Self-contained line: (text)
                                    break
                                # End of a previous multi-line group
                                break
                            elif "(" in prev_text:
                                # Opening parenthesis found (and no closing paren, since we didn't break)
                                is_paren_continuation = True
                                break
                        
                        if is_paren_continuation:
                            # This line is part of a group already handled by a previous line's spawn
                            if line["time"] not in spawned_climax_times:
                                spawned_climax_times.add(line["time"])
                            continue
                        
                        has_paren = "(" in line["text"]
                        if line["intensity"]["level"] == 3 or has_paren:
                            closing_idx = find_parenthesis_closing_line(lyrics_data, idx) if has_paren else idx
                            time_until_start = line["time"] - (local_position + current_track_offset)
                            if 0.0 < time_until_start <= PRESPAWN_LEAD_TIME:
                                if line["time"] not in spawned_climax_times:
                                    # Mark all lines in the group as spawned
                                    for k in range(idx, closing_idx + 1):
                                        spawned_climax_times.add(lyrics_data[k]["time"])
                                        
                                    target_unix_time = time.time() + time_until_start
                                    
                                    # Calculate end_time based on closing_idx
                                    next_line = lyrics_data[closing_idx + 1] if closing_idx + 1 < len(lyrics_data) else None
                                    line_duration = next_line["time"] - line["time"] if next_line else 5.0
                                    # Extend climax duration cap to 12.0 seconds to prevent premature cuts
                                    line_duration = min(12.0, line_duration)
                                    end_time = line["time"] + line_duration
                                    
                                    if enable_popups:
                                        spawn_popup_window(
                                            line,
                                            last_artist,
                                            last_title,
                                            target_unix_time,
                                            end_time,
                                            lyrics_data,
                                            idx,
                                        )
                
                # Trigger climax window spawning on line changes (fallback if not pre-spawned)
                if active_line_index != current_line_index:
                    current_line_index = active_line_index
                    if active_line_index >= 0:
                        active_line = lyrics_data[active_line_index]
                        level = active_line["intensity"]["level"]
                        has_paren = "(" in active_line["text"]
                        
                        if level == 3 or has_paren:
                            # Cancel any scheduled popup destruction
                            if popup_close_task:
                                popup_close_task.cancel()
                                popup_close_task = None
                            
                            # Spawn new popup if not already pre-spawned
                            if active_line["time"] not in spawned_climax_times:
                                closing_idx = find_parenthesis_closing_line(lyrics_data, active_line_index) if has_paren else active_line_index
                                
                                # Mark all lines in the group as spawned
                                for k in range(active_line_index, closing_idx + 1):
                                    spawned_climax_times.add(lyrics_data[k]["time"])
                                    
                                next_line = lyrics_data[closing_idx + 1] if closing_idx + 1 < len(lyrics_data) else None
                                line_duration = next_line["time"] - active_line["time"] if next_line else 5.0
                                # Extend climax duration cap to 12.0 seconds to prevent premature cuts
                                line_duration = min(12.0, line_duration)
                                end_time = active_line["time"] + line_duration
                                
                                if enable_popups:
                                    spawn_popup_window(
                                        active_line,
                                        last_artist,
                                        last_title,
                                        time.time(),
                                        end_time,
                                        lyrics_data,
                                        active_line_index,
                                    )
                        else:
                            # If we drop below level 3, schedule auto-destroy of all popups after 5 seconds of calm
                            if popup_windows and popup_close_task is None:
                                async def close_popups_later():
                                    global popup_close_task
                                    try:
                                        await asyncio.sleep(5.0)
                                        close_all_popups("popup_close_later")
                                    except asyncio.CancelledError:
                                        pass
                                    finally:
                                        popup_close_task = None
                                        
                                popup_close_task = asyncio.create_task(close_popups_later())
                
            else:
                consecutive_none_reads += 1
                if consecutive_none_reads >= 10:  # ~2.0 seconds of consecutive none reads
                    # No track active (silent default state)
                    if last_title is not None:
                        print("\n--- Playback Idle ---")
                        last_title = None
                        last_artist = None
                        current_line_index = -1
                        
                        # Force close popups and cleanup cover
                        close_all_popups("idle_no_track")
                        cover_manager.delete_cover()
                        if popup_close_task:
                            popup_close_task.cancel()
                            popup_close_task = None
                            
                        last_track_payload = {
                            "type": "track",
                            "title": "Untitled",
                            "artist": "Notepad",
                            "bpm": 120.0,
                            "energy": 0.5,
                            "valence": 0.5,
                            "source_app": "System",
                            "lyrics": [],
                            "duration": 0.0
                        }
                        last_position_payload = {
                            "type": "position",
                            "position": 0.0,
                            "is_paused": True
                        }
                        
                        # Reset global music sync variables
                        current_song_bpm = 120.0
                        current_song_energy = 0.5
                        current_playback_position = 0.0
                        last_position_update_time = time.time()
                        is_playback_paused = True
                        
                        await broadcast(last_track_payload)
                        await broadcast(last_position_payload)
                    
        except Exception as e:
            print(f"Error in media monitor: {e}")
            traceback.print_exc()
            
        # Sleep for 0.5 seconds globally to save CPU as we only check for play/pause and track changes
        await asyncio.sleep(0.5)

async def main_async():
    """Initializes trackers and starts WebSocket Server + Media Monitor task."""
    global tracker, bpm_provider, audio_analyzer
    
    tracker = MediaSessionTracker()
    await tracker.initialize()
    
    bpm_provider = BPMProvider()
    
    # Start real-time audio analyzer (PyCaw session peak monitoring)
    audio_analyzer = AudioAnalyzer()
    audio_analyzer.start()
    
    # Start windows shaking task
    asyncio.create_task(shake_windows_loop())
    
    # Start real-time audio broadcast to WebSocket clients
    asyncio.create_task(audio_broadcast_loop())
    
    # Start WebSocket Server
    print("Starting WebSocket Server on ws://localhost:8765...")
    server = await websockets.serve(register, "localhost", 8765)
    
    # Start polling loop
    await monitor_media()

def run_async_server(loop):
    asyncio.set_event_loop(loop)
    loop.run_until_complete(main_async())
    loop.run_forever()

def create_default_config():
    """Generates an empty config.json template if missing."""
    if not os.path.exists("config.json"):
        default = {
            "spotify": {
                "client_id": "",
                "client_secret": ""
            }
        }
        try:
            with open("config.json", "w", encoding="utf-8") as f:
                json.dump(default, f, indent=4)
            print("Generated template config.json. Add your Spotify Developer API keys here for exact track BPM details.")
        except Exception as e:
            pass

import http.server
import socketserver
import urllib.parse

class LocalMediaHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parsed = urllib.parse.urlparse(path)
        qs = urllib.parse.parse_qs(parsed.query)
        if 'path' in qs:
            return qs['path'][0]
        return ""

def start_media_server():
    try:
        Handler = LocalMediaHandler
        httpd = socketserver.TCPServer(("127.0.0.1", 8766), Handler)
        print("[MEDIA SERVER] Serving local media on port 8766")
        httpd.serve_forever()
    except Exception as e:
        print(f"[MEDIA SERVER] Failed to start: {e}")

if __name__ == "__main__":
    create_default_config()
    
    # 1. Launch Async Server thread (WebSocket and Media monitoring)
    loop = asyncio.new_event_loop()
    server_thread = threading.Thread(target=run_async_server, args=(loop,), daemon=True)
    server_thread.start()
    
    # Start Media Server thread
    media_server_thread = threading.Thread(target=start_media_server, daemon=True)
    media_server_thread.start()
    
    # 2. Start Desktop UI Window
    print("Launching Lyrics Notepad UI...")
    
    # Handle PyInstaller _MEIPASS temp directory
    try:
        base_path = sys._MEIPASS
    except AttributeError:
        base_path = os.path.abspath(".")
        
    html_path = os.path.join(base_path, "web", "index.html")
    if not os.path.exists(html_path):
        print(f"Error: HTML assets not found at {html_path}", file=sys.stderr)
        sys.exit(1)
        
    class Api:
        def toggle_fullscreen(self):
            try:
                webview.windows[0].toggle_fullscreen()
            except Exception as e:
                print(f"Error toggling fullscreen: {e}")
                
        def pick_media_file(self):
            try:
                import webview
                file_types = ('Media Files (*.mp4;*.webm;*.jpg;*.png;*.jpeg;*.gif)', 'All files (*.*)')
                result = webview.windows[0].create_file_dialog(
                    webview.OPEN_DIALOG, allow_multiple=False, file_types=file_types
                )
                if result:
                    # Windows paths have backslashes, let's normalize to forward slashes for URLs
                    return result[0].replace('\\', '/')
                return None
            except Exception as e:
                print(f"Error picking media file: {e}")
                return None

    window = webview.create_window(
        title="Untitled - LyricPad", 
        url=html_path, 
        width=850, 
        height=600, 
        resizable=True,
        text_select=True,
        js_api=Api()
    )
    
    # Start pywebview window loop (blocks until closed)
    # Set private_mode=False to use a persistent user data cache folder,
    # preventing the [WinError 32] file lock warning on temp folder cleanup.
    webview.start(private_mode=False)
    print("Window closed. Exiting...")
    
    # Gracefully stop the background asyncio loop
    try:
        loop.call_soon_threadsafe(loop.stop)
    except Exception:
        pass
        
    # Force exit the process to prevent thread GIL State teardown crashes (PyGILState_Release)
    os._exit(0)
