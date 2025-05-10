'use strict';

// === 1. CONFIG ===
const SAMPLE_RATE = 16000;
const AUDIO_CODEC = 'none';
const CLIENT_NAME = 'RP-Web';
const TIMEZONE = 'America/Chicago';
// Configurable chunk size for latency optimization
const CHUNK_SIZE = 1024; // in samples, matches ~64ms at 16kHz

// === 2. STATE ===
let ws, sessionId, callId = null;
let mediaStream, audioContext;
let micSource, scriptNode, audioWorkletNode;
let selectedMicId = null;
let audioQueue = [], isPlaying = false;
let serverSampleRate = 24000;
let vadEnabled = true;
let sessionTimeoutHandle = null;
let reconnectAttempts = 0;

const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const charSel  = document.getElementById('characterSelect');
const micSel   = document.getElementById('micSelect');

// === 3. UTILS ===
function updateStatus(state) {
  statusEl.className = state;
  statusEl.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function genRequestId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c=='x'? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return buf;
}

function callIdString(ci) {
  if (!ci) return '';
  if (typeof ci === "string") return ci;
  if (typeof ci === "object" && ci.id) return ci.id;
  return String(ci);
}

// === 4. AUDIO PLAYBACK ===
async function playAudio(buffer) {
  if (!audioContext) return;
  try {
    const int16 = new Int16Array(buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const audioBuf = audioContext.createBuffer(1, float32.length, serverSampleRate);
    audioBuf.getChannelData(0).set(float32);
    const src = audioContext.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioContext.destination);
    return new Promise(res => { src.onended = res; src.start(); });
  } catch {
    return Promise.resolve();
  }
}

function processQueue() {
  if (isPlaying || audioQueue.length === 0) return;
  isPlaying = true;
  playAudio(audioQueue.shift())
    .finally(() => {
      isPlaying = false;
      requestAnimationFrame(processQueue);
    });
}

// === 5. MICROPHONE DEVICE HANDLING ===
async function populateMicList() {
  micSel.innerHTML = '';
  let devices = [];
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  const mics = devices.filter(d => d.kind === 'audioinput');
  if (mics.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.text = 'No microphones found';
    micSel.appendChild(option);
    micSel.disabled = true;
  } else {
    mics.forEach((device, i) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microphone ${i+1}`;
      micSel.appendChild(option);
    });
    micSel.disabled = false;
  }
}

// === 6. VOICE ACTIVITY DETECTION (VAD) ===
function isSpeech(pcm, threshold = 800) {
  // Calculate RMS energy for VAD
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    sum += pcm[i] * pcm[i];
  }
  const rms = Math.sqrt(sum / pcm.length);
  return rms > threshold;
}

// === 7. AUDIO CAPTURE & STREAMING (with VAD, Binary, Cleanup, Fallback) ===
async function startMic() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    try { audioContext.close(); } catch {}
    audioContext = null;
  }
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });

  const constraints = {
    audio: {
      deviceId: selectedMicId ? { exact: selectedMicId } : undefined,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    // Use AudioWorklet if available, otherwise fallback to ScriptProcessorNode
    if (audioContext.audioWorklet) {
      // Modern browsers: AudioWorklet for low-latency, reliable audio
      // We provide a worklet script inline for portability
      const workletURL = URL.createObjectURL(new Blob([`
        class PCMProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
          }
          process(inputs) {
            const input = inputs[0][0];
            if (input) {
              const pcm = new Int16Array(input.length);
              for (let i = 0; i < input.length; i++) {
                let s = Math.max(-1, Math.min(1, input[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              this.port.postMessage(pcm.buffer, [pcm.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `], {type: "application/javascript"}));
      await audioContext.audioWorklet.addModule(workletURL);

      audioWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
      audioWorkletNode.port.onmessage = event => {
        const pcm = new Int16Array(event.data);
        if (vadEnabled && !isSpeech(pcm)) return;
        if (ws && ws.readyState === WebSocket.OPEN && callId) {
          ws.send(pcm.buffer);
        }
      };
      micSource = audioContext.createMediaStreamSource(mediaStream);
      micSource.connect(audioWorkletNode);
      // No need to connect to destination – no local playback
    } else {
      // Fallback: ScriptProcessorNode
      micSource = audioContext.createMediaStreamSource(mediaStream);
      scriptNode = audioContext.createScriptProcessor(CHUNK_SIZE, 1, 1);
      micSource.connect(scriptNode);
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0;
      scriptNode.connect(gainNode);
      gainNode.connect(audioContext.destination);

      scriptNode.onaudioprocess = function(ev) {
        const input = ev.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; ++i) {
          let s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        if (vadEnabled && !isSpeech(pcm)) return;
        if (ws && ws.readyState === WebSocket.OPEN && callId) {
          ws.send(pcm.buffer);
        }
      };
    }
  } catch {
    updateStatus('disconnected');
    stopSession();
  }
}

// === 8. CONNECTION AND SESSION MANAGEMENT ===
function connect(wsUrl, character) {
  updateStatus('connecting');
  try {
    ws = new WebSocket(wsUrl);
    // Send/receive binary frames for audio
    ws.binaryType = "arraybuffer";
  } catch {
    updateStatus('disconnected');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  ws.onopen = () => {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContext.resume().catch(() => {});
      updateStatus('connected');
      // Session timeout for 30 minutes (see FAQ)
      clearTimeout(sessionTimeoutHandle);
      sessionTimeoutHandle = setTimeout(() => {
        stopSession();
        updateStatus('disconnected');
      }, 30 * 60 * 1000);
    } catch {
      ws.close();
    }
  };

  ws.onmessage = ev => {
    if (ev.data instanceof ArrayBuffer) {
      // Raw PCM audio from server/Sesame
      audioQueue.push(ev.data);
      if (!isPlaying) requestAnimationFrame(processQueue);
      return;
    }
    // JSON control messages
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'initialize') {
        sessionId = msg.content?.session_id || msg.session_id;

        ws.send(JSON.stringify({
          type: 'client_location_state',
          session_id: sessionId,
          call_id: null,
          content: { latitude:0, longitude:0, address:'', timezone:TIMEZONE }
        }));

        ws.send(JSON.stringify({
          type: 'call_connect',
          session_id: sessionId,
          call_id: null,
          request_id: genRequestId(),
          content: {
            sample_rate: SAMPLE_RATE,
            audio_codec: AUDIO_CODEC,
            reconnect: false,
            is_private: false,
            client_name: CLIENT_NAME,
            settings: { preset: character },
            client_metadata: {
              language: 'en-US',
              user_agent: navigator.userAgent,
              mobile_browser: /Mobi|Android/i.test(navigator.userAgent),
              media_devices: []
            }
          }
        }));
      }
      else if (msg.type === 'call_connect_response' || (msg.type === 'chat' && (msg.call_id || msg.content?.call_id))) {
        callId = msg.call_id || msg.content?.call_id;
        if (msg.content && msg.content.sample_rate) {
          serverSampleRate = msg.content.sample_rate;
        }
        startMic();
      }
    } catch {}
  };

  ws.onclose = () => {
    updateStatus('disconnected');
    cleanupAudio();
    clearTimeout(sessionTimeoutHandle);
    // Reconnect logic with exponential backoff
    if (reconnectAttempts < 3) {
      reconnectAttempts++;
      setTimeout(() => {
        startSession();
      }, 1500 * reconnectAttempts);
    } else {
      reconnectAttempts = 0;
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  };

  ws.onerror = () => {
    updateStatus('disconnected');
  };
}

// === 9. AUDIO CLEANUP AND RESOURCE RELEASE ===
function cleanupAudio() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => {
      try { t.stop(); t.enabled = false; } catch {}
    });
    mediaStream = null;
  }
  if (audioContext) {
    try { audioContext.close(); } catch {}
    audioContext = null;
  }
  if (scriptNode) {
    try { scriptNode.disconnect(); } catch {}
    scriptNode = null;
  }
  if (audioWorkletNode) {
    try { audioWorkletNode.disconnect(); } catch {}
    audioWorkletNode = null;
  }
  if (audioLevelInterval) {
    clearInterval(audioLevelInterval);
    audioLevelInterval = null;
  }
}

// === 10. SESSION CONTROL ===
async function startSession() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  updateStatus('fetching');

  const char = charSel.value;
  selectedMicId = micSel.value;
  reconnectAttempts = 0;
  try {
    const res = await fetch(`/capture-websocket/${char.toLowerCase()}`);
    if (!res.ok) {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      updateStatus('disconnected');
      return;
    }

    const j = await res.json();
    if (!j.success) {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      updateStatus('disconnected');
      return;
    }

    connect(j.websocketUrl, char);
  } catch {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStatus('disconnected');
  }
}

function stopSession() {
  audioQueue = [];
  isPlaying = false;

  cleanupAudio();

  let closeWs = true;
  if (ws && ws.readyState === WebSocket.OPEN && callId && sessionId) {
    try {
      ws.send(JSON.stringify({
        type: 'call_disconnect',
        session_id: sessionId,
        call_id: callIdString(callId),
        request_id: genRequestId(),
        content: { reason: 'user_request' }
      }));
      closeWs = false;
      setTimeout(() => {
        if (ws) {
          try { ws.close(); } catch {}
          ws = null;
        }
        sessionId = null;
        callId = null;
      }, 100);
    } catch {}
  }

  if (closeWs && ws) {
    try { ws.close(); } catch {}
    ws = null;
    sessionId = null;
    callId = null;
  }

  clearTimeout(sessionTimeoutHandle);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateStatus('disconnected');
}

// === 12. BROWSER COMPATIBILITY CHECK ===
function checkBrowserSupport() {
  let supported = true;
  if (!window.WebSocket) supported = false;
  if (!window.AudioContext && !window.webkitAudioContext) supported = false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) supported = false;
  if (!supported) {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    updateStatus('unsupported');
    alert('Your browser does not support required features (WebSocket, Web Audio, or getUserMedia). Please update your browser.');
  }
}

// === 13. UI EVENTS AND INIT ===
micSel.onchange = () => {
  selectedMicId = micSel.value;
};
window.addEventListener('beforeunload', () => {
  stopSession();
});
window.addEventListener('load', () => {
  checkBrowserSupport();
  populateMicList();
});
startBtn.onclick = startSession;
stopBtn.onclick = stopSession;
micSel.onfocus = populateMicList;
updateStatus('disconnected');
