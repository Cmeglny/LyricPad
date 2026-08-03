let socket = null;
let lyrics = [];
let currentIndex = -1;
let currentTrack = null;
let lyricOffset = 0.0;
let isLoadingLyrics = false;
let isLyricsNotFound = false;

// Per-track cover memory: lets us restore artwork instantly when a recently played
// track comes back (e.g. after another app briefly steals the media session)
let currentTrackKey = null;
let displayedCoverKey = null;
const coverCache = {};
const coverCacheKeys = [];
const COVER_CACHE_LIMIT = 15;

// UI Elements
const tabTitle = document.getElementById('tab-title');
const lyricsHistory = document.getElementById('lyrics-history');
const currentLineSpan = document.getElementById('current-line-span');
const editorContainer = document.getElementById('editor-container');
const lyricsDisplay = document.getElementById('lyrics-display');
const lyricsEditor = document.getElementById('lyrics-editor');
const editorList = document.getElementById('editor-list');
const notepadWindow = document.getElementById('app-container');
let isEditing = false;
const editBtn = document.getElementById('edit-lyrics-btn');
const saveEditBtn = document.getElementById('save-edit-btn');
const cancelBtn = document.getElementById('cancel-edit-btn');

const editMediaBtn = document.getElementById('edit-media-btn');
const mediaEditorModal = document.getElementById('media-editor-modal');
const mediaEditorCloseBtn = document.getElementById('media-editor-close-btn');
const mediaEditorList = document.getElementById('media-editor-list');

// Fullscreen Elements
let isFullscreen = false;
const fsOverlay = document.getElementById('fullscreen-overlay');
const fsBackground = document.getElementById('fs-background');
const fsLyricContainer = document.getElementById('fs-lyric-container');
const fsBtnMenu = document.getElementById('fs-btn-menu');
const fsExitBtn = document.getElementById('fs-exit-btn');

// Fullscreen now-playing / progress elements
const fsCover = document.getElementById('fs-cover');
const fsTitle = document.getElementById('fs-title');
const fsArtist = document.getElementById('fs-artist');
const fsTimeCurrent = document.getElementById('fs-time-current');
const fsTimeTotal = document.getElementById('fs-time-total');
const fsProgressFill = document.getElementById('fs-progress-fill');
const fsProgressBar = document.getElementById('fs-progress');
const fsPlayBtn = document.getElementById('fs-play-btn');
const fsPrevBtn = document.getElementById('fs-prev-btn');
const fsNextBtn = document.getElementById('fs-next-btn');
let lastFsSecond = -1;
let lastFsPlayState = null;

function sendMediaControl(cmd) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "media_control", command: cmd }));
    }
}

function sendSeek(positionSec) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "seek", position: positionSec }));
    }
}

if (fsPlayBtn) fsPlayBtn.addEventListener('click', () => sendMediaControl('playpause'));
if (fsPrevBtn) fsPrevBtn.addEventListener('click', () => sendMediaControl('previous'));
if (fsNextBtn) fsNextBtn.addEventListener('click', () => sendMediaControl('next'));

if (fsProgressBar) {
    fsProgressBar.addEventListener('click', (e) => {
        const dur = currentTrack && currentTrack.duration ? currentTrack.duration : 0;
        if (dur <= 0) return;
        const rect = fsProgressBar.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const target = frac * dur;
        sendSeek(target);
        localTime = target;  // optimistic UI update; backend confirms via position broadcast
        lastFrameTime = performance.now();
    });
}

function formatTime(seconds) {
    if (!seconds || seconds < 0 || !isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateFsUi() {
    const dur = currentTrack && currentTrack.duration ? currentTrack.duration : 0;
    if (fsProgressFill) {
        const frac = dur > 0 ? Math.min(1, Math.max(0, localTime / dur)) : 0;
        fsProgressFill.style.transform = `scaleX(${frac.toFixed(4)})`;
    }
    const curSec = Math.floor(localTime);
    if (curSec !== lastFsSecond && fsTimeCurrent) {
        lastFsSecond = curSec;
        fsTimeCurrent.innerText = formatTime(localTime);
    }
    // Cover glow and lyric glow breathe with the live bass energy
    if (fsOverlay) {
        fsOverlay.style.setProperty('--fs-glow', smoothBassEnergy.toFixed(3));
    }
    // Play/pause button reflects the actual playback state
    if (fsPlayBtn && lastFsPlayState !== isPaused) {
        lastFsPlayState = isPaused;
        fsPlayBtn.innerText = isPaused ? '▶' : '⏸';
    }
}

// Status Bar Elements
const statusSource = document.getElementById('status-source');
const statusIntensity = document.getElementById('status-intensity');
const statusBpm = document.getElementById('status-bpm');

const fsVideoBg = document.getElementById('fs-video-bg');
const fsImgBg = document.getElementById('fs-img-bg');
const fsMediaOverlay = document.getElementById('fs-media-overlay');

let appSettings = {
    typewriter: true,
    popups: true,
    shake: true,
    shakeIntensity: 100,  // percent: 10-150
    blur: true,
    fsTransition: 'fade'
};

let activeFsMediaIndex = -1;

function mediaServerUrl(filePath, mediaUrl) {
    if (mediaUrl) return mediaUrl;
    if (!filePath) return null;
    if (/^(https?:|data:)/i.test(filePath)) return filePath;
    return null;
}

function clearFsMedia() {
    if (fsVideoBg) {
        fsVideoBg.pause();
        fsVideoBg.removeAttribute('src');
        fsVideoBg.style.display = 'none';
    }
    if (fsImgBg) {
        fsImgBg.removeAttribute('src');
        fsImgBg.style.display = 'none';
    }
    if (fsMediaOverlay) {
        fsMediaOverlay.style.display = 'none';
    }
    if (fsOverlay) {
        fsOverlay.classList.remove('has-active-media');
    }
}

function applyFsMediaTransition(el) {
    if (!el) return;
    const preset = appSettings.fsTransition || 'fade';
    el.classList.remove(
        'fade-enter', 'fade-enter-active',
        'flash-enter', 'flash-enter-active',
        'cut-enter', 'slide-enter', 'slide-enter-active'
    );
    void el.offsetWidth;
    if (preset === 'fade') {
        el.classList.add('fade-enter');
        requestAnimationFrame(() => el.classList.add('fade-enter-active'));
    } else if (preset === 'flash') {
        el.classList.add('flash-enter');
        requestAnimationFrame(() => el.classList.add('flash-enter-active'));
    } else if (preset === 'slide') {
        el.classList.add('slide-enter');
        requestAnimationFrame(() => el.classList.add('slide-enter-active'));
    } else {
        el.classList.add('cut-enter');
    }
}

function handleFsMediaChange(lineIndex) {
    if (!isFullscreen) return;
    if (lineIndex === activeFsMediaIndex) return;
    activeFsMediaIndex = lineIndex;

    if (lineIndex < 0 || !lyrics[lineIndex] || !lyrics[lineIndex].media) {
        clearFsMedia();
        return;
    }

    const path = lyrics[lineIndex].media;
    const url = mediaServerUrl(path, lyrics[lineIndex].media_url);
    if (!url) {
        clearFsMedia();
        return;
    }

    const ext = (path.split('.').pop() || '').toLowerCase();
    const isVideo = ['mp4', 'webm', 'mov', 'mkv'].includes(ext);

    clearFsMedia();

    if (isVideo && fsVideoBg) {
        fsVideoBg.src = url;
        fsVideoBg.style.display = 'block';
        fsVideoBg.play().catch(() => {});
        applyFsMediaTransition(fsVideoBg);
    } else if (fsImgBg) {
        fsImgBg.src = url;
        fsImgBg.style.display = 'block';
        applyFsMediaTransition(fsImgBg);
    }

    if (fsMediaOverlay) {
        fsMediaOverlay.style.display = 'block';
    }
    if (fsOverlay) {
        fsOverlay.classList.add('has-active-media');
    }
}

function initEqualizerCanvas() {
    const equalizer = document.getElementById('equalizer');
    if (!equalizer || document.getElementById('eq-canvas')) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'eq-canvas';
    canvas.width = 280;
    canvas.height = 40;
    equalizer.appendChild(canvas);
}

let mainHistoryText = "";

// ── Clean Lyric Engine ──
class LyricEngine {
    constructor() {
        this.lyrics = [];
        this.currentIndex = -1;
        
        this.historyEl = document.getElementById('lyrics-history');
        this.currentEl = document.getElementById('current-line-span');
        this.nextEl = document.getElementById('lyrics-next');
        this.fsContainer = document.getElementById('fs-lyric-container');
        this.fsPrevEl = document.getElementById('fs-lyric-prev');
        this.fsNextEl = document.getElementById('fs-lyric-next');
        
        this.wordNodes = [];
        this.fsWordNodes = [];
    }

    setLyrics(lyricsData) {
        this.lyrics = lyricsData || [];
        this.currentIndex = -1;
        if(this.historyEl) this.historyEl.textContent = "";
        if(this.currentEl) this.currentEl.textContent = "";
        if(this.nextEl) this.nextEl.textContent = "";
        if(this.fsContainer) this.fsContainer.textContent = "";
        if(this.fsPrevEl) this.fsPrevEl.textContent = "";
        if(this.fsNextEl) this.fsNextEl.textContent = "";
        this.wordNodes = [];
        this.fsWordNodes = [];
    }

    update(time) {
        if (!this.lyrics.length) {
            if (currentTrack && !isPaused && !currentTrack.plain_lyrics && !isLoadingLyrics && !isLyricsNotFound) {
                if (this.currentEl.textContent !== '♪') {
                    this.currentEl.textContent = '♪';
                }
            } else if (isLoadingLyrics) {
                if (this.currentEl.innerHTML.indexOf('ARANIYOR') === -1) {
                    this.currentEl.innerHTML = `<span style="color: var(--accent-primary); opacity: 0.8; animation: blink 1s step-end infinite;">⏳ ŞARKI SÖZLERİ ARANIYOR...</span>`;
                }
            } else if (isLyricsNotFound) {
                if (this.currentEl.innerHTML.indexOf('BULUNAMADI') === -1) {
                    this.currentEl.innerHTML = `<span style="color: var(--text-muted); opacity: 0.6;">❌ ŞARKI SÖZLERİ BULUNAMADI</span>`;
                }
            } else if (currentTrack && currentTrack.plain_lyrics) {
                // Let plain lyrics be handled by the track change
            } else {
                if (this.currentEl.textContent !== '') {
                    this.currentEl.textContent = "";
                }
            }
            return;
        }

        // Find current line index
        let newIndex = -1;
        for (let i = 0; i < this.lyrics.length; i++) {
            if (time >= this.lyrics[i].time) {
                newIndex = i;
            } else {
                break;
            }
        }

        if (newIndex !== this.currentIndex) {
            this.changeLine(newIndex);
        }

        this.updateWordHighlights(time);
    }

    changeLine(index) {
        this.currentIndex = index;
        currentIndex = index; // Keep global in sync for other usages (e.g. EQ intensity, FS media)
        
        if (index === -1) {
            if(this.historyEl) this.historyEl.textContent = "";
            if(this.nextEl) this.nextEl.textContent = "";
            if(this.fsPrevEl) this.fsPrevEl.textContent = "";
            if(this.fsNextEl) this.fsNextEl.textContent = "";
            if (this.lyrics.length > 0) {
                // Intro before the first lyric line — show the pulsing note
                if(this.currentEl) this.currentEl.innerHTML = '<span class="instrumental-note">♪</span>';
                if(this.fsContainer) this.fsContainer.innerHTML = '<span class="instrumental-note">♪</span>';
            } else {
                if(this.currentEl) this.currentEl.textContent = "";
                if(this.fsContainer) this.fsContainer.textContent = "";
            }
            this.wordNodes = [];
            this.fsWordNodes = [];
            if (typeof handleFsMediaChange === 'function') handleFsMediaChange(-1);
            return;
        }

        // 1. Build History (Only keep last 5 lines to prevent massive memory allocations over time)
        if (this.historyEl) {
            this.historyEl.innerHTML = '';
            const startIdx = Math.max(0, index - 5);
            for (let i = startIdx; i < index; i++) {
                let t = this.lyrics[i].text.trim();
                if (this.lyrics[i].intensity && this.lyrics[i].intensity.is_caps) t = t.toUpperCase();
                if (t) {
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'history-line';
                    lineDiv.textContent = t;
                    this.historyEl.appendChild(lineDiv);
                }
            }
        }

        // 2. Build Current Line
        const line = this.lyrics[index];
        const isCaps = line.intensity && line.intensity.is_caps;
        const lineEndTime = line.time + (line.duration || 3.0);
        
        if(this.currentEl) this.currentEl.innerHTML = "";
        if(this.fsContainer) {
            this.fsContainer.innerHTML = "";
            if ((line.intensity && line.intensity.level === 3) || line.text.includes('(')) {
                this.fsContainer.classList.add('climax-text');
                if (fsBackground) {
                    fsBackground.classList.add('climax-flash');
                    setTimeout(() => fsBackground.classList.remove('climax-flash'), 150);
                }
            } else {
                this.fsContainer.classList.remove('climax-text');
            }
        }
        
        this.wordNodes = [];
        this.fsWordNodes = [];

        const trimmedText = line.text.trim();
        if (!trimmedText) {
            // Instrumental gap marker in the LRC — show a pulsing note instead of a blank hole
            if (this.currentEl) this.currentEl.innerHTML = '<span class="instrumental-note">♪</span>';
            if (this.fsContainer) this.fsContainer.innerHTML = '<span class="instrumental-note">♪</span>';
        } else if (!line.words || line.words.length === 0) {
            let t = trimmedText;
            if (isCaps) t = t.toUpperCase();
            if(this.currentEl) this.currentEl.textContent = t;
            if(this.fsContainer) this.fsContainer.textContent = t;
        } else {
            for (let i = 0; i < line.words.length; i++) {
                const w = line.words[i];
                let wt = w.text;
                if (isCaps) wt = wt.toUpperCase();

                // Calculate dynamic fill duration based on the timestamp difference:
                // the fill should complete right when the next word starts, tracking the vocalist
                let duration = 0.3;
                if (i < line.words.length - 1) {
                    duration = line.words[i+1].time - w.time;
                } else if (i > 0) {
                    duration = Math.min(2.0, w.time - line.words[i-1].time);
                }
                duration = Math.max(0.1, Math.min(duration, 3.0));
                const transitionStyle = `background-position ${duration.toFixed(2)}s linear`;

                if (this.currentEl) {
                    const span = document.createElement('span');
                    span.className = 'lyric-char';
                    span.style.transition = transitionStyle;
                    span.textContent = wt;
                    this.currentEl.appendChild(span);

                    this.wordNodes.push({
                        el: span,
                        time: w.time,
                        duration: duration,
                        transitionStyle: transitionStyle,
                        active: false
                    });
                }

                if (this.fsContainer) {
                    const fsSpan = document.createElement('span');
                    fsSpan.className = 'fs-char';
                    fsSpan.style.transition = transitionStyle;
                    fsSpan.textContent = wt;
                    this.fsContainer.appendChild(fsSpan);
                    this.fsWordNodes.push({
                        el: fsSpan,
                        time: w.time,
                        duration: duration,
                        transitionStyle: transitionStyle,
                        active: false
                    });
                }
            }

            // Force a style flush so the freshly inserted spans get their unfilled state
            // computed BEFORE any 'active' class lands. Without this, the first word's
            // fill transition is skipped and it appears instantly filled.
            if (this.currentEl) void this.currentEl.offsetWidth;
            if (this.fsContainer) void this.fsContainer.offsetWidth;
        }

        // Soft slide-up entrance for the new active line (main + fullscreen)
        if (this.currentEl) {
            this.currentEl.classList.remove('line-in');
            void this.currentEl.offsetWidth;
            this.currentEl.classList.add('line-in');
        }
        if (this.fsContainer) {
            this.fsContainer.classList.remove('line-in');
            void this.fsContainer.offsetWidth;
            this.fsContainer.classList.add('line-in');
        }
        
        // 3. Build upcoming lines below the active lyric
        if (this.nextEl) {
            this.nextEl.innerHTML = '';
            const endIdx = Math.min(this.lyrics.length, index + 6);
            for (let i = index + 1; i < endIdx; i++) {
                let nextText = this.lyrics[i].text.trim();
                if (!nextText) continue;
                const nextIntensity = this.lyrics[i].intensity;
                if (nextIntensity && nextIntensity.is_caps) {
                    nextText = nextText.toUpperCase();
                }

                const lineDiv = document.createElement('div');
                lineDiv.className = 'next-line';
                lineDiv.textContent = nextText;
                this.nextEl.appendChild(lineDiv);
            }
        }

        // 4. Fullscreen context: previous line above, next two lines below
        if (this.fsPrevEl) {
            let prevText = "";
            for (let i = index - 1; i >= 0; i--) {
                const t = this.lyrics[i].text.trim();
                if (t) { prevText = t; break; }
            }
            this.fsPrevEl.textContent = prevText;
        }
        if (this.fsNextEl) {
            this.fsNextEl.innerHTML = '';
            let added = 0;
            for (let i = index + 1; i < this.lyrics.length && added < 2; i++) {
                const t = this.lyrics[i].text.trim();
                if (!t) continue;
                const div = document.createElement('div');
                div.className = 'fs-next-line';
                div.textContent = t;
                this.fsNextEl.appendChild(div);
                added++;
            }
        }

        // Trigger media loading for full screen mode
        if (typeof handleFsMediaChange === 'function') handleFsMediaChange(index);
    }

    updateWordHighlights(time) {
        if (this.currentIndex === -1) return;
        const line = this.lyrics[this.currentIndex];
        if (!line.words || line.words.length === 0) return;

        if (!appSettings.typewriter) {
            for (let i = 0; i < this.wordNodes.length; i++) {
                if (!this.wordNodes[i].active) {
                    this.wordNodes[i].active = true;
                    this.wordNodes[i].el.className = 'lyric-char active';
                    if (this.fsWordNodes[i]) {
                        this.fsWordNodes[i].active = true;
                        this.fsWordNodes[i].el.className = 'fs-char active';
                    }
                }
            }
            return;
        }

        for (let i = 0; i < this.wordNodes.length; i++) {
            const wNode = this.wordNodes[i];
            const isActive = time >= wNode.time;

            if (wNode.active !== isActive) {
                wNode.active = isActive;
                // If playback is already far past this word (seek / late join),
                // fill it instantly instead of slowly animating a stale word
                const fillInstantly = isActive && (time - wNode.time) > (wNode.duration + 0.2);
                this._applyWordState(wNode, 'lyric-char', isActive, fillInstantly);

                if (this.fsWordNodes[i]) {
                    this.fsWordNodes[i].active = isActive;
                    this._applyWordState(this.fsWordNodes[i], 'fs-char', isActive, fillInstantly);
                }
            }
        }
    }

    _applyWordState(wNode, baseClass, isActive, instant) {
        if (instant) {
            wNode.el.style.transition = 'none';
            wNode.el.className = `${baseClass} active`;
            void wNode.el.offsetWidth;
            wNode.el.style.transition = wNode.transitionStyle;
        } else {
            wNode.el.className = isActive ? `${baseClass} active` : baseClass;
        }
    }
}

const lyricEngine = new LyricEngine();

function prettySourceName(sourceApp) {
    // Turns raw AUMIDs like "SpotifyMusic_zpdnekdrzrea0!Spotify" into a friendly app name
    if (!sourceApp) return "Unknown";
    const s = sourceApp.toLowerCase();
    if (s.includes("spotify")) return "Spotify";
    if (s.includes("ytmusic") || s.includes("youtubemusic")) return "YouTube Music";
    if (s.includes("brave")) return "Brave";
    if (s.includes("chrome")) return "Chrome";
    if (s.includes("msedge") || s.includes("edge")) return "Edge";
    if (s.includes("firefox")) return "Firefox";
    if (s.includes("opera")) return "Opera";
    if (s.includes("vlc")) return "VLC";
    if (s.includes("applemusic") || s.includes("itunes")) return "Apple Music";
    if (s.includes("system")) return "System";
    // Fallback: take the segment after '!' (AUMID app id) or the last dotted segment, strip hashes
    let name = sourceApp.split('!').pop().split('.').pop();
    name = name.replace(/_.*$/, '').replace(/\.exe$/i, '');
    return name || sourceApp;
}

function connectWebSocket() {
    socket = new WebSocket("ws://localhost:8765");

    socket.onopen = () => {
        statusSource.innerText = "Waiting for music...";
        statusSource.classList.remove('offline');
        console.log("Connected to Python backend.");
        if (typeof sendSettings === 'function') sendSettings();
    };

    socket.onclose = () => {
        statusSource.innerText = "Offline";
        statusSource.classList.add('offline');
        console.log("Disconnected. Reconnecting in 2s...");
        setTimeout(connectWebSocket, 2000);
    };

    socket.onerror = (err) => {
        console.error("Socket error:", err);
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "track") {
            handleTrackChange(msg);
        } else if (msg.type === "lyrics_loading") {
            isLoadingLyrics = true;
            isLyricsNotFound = false;
            lyrics = [];
            lyricsHistory.textContent = "";
            currentLineSpan.innerHTML = `<span style="color: var(--accent-primary); opacity: 0.8;">⏳ ŞARKI SÖZLERİ ARANIYOR...</span>`;
        } else if (msg.type === "position") {
            handlePositionUpdate(msg.position, msg.is_paused);
        } else if (msg.type === "offset") {
            handleOffsetBroadcast(msg.offset);
        } else if (msg.type === "audio") {
            currentBassEnergy = msg.bass;
            currentKickIntensity = msg.kick || 0.0;
        } else if (msg.type === "cover_ready") {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ action: "log", message: "Frontend received cover_ready websocket message. Loading image..." }));
            }
            loadCoverColor(msg.base64);
        }
    };
}

function handleTrackChange(data) {
    // Exit edit mode if active on track change
    if (isEditing) {
        isEditing = false;
        if (lyricsDisplay) lyricsDisplay.style.display = "flex";
        if (lyricsEditor) lyricsEditor.style.display = "none";
        const equalizer = document.getElementById('equalizer');
        if (equalizer) equalizer.style.display = "flex";
    }

    currentTrack = data;
    lyrics = data.lyrics || [];
    currentIndex = -1;
    lyricOffset = data.offset || 0.0;
    
    isLoadingLyrics = false;
    isLyricsNotFound = (lyrics.length === 0 && !data.plain_lyrics && data.title !== "Untitled");
    
    // Clear previous timeout if any
    if (window.coverTimeout) clearTimeout(window.coverTimeout);

    currentTrackKey = `${data.artist}|${data.title}`;

    if (data.cover) {
        // Payload already carries the cover (reconnect or late lyrics load) — apply it directly
        // instead of arming the clear-timer, which would wipe the background to black.
        loadCoverColor(data.cover);
    } else if (coverCache[currentTrackKey]) {
        // We already have this track's cover from earlier in the session — restore instantly
        loadCoverColor(coverCache[currentTrackKey]);
    } else if (currentTrackKey === displayedCoverKey) {
        // Same track re-broadcast without a cover — keep what's on screen
    } else {
        // Wait 4 seconds for the new cover. If it doesn't arrive, then clear the old one.
        // This allows a smooth crossfade if the cover arrives quickly.
        window.coverTimeout = setTimeout(() => {
            const appBg = document.getElementById('app-background');
            if (appBg) appBg.style.backgroundImage = '';
            const trackCover = document.getElementById('track-cover');
            if (trackCover) {
                trackCover.removeAttribute('src');
                trackCover.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            }
            if (fsBackground) {
                fsBackground.style.background = '';
            }
        }, 4000);
    }
    
    // Update Title and Info
    const filename = `${data.artist} - ${data.title}`;
    if (tabTitle) tabTitle.innerText = filename;
    document.title = `${filename} - LyricPad`;
    
    // Set Fullscreen Background Color (Deterministic based on title+artist hash)
    const hashString = `${data.artist}-${data.title}`;
    let hash = 0;
    for (let i = 0; i < hashString.length; i++) {
        hash = hashString.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    const saturation = 60 + Math.abs((hash >> 2) % 30); // 60-90%
    const lightness = 45 + Math.abs((hash >> 4) % 15); // 45-60%
    document.documentElement.style.setProperty('--fs-color-core', `hsla(${hue}, ${saturation}%, ${lightness}%, 0.25)`);
    
    // Status info
    statusSource.innerText = prettySourceName(data.source_app);
    statusBpm.innerText = `${Math.round(data.bpm)} BPM`;

    // Fullscreen now-playing card
    if (fsTitle) fsTitle.innerText = data.title || "—";
    if (fsArtist) fsArtist.innerText = data.artist || "—";
    if (fsTimeTotal) fsTimeTotal.innerText = formatTime(data.duration || 0);
    lastFsSecond = -1;
    updateOffsetDisplay();
    
    lyricEngine.setLyrics(lyrics);
    
    activeFsMediaIndex = -1;
    clearFsMedia();
    
    // Reset displays
    if (data.plain_lyrics) {
        mainHistoryText = data.plain_lyrics;
        if(lyricsHistory) lyricsHistory.textContent = mainHistoryText;
        if(currentLineSpan) currentLineSpan.innerHTML = `<span style="color: var(--text-muted); opacity: 0.6; font-size: 0.85em;">(Senkronize söz bulunamadı, düz metin gösteriliyor)</span>`;
    }
    
    updateTheme(1, data.bpm); // Start with neutral theme
    updateEqualizerState();
}

function extractDominantColor(img) {
    const SAMPLE = 32;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;

    const buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let avgR = 0, avgG = 0, avgB = 0, count = 0, colorful = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        avgR += r; avgG += g; avgB += b; count++;

        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const l = (mx + mn) / 510;
        const d = mx - mn;
        const s = d === 0 ? 0 : d / (255 - Math.abs(mx + mn - 255));
        // Skip gray, near-black and near-white pixels — they never read as "the cover's color"
        if (s < 0.18 || l < 0.12 || l > 0.92) continue;
        colorful++;

        let h;
        if (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h = Math.round(h * 60);
        if (h < 0) h += 360;

        const bi = Math.floor(h / 15) % 24;
        const w = s * (1 - Math.abs(l - 0.5)); // favor saturated, mid-lightness pixels
        buckets[bi].w += w;
        buckets[bi].r += r * w;
        buckets[bi].g += g * w;
        buckets[bi].b += b * w;
    }

    let r, g, b;
    const best = buckets.reduce((a, c) => (c.w > a.w ? c : a), { w: 0 });
    if (best.w > 0 && colorful > count * 0.04) {
        r = Math.round(best.r / best.w);
        g = Math.round(best.g / best.w);
        b = Math.round(best.b / best.w);
    } else {
        // Mostly monochrome cover — fall back to the average
        r = Math.round(avgR / count);
        g = Math.round(avgG / count);
        b = Math.round(avgB / count);
    }
    return clampColorForText(r, g, b);
}

function clampColorForText(r, g, b) {
    // RGB -> HSL, clamp lightness/saturation so the fill stays readable on the dark UI
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
    let h, s, l = (mx + mn) / 2;
    if (mx === mn) { h = 0; s = 0; }
    else {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        switch (mx) {
            case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
            case gn: h = (bn - rn) / d + 2; break;
            default: h = (rn - gn) / d + 4;
        }
        h /= 6;
    }
    l = Math.min(0.72, Math.max(0.5, l));
    if (s > 0.05) s = Math.max(0.45, Math.min(0.9, s));

    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    let R, G, B;
    if (s === 0) { R = G = B = l; }
    else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        R = hue2rgb(p, q, h + 1 / 3);
        G = hue2rgb(p, q, h);
        B = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(R * 255), Math.round(G * 255), Math.round(B * 255)];
}

function loadCoverColor(base64Data) {
    const img = new Image();
    img.onload = () => {
        if (window.coverTimeout) clearTimeout(window.coverTimeout);

        // Remember this cover for the current track (bounded FIFO cache)
        if (currentTrackKey) {
            if (!(currentTrackKey in coverCache)) {
                coverCacheKeys.push(currentTrackKey);
                if (coverCacheKeys.length > COVER_CACHE_LIMIT) {
                    delete coverCache[coverCacheKeys.shift()];
                }
            }
            coverCache[currentTrackKey] = base64Data;
            displayedCoverKey = currentTrackKey;
        }

        // Set App Background (The new glassmorphism background)
        const appBg = document.getElementById('app-background');
        if (appBg) {
            appBg.style.backgroundImage = `url('${base64Data}')`;
        }
        
        // Set track cover image
        const trackCover = document.getElementById('track-cover');
        if (trackCover) {
            trackCover.src = base64Data;
        }
        if (fsCover) {
            fsCover.src = base64Data;
        }

        try {
            // Extract the DOMINANT color of the album cover (not the muddy average):
            // downsample, skip gray/too-dark/too-bright pixels, bucket by hue and pick
            // the heaviest bucket, then clamp lightness for text readability.
            const [r, g, b] = extractDominantColor(img);

            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ action: "log", message: `Frontend Extracted Colors - R:${r} G:${g} B:${b}` }));
            }
            
            // Export raw RGB and a solid core color for UI usage
            document.documentElement.style.setProperty('--fs-color-rgb', `${r}, ${g}, ${b}`);
            document.documentElement.style.setProperty('--fs-color-core', `rgb(${r}, ${g}, ${b})`);

            // Share the dominant color with the backend so climax popups match the song
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ action: "set_accent", rgb: [r, g, b] }));
            }
            
            // Optional: embed the blurred cover into the background for richer texture
            if (fsBackground) {
                fsBackground.style.background = `radial-gradient(circle at center, rgba(${r}, ${g}, ${b}, 0.5) 0%, transparent 60%), url('${base64Data}')`;
                fsBackground.style.backgroundSize = "cover";
                fsBackground.style.backgroundPosition = "center";
            }
        } catch (e) {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ action: "log", message: `Frontend Canvas Error: ${e.toString()}` }));
            }
            // Fallback: set the fsBackground without the color gradient
            if (fsBackground) {
                fsBackground.style.background = `url('${base64Data}')`;
                fsBackground.style.backgroundSize = "cover";
                fsBackground.style.backgroundPosition = "center";
            }
        }
    };
    img.onerror = (e) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: "log", message: "Frontend Image Load Error" }));
        }
    };
    img.src = base64Data;
}

function updateOffsetDisplay() {
    const statusOffset = document.getElementById('status-offset');
    if (statusOffset) {
        const sign = lyricOffset > 0 ? "+" : "";
        statusOffset.innerText = `${sign}${lyricOffset.toFixed(1)}s`;
    }
}

// High-Resolution Clock State
let localTime = 0.0;
let lastFrameTime = performance.now();
let isPaused = true;

// Equalizer State Variables
let barHeights = [];

// Real-time Audio Analysis State (from Python PyCaw peak monitoring)
let currentBassEnergy = 0.0;
let smoothBassEnergy = 0.0;
let currentActiveThemeLevel = -1;
let currentKickIntensity = 0.0;

// Dynamic intensity peak-hold state to prevent rapid UI theme flickering
let smoothedIntensityLevel = 1;
let intensityHoldTimer = 0.0;

// Canvas Equalizer Logic
const NUM_BARS = 30;
let eqLevels = Array(NUM_BARS).fill(0.1);
let eqVelY = Array(NUM_BARS).fill(0);
let eqScaleY = Array(NUM_BARS).fill(0.075);
const EQ_SPRING_K = 220.0;
const EQ_DAMPING = 0.85;

function createEqualizerBars() {
    // Left empty for compatibility, canvas doesn't need bar generation
}

// Starts continuous clock monitoring at 60 FPS
function clockTick(now) {
    const delta = (now - lastFrameTime) / 1000.0;
    
    if (!isPaused && !isEditing) {
        localTime += delta;
        
        const adjustedTime = localTime + lyricOffset;
        
        // 1. Clean Lyric Engine update
        lyricEngine.update(adjustedTime);
        
        // 2. Update beat-reactive equalizer bars and spring physics
        animateEqualizer(localTime, delta);
    } else {
        // Run physics decay even when paused so the window returns to rest smoothly
        animateEqualizer(localTime, delta);
    }
    // 3. Fullscreen progress bar, elapsed time and cover glow
    if (isFullscreen) updateFsUi();
    lastFrameTime = now;
    requestAnimationFrame(clockTick);
}
requestAnimationFrame(clockTick);

function updateEqualizerState() {
    // Empty for compatibility, canvas handles pause state internally
}

function animateEqualizer(time, dt = 0.016) {
    const canvas = document.getElementById('eq-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    
    // Smooth the real-time bass energy first: fast attack (instant), smooth decay
    if (currentBassEnergy > smoothBassEnergy) {
        smoothBassEnergy = currentBassEnergy;
    } else {
        smoothBassEnergy = smoothBassEnergy * 0.82 + currentBassEnergy * 0.18;
    }
    
    const bpm = currentTrack ? currentTrack.bpm : 120.0;
    const beatDuration = 60.0 / bpm;
    const elapsedBeats = time / beatDuration;
    
    // Calculate primary kick beat pulse (exponential decay)
    const beatFraction = elapsedBeats % 1.0;
    const beatPulse = Math.exp(-5.0 * beatFraction);
    
    // Calculate off-beat snare pulse (out of phase)
    const snareFraction = (elapsedBeats + 0.5) % 1.0;
    const snarePulse = Math.exp(-6.0 * snareFraction);
    
    // Determine target intensity level
    let rawLevel = 1;
    if (currentTrack) {
        const activeLine = lyrics[currentIndex];
        rawLevel = (activeLine && activeLine.intensity) ? activeLine.intensity.level : 1;
        
        if (smoothBassEnergy > 0.55) {
            rawLevel = 3;
        } else if (smoothBassEnergy > 0.30) {
            rawLevel = Math.max(rawLevel, 2);
        }
    }
    
    // Apply Peak-Hold logic
    const INTENSITY_HOLD_DURATION = 3.2;
    if (rawLevel > smoothedIntensityLevel) {
        smoothedIntensityLevel = rawLevel;
        intensityHoldTimer = INTENSITY_HOLD_DURATION;
    } else if (rawLevel < smoothedIntensityLevel) {
        intensityHoldTimer -= dt;
        if (intensityHoldTimer <= 0) {
            smoothedIntensityLevel = rawLevel;
        }
    } else {
        if (rawLevel === smoothedIntensityLevel && rawLevel > 1) {
            intensityHoldTimer = INTENSITY_HOLD_DURATION;
        }
    }
    
    let intensityLevel = smoothedIntensityLevel;
    
    if (currentTrack) {
        updateTheme(intensityLevel, bpm);
    }
    
    // Determine color template based on intensity
    let colorR, colorG, colorB, colorBaseA, colorDynA;
    if (intensityLevel === 3) {
        colorR = 236; colorG = 72; colorB = 153; colorBaseA = 0.4; colorDynA = 0.6;
    } else if (intensityLevel === 2) {
        colorR = 6; colorG = 182; colorB = 212; colorBaseA = 0.4; colorDynA = 0.6;
    } else {
        colorR = 255; colorG = 255; colorB = 255; colorBaseA = 0.3; colorDynA = 0.5;
    }
    
    // Clear Canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const barWidth = 6;
    const gap = 4;
    const totalWidth = NUM_BARS * barWidth + (NUM_BARS - 1) * gap;
    const startX = (canvas.width - totalWidth) / 2;
    
    for (let i = 0; i < NUM_BARS; i++) {
        const x_ratio = i / NUM_BARS;
        const wave1 = Math.sin(x_ratio * Math.PI * 4 + time * 5.0) * 0.5 + 0.5;
        const wave2 = Math.cos(x_ratio * Math.PI * 7 - time * 3.0) * 0.5 + 0.5;
        const ripple = (wave1 * 0.6 + wave2 * 0.4);
        
        const eqIntensity = Math.max(0.05, smoothBassEnergy * ripple + beatPulse * 0.2 + snarePulse * 0.15);
        
        let targetScale = isPaused ? 0.075 : 0.075 + eqIntensity * 0.925;
        
        // Physics update
        const force = (targetScale - eqScaleY[i]) * EQ_SPRING_K;
        eqVelY[i] += force * dt;
        eqVelY[i] *= EQ_DAMPING;
        eqScaleY[i] += eqVelY[i] * dt;
        eqScaleY[i] = Math.max(0.075, Math.min(1.0, eqScaleY[i]));
        
        const barHeight = eqScaleY[i] * 40;
        const x = startX + i * (barWidth + gap);
        const y = 40 - barHeight;
        
        // Draw bar using roundRect if available, otherwise fallback to fillRect
        ctx.fillStyle = `rgba(${colorR}, ${colorG}, ${colorB}, ${(colorBaseA + eqIntensity * colorDynA).toFixed(2)})`;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(x, y, barWidth, barHeight, 3);
        } else {
            ctx.fillRect(x, y, barWidth, barHeight);
        }
        ctx.fill();
    }
    
    // FULLSCREEN BACKGROUND EXPLOSION LOGIC
    if (isFullscreen && fsBackground && !isPaused) {
        if (currentKickIntensity > 0.05 || smoothBassEnergy > 0.6) {
            fsBackground.classList.add('explode');
            setTimeout(() => {
                fsBackground.classList.remove('explode');
            }, 150);
            
            // Reduced explosion spawning: max 1 per 500ms, single particle only
            const now = performance.now();
            if (!window._lastExplosionTime || now - window._lastExplosionTime > 500) {
                window._lastExplosionTime = now;
                if (Math.random() > 0.3 && typeof spawnRandomExplosion === 'function') {
                    spawnRandomExplosion();
                }
            }
        }
    }

    if (appSettings.shake && notepadWindow && !isPaused && smoothBassEnergy > 0.35) {
        const amt = smoothBassEnergy * 5;
        notepadWindow.style.transform = `translate(${(Math.random() - 0.5) * amt}px, ${(Math.random() - 0.5) * amt}px)`;
    } else if (notepadWindow) {
        notepadWindow.style.transform = '';
    }
}

function spawnRandomExplosion() {
    const particle = document.createElement('div');
    particle.className = 'random-explosion';
    const x = 10 + Math.random() * 80;
    const y = 10 + Math.random() * 80;
    particle.style.left = `${x}vw`;
    particle.style.top = `${y}vh`;
    
    const size = 10 + Math.random() * 30; // 10vw to 40vw width
    particle.style.width = `${size}vw`;
    particle.style.height = `${size}vw`;
    
    const fsBg = document.getElementById('fs-background');
    if (fsBg && fsBg.parentElement) {
        fsBg.parentElement.insertBefore(particle, fsBg.nextSibling);
    }
    
    setTimeout(() => {
        if (particle.parentElement) particle.remove();
    }, 2000);
}

// Reduced occasional random light balls — only 1 per 2 seconds to prevent DOM churn
setInterval(() => {
    const overlay = document.getElementById('fullscreen-overlay');
    if (overlay && overlay.style.display !== 'none' && !isPaused && Math.random() > 0.4) {
        spawnRandomExplosion();
    }
}, 2000);

function handlePositionUpdate(position, is_paused) {
    // Backend only sends this when necessary (on seek or state change), so unconditionally accept the authoritative update.
    localTime = position;
    isPaused = is_paused;
    lastFrameTime = performance.now();
    
    const adjustedTime = localTime + lyricOffset;
    lyricEngine.update(adjustedTime);
    updateEqualizerState();
}

// === END LYRIC ENGINE REWRITE ===

function updateTheme(level, bpm) {
    if (level === currentActiveThemeLevel) return;
    currentActiveThemeLevel = level;
    
    // Remove all themes
    document.body.classList.remove('theme-calm', 'theme-energetic', 'theme-dramatic');
    
    let intensityLabel = "CALM";
    
    // Reset element styles
    notepadWindow.style.animationDuration = "";
    editorContainer.style.animationDuration = "";
    
    // Update CSS custom variable for beat pulsating
    const beatDuration = 60.0 / bpm;
    document.documentElement.style.setProperty('--beat-duration', `${beatDuration}s`);
    
    if (level === 0) {
        document.body.classList.add("theme-calm");
        intensityLabel = "AMBIENT";
    } else if (level === 1) {
        document.body.classList.add("theme-calm");
        intensityLabel = "NORMAL";
    } else if (level === 2) {
        document.body.classList.add("theme-energetic");
        intensityLabel = "ENERGETIC";
    } else if (level === 3) {
        document.body.classList.add("theme-dramatic");
        intensityLabel = "DRAMATIC";
        
        // Reset overrides and rely on CSS beat-duration variables
        notepadWindow.style.animationDuration = "";
        editorContainer.style.animationDuration = "";
    }
    
    if (statusIntensity) {
        statusIntensity.innerText = intensityLabel;
        statusIntensity.classList.remove('level-energetic', 'level-dramatic');
        if (level === 2) statusIntensity.classList.add('level-energetic');
        else if (level === 3) statusIntensity.classList.add('level-dramatic');
    }
}

// Hook up sync button
const syncBtn = document.getElementById('sync-btn');
if (syncBtn) {
    syncBtn.addEventListener('click', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: "force_sync" }));
            
            // Visual feedback
            const spanEl = syncBtn.querySelector('span');
            if (spanEl) {
                const originalText = spanEl.innerText;
                spanEl.innerText = "Syncing...";
                syncBtn.style.opacity = "0.7";
                setTimeout(() => {
                    spanEl.innerText = originalText;
                    syncBtn.style.opacity = "1";
                }, 800);
            }
        }
        
        // Force clock to start running if it was stuck due to GSMTC false-pause bug
        isPaused = false;
        const equalizer = document.getElementById('equalizer');
        if (equalizer) equalizer.classList.remove('paused');
    });
}

// Start connection
initEqualizerCanvas();
createEqualizerBars();
connectWebSocket();

function handleOffsetBroadcast(offset) {
    lyricOffset = offset;
    updateOffsetDisplay();
}

function adjustOffset(amount) {
    lyricOffset += amount;
    // Limit between -30s and +30s to support large gaps (e.g. album/radio edits)
    lyricOffset = Math.max(-30.0, Math.min(30.0, lyricOffset));
    updateOffsetDisplay();
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            action: "set_offset",
            offset: lyricOffset
        }));
    }
}

// Hook up offset buttons
const decBtn = document.getElementById('offset-dec-btn');
const incBtn = document.getElementById('offset-inc-btn');

if (decBtn) {
    decBtn.addEventListener('click', (e) => {
        const amt = e.shiftKey ? -2.0 : -0.5;
        adjustOffset(amt);
    });
}
if (incBtn) {
    incBtn.addEventListener('click', (e) => {
        const amt = e.shiftKey ? 2.0 : 0.5;
        adjustOffset(amt);
    });
}

// Render Lyrics Timing Editor
function renderLyricsEditor() {
    if (!editorList) return;
    editorList.innerHTML = '';
    
    if (!lyrics || lyrics.length === 0) {
        editorList.innerHTML = '<div style="padding: 20px; color: var(--text-muted);">No synced lyrics available to edit.</div>';
        return;
    }
    
    lyrics.forEach((line, index) => {
        const row = document.createElement('div');
        row.className = 'editor-row';
        
        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.className = 'time-input';
        
        // Format to mm:ss.xx
        const m = Math.floor(line.time / 60).toString().padStart(2, '0');
        const s = (line.time % 60).toFixed(2).padStart(5, '0');
        timeInput.value = `${m}:${s}`;
        
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'text-input';
        textInput.value = line.text;
        
        row.appendChild(timeInput);
        row.appendChild(textInput);
        editorList.appendChild(row);
    });
}

// Hook up Edit Lyrics Button
if (editBtn) {
    editBtn.addEventListener('click', () => {
        if (!currentTrack) return;
        
        if (!isEditing) {
            // Enter Edit Mode
            isEditing = true;
            
            // Toggle view
            if (lyricsDisplay) lyricsDisplay.style.display = "none";
            if (lyricsEditor) lyricsEditor.style.display = "flex";
            
            renderLyricsEditor();
            
            // Hide equalizer
            const equalizer = document.getElementById('equalizer');
            if (equalizer) equalizer.style.display = "none";
        }
    });
}

if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
        isEditing = false;
        
        if (lyricsDisplay) lyricsDisplay.style.display = "flex";
        if (lyricsEditor) lyricsEditor.style.display = "none";
        
        // Show equalizer
        const equalizer = document.getElementById('equalizer');
        if (equalizer) equalizer.style.display = "flex";
    });
}

if (saveEditBtn) {
    saveEditBtn.addEventListener('click', () => {
        if (!editorList) return;
        
        // Parse rows
        const rows = editorList.querySelectorAll('.editor-row');
        let newLrcContent = "";
        
        rows.forEach(row => {
            const timeVal = row.querySelector('.time-input').value; // e.g. 01:23.45
            const textVal = row.querySelector('.text-input').value;
            newLrcContent += `[${timeVal}] ${textVal}\n`;
        });
        
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                action: "save_lyrics",
                lyrics: newLrcContent
            }));
        }
        
        // Exit edit mode
        isEditing = false;
        if (lyricsDisplay) lyricsDisplay.style.display = "flex";
        if (lyricsEditor) lyricsEditor.style.display = "none";
        
        const equalizer = document.getElementById('equalizer');
        if (equalizer) equalizer.style.display = "flex";
    });
}

// Hook up keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || isEditing) {
        return;
    }
    if (e.key === '[') {
        const amt = e.shiftKey ? -2.0 : -0.5;
        adjustOffset(amt);
    } else if (e.key === ']') {
        const amt = e.shiftKey ? 2.0 : 0.5;
        adjustOffset(amt);
    }
});

// --- Settings Modal Logic ---
const settingsModal = document.getElementById('settings-modal');
const settingsBtn = document.getElementById('settings-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');

function loadSettings() {
    const saved = localStorage.getItem('lyricsNotepadSettings');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            appSettings = { ...appSettings, ...parsed };
        } catch(e) {}
    }
    
    // Update DOM toggles
    document.getElementById('setting-typewriter').checked = appSettings.typewriter;
    document.getElementById('setting-popups').checked = appSettings.popups;
    document.getElementById('setting-shake').checked = appSettings.shake;
    document.getElementById('setting-blur').checked = appSettings.blur;
    const transitionSelect = document.getElementById('setting-fs-transition');
    if (transitionSelect) transitionSelect.value = appSettings.fsTransition || 'fade';
    const intensitySlider = document.getElementById('setting-shake-intensity');
    if (intensitySlider) {
        intensitySlider.value = appSettings.shakeIntensity;
        const label = document.getElementById('shake-intensity-value');
        if (label) label.innerText = `${appSettings.shakeIntensity}%`;
    }
    
    applyClientSettings();
    sendSettings();
}

function saveSettings() {
    localStorage.setItem('lyricsNotepadSettings', JSON.stringify(appSettings));
    applyClientSettings();
    sendSettings();
}

function applyClientSettings() {
    if (appSettings.blur) {
        document.body.classList.remove('no-blur');
    } else {
        document.body.classList.add('no-blur');
    }
}

function sendSettings() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            action: "settings",
            settings: {
                popups: appSettings.popups,
                shake: appSettings.shake,
                shake_intensity: (appSettings.shakeIntensity || 100) / 100.0,
            }
        }));
    }
}

// Bind toggles
['typewriter', 'popups', 'shake', 'blur'].forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) {
        el.addEventListener('change', (e) => {
            appSettings[key] = e.target.checked;
            saveSettings();
        });
    }
});

const transitionSelect = document.getElementById('setting-fs-transition');
if (transitionSelect) {
    transitionSelect.addEventListener('change', (e) => {
        appSettings.fsTransition = e.target.value;
        saveSettings();
    });
}

const shakeIntensitySlider = document.getElementById('setting-shake-intensity');
if (shakeIntensitySlider) {
    shakeIntensitySlider.addEventListener('input', (e) => {
        appSettings.shakeIntensity = parseInt(e.target.value, 10) || 100;
        const label = document.getElementById('shake-intensity-value');
        if (label) label.innerText = `${appSettings.shakeIntensity}%`;
        saveSettings();
    });
}

function closeModalWithAnimation(modal) {
    modal.classList.add('closing');
    setTimeout(() => {
        modal.style.display = 'none';
        modal.classList.remove('closing');
    }, 300);
}

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        settingsModal.style.display = 'flex';
    });
}

if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener('click', () => {
        closeModalWithAnimation(settingsModal);
    });
}

// --- Fullscreen Logic ---
let mouseTimeout;
function hideMouse() {
    if (isFullscreen) {
        document.body.style.cursor = 'none';
        fsExitBtn.style.opacity = '0';
    }
}

function handleMouseMove() {
    if (!isFullscreen) return;
    document.body.style.cursor = 'default';
    fsExitBtn.style.opacity = '1';
    clearTimeout(mouseTimeout);
    mouseTimeout = setTimeout(hideMouse, 2000);
}

function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    
    if (isFullscreen) {
        activeFsMediaIndex = -1;
        handleFsMediaChange(currentIndex);
    } else {
        activeFsMediaIndex = -1;
        clearFsMedia();
    }
    // Notify python backend to block climax popups while in fullscreen
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "set_fullscreen", state: isFullscreen }));
    }
    
    // Call python backend to toggle windowless fullscreen
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.toggle_fullscreen();
    }
    
    if (isFullscreen) {
        fsOverlay.style.display = 'flex';
        // Small delay to allow display to apply before opacity transition
        setTimeout(() => fsOverlay.style.opacity = '1', 10);
        
        // Setup mouse hide listener
        document.addEventListener('mousemove', handleMouseMove);
        mouseTimeout = setTimeout(hideMouse, 2000);
    } else {
        fsOverlay.style.opacity = '0';
        setTimeout(() => fsOverlay.style.display = 'none', 500);
        
        // Remove mouse hide listener
        document.removeEventListener('mousemove', handleMouseMove);
        clearTimeout(mouseTimeout);
        document.body.style.cursor = 'default';
        fsExitBtn.style.opacity = '1';
    }
}

if (fsBtnMenu) {
    fsBtnMenu.addEventListener('click', toggleFullscreen);
}

if (fsExitBtn) {
    fsExitBtn.addEventListener('click', () => {
        if (isFullscreen) toggleFullscreen();
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen) {
        toggleFullscreen();
        return;
    }
    // Fullscreen media shortcuts: Space = play/pause, arrows = seek ±5s
    if (!isFullscreen || isEditing) return;
    if (e.code === 'Space') {
        e.preventDefault();
        sendMediaControl('playpause');
    } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault();
        const dur = currentTrack && currentTrack.duration ? currentTrack.duration : 0;
        if (dur > 0) {
            const target = Math.min(dur, Math.max(0, localTime + (e.code === 'ArrowRight' ? 5 : -5)));
            sendSeek(target);
            localTime = target;
            lastFrameTime = performance.now();
        }
    }
});

settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        closeModalWithAnimation(settingsModal);
    }
});

mediaEditorModal.addEventListener('click', (e) => {
    if (e.target === mediaEditorModal) {
        closeModalWithAnimation(mediaEditorModal);
    }
});

loadSettings();

// --- Media Editor Modal Logic ---
if (editMediaBtn) {
    editMediaBtn.addEventListener('click', () => {
        if (!lyrics || lyrics.length === 0) {
            alert("No lyrics available to edit media for.");
            return;
        }
        renderMediaEditorList();
        mediaEditorModal.style.display = 'flex';
    });
}

if (mediaEditorCloseBtn) {
    mediaEditorCloseBtn.addEventListener('click', () => {
        closeModalWithAnimation(mediaEditorModal);
    });
}

function renderMediaEditorList() {
    mediaEditorList.innerHTML = '';
    lyrics.forEach((line, index) => {
        const row = document.createElement('div');
        row.className = 'media-row';
        
        const m = Math.floor(line.time / 60).toString().padStart(2, '0');
        const s = (line.time % 60).toFixed(2).padStart(5, '0');
        
        const timeSpan = document.createElement('span');
        timeSpan.className = 'media-row-time';
        timeSpan.innerText = `[${m}:${s}]`;
        
        const textSpan = document.createElement('span');
        textSpan.className = 'media-row-text';
        textSpan.innerText = line.text;
        textSpan.title = line.text;
        
        const pathSpan = document.createElement('span');
        pathSpan.className = 'media-status';
        pathSpan.innerText = line.media ? line.media.split(/[\\/]/).pop() : 'No Media';
        if (line.media) pathSpan.title = line.media;
        
        const addBtn = document.createElement('button');
        addBtn.className = line.media ? 'media-btn has-media' : 'media-btn';
        addBtn.innerHTML = '🎬 <span>Select Media</span>';
        addBtn.onclick = async () => {
            if (window.pywebview && window.pywebview.api) {
                const result = await window.pywebview.api.pick_media_file();
                if (result) {
                    const mediaPath = typeof result === 'string' ? result : result.path;
                    const mediaUrl = typeof result === 'string' ? null : result.url;
                    lyrics[index].media = mediaPath;
                    if (mediaUrl) lyrics[index].media_url = mediaUrl;
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            action: "set_line_media",
                            index: index,
                            media_path: mediaPath
                        }));
                    }
                    renderMediaEditorList();
                }
            }
        };
        
        row.appendChild(timeSpan);
        row.appendChild(textSpan);
        row.appendChild(pathSpan);
        
        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '8px';
        btnGroup.appendChild(addBtn);
        
        if (line.media) {
            const clearBtn = document.createElement('button');
            clearBtn.innerText = '✕';
            clearBtn.className = 'media-btn remove-media';
            clearBtn.onclick = () => {
                delete lyrics[index].media;
                delete lyrics[index].media_url;
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        action: "clear_line_media",
                        index: index
                    }));
                }
                renderMediaEditorList();
            };
            btnGroup.appendChild(clearBtn);
        }
        
        row.appendChild(btnGroup);
        mediaEditorList.appendChild(row);
    });
}
