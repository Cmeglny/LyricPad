import os
import re
import requests
import asyncio
import threading
import urllib.parse

class CoverManager:
    def __init__(self, web_dir: str = "web"):
        self.web_dir = web_dir
        # Serializes file writes/deletes across concurrent track-change tasks
        # (RLock because _download_sync calls delete_cover internally)
        self._file_lock = threading.RLock()
        
        # Determine the correct base_path to handle PyInstaller
        import sys
        try:
            base_path = sys._MEIPASS
        except AttributeError:
            base_path = os.path.abspath(".")
            
        self.web_dir_full = os.path.join(base_path, self.web_dir)
        self.cover_filename = "cover.jpg"
        self.cover_path = os.path.join(self.web_dir_full, self.cover_filename)

    @staticmethod
    def _normalize(text: str) -> str:
        return re.sub(r'[^a-z0-9]', '', (text or "").lower())

    def _pick_best_result(self, results: list, artist: str, title: str, album: str = ""):
        """Scores iTunes results by track/artist/album name similarity so a different
        album/single of the same artist doesn't win over the actual release."""
        n_artist = self._normalize(artist)
        n_title = self._normalize(title)
        n_album = self._normalize(album)

        best, best_score = None, -1.0
        for res in results:
            r_track = self._normalize(res.get("trackName", ""))
            r_artist = self._normalize(res.get("artistName", ""))
            r_album = self._normalize(res.get("collectionName", ""))

            score = 0.0
            if n_title and r_track:
                if r_track == n_title:
                    score += 3.0
                elif n_title in r_track or r_track in n_title:
                    score += 2.0
            if n_artist and r_artist:
                if r_artist == n_artist:
                    score += 2.0
                elif n_artist in r_artist or r_artist in n_artist:
                    score += 1.5
            if n_album and r_album:
                if r_album == n_album:
                    score += 4.0
                elif n_album in r_album or r_album in n_album:
                    score += 3.0

            if score > best_score:
                best, best_score = res, score
        return best

    def _download_sync(self, artist: str, title: str, album: str = "") -> bool:
        try:
            self.delete_cover()

            query = f"{title} {artist}"
            encoded_query = urllib.parse.quote(query)
            url = f"https://itunes.apple.com/search?term={encoded_query}&entity=song&limit=10"

            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])
                if results:
                    best = self._pick_best_result(results, artist, title, album) or results[0]
                    thumb_url = best.get("artworkUrl100")
                    if thumb_url:
                        high_res_url = thumb_url.replace("100x100bb.jpg", "600x600bb.jpg")
                        img_resp = requests.get(high_res_url, timeout=5)
                        if img_resp.status_code == 200:
                            with self._file_lock:
                                with open(self.cover_path, "wb") as f:
                                    f.write(img_resp.content)
                            print(f"Successfully downloaded cover for '{title}' by '{artist}'")
                            return True
            return False
        except Exception as e:
            print(f"Error downloading cover: {e}")
            return False

    async def download_cover(self, artist: str, title: str, album: str = "") -> bool:
        """
        Fetches the high-res album cover from iTunes Search API and saves it.
        Returns True if successful, False otherwise.
        """
        return await asyncio.to_thread(self._download_sync, artist, title, album)

    def save_cover_bytes(self, data: bytes) -> bool:
        """Writes raw image bytes (e.g. the media session's own thumbnail) as the current cover."""
        if not data:
            return False
        try:
            with self._file_lock:
                with open(self.cover_path, "wb") as f:
                    f.write(data)
            return True
        except Exception as e:
            print(f"Error saving cover bytes: {e}")
            return False

    def delete_cover(self):
        """Deletes the locally stored cover image."""
        try:
            with self._file_lock:
                if os.path.exists(self.cover_path):
                    os.remove(self.cover_path)
        except Exception as e:
            print(f"Error deleting cover: {e}")
