let socket = null;
let lyrics = [];
let currentIndex = -1;
let currentTrack = null;
let lyricOffset = 0.0;
let isLoadingLyrics = false;
let isLyricsNotFound = false;

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
    blur: true,
    fsTransition: 'fade'
};

let activeFsMediaIndex = -1;

function mediaServerUrl(filePath) {
    if (!filePath) return null;
    if (/^(https?:|data:)/i.test(filePath)) return filePath;
    return `http://127.0.0.1:8766/?path=${encodeURIComponent(filePath)}`;
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
    const url = mediaServerUrl(path);
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
        this.fsContainer = document.getElementById('fs-lyric-container');
        
        this.wordNodes = [];
        this.fsWordNodes = [];
    }

    setLyrics(lyricsData) {
        this.lyrics = lyricsData || [];
        this.currentIndex = -1;
        if(this.historyEl) this.historyEl.textContent = "";
        if(this.currentEl) this.currentEl.textContent = "";
        if(this.fsContainer) this.fsContainer.textContent = "";
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
            if(this.currentEl) this.currentEl.textContent = "";
            if(this.fsContainer) this.fsContainer.textContent = "";
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
            if (line.intensity && line.intensity.level === 3 || line.text.includes('(')) {
                this.fsContainer.classList.add('climax-text');
                const fsBackground = document.getElementById('fs-background');
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

        if (!line.words || line.words.length === 0) {
            let t = line.text.trim();
            if (isCaps) t = t.toUpperCase();
            if(this.currentEl) this.currentEl.textContent = t;
            if(this.fsContainer) this.fsContainer.textContent = t;
        } else {
            for (let i = 0; i < line.words.length; i++) {
                const w = line.words[i];
                let wt = w.text;
                if (isCaps) wt = wt.toUpperCase();

                if (this.currentEl) {
                    const span = document.createElement('span');
                    span.className = 'lyric-char';
                    span.textContent = wt;
                    this.currentEl.appendChild(span);
                    
                    this.wordNodes.push({
                        el: span,
                        time: w.time,
                        active: false
                    });
                }

                if (this.fsContainer) {
                    const fsSpan = document.createElement('span');
                    fsSpan.className = 'fs-char';
                    fsSpan.textContent = wt;
                    this.fsContainer.appendChild(fsSpan);
                    this.fsWordNodes.push({
                        el: fsSpan,
                        time: w.time,
                        active: false
                    });
                }
            }
        }
        
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
                wNode.el.className = isActive ? 'lyric-char active' : 'lyric-char';
                
                if (this.fsWordNodes[i]) {
                    this.fsWordNodes[i].active = isActive;
                    this.fsWordNodes[i].el.className = isActive ? 'fs-char active' : 'fs-char';
                }
            }
        }
    }
}

const lyricEngine = new LyricEngine();

function connectWebSocket() {
    socket = new WebSocket("ws://localhost:8765");
    
    socket.onopen = () => {
        statusSource.innerText = "Status: Online (Waiting)";
        console.log("Connected to Python backend.");
        if (typeof sendSettings === 'function') sendSettings();
    };

    socket.onclose = () => {
        statusSource.innerText = "Status: Offline";
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
            if (msg.kick > 0.0) {
                currentKickIntensity = msg.kick;
            }
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
    statusSource.innerText = `Source: ${data.source_app.split('.').pop()}`;
    statusBpm.innerText = `BPM: ${Math.round(data.bpm)}`;
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

function loadCoverColor(base64Data) {
    const img = new Image();
    img.onload = () => {
        try {
            // Use a tiny canvas to extract the average color of the album cover
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            canvas.width = 1;
            canvas.height = 1;
            
            ctx.drawImage(img, 0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ action: "log", message: `Frontend Extracted Colors - R:${r} G:${g} B:${b}` }));
            }
            
            // Export raw RGB and a solid core color for UI usage
            document.documentElement.style.setProperty('--fs-color-rgb', `${r}, ${g}, ${b}`);
            document.documentElement.style.setProperty('--fs-color-core', `rgb(${r}, ${g}, ${b})`);
            
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
    document.body.className = "";
    
    let intensityLabel = "CALM";
    
    // Reset element styles
    notepadWindow.style.animationDuration = "";
    editorContainer.style.animationDuration = "";
    
    // Update CSS custom variable for beat pulsating
    const beatDuration = 60.0 / bpm;
    document.documentElement.style.setProperty('--beat-duration', `${beatDuration}s`);
    
    if (level === 0) {
        document.body.className = "theme-calm";
        intensityLabel = "AMBIENT";
    } else if (level === 1) {
        document.body.className = "theme-calm";
        intensityLabel = "NORMAL";
    } else if (level === 2) {
        document.body.className = "theme-energetic";
        intensityLabel = "ENERGETIC";
    } else if (level === 3) {
        document.body.className = "theme-dramatic";
        intensityLabel = "DRAMATIC";
        
        // Reset overrides and rely on CSS beat-duration variables
        notepadWindow.style.animationDuration = "";
        editorContainer.style.animationDuration = "";
    }
    
    if (statusIntensity) {
        statusIntensity.innerText = intensityLabel;
    }
}

// Hook up sync button
const syncBtn = document.getElementById('sync-btn');
if (syncBtn) {
    syncBtn.addEventListener('click', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: "force_sync" }));
            
            // Visual feedback
            const originalText = syncBtn.innerText;
            syncBtn.innerText = "🔄 Syncing...";
            syncBtn.style.opacity = "0.7";
            setTimeout(() => {
                syncBtn.innerText = originalText;
                syncBtn.style.opacity = "1";
            }, 800);
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

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        settingsModal.style.display = 'flex';
    });
}

if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener('click', () => {
        settingsModal.style.display = 'none';
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
    }
});

settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.style.display = 'none';
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
        mediaEditorModal.style.display = 'none';
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
        timeSpan.className = 'time';
        timeSpan.innerText = `[${m}:${s}]`;
        
        const textSpan = document.createElement('span');
        textSpan.className = 'text';
        textSpan.innerText = line.text;
        textSpan.title = line.text;
        
        const pathSpan = document.createElement('span');
        pathSpan.className = 'media-path';
        pathSpan.innerText = line.media ? line.media.split(/[\\/]/).pop() : 'No Media';
        if (line.media) pathSpan.title = line.media;
        
        const addBtn = document.createElement('button');
        addBtn.innerText = '📷 Select Media';
        addBtn.onclick = async () => {
            if (window.pywebview && window.pywebview.api) {
                const result = await window.pywebview.api.pick_media_file();
                if (result) {
                    lyrics[index].media = result;
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            action: "set_line_media",
                            index: index,
                            media_path: result
                        }));
                    }
                    renderMediaEditorList();
                }
            }
        };
        
        row.appendChild(timeSpan);
        row.appendChild(textSpan);
        row.appendChild(pathSpan);
        row.appendChild(addBtn);
        
        if (line.media) {
            const clearBtn = document.createElement('button');
            clearBtn.innerText = '✕';
            clearBtn.className = 'clear-btn';
            clearBtn.onclick = () => {
                delete lyrics[index].media;
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        action: "clear_line_media",
                        index: index
                    }));
                }
                renderMediaEditorList();
            };
            row.appendChild(clearBtn);
        }
        
        mediaEditorList.appendChild(row);
    });
}
