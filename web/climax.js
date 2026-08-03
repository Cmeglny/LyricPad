let socket = null;
let lyrics = [];
let currentIndex = -1;

// High-Resolution Clock State
let localTime = 0.0;
let lastFrameTime = performance.now();
let isPaused = true;
let currentTrack = null;

const lyricsHistory = document.getElementById('lyrics-history');
const currentLineSpan = document.getElementById('current-line-span');
const appBg = document.getElementById('app-background');

let wordNodes = [];
let climaxHistoryText = [];

function connectWebSocket() {
    socket = new WebSocket("ws://localhost:8765");
    
    socket.onopen = () => {
        console.log("Climax Window socket connected.");
    };

    socket.onclose = () => {
        console.log("Climax socket disconnected. Reconnecting...");
        setTimeout(connectWebSocket, 1000);
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "track") {
            currentTrack = msg;
            lyrics = msg.lyrics || [];
            currentIndex = -1;
            climaxHistoryText = [];
            lyricsHistory.innerHTML = "";
            currentLineSpan.innerHTML = "";
            wordNodes = [];
            
        } else if (msg.type === "cover_ready") {
            loadCoverColor(msg.base64);
        } else if (msg.type === "position") {
            const timeDiff = Math.abs(msg.position - localTime);
            if (msg.is_paused !== isPaused || timeDiff > 2.0 || msg.position === 0.0) {
                localTime = msg.position;
                isPaused = msg.is_paused;
                lastFrameTime = performance.now();
                
                checkLyricsSync(localTime);
                updateWordHighlights(localTime);
            }
        }
    };
}

function loadCoverColor(base64Data) {
    const img = new Image();
    img.onload = () => {
        try {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            canvas.width = 1;
            canvas.height = 1;
            
            ctx.drawImage(img, 0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            
            document.documentElement.style.setProperty('--fs-color-rgb', `${r}, ${g}, ${b}`);
            document.documentElement.style.setProperty('--fs-color-core', `rgb(${r}, ${g}, ${b})`);
            
            if (appBg) {
                appBg.style.backgroundImage = `url('${base64Data}')`;
            }
        } catch (e) {
            console.error(e);
        }
    };
    img.src = base64Data;
}

// 60 FPS Clock loop
function clockTick(now) {
    if (!isPaused && lyrics.length > 0) {
        const delta = (now - lastFrameTime) / 1000.0;
        localTime += delta;
        
        checkLyricsSync(localTime);
        updateWordHighlights(localTime);
    }
    lastFrameTime = now;
    requestAnimationFrame(clockTick);
}
requestAnimationFrame(clockTick);

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
    
    if (activeLineIndex !== currentIndex) {
        handleActiveLineChange(activeLineIndex);
    }
}

function handleActiveLineChange(activeLineIndex) {
    if (activeLineIndex === -1) {
        climaxHistoryText = [];
        lyricsHistory.innerHTML = "";
        currentLineSpan.innerHTML = "";
        wordNodes = [];
        currentIndex = -1;
        return;
    } 

    const line = lyrics[activeLineIndex];
    const intensity = line.intensity || { level: 1, is_caps: false };
    const isCaps = intensity.is_caps || intensity.level === 3;
    
    // Add previous line to history if it was climax level
    if (currentIndex >= 0 && currentIndex !== activeLineIndex && currentIndex < lyrics.length) {
        const prevLine = lyrics[currentIndex];
        const prevIntensity = prevLine.intensity || { level: 1 };
        if (prevIntensity.level === 3 && prevLine.text.trim() !== "") {
            let histText = prevLine.text.trim();
            if (prevIntensity.is_caps || prevIntensity.level === 3) histText = histText.toUpperCase();
            climaxHistoryText.push(histText);
            
            // Keep only last 3 history lines for climax
            if (climaxHistoryText.length > 3) {
                climaxHistoryText.shift();
            }
        }
    } else if (activeLineIndex < currentIndex || activeLineIndex - currentIndex > 1) {
        // Jumped timeline, rebuild history
        climaxHistoryText = [];
        for (let i = Math.max(0, activeLineIndex - 5); i < activeLineIndex; i++) {
            const l = lyrics[i];
            const iLevel = l.intensity || { level: 1 };
            if (iLevel.level === 3 && l.text.trim() !== "") {
                let histText = l.text.trim();
                if (iLevel.is_caps || iLevel.level === 3) histText = histText.toUpperCase();
                climaxHistoryText.push(histText);
            }
        }
        if (climaxHistoryText.length > 3) {
            climaxHistoryText = climaxHistoryText.slice(-3);
        }
    }

    currentIndex = activeLineIndex;
    
    // Render History
    lyricsHistory.innerHTML = '';
    climaxHistoryText.forEach(text => {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'history-line';
        lineDiv.textContent = text;
        lyricsHistory.appendChild(lineDiv);
    });
    
    // Climax window ONLY displays level 3 (Dramatic) lyrics in the active zone
    currentLineSpan.innerHTML = "";
    wordNodes = [];
    
    if (intensity.level !== 3) {
        return;
    }
    
    // Render Current Line with typewriter effect
    if (!line.words || line.words.length === 0) {
        let text = line.text.trim();
        if (isCaps) text = text.toUpperCase();
        currentLineSpan.textContent = text;
        return;
    }
    
    for (let i = 0; i < line.words.length; i++) {
        const w = line.words[i];
        let wt = w.text;
        if (isCaps) wt = wt.toUpperCase();

        // Calculate dynamic fill duration
        let duration = 0.3;
        if (i < line.words.length - 1) {
            duration = line.words[i+1].time - w.time;
        } else if (i > 0) {
            duration = Math.min(1.5, w.time - line.words[i-1].time);
        }
        duration = Math.max(0.1, Math.min(duration, 1.5));
        const transitionStyle = `background-position ${duration.toFixed(2)}s linear`;

        const span = document.createElement('span');
        span.className = 'lyric-char';
        span.style.transition = transitionStyle;
        span.textContent = wt;
        currentLineSpan.appendChild(span);
        
        wordNodes.push({
            el: span,
            time: w.time,
            active: false
        });
    }
}

function updateWordHighlights(time) {
    if (currentIndex === -1 || wordNodes.length === 0) return;

    for (let i = 0; i < wordNodes.length; i++) {
        const wNode = wordNodes[i];
        const isActive = time >= wNode.time;
        
        if (wNode.active !== isActive) {
            wNode.active = isActive;
            wNode.el.className = isActive ? 'lyric-char active' : 'lyric-char';
        }
    }
}

// Start connection
connectWebSocket();
