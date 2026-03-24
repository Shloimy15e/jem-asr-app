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

// Fetch audio and return { base64, format } or { audioUrl } for untrimmed R2 audio.
// Untrimmed R2 audio returns the URL so the GPU server can fetch it directly —
// avoids base64-encoding large files through the Cloudflare proxy (413 limit).
// Trimmed audio is cropped, downsampled to 16 kHz mono, and returned as WAV base64.
async function fetchAudioForAlignment(url, trimStart, trimEnd) {
  const hasTrim = (trimStart > 0) || (trimEnd > 0);

  // For untrimmed audio from R2, skip the fetch entirely — pass the URL to the GPU server.
  if (!hasTrim && url.includes('audio.kohnai.ai')) {
    return { audioUrl: url };
  }

  const fetchUrl = url.includes('audio.kohnai.ai')
    ? `/api/audio?url=${encodeURIComponent(url)}`
    : url;

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status}`);
  const blob = await res.blob();

  if (!hasTrim) {
    // Non-R2 URL with no trim — encode as-is (Google Drive links, etc.)
    const base64 = await blobToBase64(blob);
    return { base64, format: '.mp3' };
  }

  // Crop via Web Audio API, then downsample to 16 kHz mono (Whisper only needs this).
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const sr = decoded.sampleRate;
  const startSample = Math.floor((trimStart || 0) * sr);
  const endSample = trimEnd > 0 ? Math.floor(trimEnd * sr) : decoded.length;
  const trimLength = Math.max(1, endSample - startSample);

  // Resample to 16 kHz mono via OfflineAudioContext — reduces WAV size ~6× vs stereo 44.1 kHz.
  const TARGET_SR = 16000;
  const targetLength = Math.ceil(trimLength / sr * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, targetLength, TARGET_SR);
  const tmpBuf = new AudioBuffer({ length: trimLength, numberOfChannels: decoded.numberOfChannels, sampleRate: sr });
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    tmpBuf.copyToChannel(decoded.getChannelData(ch).subarray(startSample, startSample + trimLength), ch);
  }
  const src = offCtx.createBufferSource();
  src.buffer = tmpBuf;
  src.connect(offCtx.destination);
  src.start();
  const resampled = await offCtx.startRendering();

  const wavBlob = audioBufferToWavBlob(resampled);
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

  const audioResult = await fetchAudioForAlignment(url, trimStart, trimEnd);

  const requestBody = JSON.stringify(
    audioResult.audioUrl
      ? { mode: 'align', audio_url: audioResult.audioUrl, text: alignText, language: 'yi' }
      : { mode: 'align', audio_base64: audioResult.base64, audio_format: audioResult.format, text: alignText, language: 'yi' }
  );

  // Retry logic for cold start 502/504 timeouts and network errors
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 10000;
  const FETCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  let response;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      response = await fetch(ALIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`[Align] Network error on attempt ${attempt}/${MAX_RETRIES}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`Alignment network error after ${MAX_RETRIES} attempts: ${err.message}`);
    }
    clearTimeout(timeoutId);
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
  const audioResult = await fetchAudioForAlignment(audioUrl, 0, 0);

  const audioFields = audioResult.audioUrl
    ? { audio_url: audioResult.audioUrl }
    : { audio_base64: audioResult.base64, audio_format: audioResult.format || '.mp3' };

  const response = await fetch(modelConfig.endpoint || ALIGN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'transcribe',
      ...audioFields,
      language: 'yi',
      ...(modelConfig.requestTemplate || {}),
    }),
  });

  if (!response.ok) throw new Error(`Transcription API error: ${response.status}`);

  const data = await response.json();
  return data.full_text || data.text || '';
}
