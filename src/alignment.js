import { updateState } from './state.js';

const ALIGN_ENDPOINT = '/api/align';

function getAudioUrl(audioId, state) {
  const entry = state.audio.find(a => a.id === audioId);
  if (!entry) return null;
  return entry.r2Link || entry.driveLink || null;
}

// Encode an AudioBuffer as a WAV Blob (PCM 16-bit)
function audioBufferToWavBlob(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const dataSize = len * numCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// Fetch audio and return { base64, format }.
// If trim is set, crops via Web Audio API and returns WAV.
async function fetchAudioForAlignment(url, trimStart, trimEnd) {
  const fetchUrl = url.includes('audio.kohnai.ai')
    ? `/api/audio?url=${encodeURIComponent(url)}`
    : url;

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status}`);
  const blob = await res.blob();

  const hasTrim = (trimStart > 0) || (trimEnd > 0);
  if (!hasTrim) {
    const base64 = await blobToBase64(blob);
    return { base64, format: '.mp3' };
  }

  // Crop via Web Audio API
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const sr = decoded.sampleRate;
  const startSample = Math.floor((trimStart || 0) * sr);
  const endSample = trimEnd > 0 ? Math.floor(trimEnd * sr) : decoded.length;
  const length = Math.max(1, endSample - startSample);

  // Can't call createBuffer on closed context — use OfflineAudioContext
  const trimmedBuf = new AudioBuffer({ length, numberOfChannels: decoded.numberOfChannels, sampleRate: sr });
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    trimmedBuf.copyToChannel(decoded.getChannelData(ch).subarray(startSample, startSample + length), ch);
  }

  const wavBlob = audioBufferToWavBlob(trimmedBuf);
  const base64 = await blobToBase64(wavBlob);
  return { base64, format: '.wav' };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function alignRow(audioId, state, textOverride = null) {
  const url = getAudioUrl(audioId, state);
  if (!url) throw new Error(`No audio URL for ${audioId}`);

  const alignText = textOverride || state.cleaning[audioId]?.cleanedText;
  if (!alignText) {
    throw new Error(`No text for alignment for ${audioId}`);
  }

  const trim = state.trims?.[audioId] || {};
  const trimStart = trim.start || 0;
  const trimEnd = trim.end || 0;

  const { base64: audioBase64, format: audioFormat } = await fetchAudioForAlignment(url, trimStart, trimEnd);

  const requestBody = JSON.stringify({
    mode: 'align',
    audio_base64: audioBase64,
    audio_format: audioFormat,
    text: alignText,
    language: 'yi',
  });

  // Retry logic for cold start 502/504 timeouts
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 10000;
  let response;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    response = await fetch(ALIGN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
    if (response.status === 502 || response.status === 504) {
      console.warn(`[Align] Got ${response.status} on attempt ${attempt}/${MAX_RETRIES} — retrying in ${RETRY_DELAY_MS / 1000}s...`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    }
    break;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Alignment API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  console.log('[Align] raw response keys:', Object.keys(data));
  if (data.timestamps?.[0]) console.log('[Align] sample timestamp:', JSON.stringify(data.timestamps[0]));
  if (data.segments?.[0]?.words?.[0]) console.log('[Align] sample segment word:', JSON.stringify(data.segments[0].words[0]));

  let rawWords = data.timestamps || [];
  if (rawWords.length === 0 && data.segments) {
    rawWords = data.segments.flatMap(seg => seg.words || []);
  }

  const words = rawWords.map(t => ({
    word: t.word || t.text || '',
    start: (t.start || 0) + trimStart, // offset to absolute time in original audio
    end: (t.end || 0) + trimStart,
    confidence: t.confidence ?? t.probability ?? t.score ?? 0,
  }));

  const totalConf = words.reduce((sum, w) => sum + (w.confidence || 0), 0);
  const avgConfidence = words.length > 0 ? totalConf / words.length : 0;
  const lowConfidenceCount = words.filter(w => (w.confidence || 0) < 0.4).length;

  const alignment = {
    words,
    avgConfidence,
    lowConfidenceCount,
    alignedAt: new Date().toISOString(),
    trimStart: trimStart || undefined,
    trimEnd: trimEnd || undefined,
  };

  updateState('alignments', audioId, alignment);
  return alignment;
}

export async function batchAlign(audioIds, state, onProgress) {
  const total = audioIds.length;
  const startTime = Date.now();

  for (let i = 0; i < total; i++) {
    const audioId = audioIds[i];
    try {
      await alignRow(audioId, state);
    } catch (err) {
      console.error(`Alignment failed for ${audioId}:`, err);
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (onProgress) onProgress(i + 1, total, elapsed);
  }
}

export async function transcribeAudio(audioId, audioUrl, modelConfig) {
  const { base64: audioBase64 } = await fetchAudioForAlignment(audioUrl, 0, 0);

  const response = await fetch(modelConfig.endpoint || ALIGN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'transcribe',
      audio_base64: audioBase64,
      audio_format: '.mp3',
      language: 'yi',
      ...(modelConfig.requestTemplate || {}),
    }),
  });

  if (!response.ok) throw new Error(`Transcription API error: ${response.status}`);

  const data = await response.json();
  return data.full_text || data.text || '';
}
