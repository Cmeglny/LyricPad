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
                "duration": duration,
                "position": position,
                "is_paused": is_paused,
                "source_app": source_app
            }
        except Exception as e:
            print(f"Error reading track info: {e}")
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
