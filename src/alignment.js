import { updateState, setVersionAlignment } from './state.js';

const ALIGN_ENDPOINT = '/api/align';

// RunPod rejects text longer than ~18K chars. Stay safely under that.
const CHUNK_LIMIT = 15000;

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

// Split text into chunks of at most CHUNK_LIMIT chars, splitting at word boundaries.
function splitTextIntoChunks(text) {
  if (text.length <= CHUNK_LIMIT) return [text];
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    const end = pos + CHUNK_LIMIT;
    if (end >= text.length) {
      chunks.push(text.slice(pos));
      break;
    }
    // Split at the last space before the limit
    const splitAt = text.lastIndexOf(' ', end);
    const chunkEnd = splitAt > pos ? splitAt : end;
    chunks.push(text.slice(pos, chunkEnd));
    pos = chunkEnd + 1;
  }
  return chunks;
}

// Send one alignment request to the CF Worker with retry logic.
// Returns the parsed response data object.
async function doAlignRequest(requestBody, chunkLabel) {
  const MAX_RETRIES = 15; // GPU cold start can take ~2.5 min; 15×10s = 150s covers it
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
      console.warn(`[Align${chunkLabel}] Network error on attempt ${attempt}/${MAX_RETRIES}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`Alignment network error after ${MAX_RETRIES} attempts: ${err.message}`);
    }
    clearTimeout(timeoutId);
    if (response.status === 502 || response.status === 504) {
      console.warn(`[Align${chunkLabel}] Got ${response.status} on attempt ${attempt}/${MAX_RETRIES} — retrying in ${RETRY_DELAY_MS / 1000}s...`);
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
  return response.json();
}

// Build the JSON request body for one alignment chunk.
function buildRequestBody(audioResult, chunkText) {
  return JSON.stringify(
    audioResult.audioUrl
      ? {
          mode: 'align',
          audio_url: audioResult.audioUrl,
          ...(audioResult.trimStart > 0 ? { trim_start: audioResult.trimStart } : {}),
          ...(audioResult.trimEnd > 0 ? { trim_end: audioResult.trimEnd } : {}),
          ...(audioResult.audioDuration ? { audio_duration: audioResult.audioDuration } : {}),
          text: chunkText,
          language: 'yi',
        }
      : { mode: 'align', audio_base64: audioResult.base64, audio_format: audioResult.format, text: chunkText, language: 'yi' }
  );
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

  const chunks = splitTextIntoChunks(alignText);

  if (chunks.length > 1) {
    console.log(`[Align] Text too long (${alignText.length} chars) — splitting into ${chunks.length} chunks (audio ~${Math.round(audioDuration)}s)`);
  }

  const effectiveEnd = trimEnd > 0 ? trimEnd : audioDuration;

  let allWords = [];
  let chunkAudioStart = trimStart;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLast = i === chunks.length - 1;
    const chunkLabel = chunks.length > 1 ? ` chunk ${i + 1}/${chunks.length}` : '';

    // For the last chunk, use the remaining audio. For intermediate chunks,
    // estimate the end proportionally from the remaining text/audio with a 30% buffer.
    let chunkAudioEnd;
    if (isLast) {
      chunkAudioEnd = trimEnd; // 0 = go to end of audio
    } else {
      const charsLeft = alignText.length - chunks.slice(0, i).reduce((s, c) => s + c.length + 1, 0);
      const fraction = chunk.length / charsLeft;
      const audioLeft = effectiveEnd - chunkAudioStart;
      chunkAudioEnd = Math.min(chunkAudioStart + audioLeft * fraction * 1.3, effectiveEnd);
    }

    const audioResult = await fetchAudioForAlignment(url, chunkAudioStart, chunkAudioEnd, audioDuration);
    const requestBody = buildRequestBody(audioResult, chunk);
    const data = await doAlignRequest(requestBody, chunkLabel);

    let rawWords = data.timestamps || [];
    if (rawWords.length === 0 && data.segments) {
      rawWords = data.segments.flatMap(seg => seg.words || []);
    }

    const chunkWords = rawWords.map(t => ({
      word: t.word || t.text || '',
      start: (t.start || 0) + chunkAudioStart,
      end: (t.end || 0) + chunkAudioStart,
      confidence: t.confidence ?? t.probability ?? t.score ?? 0,
    }));

    allWords = allWords.concat(chunkWords);

    // Use the actual last aligned word's end time as the next chunk's audio start.
    // This is more accurate than a proportional estimate.
    if (chunkWords.length > 0) {
      chunkAudioStart = chunkWords[chunkWords.length - 1].end;
    } else {
      chunkAudioStart = chunkAudioEnd || effectiveEnd;
    }
  }

  const totalConf = allWords.reduce((sum, w) => sum + (w.confidence || 0), 0);
  const avgConfidence = allWords.length > 0 ? totalConf / allWords.length : 0;
  const lowConfidenceCount = allWords.filter(w => (w.confidence || 0) < 0.4).length;

  const alignment = {
    words: allWords,
    avgConfidence,
    lowConfidenceCount,
    alignedAt: new Date().toISOString(),
    trimStart: trimStart || undefined,
    trimEnd: trimEnd || undefined,
  };

  updateState('alignments', audioId, alignment);
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

const TRANSCRIBE_ENDPOINT = '/api/transcribe';

/**
 * Transcribe audio using one of the supported providers.
 *
 * @param {string} audioId - Audio file ID (unused in request, kept for caller convenience)
 * @param {string} audioUrl - URL of the audio file (R2 or Drive)
 * @param {object} config - Provider config from state.transcribeProviders[provider]
 * @param {'gemini'|'whisper'|'yiddish-labs'} config.provider
 * @param {string} [config.apiKey]    - API key for gemini or yiddish-labs
 * @param {string} [config.modelId]   - Gemini model ID (numeric for fine-tuned)
 * @param {string} [config.endpoint]  - Custom endpoint for yiddish-labs (optional)
 * @returns {Promise<string>} Transcription text
 */
export async function transcribeAudio(audioId, audioUrl, config) {
  const { provider } = config;
  if (!provider) throw new Error('transcribeAudio: missing provider in config');

  const audioResult = await fetchAudioForAlignment(audioUrl, 0, 0);

  const audioFields = audioResult.audioUrl
    ? { audio_url: audioResult.audioUrl }
    : { audio_base64: audioResult.base64, audio_format: audioResult.format || '.mp3' };

  // Whisper: route through existing align endpoint with mode:'transcribe' (no text)
  if (provider === 'whisper') {
    const response = await fetch(ALIGN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'transcribe', ...audioFields, language: 'yi' }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Whisper transcription error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    // stable-whisper returns { text, segments, ... }
    return (data.text || data.full_text || data.transcription || '').trim();
  }

  // Gemini and Yiddish Labs: route through /api/transcribe CF Worker
  // Secrets (SA JSON, API keys) live in Cloudflare Worker env — never sent from the browser.
  // Only non-sensitive config is included in the payload.
  let providerPayload;
  if (provider === 'gemini') {
    if (!config.endpointId) throw new Error('Gemini requires an Endpoint ID — set it in ASR Settings');
    providerPayload = {
      gemini_project_id: config.projectId || '',
      gemini_region: config.region || 'us-central1',
      gemini_endpoint_id: config.endpointId,
    };
  } else if (provider === 'yiddish-labs') {
    providerPayload = {
      ...(config.endpoint ? { yl_endpoint: config.endpoint } : {}),
    };
  } else {
    throw new Error(`Unknown transcription provider: ${provider}`);
  }

  const response = await fetch(TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, ...audioFields, ...providerPayload }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Transcription error ${response.status}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}
