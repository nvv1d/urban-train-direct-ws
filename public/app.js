'use strict';

const SAMPLE_RATE = 16000;
const AUDIO_CODEC = 'none';
const CLIENT_NAME = 'RP-Web';
const TIMEZONE = 'America/Chicago';

let ws, sessionId, callId = null;
let mediaStream, audioContext;
let micSource, scriptNode;
let selectedMicId = null;
let audioQueue = [], isPlaying = false;
let serverSampleRate = 24000;
let audioLevelInterval;

const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const charSel  = document.getElementById('characterSelect');
const micSel   = document.getElementById('micSelect');

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

function callIdString(ci) {
  if (!ci) return '';
  if (typeof ci === "string") return ci;
  if (typeof ci === "object" && ci.id) return ci.id;
  return String(ci);
}

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
    micSource = audioContext.createMediaStreamSource(mediaStream);
    scriptNode = audioContext.createScriptProcessor(1024, 1, 1);

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
      if (ws && ws.readyState === WebSocket.OPEN && callId) {
        const b64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
        ws.send(JSON.stringify({
          type: 'audio',
          session_id: sessionId,
          call_id: callIdString(callId),
          content: { audio_data: b64 }
        }));
      }
    };
  } catch {
    updateStatus('disconnected');
    stopSession();
  }
}

micSel.onchange = () => {
  selectedMicId = micSel.value;
};

function connect(wsUrl, character) {
  updateStatus('connecting');
  try {
    ws = new WebSocket(wsUrl);
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
    } catch {
      ws.close();
    }
  };

  ws.onmessage = ev => {
    try {
      if (typeof ev.data === 'string') {
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
        else if (msg.type === 'audio') {
          const b64 = msg.content?.audio_data;
          if (b64) {
            const buf = base64ToArrayBuffer(b64);
            audioQueue.push(buf);
            if (!isPlaying) requestAnimationFrame(processQueue);
          }
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    updateStatus('disconnected');
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
  };

  ws.onerror = () => {};
}

async function startSession() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  updateStatus('fetching');

  const char = charSel.value;
  selectedMicId = micSel.value;
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

  if (audioLevelInterval) {
    clearInterval(audioLevelInterval);
    audioLevelInterval = null;
  }

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

  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateStatus('disconnected');
}

window.addEventListener('load', () => {
  if (!window.WebSocket) {
    startBtn.disabled = true;
  }
  if (!window.AudioContext && !window.webkitAudioContext) {
    startBtn.disabled = true;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    startBtn.disabled = true;
  }
  populateMicList();
});

startBtn.onclick = startSession;
stopBtn.onclick = stopSession;
micSel.onfocus = populateMicList;
updateStatus('disconnected');
