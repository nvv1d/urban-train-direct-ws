'use strict';

const SAMPLE_RATE = 16000;
const AUDIO_CODEC = 'adpcm';  // Changed from 'none' to 'adpcm'
const CLIENT_NAME = 'RP-Web';
const TIMEZONE = 'America/Chicago';

let ws, sessionId, callId = null;
let mediaStream, audioContext;
let micSource, scriptNode;
let selectedMicId = null;
let audioQueue = [], isPlaying = false;
let serverSampleRate = 24000;
let audioLevelInterval;

// ADPCM Encoder/Decoder
const ADPCM = {
  indexTable: [
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8
  ],
  
  stepSizeTable: [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
  ],
  
  encode: function(buffer) {
    const samples = new Int16Array(buffer);
    const encodedSize = Math.ceil(samples.length / 2);
    const encoded = new Uint8Array(encodedSize);
    
    let index = 0;
    let predsample = 0;
    let step = 7;
    let bufferstep = 0;
    let outbyte = 0;
    let outn = 0;
    
    for (let n = 0; n < samples.length; n++) {
      let input = samples[n];
      let diff = input - predsample;
      let sign = (diff < 0) ? 8 : 0;
      if (sign) diff = -diff;
      
      let delta = 0;
      let vpdiff = (step >> 3);
      
      if (diff >= step) {
        delta = 4;
        diff -= step;
        vpdiff += step;
      }
      
      step >>= 1;
      if (diff >= step) {
        delta |= 2;
        diff -= step;
        vpdiff += step;
      }
      
      step >>= 1;
      if (diff >= step) {
        delta |= 1;
        vpdiff += step;
      }
      
      if (sign) predsample -= vpdiff;
      else predsample += vpdiff;
      
      if (predsample > 32767) predsample = 32767;
      else if (predsample < -32768) predsample = -32768;
      
      index += this.indexTable[delta | sign];
      if (index < 0) index = 0;
      else if (index > 88) index = 88;
      
      step = this.stepSizeTable[index];
      
      if (bufferstep) {
        outbyte |= (delta | sign);
        encoded[outn++] = outbyte;
        bufferstep = 0;
      } else {
        outbyte = (delta | sign) << 4;
        bufferstep = 1;
      }
    }
    
    if (bufferstep) encoded[outn++] = outbyte;
    return encoded.slice(0, outn);
  },
  
  decode: function(encoded, expectedLength) {
    const decoded = new Int16Array(expectedLength);
    
    let index = 0;
    let predsample = 0;
    let step = 7;
    let outx = 0;
    
    for (let n = 0; n < encoded.length; n++) {
      const inputbyte = encoded[n];
      
      let delta = (inputbyte >> 4) & 0xf;
      this._decodeSample(delta, predsample, step, index, (sample, newStep, newIndex) => {
        predsample = sample;
        step = newStep;
        index = newIndex;
        if (outx < decoded.length) decoded[outx++] = sample;
      });
      
      delta = inputbyte & 0xf;
      this._decodeSample(delta, predsample, step, index, (sample, newStep, newIndex) => {
        predsample = sample;
        step = newStep;
        index = newIndex;
        if (outx < decoded.length) decoded[outx++] = sample;
      });
    }
    
    return decoded;
  },
  
  _decodeSample: function(delta, predsample, step, index, callback) {
    const sign = delta & 8;
    delta &= 7;
    
    let vpdiff = step >> 3;
    if (delta & 4) vpdiff += step;
    if (delta & 2) vpdiff += step >> 1;
    if (delta & 1) vpdiff += step >> 2;
    vpdiff += step >> 3;
    
    if (sign) predsample -= vpdiff;
    else predsample += vpdiff;
    
    if (predsample > 32767) predsample = 32767;
    else if (predsample < -32768) predsample = -32768;
    
    index += this.indexTable[delta | (sign ? 8 : 0)];
    if (index < 0) index = 0;
    else if (index > 88) index = 88;
    
    step = this.stepSizeTable[index];
    
    callback(predsample, step, index);
  }
};

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

// Modified to handle binary data directly
function processAudioData(audioData) {
  if (!audioData) return null;
  
  if (typeof audioData === 'string') {
    // Handle base64 string format (backward compatible)
    return base64ToArrayBuffer(audioData);
  } else if (audioData instanceof ArrayBuffer) {
    // Handle raw ArrayBuffer
    return audioData;
  } else if (audioData instanceof Uint8Array) {
    // Handle Uint8Array (for ADPCM)
    return audioData.buffer;
  }
  return null;
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
    let float32;
    
    // Handle ADPCM decoding if needed
    if (AUDIO_CODEC === 'adpcm') {
      // ADPCM data - decode first
      // Assuming the server sends metadata about expected PCM length
      const expectedSamples = Math.floor(buffer.byteLength * 2); // Estimate: each byte contains ~2 samples
      const decodedData = ADPCM.decode(new Uint8Array(buffer), expectedSamples);
      
      // Convert Int16 to Float32
      float32 = new Float32Array(decodedData.length);
      for (let i = 0; i < decodedData.length; i++) {
        float32[i] = decodedData[i] / 32768;
      }
    } else {
      // Raw PCM data
      const int16 = new Int16Array(buffer);
      float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }
    }
    
    const audioBuf = audioContext.createBuffer(1, float32.length, serverSampleRate);
    audioBuf.getChannelData(0).set(float32);
    const src = audioContext.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioContext.destination);
    return new Promise(res => { src.onended = res; src.start(); });
  } catch (error) {
    console.error("Audio playback error:", error);
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

// Binary message sending function
function sendBinaryAudio(audioData) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !callId) return;
  
  // Create a message header (20 bytes)
  const headerView = new DataView(new ArrayBuffer(20));
  
  // Message type (4 bytes) - using a simple ID for audio data (e.g., 1)
  headerView.setUint32(0, 1, true);
  
  // Session ID hash (8 bytes) - using first 8 bytes of sessionId as hash
  const sessionHash = parseInt(sessionId.replace(/-/g, '').substring(0, 16), 16);
  headerView.setBigUint64(4, BigInt(sessionHash), true);
  
  // Audio data length (4 bytes)
  headerView.setUint32(12, audioData.byteLength, true);
  
  // Audio format (4 bytes) - PCM=1, ADPCM=2
  headerView.setUint32(16, AUDIO_CODEC === 'adpcm' ? 2 : 1, true);
  
  // Combine header and audio data
  const message = new Uint8Array(headerView.byteLength + audioData.byteLength);
  message.set(new Uint8Array(headerView.buffer), 0);
  message.set(audioData, headerView.byteLength);
  
  // Send binary data
  ws.send(message.buffer);
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
        if (AUDIO_CODEC === 'adpcm') {
          // Compress using ADPCM
          const compressedData = ADPCM.encode(pcm.buffer);
          sendBinaryAudio(compressedData);
        } else {
          // Use raw PCM
          sendBinaryAudio(new Uint8Array(pcm.buffer));
        }
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
    // Support for binary data
    ws.binaryType = 'arraybuffer';
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
      
      // Send initial protocol message to indicate we'll use binary audio
      ws.send(JSON.stringify({
        type: 'initialize',
        session_id: null,
        call_id: null,
        content: {
          protocol_version: 2,
          audio_mode: AUDIO_CODEC === 'adpcm' ? 'adpcm' : 'pcm_raw'
        }
      }));
    } catch {
      ws.close();
    }
  };

  ws.onmessage = ev => {
    try {
      // Handle both text and binary messages
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
              binary_audio: true,  // Signal we'll use binary audio
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
          const audioData = msg.content?.audio_data;
          if (audioData) {
            const buf = processAudioData(audioData);
            if (buf) {
              audioQueue.push(buf);
              if (!isPlaying) requestAnimationFrame(processQueue);
            }
          }
        }
      } else if (ev.data instanceof ArrayBuffer) {
        // Handle binary audio from server
        const headerView = new DataView(ev.data, 0, 20);
        const messageType = headerView.getUint32(0, true);
        
        if (messageType === 1) { // Audio data
          const audioFormat = headerView.getUint32(16, true);
          const audioData = ev.data.slice(20);
          
          audioQueue.push(audioData);
          if (!isPlaying) requestAnimationFrame(processQueue);
        }
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
    }
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

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
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
