"""
Real-time Audio Analyzer — WASAPI Loopback Bass/Kick Detection
With targeted application audio session isolation using pycaw.

Captures system audio output and filters out sound from unwanted applications
(like Discord, system alerts, etc.) by validating the active music source volume.
"""

import threading
import time
import traceback
import warnings
import sys

# Force MTA COM initialization before comtypes is imported to prevent Thread Mode conflicts
if not hasattr(sys, 'coinit_flags'):
    sys.coinit_flags = 0  # COINIT_MULTITHREADED

# Suppress annoying soundcard discontinuity warnings that pollute the console

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

    def get_bass_energy(self) -> float:
        """Returns the current bass energy level (0.0 - 1.0)."""
        with self._lock:
            return self._bass_energy

    def get_kick_intensity(self) -> float:
        """Returns the current kick/onset transient intensity (0.0 - 1.0).
        Resets to 0 after reading so each kick is consumed once."""
        with self._lock:
            val = self._kick_intensity
            self._kick_intensity = 0.0
            return val

    def _get_target_session_peak(self, pycaw_utilities, target_keyword):
        """Finds target audio session and queries its current peak volume level."""
        try:
            sessions = pycaw_utilities.AudioUtilities.GetAllSessions()
            for session in sessions:
                if session.Process and target_keyword in session.Process.name().lower():
                    # Return target application's active volume level (0.0 to 1.0)
                    meter = session.AudioMeterInformation
                    if meter:
                        return meter.GetPeakValue()
        except Exception:
            pass
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

        try:
            while self._running:
                # 1. Fetch target app name
                with self._app_lock:
                    target_app = self._target_app_keyword

                # 2. Query target application's specific volume level
                target_peak = self._get_target_session_peak(pcw, target_app)

                if target_peak is not None:
                    # Adaptive Peak normalizer for target_peak
                    if target_peak > self._peak_bass:
                        self._peak_bass = target_peak
                    else:
                        self._peak_bass = self._peak_bass * 0.985 + target_peak * 0.015
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

                    with self._lock:
                        self._bass_energy = float(normalized)
                        if kick > self._kick_intensity:
                            self._kick_intensity = float(kick)
                else:
                    # Target app silent or not found
                    with self._lock:
                        self._bass_energy *= 0.8
                        self._kick_intensity *= 0.8

                time.sleep(0.016)  # ~60 FPS polling

        except Exception as e:
            print(f"[AudioAnalyzer] Error in PyCaw loop: {e}")
            traceback.print_exc()
        finally:
            try:
                comtypes.CoUninitialize()
            except Exception:
                pass
