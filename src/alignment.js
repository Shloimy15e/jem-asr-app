import { updateState, setVersionAlignment } from './state.js';

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

// Fetch audio and return { base64, format } or { audioUrl, trimStart, trimEnd, audioDuration }.
// R2 audio (trimmed or not) returns the URL so the CF Worker fetches it server-side —
// avoids base64-encoding large files through the Cloudflare proxy (413 limit).
// The CF Worker applies byte-level trimming when trimStart/trimEnd are provided.
// Only non-R2 URLs (e.g. Google Drive) fall back to browser-side fetch + base64.
async function fetchAudioForAlignment(url, trimStart, trimEnd, audioDuration) {
  const hasTrim = (trimStart > 0) || (trimEnd > 0);

  // For all R2 audio (trimmed or not), pass the URL to the CF Worker.
  // The Worker fetches from R2 with no inbound size limit and handles trimming server-side.
  if (url.includes('audio.kohnai.ai')) {
    return { audioUrl: url, trimStart: hasTrim ? trimStart : undefined, trimEnd: hasTrim ? trimEnd : undefined, audioDuration: hasTrim ? audioDuration : undefined };
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status}`);
  const blob = await res.blob();

  if (!hasTrim) {
    // Non-R2 URL with no trim — encode as-is (Google Drive links, etc.)
    const base64 = await blobToBase64(blob);
    return { base64, format: '.mp3' };
  }

  // Non-R2 trimmed audio — crop + downsample to 16 kHz mono in the browser.
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const sr = decoded.sampleRate;
  const startSample = Math.floor((trimStart || 0) * sr);
  const endSample = trimEnd > 0 ? Math.floor(trimEnd * sr) : decoded.length;
  const trimLength = Math.max(1, endSample - startSample);

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

export async function alignRow(audioId, state, textOverride = null, versionId = null) {
  const url = getAudioUrl(audioId, state);
  if (!url) throw new Error(`No audio URL for ${audioId}`);

  const alignText = textOverride || state.cleaning[audioId]?.cleanedText;
  if (!alignText) {
    throw new Error(`No text for alignment for ${audioId}`);
  }

  const trim = state.trims?.[audioId] || {};
  const trimStart = trim.start || 0;
  const trimEnd = trim.end || 0;

  const audioEntry = state.audio.find(a => a.id === audioId);
  const audioDuration = (audioEntry?.estMinutes || 0) * 60;

  const audioResult = await fetchAudioForAlignment(url, trimStart, trimEnd, audioDuration);

  // Cap text to avoid RunPod timeout/rejection on very long transcripts.
  // RunPod rejects requests with text >~18K chars. Yiddish speech runs ~15 chars/second.
  // Hard cap at 17000 to stay safely under RunPod's limit regardless of audio duration.
  const RUNPOD_TEXT_LIMIT = 17000;
  const estimatedMaxChars = audioDuration > 0 ? Math.ceil(audioDuration * 15) + 2000 : 12000;
  const maxChars = Math.min(estimatedMaxChars, RUNPOD_TEXT_LIMIT);
  const lastSpace = alignText.lastIndexOf(' ', maxChars);
  const boundedText = alignText.length > maxChars
    ? alignText.slice(0, lastSpace > 0 ? lastSpace : maxChars)
    : alignText;
  if (boundedText.length < alignText.length) {
    console.warn(`[Align] Text truncated from ${alignText.length} to ${boundedText.length} chars (audio ~${Math.round(audioDuration)}s)`);
  }

  const requestBody = JSON.stringify(
    audioResult.audioUrl
      ? {
          mode: 'align',
          audio_url: audioResult.audioUrl,
          ...(audioResult.trimStart > 0 ? { trim_start: audioResult.trimStart } : {}),
          ...(audioResult.trimEnd > 0 ? { trim_end: audioResult.trimEnd } : {}),
          ...(audioResult.audioDuration ? { audio_duration: audioResult.audioDuration } : {}),
          text: boundedText,
          language: 'yi',
        }
      : { mode: 'align', audio_base64: audioResult.base64, audio_format: audioResult.format, text: boundedText, language: 'yi' }
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
  // Also store on the specific version if provided
  if (versionId) {
    setVersionAlignment(audioId, versionId, alignment);
  }
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
