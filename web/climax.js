let socket = null;
let lyrics = [];
let currentIndex = -1;

// High-Resolution Clock State
let localTime = 0.0;
let lastFrameTime = performance.now();
let isPaused = true;

const lyricsHistory = document.getElementById('lyrics-history');
const currentLineSpan = document.getElementById('current-line-span');
const textarea = document.getElementById('notepad-textarea');
const notepadWindow = document.getElementById('notepad-window');

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
            lyrics = msg.lyrics || [];
            currentIndex = -1;
            climaxHistoryText = "";
            lyricsHistory.innerText = "";
            currentLineSpan.innerText = "";
        } else if (msg.type === "position") {
            const timeDiff = Math.abs(msg.position - localTime);
            if (msg.is_paused !== isPaused || timeDiff > 2.0 || msg.position === 0.0) {
                localTime = msg.position;
                isPaused = msg.is_paused;
                lastFrameTime = performance.now();
                
                checkLyricsSync(localTime);
                renderCurrentLine(localTime);
            }
        }
    };
}

// 60 FPS Clock loop
function clockTick(now) {
    if (!isPaused && lyrics.length > 0) {
        const delta = (now - lastFrameTime) / 1000.0;
        localTime += delta;
        
        checkLyricsSync(localTime);
        renderCurrentLine(localTime);
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

let climaxHistoryText = "";

function handleActiveLineChange(activeLineIndex) {
    if (activeLineIndex === -1) {
        climaxHistoryText = "";
        lyricsHistory.innerText = "";
        currentLineSpan.innerText = "";
        currentIndex = -1;
    } else if (activeLineIndex < currentIndex || activeLineIndex - currentIndex > 1) {
        // Major jump (user seeked backward or forward manually)
        climaxHistoryText = "";
        for (let i = 0; i <= activeLineIndex - 1; i++) {
            const line = lyrics[i];
            const intensity = line.intensity || { level: 1 };
            if (intensity.level === 3 && line.text.trim() !== "") {
                climaxHistoryText += line.text.trim().toUpperCase() + "\n";
            }
        }
        currentIndex = activeLineIndex;
        lyricsHistory.innerText = climaxHistoryText;
    } else {
        // Normal sequential progression
        if (currentIndex >= 0) {
            const prevLine = lyrics[currentIndex];
            const prevIntensity = prevLine.intensity || { level: 1 };
            if (prevIntensity.level === 3 && prevLine.text.trim() !== "") {
                climaxHistoryText += prevLine.text.trim().toUpperCase() + "\n";
            }
        }
        
        currentIndex = activeLineIndex;
        lyricsHistory.innerText = climaxHistoryText;
    }
    textarea.scrollTop = textarea.scrollHeight;
}

function renderCurrentLine(time) {
    if (currentIndex < 0 || currentIndex >= lyrics.length) {
        currentLineSpan.innerText = "";
        return;
    }
    
    const line = lyrics[currentIndex];
    const intensity = line.intensity || { level: 1, is_caps: false };
    
    // Climax window ONLY displays level 3 (Dramatic) lyrics in the active zone
    if (intensity.level !== 3) {
        currentLineSpan.innerText = "";
        return;
    }
    
    if (!line.words || line.words.length === 0) {
        let text = line.text.trim();
        if (intensity.is_caps) text = text.toUpperCase();
        currentLineSpan.innerText = text;
        return;
    }
    
    let lineHTML = "";
    for (let i = 0; i < line.words.length; i++) {
        const w = line.words[i];
        if (time < w.time) {
            break; // Word has not started yet
        }
        
        let wordText = w.text;
        if (intensity.is_caps) {
            wordText = wordText.toUpperCase();
        }
        
        lineHTML += wordText;
    }
    
    // Trim leading whitespace during formatting
    currentLineSpan.innerText = lineHTML.replace(/^\s+/, "");
}

// Start connection
connectWebSocket();
