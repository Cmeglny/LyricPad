"""
Real-time Audio Analyzer — PyCaw session peak monitoring for bass/kick detection.

Measures per-application audio peak levels via Windows Core Audio API (pycaw),
isolating the active music player from other system sounds.
"""

import threading
import time
import traceback
import warnings
import sys

# Force MTA COM initialization before comtypes is imported to prevent Thread Mode conflicts
if not hasattr(sys, 'coinit_flags'):
    sys.coinit_flags = 0  # COINIT_MULTITHREADED

# Suppress comtypes warnings that pollute the console

warnings.filterwarnings("ignore", message="data discontinuity in recording")


class AudioAnalyzer:
    """Captures system audio output and analyzes bass/kick energy in real-time.
    Uses pycaw to isolate only the target media source's audio output."""

    def __init__(self):
        self._bass_energy = 0.0        # Normalized bass energy (0.0 - 1.0)
        self._kick_intensity = 0.0     # Onset/transient strength (0.0 - 1.0)
        self._running = False
        self._thread = None
        self._lock = threading.Lock()
        self._available = False        # Whether audio capture started successfully

        # Target app tracking
        self._target_app_keyword = "spotify"
        self._app_lock = threading.Lock()

        # Internal analysis state
        self._smooth_bass = 0.0
        self._peak_bass = 0.001        # Adaptive normalization ceiling
        self._prev_energy = 0.0        # For onset detection
        self._last_kick_time = 0.0
        self._cached_meter = None
        self._last_session_check = 0
        self._last_error_msg = None
        self._envelope = 0.0           # Slow loudness envelope (~1.7s) for section detection
        self._env_fast = 0.0           # Fast envelope (~0.3s) for surge/explosion detection
        self._section_intensity = 0.0  # How loud the current SECTION is vs the song's loud parts (0-1)
        self._surge = 0.0              # Fast/slow envelope ratio: >1 means loudness is exploding upward

    @property
    def available(self) -> bool:
        """Whether the audio capture backend is running and producing data."""
        return self._available

    def start(self):
        """Start the background audio capture thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True, name="AudioAnalyzer")
        self._thread.start()

    def stop(self):
        """Stop the background audio capture thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)

    def set_target_app(self, app_name: str):
        """Sets target app keyword (e.g. 'spotify', 'brave', 'chrome') to isolate audio."""
        if not app_name:
            return
        keyword = app_name.lower()
        if "spotify" in keyword:
            keyword = "spotify"
        elif "brave" in keyword:
            keyword = "brave"
        elif "chrome" in keyword:
            keyword = "chrome"
        elif "edge" in keyword:
            keyword = "msedge"
        
        with self._app_lock:
            if self._target_app_keyword != keyword:
                print(f"[AudioAnalyzer] Target isolated app updated to: {keyword}")
                self._target_app_keyword = keyword
                # Invalidate the cached meter so the new target is picked up immediately
                self._cached_meter = None
                self._last_session_check = 0

    def get_bass_energy(self) -> float:
        """Returns the current bass energy level (0.0 - 1.0)."""
        with self._lock:
            return self._bass_energy

    def reset_adaptation(self):
        """Resets the adaptive loudness ceiling. Call on track change so a quiet song
        isn't measured against the previous loud song's ceiling."""
        with self._lock:
            self._peak_bass = 0.001
            self._prev_energy = 0.0
            self._envelope = 0.0
            self._env_fast = 0.0
            self._section_intensity = 0.0
            self._surge = 0.0

    def get_section_intensity(self) -> float:
        """Returns how intense the current SECTION of the song is (0.0-1.0), based on a
        slow loudness envelope relative to the track's loud parts. Quiet verses and
        calm passages read low; choruses and drops read high."""
        with self._lock:
            return self._section_intensity

    def get_surge(self) -> float:
        """Returns the fast/slow envelope ratio (~0-2). Values noticeably above 1.0 mean
        the loudness is exploding upward right now (a drop hitting, vocalist belting)."""
        with self._lock:
            return self._surge

    def get_kick_intensity(self) -> float:
        """Returns the current kick/onset transient intensity (0.0 - 1.0).
        Resets to 0 after reading so each kick is consumed once."""
        with self._lock:
            val = self._kick_intensity
            self._kick_intensity = 0.0
            return val

    def _log_error_once(self, msg: str):
        """Prints an error only when it changes, to avoid flooding the console at 60 FPS."""
        if msg != self._last_error_msg:
            self._last_error_msg = msg
            print(f"[AudioAnalyzer] {msg}")

    def _get_target_session_peak(self, pycaw_utilities, target_keyword):
        """Finds target audio session and queries its current peak volume level."""
        # Find and cache the meter if we don't have it, or check every 2 seconds
        now = time.time()
        if self._cached_meter is None or (now - self._last_session_check) > 2.0:
            self._last_session_check = now
            self._cached_meter = None
            try:
                sessions = pycaw_utilities.AudioUtilities.GetAllSessions()
                for session in sessions:
                    if session.Process and target_keyword in session.Process.name().lower():
                        # pycaw exposes no meter property on AudioSession; query the
                        # IAudioMeterInformation COM interface from the session control
                        try:
                            meter = session._ctl.QueryInterface(pycaw_utilities.IAudioMeterInformation)
                        except Exception as e:
                            self._log_error_once(f"meter query failed for '{target_keyword}': {e}")
                            meter = None
                        if meter:
                            self._cached_meter = meter
                            break
            except Exception as e:
                self._log_error_once(f"session enumeration failed: {e}")

        if self._cached_meter:
            try:
                return self._cached_meter.GetPeakValue()
            except Exception:
                self._cached_meter = None # In case the session dies
                return None
        return None

    def _capture_loop(self):
        """Main audio capture using PyCaw Session Peak (Isolates specific app audio)."""
        try:
            import comtypes
            from pycaw import pycaw as pcw
        except ImportError as e:
            print(f"[AudioAnalyzer] Missing dependency: {e}")
            return

        print(f"[AudioAnalyzer] Starting pycaw application-isolated audio peak monitoring.")
        self._available = True
        self._cached_meter = None
        self._last_session_check = 0

        try:
            while self._running:
                # 1. Fetch target app name
                with self._app_lock:
                    target_app = self._target_app_keyword

                # 2. Query target application's specific volume level
                target_peak = self._get_target_session_peak(pcw, target_app)

                if target_peak is not None:
                    # Adaptive Peak normalizer for target_peak: the ceiling rises instantly
                    # on loud peaks but decays slowly (~17s time constant), so quiet verses
                    # read as genuinely low energy instead of re-normalizing back to 1.0
                    if target_peak > self._peak_bass:
                        self._peak_bass = target_peak
                    else:
                        self._peak_bass = self._peak_bass * 0.999 + target_peak * 0.001
                    self._peak_bass = max(self._peak_bass, 0.0005)

                    normalized = min(1.0, target_peak / self._peak_bass)

                    # Noise gate
                    if target_peak < 0.0015:
                        normalized = 0.0

                    # Onset detection (Derivative of volume envelope)
                    onset = max(0.0, normalized - self._prev_energy)
                    self._prev_energy = normalized * 0.7 + self._prev_energy * 0.3

                    now = time.time()
                    kick = 0.0
                    if onset > 0.05 and (now - self._last_kick_time) > 0.06:
                        kick = min(1.0, onset * 6.0)
                        self._last_kick_time = now

                    # Slow section envelope: EMA over ~1.7s of the raw peak, compared
                    # against the adaptive ceiling — tells apart quiet verses from drops.
                    # The fast envelope (~0.3s) versus the slow one detects sudden
                    # loudness explosions (drops, belting vocals).
                    self._envelope = self._envelope * 0.99 + target_peak * 0.01
                    self._env_fast = self._env_fast * 0.95 + target_peak * 0.05
                    section = min(1.0, self._envelope / max(self._peak_bass * 0.8, 0.0005))
                    surge = min(2.0, self._env_fast / max(self._envelope, 0.0005))

                    with self._lock:
                        self._bass_energy = float(normalized)
                        self._section_intensity = float(section)
                        self._surge = float(surge)
                        if kick > self._kick_intensity:
                            self._kick_intensity = float(kick)
                else:
                    # Target app silent or not found
                    self._envelope *= 0.97
                    self._env_fast *= 0.95
                    with self._lock:
                        self._bass_energy *= 0.8
                        self._kick_intensity *= 0.8
                        self._section_intensity *= 0.95
                        self._surge *= 0.95

                time.sleep(0.016)  # ~60 FPS polling

        except Exception as e:
            print(f"[AudioAnalyzer] Error in PyCaw loop: {e}")
            traceback.print_exc()
        finally:
            try:
                comtypes.CoUninitialize()
            except Exception:
                pass
