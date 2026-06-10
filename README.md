# 🎵 Lyrics Notepad (Antigravity-IDE Edition)

A highly dynamic, visually stunning, and interactive floating desktop lyrics widget for Windows. 
It seamlessly syncs with your currently playing music (Spotify, YouTube, etc.) and displays lyrics in an aesthetically pleasing transparent notepad window directly on your desktop.

## ✨ Features

- **Automatic Music Detection**: Hooks into Windows Global System Media Transport Controls (GSMTC) to automatically detect the current playing track, artist, and playback position from any app.
- **Dynamic Typing Animation**: The lyrics flow naturally, with the typing speed perfectly matching the singer's actual singing speed.
- **Real-time Audio Analysis**: Uses PyCaw to directly isolate the audio peak volume of your specific music player (filtering out Discord and system sounds) to create beautiful glowing effects that pulse to the kick and bass.
- **Dynamic Intensity Themes**: Automatically fetches BPM and song structure, categorizing lyrics into "Calm", "Build-up", and "Climax" sections with corresponding color themes (White, Neon Cyan, Crimson Red).
- **Ultimate Climax Popups**: During the most intense parts of the song, lyrics break out of the main window and explode across your screen in frameless, transparent popups with a dramatic glitch aesthetic.
- **Window Shaking**: The entire notepad window physically shakes during the heaviest bass drops.

## 🚀 Installation & Usage

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd lyrics-notepad
   ```

2. **Install dependencies:**
   Ensure you have Python 3.10+ installed.
   ```bash
   pip install -r requirements.txt
   ```

3. **Run the application:**
   ```bash
   python main.py
   ```

## 🛠️ Tech Stack & Architecture

- **Backend**: Python
  - `pywebview`: Creates the transparent, frameless desktop windows using WebView2 (Edge Chromium).
  - `websockets`: Provides low-latency, real-time communication between the Python backend and the JavaScript UI.
  - `winrt`: Accesses Windows native media session metadata and tracking.
  - `pycaw`: Interacts with the Windows Core Audio API to measure application-specific audio peak levels.
  - `syncedlyrics`: Fetches LRC formatted lyrics dynamically.
- **Frontend**: HTML5, Vanilla JavaScript, CSS3
  - Dynamic responsive layouts with Glassmorphism aesthetic.
  - Hardware-accelerated CSS animations (`requestAnimationFrame`) for completely smooth typing and glowing effects.

## 📁 Directory Structure

- `main.py` - Core application lifecycle, websocket server, and pywebview manager.
- `media_session.py` - Windows GSMTC interface wrapper.
- `audio_analyzer.py` - Real-time volume polling via PyCaw for visualizer data.
- `lyrics_provider.py` - LRCLIB fetcher and lyric processor.
- `bpm_provider.py` - BPM detection and lyric intensity/climax categorization logic.
- `web/` - Frontend assets (`index.html`, `app.js`, `style.css`, etc.)

## ⚠️ Notes

- This application is designed specifically for **Windows**.
- Make sure WebView2 Runtime is installed on your system (it comes pre-installed on modern Windows 10/11).
