import { updateState, setVersionAlignment } from './state.js';
import { isLibraryR2Url, getAccessToken } from './auth.js';

// Build common headers for billing-aware /api endpoints. Includes the
// Supabase access token so the Worker can pre-flight credits and meter usage
// against the caller's org. When unauthenticated (e.g. desktop / staff
// scripts) the Worker treats the request as internal and skips metering.
async function billingHeaders(extra = {}) {
  const token = await getAccessToken().catch(() => null);
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Throw a billing-aware error that pages can catch and route to /billing.html.
async function throwForResponse(response, label) {
  let body = null;
  try { body = await response.clone().json(); } catch {}
  const errText = (body && body.error) || (await response.text().catch(() => '')) || '';
  if (response.status === 402) {
    const err = new Error(body?.error || 'Insufficient credits — open Billing to top up.');
    err.code = 'INSUFFICIENT_CREDITS';
    err.status = 402;
    err.balance = body?.balance_micro_usd ?? null;
    throw err;
  }
  throw new Error(`${label} ${response.status}: ${errText}`);
}

const ALIGN_ENDPOINT = '/api/align';

// Soft cap on alignment text length for splitTextIntoChunks (used downstream
// when we hand text off to the aligner pod, not for audio chunking).
const CHUNK_LIMIT = 15000;

// ── Aligner selection ────────────────────────────────────────────────────
// 'stable-ts'        → align.kohnai.ai pod for untrimmed; RunPod trim pod
//                      (STABLE_TS_TRIM_ENDPOINT_ID) for trimmed. Single request,
//                      no browser-side chunking.
// 'ivrit-iterative'  → RunPod pod (chevreman/ivrit-iterative-aligner). Runs
//                      iterative alignment with confusion recovery.

export const ALIGNER_OPTIONS = [
  { value: 'stable-ts',       label: 'stable-ts' },
  { value: 'ivrit-iterative', label: 'ivrit-iterative' },
];
const ALIGNER_STORAGE_KEY = 'jem-aligner-choice';

export function getAlignerChoice() {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(ALIGNER_STORAGE_KEY) : null;
  return v === 'ivrit-iterative' ? 'ivrit-iterative' : 'stable-ts';
}

export function setAlignerChoice(value) {
  if (value !== 'stable-ts' && value !== 'ivrit-iterative') return;
  localStorage.setItem(ALIGNER_STORAGE_KEY, value);
}

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
export async function fetchAudioForAlignment(url, trimStart, trimEnd, audioDuration) {
  // For all R2 audio, always pass trim params to the CF Worker so it uses range-fetch
  // instead of loading the entire file into memory (which exceeds Worker resource limits).
  if (isLibraryR2Url(url)) {
    return {
      audioUrl: url,
      trimStart: trimStart || 0,
      trimEnd: trimEnd || undefined,
      audioDuration: audioDuration || undefined,
    };
  }
  const hasTrim = (trimStart > 0) || (trimEnd > 0);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Audio not on R2 — set r2_link in Supabase for this file (${url.substring(0, 60)})`);
  }
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
  let decoded;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (e) {
    await audioCtx.close().catch(() => {});
    throw new Error("Audio decode failed (URL returned non-audio data). Set r2_link in Supabase for " + url.substring(0, 60));
  }
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

// Split text into chunks of at most `limit` chars, splitting at word boundaries.
function splitTextIntoChunks(text, limit = CHUNK_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    const end = pos + limit;
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
export async function doAlignRequest(requestBody, chunkLabel, onProgress) {
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
        headers: await billingHeaders(),
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`[Align${chunkLabel}] Network error on attempt ${attempt}/${MAX_RETRIES}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        if (onProgress) onProgress(attempt, MAX_RETRIES);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`Alignment network error after ${MAX_RETRIES} attempts: ${err.message}`);
    }
    clearTimeout(timeoutId);
    // Billing pre-flight failure — surface with the special code so callers
    // can redirect to /billing.html instead of generic-erroring.
    if (response.status === 402) {
      await throwForResponse(response, `Alignment${chunkLabel}`);
    }
    if (response.status === 502 || response.status === 504) {
      console.warn(`[Align${chunkLabel}] Got ${response.status} on attempt ${attempt}/${MAX_RETRIES} — retrying in ${RETRY_DELAY_MS / 1000}s...`);
      if (attempt < MAX_RETRIES) {
        if (onProgress) onProgress(attempt, MAX_RETRIES);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    }
    // HTTP/2 stream resets: CF edge returns 400 with "goaway or rst_stream" HTML.
    // Read the body to detect this — it's transient, not a real bad request.
    if (response.status === 400) {
      const body400 = await response.text().catch(() => '');
      if (body400.includes('goaway') || body400.includes('rst_stream')) {
        console.warn(`[Align${chunkLabel}] HTTP/2 stream reset on attempt ${attempt}/${MAX_RETRIES} — retrying...`);
        if (attempt < MAX_RETRIES) {
          if (onProgress) onProgress(attempt, MAX_RETRIES);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
      }
      throw new Error(`Alignment API error 400: ${body400}`);
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
export function buildRequestBody(audioResult, chunkText, aligner = 'stable-ts') {
  return JSON.stringify(
    audioResult.audioUrl
      ? {
          mode: 'align',
          aligner,
          audio_url: audioResult.audioUrl,
          ...(audioResult.trimStart != null ? { trim_start: audioResult.trimStart } : {}),
          ...(audioResult.trimEnd != null && audioResult.trimEnd > 0 ? { trim_end: audioResult.trimEnd } : {}),
          ...(audioResult.audioDuration ? { audio_duration: audioResult.audioDuration } : {}),
          text: chunkText,
          language: 'yi',
        }
      : { mode: 'align', aligner, audio_base64: audioResult.base64, audio_format: audioResult.format, text: chunkText, language: 'yi' }
  );
}

// Normalize a word for comparison: strip punctuation/symbols/whitespace, lowercase.
// Works across Latin, Hebrew, and Yiddish scripts.
function normWord(s) {
  if (!s) return '';
  return s.replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
}

// Reconcile the aligner's output against the original input text so that every
// input word is preserved — even ones the aligner couldn't match to audio.
// Missing words get inserted as zero-confidence placeholders with neighbor
// timestamps so they remain in the editor text and in future realign inputs.
function reconcileAlignedWithInput(alignText, alignedWords) {
  const inputTokens = alignText.trim().split(/\s+/).filter(t => t.length > 0);
  if (inputTokens.length === 0) return alignedWords;
  if (!alignedWords || alignedWords.length === 0) {
    return inputTokens.map(w => ({
      word: w, start: 0, end: 0, confidence: 0, unaligned: true,
    }));
  }

  const LOOKAHEAD = 8;
  const result = [];
  let ai = 0;

  for (let ii = 0; ii < inputTokens.length; ii++) {
    const inp = inputTokens[ii];
    const inpNorm = normWord(inp);

    // Direct match: aligner word at current position equals input word.
    if (ai < alignedWords.length && normWord(alignedWords[ai].word) === inpNorm) {
      result.push(alignedWords[ai]);
      ai++;
      continue;
    }

    // Look ahead: maybe aligner emitted extra words (e.g. anchor residue) before
    // the next real match. Walk up to LOOKAHEAD words forward.
    let foundAt = -1;
    for (let la = ai + 1; la < Math.min(ai + 1 + LOOKAHEAD, alignedWords.length); la++) {
      if (normWord(alignedWords[la].word) === inpNorm) { foundAt = la; break; }
    }

    if (foundAt !== -1) {
      for (let la = ai; la <= foundAt; la++) result.push(alignedWords[la]);
      ai = foundAt + 1;
    } else {
      // Input word absent from aligner output — insert a placeholder so it
      // survives to the editor text and future realigns.
      const prevEnd = result.length > 0 ? (result[result.length - 1].end || 0) : 0;
      const nextStart = ai < alignedWords.length ? (alignedWords[ai].start || prevEnd) : prevEnd;
      const t = prevEnd || nextStart || 0;
      result.push({
        word: inp,
        start: t,
        end: Math.max(t, nextStart || t),
        confidence: 0,
        unaligned: true,
      });
    }
  }

  // Flush any trailing aligner words (defensive — should be rare).
  while (ai < alignedWords.length) {
    result.push(alignedWords[ai]);
    ai++;
  }

  return result;
}

export async function alignRow(audioId, state, textOverride = null, versionId = null, onProgress = null, opts = {}) {
  const url = getAudioUrl(audioId, state);
  if (!url) throw new Error(`No audio URL for ${audioId}`);

  const rawAlignText = textOverride || state.cleaning[audioId]?.cleanedText;
  if (!rawAlignText) {
    throw new Error(`No text for alignment for ${audioId}`);
  }
  // Strip lone surrogates (encoding artifact in imported transcripts) that crash
  // JSON.stringify with "The string did not match the expected pattern." in Safari.
  const alignText = rawAlignText.replace(/[�-�]/gu, "");

  const aligner = getAlignerChoice();

  const trim = state.trims?.[audioId] || {};
  // opts.trimStartOverride / opts.trimEndOverride let callers (e.g. alignFromWord)
  // pin the alignment to a sub-range without mutating the saved user trim.
  const trimStart = opts.trimStartOverride ?? (trim.start || 0);
  const trimEnd   = opts.trimEndOverride   ?? (trim.end   || 0);

  const audioEntry = state.audio.find(a => a.id === audioId);
  const audioDuration = (audioEntry?.estMinutes || 0) * 60;

  // Single-request path for both aligners. Browser-side chunking + anchor-word
  // calibration was removed because the calibration used end-of-chunk timestamps
  // that are systematically inflated by the aligner, producing a uniform ~19s
  // drift in every downstream chunk. The align.kohnai.ai pod (for stable-ts) and
  // the ivrit-iterative pod both handle long audio internally — no chunking
  // needed on the client.
  //
  // For R2 audio, the pod downloads directly (no size limit). For non-R2 audio,
  // the CF Worker base64-encodes the whole file; 38 min of MP3 ≈ 35 MB base64,
  // well under the 128 MB Worker body limit.
  console.log(`[Align] ${aligner} — single-request; text=${alignText.length}c, audio=${Math.round(audioDuration)}s`);

  // TODO (drift): For trimmed R2 alignments, the CF Worker's XING VBR TOC
  // byte-seek is approximate and can land ~1–2s off the intended trim_start.
  // We tried browser-side AudioContext decode + WAV slice to get frame-accurate
  // output, but the resulting base64 WAV is 2.5× the MP3 size, pushing payloads
  // past the pod's ~20 MB body limit on long audio and causing hard 400s.
  // Proper fix: either an in-browser MP3 encoder (lamejs), or pod-side trim
  // support. Until then we accept the sub-2s drift.
  const audioResult = await fetchAudioForAlignment(url, trimStart, trimEnd, audioDuration);

  const requestBody = buildRequestBody(audioResult, alignText, aligner);
  const data = await doAlignRequest(requestBody, '', onProgress);

  let rawWords = data.timestamps || [];
  if (rawWords.length === 0 && data.segments) {
    rawWords = data.segments.flatMap(seg => seg.words || []);
  }

  console.log(`[Align] Pod returned ${rawWords.length} words; first=${JSON.stringify(rawWords[0])}, last=${JSON.stringify(rawWords[rawWords.length - 1])}`);

  // Shift pod-returned timestamps to absolute file time. Untrimmed full-file
  // alignments have trimStart=0, so this is a no-op; trimmed paths (R2 WAV
  // slice, non-R2 AudioContext slice, CF Worker XING slice) send clips where
  // pod-time 0 corresponds to real-time trimStart, so we add trimStart back.
  let allWords = rawWords.map(t => ({
    word: t.word || t.text || '',
    start: (t.start || 0) + trimStart,
    end: (t.end || 0) + trimStart,
    confidence: t.confidence ?? t.probability ?? t.score ?? 0,
  }));

  // Snapshot the raw aligner output *before* reconciliation so the review UI
  // can show exactly what the aligner timestamped vs. what was backfilled.
  const rawAlignerWords = allWords.slice();
  // Reconcile aligner output against the original input text. Any input word
  // the aligner dropped gets re-inserted as a zero-confidence placeholder so
  // it stays in the editor's plain text and survives future realigns.
  const reconciledBefore = allWords.length;
  allWords = reconcileAlignedWithInput(alignText, allWords);
  const unalignedCount = allWords.filter(w => w.unaligned).length;
  if (unalignedCount > 0) {
    console.warn(`[Align] Reconciled ${unalignedCount} input word(s) the aligner did not match (aligner returned ${reconciledBefore}, input had ${allWords.length})`);
  }

  // Partial re-align: keep existing words[0..mergeFromIndex-1] and append the
  // freshly-aligned tail. Used by alignFromWord to fix a problematic mid-audio
  // region without re-aligning the whole file.
  let finalWords = allWords;
  if (opts.mergeFromIndex != null) {
    const existing = state.alignments?.[audioId];
    const prior = (existing && Array.isArray(existing.words)) ? existing.words : [];
    const kept = prior.slice(0, opts.mergeFromIndex);
    finalWords = kept.concat(allWords);
  }

  const totalConf = finalWords.reduce((sum, w) => sum + (w.confidence || 0), 0);
  const avgConfidence = finalWords.length > 0 ? totalConf / finalWords.length : 0;
  const lowConfidenceCount = finalWords.filter(w => (w.confidence || 0) < 0.4).length;

  const priorAlignment = state.alignments?.[audioId];
  // For a partial merge, keep the prior rawWords intact — the partial only
  // re-aligns the tail and we don't want to drop prior raw data.
  const rawWordsForAlignment = (opts.mergeFromIndex != null && Array.isArray(priorAlignment?.rawWords))
    ? priorAlignment.rawWords.slice(0, opts.mergeFromIndex).concat(rawAlignerWords)
    : rawAlignerWords;
  const alignment = {
    words: finalWords,
    rawWords: rawWordsForAlignment,
    avgConfidence,
    lowConfidenceCount,
    alignedAt: new Date().toISOString(),
    // On a partial merge preserve the original saved trim; the override only
    // affected this one request.
    trimStart: (opts.mergeFromIndex != null ? priorAlignment?.trimStart : (trimStart || undefined)),
    trimEnd:   (opts.mergeFromIndex != null ? priorAlignment?.trimEnd   : (trimEnd   || undefined)),
    aligner, // which pod produced this alignment (of the tail, for partial merges)
    ...(opts.mergeFromIndex != null ? { lastPartialFromIndex: opts.mergeFromIndex } : {}),
  };

  updateState('alignments', audioId, alignment);
  if (versionId) {
    setVersionAlignment(audioId, versionId, alignment);
  }
  return alignment;
}

// Partial re-align from a specific word to the end of the audio. Keeps words
// 0..wordIndex-1 as-is, re-aligns the rest starting from the anchor's timestamp.
export async function alignFromWord(audioId, state, wordIndex, versionId = null, onProgress = null) {
  const existing = state.alignments?.[audioId];
  if (!existing || !Array.isArray(existing.words) || !existing.words[wordIndex]) {
    throw new Error('No alignment word at that index to re-align from');
  }
  const anchor = existing.words[wordIndex];
  if (!(anchor.start >= 0)) {
    throw new Error('Anchor word has no valid start timestamp');
  }

  const fullText = (state.cleaning[audioId]?.cleanedText || '').replace(/[�-�]/gu, '');
  if (!fullText.trim()) throw new Error('No cleaned text available for re-alignment');

  // Input tokens are 1:1 with alignment.words (reconcileAlignedWithInput preserves mapping).
  const tokens = fullText.trim().split(/\s+/).filter(t => t.length > 0);
  if (wordIndex >= tokens.length) {
    throw new Error(`Anchor index ${wordIndex} out of range (text has ${tokens.length} tokens)`);
  }
  const partialText = tokens.slice(wordIndex).join(' ');

  // Run alignment with trim_start pinned just slightly before the anchor so the
  // first word isn't clipped. 1 s pre-buffer is enough for phoneme onset.
  const PRE_BUFFER = 1.0;
  const trimStartOverride = Math.max(0, anchor.start - PRE_BUFFER);

  return alignRow(
    audioId,
    state,
    partialText,
    versionId,
    onProgress,
    {
      trimStartOverride,
      trimEndOverride: 0,          // go to end of audio
      mergeFromIndex: wordIndex,   // keep words[0..wordIndex-1] intact
    },
  );
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

const TRANSCRIBE_ENDPOINT        = '/api/transcribe';
const TRANSCRIBE_STATUS_ENDPOINT = '/api/transcribe-status';
const ALIGN_STATUS_ENDPOINT      = '/api/align-status';

// ── Gemini long-audio: async kickoff + poll ──────────────────────────────
// Cloudflare Pages Functions cap each request at ~60 s wall time and Vertex
// fine-tuned-endpoint inference (Jem-1 V2 ckpt9) commonly exceeds that for
// audio longer than ~7 min. The Pages function `/api/transcribe` therefore
// no longer calls Vertex inline; it enqueues a job onto the gemini-asr-jobs
// queue and returns 202 with a job_id. A separate consumer worker
// (workers/gemini-consumer) handles R2 -> GCS upload -> Vertex without the
// edge cap, then writes the result into KV. The browser polls
// /api/transcribe-status which reads from KV.
//
// This replaces the previous browser-side chunking entirely. No more WAV
// decode, no more chunk uploads to R2, no more boundary-word stitching.

// Long-job client polling. Cloudflare's edge cuts off any single Pages
// Function response after ~100 s, so the worker hands us a job_id and we
// poll a status endpoint until the provider reports completion. The
// interval is conservative — Mendel/RunPod jobs typically complete in
// minutes, not seconds, so we don't waste calls.
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_TRIES   = 240;  // 240 × 5s = 20 minutes ceiling

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntilTerminal(statusUrl, label) {
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await sleep(POLL_INTERVAL_MS);
    let resp;
    try {
      resp = await fetch(statusUrl, { headers: await billingHeaders() });
    } catch (err) {
      // Transient network errors: log & retry. Bail if we've exhausted tries.
      console.warn(`[${label}] poll fetch error:`, err);
      continue;
    }
    if (resp.status === 402) {
      // Mid-job credit denial — surface immediately.
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Insufficient credits during job');
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `${label} status ${resp.status}`);
    }
    const data = await resp.json().catch(() => ({}));
    if (data.status === 'completed') return data;
    if (data.status === 'failed') throw new Error(data.error || `${label} job failed`);
    // status === 'processing' (or anything else) → keep polling
  }
  throw new Error(`${label} timed out after ${(POLL_MAX_TRIES * POLL_INTERVAL_MS) / 60000} min of client polling`);
}

/**
 * Transcribe audio using one of the supported providers.
 *
 * @param {string} audioId - Audio file ID (unused in request, kept for caller convenience)
 * @param {string} audioUrl - URL of the audio file (R2 or Drive)
 * @param {object} config - Provider config from state.transcribeProviders[provider]
 * @param {'gemini'|'whisper'|'mendel'} config.provider
 * @param {string} [config.apiKey]    - API key for gemini or mendel
 * @param {string} [config.modelId]   - Gemini model ID (numeric for fine-tuned)
 * @param {string} [config.endpoint]  - Custom endpoint for mendel (optional)
 * @returns {Promise<string>} Transcription text
 */
export async function transcribeAudio(audioId, audioUrl, config) {
  const { provider } = config;
  if (!provider) throw new Error('transcribeAudio: missing provider in config');

  const audioResult = await fetchAudioForAlignment(audioUrl, 0, 0);

  const audioFields = audioResult.audioUrl
    ? { audio_url: audioResult.audioUrl }
    : { audio_base64: audioResult.base64, audio_format: audioResult.format || '.mp3' };

  // Whisper: route through existing align endpoint with mode:'transcribe'.
  // The worker now kicks off a RunPod job and returns 202 with a job_id;
  // we poll /api/align-status from the browser until the pod completes.
  if (provider === 'whisper') {
    const response = await fetch(ALIGN_ENDPOINT, {
      method: 'POST',
      headers: await billingHeaders(),
      body: JSON.stringify({
        mode: 'transcribe',
        ...audioFields,
        language: 'yi',
        ...(audioId ? { audio_id: audioId } : {}),
      }),
    });
    if (response.status === 402) await throwForResponse(response, 'Whisper');
    if (!response.ok) {
      // Surface the JSON error.message verbatim when the Worker emitted one
      // (e.g. the 503 "RunPod queue saturated" message) so the user sees a
      // useful, actionable string instead of a status-prefixed text dump.
      const errJson = await response.clone().json().catch(() => null);
      if (errJson && errJson.error) throw new Error(errJson.error);
      const errText = await response.text().catch(() => '');
      throw new Error(`Whisper transcription error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    if (data.status === 'processing' && data.job_id) {
      const params = new URLSearchParams({
        job_id: data.job_id,
        endpoint_label: data.endpoint_label || 'stable-ts',
        ...(data.usage_id ? { usage_id: data.usage_id } : {}),
        ...(data.audio_seconds ? { audio_seconds: String(data.audio_seconds) } : {}),
      });
      const done = await pollUntilTerminal(`${ALIGN_STATUS_ENDPOINT}?${params}`, 'Whisper');
      const text = (done.text || done.output?.text || done.output?.full_text || done.output?.transcription || '').trim();
      if (!text) throw new Error('Whisper completed but returned no text');
      return text;
    }
    // stable-whisper sync return: { text, segments, ... }
    return (data.text || data.full_text || data.transcription || '').trim();
  }

  // Gemini and Mendel: route through /api/transcribe CF Worker
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
    // Optional per-call user-turn prompt — Worker falls back to default if missing.
    if (typeof config.prompt === 'string' && config.prompt.trim().length > 0) {
      providerPayload.gemini_prompt = config.prompt;
    }
    // Optional systemInstruction — sent as a top-level Vertex field, separate
    // from the user prompt. See buildGeminiRequestBody in functions/api/transcribe.js.
    if (typeof config.systemInstruction === 'string' && config.systemInstruction.trim().length > 0) {
      providerPayload.gemini_system_instruction = config.systemInstruction;
    }
  } else if (provider === 'mendel') {
    providerPayload = {
      ...(config.endpoint ? { yl_endpoint: config.endpoint } : {}),
    };
    // Mendel `context` form field — the YL bias-vocabulary lever (analog of
    // an OpenAI Whisper initial_prompt). Wired off the same UI textarea as
    // gemini_prompt so the user only fills it once.
    if (typeof config.prompt === 'string' && config.prompt.trim().length > 0) {
      providerPayload.mendel_context = config.prompt;
    }
    if (config.rapid === true) providerPayload.mendel_rapid = true;
    if (config.timestamps === true) providerPayload.mendel_timestamps = true;
    if (typeof config.language === 'string' && config.language.trim().length > 0) {
      providerPayload.mendel_language = config.language;
    }
  } else {
    throw new Error(`Unknown transcription provider: ${provider}`);
  }

  // Both Gemini and Mendel use the async kickoff pattern — /api/transcribe
  // enqueues / forwards the job and returns 202 with a job_id; the Worker
  // never calls the slow upstream synchronously. We then poll
  // /api/transcribe-status until the provider reports completed/failed.
  const response = await fetch(TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: await billingHeaders(),
    body: JSON.stringify({
      provider,
      ...audioFields,
      ...providerPayload,
      ...(audioId ? { audio_id: audioId } : {}),
      ...(typeof config.audioDurationSec === 'number' ? { audio_duration_seconds: config.audioDurationSec } : {}),
    }),
  });

  if (response.status === 402) await throwForResponse(response, provider);
  if (!response.ok) {
    // Surface the JSON error.message verbatim when the Worker emitted one.
    const errJson = await response.clone().json().catch(() => null);
    if (errJson && errJson.error) throw new Error(errJson.error);
    const errText = await response.text().catch(() => '');
    throw new Error(`Transcription error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  if (data.status === 'processing' && data.job_id) {
    const params = new URLSearchParams({
      provider,
      job_id: data.job_id,
      ...(data.usage_id ? { usage_id: data.usage_id } : {}),
      ...(data.audio_seconds ? { audio_seconds: String(data.audio_seconds) } : {}),
    });
    const done = await pollUntilTerminal(`${TRANSCRIBE_STATUS_ENDPOINT}?${params}`, provider);
    const text = (done.text || '').trim();
    if (!text) throw new Error(`${provider} completed but returned no text`);
    return text;
  }
  return (data.text || '').trim();
}

// (Browser-side Gemini chunking removed — long-audio is now handled by the
// gemini-asr-jobs queue + workers/gemini-consumer GCS bridge. See the
// "Gemini long-audio" comment block above.)
