let socket = null;
let lyrics = [];
let currentIndex = -1;
let currentTrack = null;
let lyricOffset = 0.0;

// UI Elements
const tabTitle = document.getElementById('tab-title');
const activeTrack = document.getElementById('active-track');
const lyricsHistory = document.getElementById('lyrics-history');
const currentLineSpan = document.getElementById('current-line-span');
const editorContainer = document.getElementById('editor-container');
const textarea = document.getElementById('notepad-textarea');
const notepadWindow = document.getElementById('notepad-window');
let isEditing = false;
const editBtn = document.getElementById('edit-lyrics-btn');
const cancelBtn = document.getElementById('cancel-edit-btn');
const editTextarea = document.getElementById('edit-textarea');

// Status Bar Elements
const statusSource = document.getElementById('status-source');
const statusIntensity = document.getElementById('status-intensity');
const statusBpm = document.getElementById('status-bpm');

let mainHistoryText = "";

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
        } else if (msg.type === "position") {
            handlePositionUpdate(msg.position, msg.is_paused);
        } else if (msg.type === "offset") {
            handleOffsetBroadcast(msg.offset);
        } else if (msg.type === "audio") {
            currentBassEnergy = msg.bass;
            if (msg.kick > 0.0) {
                currentKickIntensity = msg.kick;
            }
        }
    };
}

function handleTrackChange(data) {
    // Exit edit mode if active on track change
    if (isEditing) {
        isEditing = false;
        if (editBtn) editBtn.innerText = "✎ Edit Lyrics";
        if (cancelBtn) cancelBtn.style.display = "none";
        if (editTextarea) editTextarea.style.display = "none";
        if (textarea) textarea.style.display = "block";
        const equalizer = document.getElementById('equalizer');
        if (equalizer) equalizer.style.display = "flex";
    }

    currentTrack = data;
    lyrics = data.lyrics || [];
    currentIndex = -1;
    lyricOffset = data.offset || 0.0;
    
    // Update Title and Info
    const filename = `${data.artist} - ${data.title}.txt`;
    tabTitle.innerText = filename;
    document.title = `${filename} - Notepad`;
    activeTrack.innerText = `${data.artist} - ${data.title}`;
    
    // Status info
    statusSource.innerText = `Source: ${data.source_app.split('.').pop()}`;
    statusBpm.innerText = `BPM: ${Math.round(data.bpm)}`;
    updateOffsetDisplay();
    
    // Reset displays
    mainHistoryText = "";
    lyricsHistory.innerText = "";
    currentLineSpan.innerText = "";
    
    updateTheme(1, data.bpm); // Start with neutral theme
    updateEqualizerState();
}

// High-Resolution Clock State
let localTime = 0.0;
let lastFrameTime = performance.now();
let isPaused = true;

// Equalizer State Variables
let barHeights = [];

// Real-time Audio Analysis State (from Python WASAPI loopback)
let currentBassEnergy = 0.0;   // Raw bass energy from backend (0.0 - 1.0)
let smoothBassEnergy = 0.0;    // Smoothed bass energy for animations
let currentActiveThemeLevel = -1; // Tracking current UI visual theme level
let currentKickIntensity = 0.0;  // Real-time kick drum onset hit energy

// Spring-Mass-Damper Physics State for organic window movements
let springX = 0.0;
let springY = 0.0;
let springScale = 1.0;
let vx = 0.0;
let vy = 0.0;
let vScale = 0.0;

// Dynamic intensity peak-hold state to prevent rapid UI theme flickering
let smoothedIntensityLevel = 1;
let intensityHoldTimer = 0.0;

// Generate equalizer bars dynamically
function createEqualizerBars() {
    const equalizer = document.getElementById('equalizer');
    if (equalizer) {
        equalizer.innerHTML = "";
        const numBars = 60; // 60 bars spanning from left to right wall
        for (let i = 0; i < numBars; i++) {
            const bar = document.createElement('span');
            bar.className = 'eq-bar';
            equalizer.appendChild(bar);
        }
    }
}

// Starts continuous clock monitoring at 60 FPS
function clockTick(now) {
    const delta = (now - lastFrameTime) / 1000.0;
    
    if (!isPaused && !isEditing) {
        localTime += delta;
        
        const adjustedTime = localTime + lyricOffset;
        
        // 1. Sync lyrics based on current interpolated time
        checkLyricsSync(adjustedTime);
        
        // 2. Dynamic character-by-character word rendering
        renderCurrentLine(adjustedTime);
        
        // 3. Update beat-reactive equalizer bars and spring physics
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
    const equalizer = document.getElementById('equalizer');
    if (equalizer) {
        if (isPaused) {
            equalizer.classList.add('paused');
            // Reset all bars to flat height
            const bars = equalizer.children;
            for (let i = 0; i < bars.length; i++) {
                bars[i].style.height = "3px";
            }
            barHeights = [];
            // Reset main window dynamic styles when paused
            if (notepadWindow) {
                notepadWindow.style.transform = "";
                notepadWindow.style.borderColor = "";
                notepadWindow.style.boxShadow = "";
            }
            updateTheme(1, 120);
        } else {
            equalizer.classList.remove('paused');
        }
    }
}

function animateEqualizer(time, dt = 0.016) {
    const equalizer = document.getElementById('equalizer');
    if (!equalizer) return;
    
    // Physics coefficients for natural spring damping (Hooke's Law)
    const stiffness = 220.0;  // Spring tightness
    const damping = 15.0;     // Friction/damping factor to bring it to rest
    const simDt = Math.min(0.05, dt); // Cap dt to prevent simulation explosion on lag
    
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
    
    // Determine target intensity level based on active lyrics and real-time audio
    let rawLevel = 1;
    if (currentTrack) {
        const activeLine = lyrics[currentIndex];
        rawLevel = (activeLine && activeLine.intensity) ? activeLine.intensity.level : 1;
        
        // Boost level based on real-time bass energy
        if (smoothBassEnergy > 0.55) {
            rawLevel = 3;
        } else if (smoothBassEnergy > 0.30) {
            rawLevel = Math.max(rawLevel, 2);
        }
    }
    
    // Apply Peak-Hold logic: fast upgrade, slow decay to prevent theme flickering
    const INTENSITY_HOLD_DURATION = 3.2; // Keep theme active for 3.2 seconds
    if (rawLevel > smoothedIntensityLevel) {
        smoothedIntensityLevel = rawLevel;
        intensityHoldTimer = INTENSITY_HOLD_DURATION;
    } else if (rawLevel < smoothedIntensityLevel) {
        intensityHoldTimer -= simDt;
        if (intensityHoldTimer <= 0) {
            smoothedIntensityLevel = rawLevel; // Hold time expired, safe to drop
        }
    } else {
        if (rawLevel === smoothedIntensityLevel && rawLevel > 1) {
            intensityHoldTimer = INTENSITY_HOLD_DURATION; // Maintain timer on matches
        }
    }
    
    let intensityLevel = smoothedIntensityLevel;
    
    if (currentTrack) {
        // Dynamically update UI theme (calm, energetic, dramatic background etc)
        updateTheme(intensityLevel, bpm);
    }
    
    // If equalizer is paused, we skip generating heights, but we still run spring physics below
    const isPausedState = equalizer.classList.contains('paused');
    const bars = equalizer.children;
    const numBars = bars.length;
    
    if (!isPausedState && numBars > 0) {
        // Initialize heights array if needed
        if (barHeights.length !== numBars) {
            barHeights = Array(numBars).fill(3);
        }
        
        let maxHeight = 32;
        let levelScale = 0.35;
        if (intensityLevel === 0) {
            maxHeight = 22;
            levelScale = 0.15;
        } else if (intensityLevel === 2) {
            maxHeight = 45;
            levelScale = 0.65;
        } else if (intensityLevel === 3) {
            maxHeight = 65;
            levelScale = 1.0;
        }
        
        for (let i = 0; i < numBars; i++) {
            const progress = i / (numBars - 1);
            const bass = beatPulse * Math.max(0, 1.0 - progress * 1.8) * 0.8;
            const treble = snarePulse * Math.max(0, (progress - 0.2) * 1.3) * 0.5;
            const jitter = Math.random() * 0.22;
            
            let targetAmplitude = (bass + treble + jitter) * levelScale;
            targetAmplitude = Math.min(1.0, targetAmplitude);
            
            const targetHeight = 3 + targetAmplitude * maxHeight;
            barHeights[i] = barHeights[i] + (targetHeight - barHeights[i]) * 0.25;
            bars[i].style.height = `${barHeights[i]}px`;
        }
    }
    
    // SPRING PHYSICS SIMULATION (Organically shakes window on real kick drum hits)
    if (notepadWindow) {
        // Apply impulse force on kick onset hits (if music is playing)
        if (!isPausedState && currentKickIntensity > 0.08) {
            let impulseAmt = 40.0; // default displacement velocity
            let scaleImpulse = 0.06; // default scale expansion velocity
            
            if (intensityLevel === 2) {
                impulseAmt = 60.0;
                scaleImpulse = 0.12;
            } else if (intensityLevel === 3) {
                impulseAmt = 100.0;
                scaleImpulse = 0.24;
            }
            
            // Apply a sudden physical impulse in a random direction
            const angle = Math.random() * Math.PI * 2;
            const force = currentKickIntensity * impulseAmt;
            
            vx += Math.cos(angle) * force;
            vy += Math.sin(angle) * force;
            vScale += currentKickIntensity * scaleImpulse;
            
            currentKickIntensity = 0.0; // Consume the kick
        }
        
        // Simulate spring physics: acceleration = -stiffness * displacement - damping * velocity
        const ax = -stiffness * springX - damping * vx;
        const ay = -stiffness * springY - damping * vy;
        
        vx += ax * simDt;
        vy += ay * simDt;
        springX += vx * simDt;
        springY += vy * simDt;
        
        // Scale Spring physics (Resting length is 1.0)
        const aScale = -stiffness * (springScale - 1.0) - damping * vScale;
        vScale += aScale * simDt;
        springScale += vScale * simDt;
        
        // Clamp scale to prevent negative or extreme sizes
        const finalScale = Math.max(0.5, Math.min(1.8, springScale));
        
        // Render physical displacement transforms
        notepadWindow.style.transform = `scale(${finalScale}) translate(${springX}px, ${springY}px)`;
        
        // Dynamically adjust box shadow and border color based on physical scale & real bass energy
        const bass = smoothBassEnergy;
        if (intensityLevel === 3) {
            const r = Math.round(139 + (236 - 139) * bass);
            const g = Math.round(92 + (72 - 92) * bass);
            const b = Math.round(246 + (153 - 246) * bass);
            const glowOpacity = 0.1 + 0.35 * (finalScale - 1.0) + 0.1 * bass;
            const innerGlow = 0.03 + 0.05 * (finalScale - 1.0);
            notepadWindow.style.borderColor = `rgb(${r}, ${g}, ${b})`;
            notepadWindow.style.boxShadow = `0 0 45px rgba(${r}, ${g}, ${b}, ${glowOpacity}), inset 0 0 70px rgba(${r}, ${g}, ${b}, ${innerGlow})`;
        } else if (intensityLevel === 2) {
            const glowOpacity = 0.03 + 0.28 * (finalScale - 1.0) + 0.08 * bass;
            notepadWindow.style.borderColor = `rgba(6, 182, 212, ${0.12 + 0.22 * bass})`;
            notepadWindow.style.boxShadow = `0 0 35px rgba(6, 182, 212, ${glowOpacity})`;
        } else {
            // Calm/Ambient white pulse
            const glowOpacity = 0.01 + 0.1 * (finalScale - 1.0) + 0.03 * bass;
            notepadWindow.style.borderColor = `rgba(255, 255, 255, ${0.08 + 0.1 * bass})`;
            notepadWindow.style.boxShadow = `0 0 20px rgba(255, 255, 255, ${glowOpacity})`;
        }
    }
}

function handlePositionUpdate(position, is_paused) {
    // Backend only sends this when necessary (on seek or state change), so unconditionally accept the authoritative update.
    localTime = position;
    isPaused = is_paused;
    lastFrameTime = performance.now();
    
    const adjustedTime = localTime + lyricOffset;
    checkLyricsSync(adjustedTime);
    renderCurrentLine(adjustedTime);
    updateEqualizerState();
}

function checkLyricsSync(time) {
    if (!lyrics.length) return;
    
    let activeLineIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
        if (time >= lyrics[i].time) {
            activeLineIndex = i;
        } else {
            break;
        }
    }
    
    // Handle changes in active lyric line
    if (activeLineIndex !== currentIndex) {
        handleActiveLineChange(activeLineIndex);
    }
}

function handleActiveLineChange(activeLineIndex) {
    if (activeLineIndex === -1) {
        // Song just started or rewound before first line
        mainHistoryText = "";
        lyricsHistory.innerText = "";
        currentLineSpan.innerText = "";
        currentIndex = -1;
    } else if (activeLineIndex < currentIndex || activeLineIndex - currentIndex > 1) {
        // Major jump (user seeked backward or forward manually)
        
        // Rebuild history up to this line
        mainHistoryText = "";
        for (let i = 0; i <= activeLineIndex - 1; i++) {
            const line = lyrics[i];
            if (line.text.trim() !== "") {
                let lineText = line.text.trim();
                if (line.intensity && line.intensity.is_caps) {
                    lineText = lineText.toUpperCase();
                }
                mainHistoryText += lineText + "\n";
            }
        }
        lyricsHistory.innerText = mainHistoryText;
        
        currentIndex = activeLineIndex;
    } else {
        // Normal sequential progression
        
        // Save previous line to history
        if (currentIndex >= 0) {
            const prevLine = lyrics[currentIndex];
            if (prevLine.text.trim() !== "") {
                let lineText = prevLine.text.trim();
                if (prevLine.intensity && prevLine.intensity.is_caps) {
                    lineText = lineText.toUpperCase();
                }
                mainHistoryText += lineText + "\n";
            }
        }
        
        currentIndex = activeLineIndex;
        
        lyricsHistory.innerText = mainHistoryText;
    }
    
    // Auto scroll editor to bottom
    textarea.scrollTop = textarea.scrollHeight;
}

function renderCurrentLine(time) {
    if (currentIndex < 0 || (lyrics.length === 0)) {
        // Show musical note glyph during intro segments before the first lyric line starts
        if (currentTrack && !isPaused) {
            const beatPulseOpacity = Math.max(0.3, Math.min(1.0, 0.3 + (currentKickIntensity * 0.8) + (smoothBassEnergy * 0.6)));
            currentLineSpan.innerHTML = `<span style="opacity: ${beatPulseOpacity}; transition: opacity 0.05s ease;">♪</span>`;
        } else {
            currentLineSpan.innerText = "";
        }
        return;
    }
    if (currentIndex >= lyrics.length) {
        currentLineSpan.innerText = "";
        return;
    }
    
    const line = lyrics[currentIndex];
    const intensity = line.intensity || { level: 1, is_caps: false };
    const lineEndTime = line.time + (line.duration || 3.0);
    
    if (!line.words || line.words.length === 0) {
        let text = line.text.trim();
        if (intensity.is_caps) text = text.toUpperCase();
        
        const nextLine = lyrics[currentIndex + 1];
        const nextTime = nextLine ? nextLine.time : (lineEndTime + 5.0);
        if (appSettings.notes && time >= lineEndTime && (nextTime - lineEndTime) > 1.5) {
            text += " ♪";
        }
        
        currentLineSpan.innerText = text;
        return;
    }
    
    let lineHTML = "";
    let actualLineEndTime = lineEndTime;
    
    for (let i = 0; i < line.words.length; i++) {
        const w = line.words[i];
        
        // Calculate word duration (until next word, or bounded end of line duration)
        let wNextTime = (i + 1 < line.words.length) ? line.words[i + 1].time : Math.min(lineEndTime, w.time + (line.words.length > 1 ? ((w.time - line.words[0].time) / (line.words.length - 1)) * 1.5 : 1.5));
        
        if (i === line.words.length - 1) {
            actualLineEndTime = wNextTime;
        }
        
        if (time < w.time) {
            break; // Word has not started yet
        }
        
        let wordDuration = Math.max(0.05, wNextTime - w.time);
        let typingDuration = wordDuration;
        
        // Calculate characters to show based on elapsed time inside the word
        let elapsed = time - w.time;
        let fraction = Math.min(1.0, elapsed / typingDuration);
        let charsToShow = appSettings.typewriter ? Math.ceil(w.text.length * fraction) : w.text.length;
        
        let wordText = w.text.slice(0, charsToShow);
        if (intensity.is_caps) {
            wordText = wordText.toUpperCase();
        }
        
        lineHTML += wordText;
    }
    
    // Append eighth note emoji ♪ if we are in a significant instrumental break
    const nextLine = lyrics[currentIndex + 1];
    const timeUntilNextLine = nextLine ? (nextLine.time - time) : 5.0;
    if (appSettings.notes && time >= actualLineEndTime && timeUntilNextLine > 1.5) {
        lineHTML += " ♪";
    }
    
    // Forcibly strip leading spaces from the current line span to resolve indentation
    currentLineSpan.innerText = lineHTML.replace(/^\s+/, "");
}

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
    
    statusIntensity.innerText = `Intensity: ${intensityLabel}`;
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
    });
}

// Start connection
createEqualizerBars();
connectWebSocket();

// Offset Adjustment Functions
function updateOffsetDisplay() {
    const statusOffset = document.getElementById('status-offset');
    if (statusOffset) {
        const sign = lyricOffset > 0 ? "+" : "";
        statusOffset.innerText = `Offset: ${sign}${lyricOffset.toFixed(1)}s`;
    }
}

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

// Hook up Edit Lyrics Button
if (editBtn) {
    editBtn.addEventListener('click', () => {
        if (!currentTrack || lyrics.length === 0) return;
        
        if (!isEditing) {
            // Enter Edit Mode
            isEditing = true;
            editBtn.innerText = "💾 Save";
            if (cancelBtn) cancelBtn.style.display = "inline-block";
            
            // Toggle textareas
            if (textarea) textarea.style.display = "none";
            if (editTextarea) {
                editTextarea.style.display = "block";
                // Populate with clean plain text of current lyrics
                const plainText = lyrics.map(l => l.text).join('\n');
                editTextarea.value = plainText;
                editTextarea.focus();
            }
            
            // Hide equalizer
            const equalizer = document.getElementById('equalizer');
            if (equalizer) equalizer.style.display = "none";
        } else {
            // Save & Exit Edit Mode
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    action: "save_lyrics",
                    lyrics: editTextarea ? editTextarea.value : ""
                }));
            }
            
            isEditing = false;
            editBtn.innerText = "✎ Edit Lyrics";
            if (cancelBtn) cancelBtn.style.display = "none";
            
            if (editTextarea) editTextarea.style.display = "none";
            if (textarea) textarea.style.display = "block";
            
            // Show equalizer
            const equalizer = document.getElementById('equalizer');
            if (equalizer) equalizer.style.display = "flex";
        }
    });
}

if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
        isEditing = false;
        if (editBtn) editBtn.innerText = "✎ Edit Lyrics";
        cancelBtn.style.display = "none";
        
        if (editTextarea) editTextarea.style.display = "none";
        if (textarea) textarea.style.display = "block";
        
        // Show equalizer
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
let appSettings = {
    typewriter: true,
    popups: true,
    shake: true,
    blur: true,
    notes: true
};

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
    document.getElementById('setting-notes').checked = appSettings.notes;
    
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
            settings: appSettings
        }));
    }
}

// Bind toggles
['typewriter', 'popups', 'shake', 'blur', 'notes'].forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) {
        el.addEventListener('change', (e) => {
            appSettings[key] = e.target.checked;
            saveSettings();
        });
    }
});

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

settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.style.display = 'none';
    }
});

loadSettings();

