import os
import requests
import asyncio
import urllib.parse

class CoverManager:
    def __init__(self, web_dir: str = "web"):
        self.web_dir = web_dir
        
        # Determine the correct base_path to handle PyInstaller
        import sys
        try:
            base_path = sys._MEIPASS
        except AttributeError:
            base_path = os.path.abspath(".")
            
        self.web_dir_full = os.path.join(base_path, self.web_dir)
        self.cover_filename = "cover.jpg"
        self.cover_path = os.path.join(self.web_dir_full, self.cover_filename)

    def _download_sync(self, artist: str, title: str) -> bool:
        try:
            self.delete_cover()
            
            query = f"{title} {artist}"
            encoded_query = urllib.parse.quote(query)
            url = f"https://itunes.apple.com/search?term={encoded_query}&entity=song&limit=1"
            
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])
                if results:
                    thumb_url = results[0].get("artworkUrl100")
                    if thumb_url:
                        high_res_url = thumb_url.replace("100x100bb.jpg", "600x600bb.jpg")
                        img_resp = requests.get(high_res_url, timeout=5)
                        if img_resp.status_code == 200:
                            with open(self.cover_path, "wb") as f:
                                f.write(img_resp.content)
                            print(f"Successfully downloaded cover for '{title}' by '{artist}'")
                            return True
            return False
        except Exception as e:
            print(f"Error downloading cover: {e}")
            return False

    async def download_cover(self, artist: str, title: str) -> bool:
        """
        Fetches the high-res album cover from iTunes Search API and saves it.
        Returns True if successful, False otherwise.
        """
        return await asyncio.to_thread(self._download_sync, artist, title)

    def delete_cover(self):
        """Deletes the locally stored cover image."""
        try:
            if os.path.exists(self.cover_path):
                os.remove(self.cover_path)
        except Exception as e:
            print(f"Error deleting cover: {e}")
