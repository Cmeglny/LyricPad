import os
import json
import re
import requests
from typing import List, Dict, Tuple

class BPMProvider:
    def __init__(self, config_path: str = "config.json"):
        self.config_path = config_path
        self.spotify_creds = self.load_config()
        self.spotify_token = None
        self.spotify_api_disabled = False

    def load_config(self) -> Dict:
        """Loads client_id and client_secret if present in config.json."""
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if "spotify" in data:
                        return data["spotify"]
            except Exception as e:
                print(f"Error reading config file: {e}")
        return {}

    def get_spotify_token(self) -> bool:
        """Authenticates with Spotify Client Credentials flow."""
        client_id = self.spotify_creds.get("client_id")
        client_secret = self.spotify_creds.get("client_secret")
        if not client_id or not client_secret:
            return False

        try:
            url = "https://accounts.spotify.com/api/token"
            headers = {"Content-Type": "application/x-www-form-urlencoded"}
            data = {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret
            }
            res = requests.post(url, headers=headers, data=data, timeout=5)
            if res.status_code == 200:
                self.spotify_token = res.json().get("access_token")
                return True
        except Exception as e:
            print(f"Spotify authentication failed: {e}")
        return False

    def fetch_spotify_audio_features(self, title: str, artist: str) -> Tuple[float, float, float, bool]:
        """
        Fetches (tempo, energy, valence, valid) from Spotify API. Checks disk cache first.
        'valid' is False when the values are the (120.0, 0.5, 0.5) fallback rather than real API data.
        """
        from lyrics_provider import get_cache_path

        key = f"{artist}_{title}"
        cache_path = get_cache_path("spotify", key)
        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                    valid = cached.get("valid")
                    if valid is None:
                        # Old cache format without 'valid': the exact fallback triple means a cached failure
                        valid = not (
                            float(cached["bpm"]) == 120.0
                            and float(cached["energy"]) == 0.5
                            and float(cached["valence"]) == 0.5
                        )
                    print(f"[CACHE HIT] Loaded Spotify features from cache for: '{title}' by '{artist}' (BPM={cached['bpm']:.1f})")
                    return float(cached["bpm"]), float(cached["energy"]), float(cached["valence"]), bool(valid)
            except Exception as e:
                print(f"Failed to read Spotify cache: {e}")

        # Core logic: if we don't have creds or auth fails, we should cache the fallback (120.0, 0.5, 0.5)
        # to avoid repeated auth/connection attempts for this track.
        bpm, energy, valence = 120.0, 0.5, 0.5
        valid = False

        if self.spotify_api_disabled:
            pass  # Spotify Audio Features API deprecated (403), skip
        elif self.spotify_creds and (self.spotify_token or self.get_spotify_token()):
            try:
                # Step 1: Search for the track
                search_url = "https://api.spotify.com/v1/search"
                headers = {"Authorization": f"Bearer {self.spotify_token}"}
                params = {
                    "q": f"track:{title} artist:{artist}",
                    "type": "track",
                    "limit": 1
                }
                print(f"[CACHE MISS] Fetching Spotify features for: '{title}' by '{artist}'...")
                res = requests.get(search_url, headers=headers, params=params, timeout=5)
                if res.status_code == 200:
                    tracks = res.json().get("tracks", {}).get("items", [])
                    if not tracks:
                        # Fallback to search query
                        params["q"] = f"{title} {artist}"
                        res = requests.get(search_url, headers=headers, params=params, timeout=5)
                        tracks = res.json().get("tracks", {}).get("items", [])
                    
                    if tracks:
                        track_id = tracks[0]["id"]
                        
                        # Step 2: Get audio features
                        features_url = f"https://api.spotify.com/v1/audio-features/{track_id}"
                        res_features = requests.get(features_url, headers=headers, timeout=5)
                        if res_features.status_code == 200:
                            feat = res_features.json()
                            bpm = float(feat.get("tempo", 120.0))
                            energy = float(feat.get("energy", 0.5))
                            valence = float(feat.get("valence", 0.5))
                            valid = True
                            print(f"Spotify Audio Features loaded: BPM={bpm:.1f}, Energy={energy:.2f}, Valence={valence:.2f}")
                        elif res_features.status_code == 403:
                            print(f"[SPOTIFY] Audio Features API returned 403 (deprecated). Disabling future API calls.")
                            self.spotify_api_disabled = True
            except Exception as e:
                print(f"Failed to fetch Spotify audio features: {e}")

        # Cache the result (whether loaded from Spotify or fallback)
        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump({"bpm": bpm, "energy": energy, "valence": valence, "valid": valid}, f, indent=4)
        except Exception as e:
            print(f"Failed to write Spotify cache: {e}")

        return bpm, energy, valence, valid

    def analyze_lyrics_metrics(self, lyrics: List[Dict]) -> Tuple[float, float, float]:
        """
        Fallback lyric heuristic analyzer.
        Estimates (BPM, Energy, Valence) based on timing gaps, text density, and words.
        Also pre-calculates repeated lyric lines to identify the chorus/climax sections.
        """
        if not lyrics:
            self.repeated_lyrics = set()
            return 120.0, 0.5, 0.5

        # Pre-calculate normalized line frequencies to identify chorus/climax repetitions
        freq_map = {}
        for line in lyrics:
            # Normalize text (lowercase, alphanumeric only)
            norm = re.sub(r'[^a-z0-9\s]', '', line["text"].lower()).strip()
            if len(norm) > 5: # Ignore very short words or blank lines
                freq_map[norm] = freq_map.get(norm, 0) + 1
                
        # Store as a set of repeated phrases
        self.repeated_lyrics = {phrase for phrase, count in freq_map.items() if count >= 2}
        print(f"Chorus/Climax detection: Identified {len(self.repeated_lyrics)} repeated phrases in song.")

        gaps = []
        for i in range(len(lyrics) - 1):
            gap = lyrics[i + 1]["time"] - lyrics[i]["time"]
            if 0.5 < gap < 12.0:  # Exclude instrumental breaks
                gaps.append(gap)

        # Average gap between lines
        avg_gap = sum(gaps) / len(gaps) if gaps else 4.0
        
        # Estimate BPM: assuming 1 line is roughly 8 beats (2 measures at 4/4)
        estimated_bpm = 480 / avg_gap
        estimated_bpm = max(60.0, min(180.0, estimated_bpm))

        # Estimate Energy from lyrics density (characters per second overall)
        total_chars = sum(len(line["text"]) for line in lyrics)
        total_time = lyrics[-1]["time"] - lyrics[0]["time"] if len(lyrics) > 1 else 30.0
        if total_time <= 0:
            total_time = 30.0
        overall_cpm = total_chars / total_time

        # Lyric density alone overrates slow, wordy ballads — weight by tempo as well
        tempo_factor = min(1.2, estimated_bpm / 120.0)
        estimated_energy = max(0.1, min(0.95, (overall_cpm / 10.0) * tempo_factor))

        # Valence (default to neutral 0.5, modified slightly by key words)
        estimated_valence = 0.5
        sad_words = ["sad", "cry", "die", "dead", "grief", "pain", "hurt", "broke", "lost", "dark", "acıt", "üzgün", "ağla", "öl", "karanlık"]
        happy_words = ["happy", "love", "smile", "dance", "bright", "joy", "laugh", "sevg", "mutlu", "gül", "ışık", "parla"]
        
        sad_count = 0
        happy_count = 0
        for line in lyrics:
            text = line["text"].lower()
            sad_count += sum(1 for w in sad_words if w in text)
            happy_count += sum(1 for w in happy_words if w in text)

        if sad_count > happy_count:
            estimated_valence = max(0.1, 0.5 - (sad_count - happy_count) * 0.05)
        elif happy_count > sad_count:
            estimated_valence = min(0.9, 0.5 + (happy_count - sad_count) * 0.05)

        print(f"Lyrics Heuristic Analysis: Estimated BPM={estimated_bpm:.1f}, Energy={estimated_energy:.2f}, Valence={estimated_valence:.2f}")
        return estimated_bpm, estimated_energy, estimated_valence

    def get_line_intensity(self, current_line: Dict, next_line: Dict, song_bpm: float, song_energy: float = 0.5) -> Dict:
        """
        Calculates local properties for the current lyric line:
        - speed: factor for text typing (words per second / density)
        - intensity_level: 0 (Calm), 1 (Normal), 2 (Energetic), 3 (Dramatic/Glitch)
        """
        text = current_line["text"]
        
        # Calculate duration of the line
        if next_line:
            duration = max(0.5, next_line["time"] - current_line["time"])
        else:
            duration = 5.0 # default duration for last line
            
        # Punctuation triggers
        has_exclamation = "!" in text
        has_question = "?" in text
        is_uppercase = text.isupper() and len(text) > 3
        
        # Detect elongated vowels in the ORIGINAL text (e.g. "meeeee", "NOOOOO", "whyyy")
        # This is a very strong climax signal since lyric sources encode intensity this way
        elongated_vowel = bool(re.search(r'([aeıioöuüAEIİOÖUÜ])\1{2,}', text))
        elongated_consonant = bool(re.search(r'([a-zA-ZçğşÇĞŞ])\1{3,}', text))
        has_elongation = elongated_vowel or elongated_consonant
        
        # Word density
        words = text.split()
        word_count = len(words)
        char_count = len(text)
        
        # Characters per second
        cps = char_count / duration
        
        # Check if this line is part of a repeated chorus section
        norm_text = re.sub(r'[^a-z0-9\s]', '', text.lower()).strip()
        is_repeated_chorus = norm_text in self.repeated_lyrics if hasattr(self, 'repeated_lyrics') else False
        
        # High intensity keyword matching. Split into STRONG (aggressive/explosive words
        # that genuinely signal intensity) and WEAK (emotional words that only count in
        # combination). Ultra-common words like "me/you/love/heart" were removed entirely —
        # they appear in every ballad and made calm songs read as energetic.
        strong_words = [
            # Raw energy / aggression
            "scream", "shout", "fire", "burn", "die", "blood", "kill", "fear", "mad", "crazy",
            "hate", "war", "boom", "loud", "hell", "fight", "explode", "rage",
            # Turkish
            "bağır", "çığlık", "ateş", "yan", "öl", "kan", "vur", "kork", "delir", "nefret",
            "savaş", "güm", "patla", "çıldır",
        ]
        weak_words = [
            # Emotional climax vocabulary (needs to co-occur to matter)
            "crushed", "smashed", "devastated", "collapse", "useless", "empty",
            "pain", "tears", "broken", "hurt", "cry", "scars", "bleeding",
            "alone", "gone", "forever", "nothing", "everything", "sorry", "drowned",
            # Turkish emotional
            "yık", "çök", "acı", "üzgün", "kayıp", "karanlık", "kırık", "yalnız",
        ]

        # Count matching keywords (match whole words only to avoid false positives)
        text_lower = text.lower()
        text_words_set = set(re.findall(r'[a-zA-ZçğıöşüÇĞİÖŞÜ]+', text_lower))
        strong_matches = [w for w in strong_words if w in text_words_set]
        weak_matches = [w for w in weak_words if w in text_words_set]
        matched_keywords = strong_matches + weak_matches
        # One aggressive word or an accumulation of emotional ones
        has_intensity_word = len(strong_matches) >= 1 or len(weak_matches) >= 2

        # Calm songs (low energy AND slow tempo) only reach Dramatic with explicit
        # vocal-intensity markers baked into the lyric source (NOOOO / ALL CAPS)
        is_calm_song = song_energy < 0.5 and song_bpm < 110

        # Determine intensity level (0-3)
        if not text.strip() or duration > 12.0:
            level = 0  # Calm/Silence
        else:
            level = 1  # Normal

            # Upgrade conditions (calm songs need noticeably denser lines to read as energetic)
            cps_energetic_threshold = 9.0 if is_calm_song else 5.5
            if cps > cps_energetic_threshold or has_intensity_word or has_exclamation or is_repeated_chorus:
                level = 2  # Energetic

            # Dynamic triggers for Dramatic/Glitch mode
            if (cps > 9.5) or \
               (has_intensity_word and (cps > 7.0 or has_exclamation)) or \
               (is_uppercase) or \
               (has_elongation) or \
               (is_repeated_chorus and cps > 4.5 and has_intensity_word) or \
               (has_exclamation and len(strong_matches) >= 1):
                level = 3  # Dramatic / Extreme

            if level == 3 and is_calm_song and not (has_elongation or is_uppercase):
                level = 2
                
        # Speed modifier for typewriter/scrolling based on BPM
        speed_factor = 1.0 + (song_bpm - 120.0) / 120.0
        speed_factor = max(0.5, min(2.5, speed_factor))

        return {
            "duration": duration,
            "cps": cps,
            "level": level,
            "speed_factor": speed_factor,
            "is_caps": level >= 2 or is_uppercase,
            "has_elongation": has_elongation,
            "matched_keywords": len(matched_keywords)
        }
