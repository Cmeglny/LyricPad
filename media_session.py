import asyncio
import traceback
from typing import Dict, Optional
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as SessionManager

class MediaSessionTracker:
    def __init__(self):
        self.manager = None

    async def initialize(self):
        try:
            self.manager = await SessionManager.request_async()
            print("Media Session Manager initialized successfully.")
        except Exception as e:
            print(f"Error initializing MediaSessionManager: {e}")
            traceback.print_exc()

    def get_current_session(self):
        if not self.manager:
            return None
        try:
            return self.manager.get_current_session()
        except Exception as e:
            print(f"Error getting current session: {e}")
            return None

    async def get_track_info(self) -> Optional[Dict]:
        session = self.get_current_session()
        if not session:
            return None
        
        try:
            props = await session.try_get_media_properties_async()
            timeline = session.get_timeline_properties()
            playback = session.get_playback_info()
            
            if not props:
                return None
                
            title = props.title or "Unknown Title"
            artist = props.artist or "Unknown Artist"
            album = props.album_title or ""

            # Duration and Position
            duration = timeline.end_time.total_seconds() if timeline and timeline.end_time else 0.0
            position = timeline.position.total_seconds() if timeline and timeline.position else 0.0
            
            # Playback status: 4 is Playing, 5 is Paused
            # 0: Closed, 1: Opened, 2: Changing, 3: Stopped, 4: Playing, 5: Paused
            status = playback.playback_status if playback else 0
            is_paused = (status != 4)
            
            source_app = session.source_app_user_model_id or "Unknown Source"
            
            return {
                "title": title,
                "artist": artist,
                "album": album,
                "duration": duration,
                "position": position,
                "is_paused": is_paused,
                "source_app": source_app
            }
        except Exception as e:
            print(f"Error reading track info: {e}")
            return None

    async def send_control(self, command: str) -> bool:
        """Sends a playback control command to the active media session."""
        session = self.get_current_session()
        if not session:
            return False
        try:
            if command == "playpause":
                return await session.try_toggle_play_pause_async()
            if command == "next":
                return await session.try_skip_next_async()
            if command == "previous":
                return await session.try_skip_previous_async()
        except Exception as e:
            print(f"Error sending media control '{command}': {e}")
        return False

    async def seek_to(self, position_seconds: float) -> bool:
        """Seeks the active media session to the given position (if the player allows it)."""
        session = self.get_current_session()
        if not session:
            return False
        try:
            ticks = int(position_seconds * 10_000_000)  # 100ns units
            return await session.try_change_playback_position_async(ticks)
        except Exception as e:
            print(f"Error seeking to {position_seconds:.1f}s: {e}")
            return False

    async def get_thumbnail_bytes(self, expected_title: str = None):
        """Reads the current session's thumbnail (the exact artwork the player shows) into bytes.
        Returns None if unavailable, or if the session's title no longer matches expected_title
        (guards against reading the previous track's stale artwork)."""
        session = self.get_current_session()
        if not session:
            return None
        try:
            props = await session.try_get_media_properties_async()
            if not props or not props.thumbnail:
                return None
            if expected_title and (props.title or "") != expected_title:
                return None
            stream = await props.thumbnail.open_read_async()
            if not stream or stream.size == 0:
                return None
            from winrt.windows.storage.streams import DataReader
            reader = DataReader(stream)
            await reader.load_async(stream.size)
            buffer = reader.read_buffer(stream.size)
            return bytes(buffer)
        except Exception as e:
            print(f"Error reading media thumbnail: {e}")
            return None

    def get_current_position(self) -> Optional[Dict]:
        """Fast method to only poll position and playing status without async calls."""
        session = self.get_current_session()
        if not session:
            return None
        try:
            timeline = session.get_timeline_properties()
            playback = session.get_playback_info()
            
            position = timeline.position.total_seconds() if timeline and timeline.position else 0.0
            duration = timeline.end_time.total_seconds() if timeline and timeline.end_time else 0.0
            status = playback.playback_status if playback else 0
            is_paused = (status != 4)
            source_app = session.source_app_user_model_id or "Unknown Source"
            
            return {
                "position": position,
                "duration": duration,
                "is_paused": is_paused,
                "source_app": source_app
            }
        except Exception as e:
            # Silent fallback if session is transiently unavailable
            return None
