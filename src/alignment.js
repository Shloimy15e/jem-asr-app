import { updateState, setVersionAlignment } from './state.js';
import { isLibraryR2Url } from './auth.js';

const ALIGN_ENDPOINT = '/api/align';

// Keep chunks short so the model recovers from confusion zones naturally.
// WAV slicing (fetchAndDecodeFullAudio + sliceToWavBase64) ensures no
// frame-boundary drift between chunks.
const CHUNK_LIMIT = 15000;

// ── Aligner selection ────────────────────────────────────────────────────
// 'stable-ts'        → legacy align.kohnai.ai pod. Browser chunks + anchor calibration.
// 'ivrit-iterative'  → new RunPod pod (chevreman/ivrit-iterative-aligner). Pod downloads
//                      audio itself and runs iterative alignment with confusion recovery.
//                      No browser-side chunking — the pod handles long audio internally.

export const ALIGNER_OPTIONS = [
  { value: 'stable-ts',       label: 'stable-ts (legacy, chunked)' },
  { value: 'ivrit-iterative', label: 'ivrit-iterative (long audio)' },
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

// Fetch the full audio file and decode it to an AudioBuffer in the browser.
// R2 URLs go through the /api/audio proxy to avoid CORS issues.
async function fetchAndDecodeFullAudio(url) {
  const fetchUrl = isLibraryR2Url(url)
    ? `/api/audio?url=${encodeURIComponent(url)}`
    : url;

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Failed to fetch full audio: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (e) {
    await audioCtx.close().catch(() => {});
    throw new Error(`Audio decode failed for ${url.substring(0, 60)}`);
  }
  await audioCtx.close();
  return decoded;
}

// Extract a time range from an AudioBuffer as a 16 kHz mono WAV base64 string.
// Produces a clean WAV with proper headers — no frame-boundary issues.
async function sliceToWavBase64(audioBuffer, startSec, endSec) {
  const sr = audioBuffer.sampleRate;
  const startSample = Math.floor(startSec * sr);
  const endSample = endSec > 0
    ? Math.min(Math.floor(endSec * sr), audioBuffer.length)
    : audioBuffer.length;
  const sliceLen = Math.max(1, endSample - startSample);

  const TARGET_SR = 16000;
  const targetLen = Math.ceil(sliceLen / sr * TARGET_SR);
  const offCtx = new OfflineAudioContext(1, targetLen, TARGET_SR);
  const tmpBuf = new AudioBuffer({
    length: sliceLen,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: sr,
  });
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    tmpBuf.copyToChannel(
      audioBuffer.getChannelData(ch).subarray(startSample, startSample + sliceLen),
      ch,
    );
  }
  const src = offCtx.createBufferSource();
  src.buffer = tmpBuf;
  src.connect(offCtx.destination);
  src.start();
  const resampled = await offCtx.startRendering();

  const wavBlob = audioBufferToWavBlob(resampled);
  return blobToBase64(wavBlob);
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
        headers: { 'Content-Type': 'application/json' },
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
  // calibration was removed because the calibration used chunk N's last ~20 words
  // as ground truth, but those words suffer from end-of-chunk boundary inflation
  // (~18-19s late). The median of inflated anchors becomes the calibration delta,
  // which then shifts every word in chunk N+1 forward by the inflation amount —
  // and the error rides forward through all subsequent chunks.
  //
  // For R2 audio, the pod downloads directly (no size limit). For non-R2 audio,
  // the CF Worker base64-encodes the whole file; 38 min of MP3 ≈ 35MB base64, still
  // under the 128MB Worker body limit.
  const chunks = [alignText];
  console.log(`[Align] ${aligner} — single-request (no browser chunking); text=${alignText.length}c, audio=${Math.round(audioDuration)}s`);

  const effectiveEnd = trimEnd > 0 ? trimEnd : audioDuration;

  // For multi-chunk alignment, VBR MP3 byte-seeking can be inaccurate mid-file.
  //
  // Fix (two parts):
  // 1. CF Worker detects corrupt (flat) XING TOC and falls back to byte-proportional,
  //    giving an accurate short clip starting just before the chunk boundary.
  // 2. The last ANCHOR_COUNT words of chunk N are prepended to chunk N+1's text.
  //    RunPod aligns them first; comparing their timestamps against chunk N's known
  //    timestamps gives the residual byte-seeking error (calibration), which is then
  //    applied to all of chunk N+1's timestamps.
  //
  // The audio clip starts ANCHOR_PRE_BUFFER seconds before the first anchor word so
  // the clip is short (~500s). A short clip prevents RunPod from false-matching to
  // unrelated speech that appears earlier in the recording.
  const ANCHOR_COUNT = 20;         // words to borrow from previous chunk
  const ANCHOR_PRE_BUFFER = 20;    // seconds of audio before first anchor word
  const BOUNDARY_GAP_THRESHOLD = 5; // seconds — inter-word gap larger than this = inflation artifact
  const BOUNDARY_MAX_POPS = 3;     // cap pops at a boundary so real pauses don't eat legit words

  // Decode the full audio in the browser when we need frame-accurate slicing:
  //   (a) multi-chunk non-R2 (original case — no URL handoff available), or
  //   (b) R2 with trim_start > 0 (split file). For (b), the CF Worker's XING
  //       VBR TOC byte-seek is approximate and can land ~1–2s off trim_start,
  //       so chip timestamps would be consistently 1-2s earlier than reality
  //       across the whole split. Browser-side AudioContext decoding handles
  //       VBR correctly and slices at exact sample boundaries, so the clip
  //       the pod receives starts at exactly trim_start.
  let fullAudioBuffer = null;
  const needsPreciseTrim = trimStart > 0 && isLibraryR2Url(url);
  if ((chunks.length > 1 && !isLibraryR2Url(url)) || needsPreciseTrim) {
    const reason = needsPreciseTrim
      ? `R2 split (trim_start=${trimStart}s): decoding in browser for frame-accurate slice`
      : 'Multi-chunk (non-R2): decoding full audio in browser for frame-accurate slicing';
    console.log(`[Align] ${reason}…`);
    fullAudioBuffer = await fetchAndDecodeFullAudio(url);
  }

  let allWords = [];
  let chunkAudioStart = trimStart;
  let prevChunkWords = null;

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

    let requestText = chunk;
    let anchorCount = 0;
    let audioStart = chunkAudioStart;

    if (i > 0 && prevChunkWords && prevChunkWords.length >= ANCHOR_COUNT) {
      const anchors = prevChunkWords.slice(-ANCHOR_COUNT);
      requestText = anchors.map(w => w.word).join(' ') + ' ' + chunk;
      anchorCount = ANCHOR_COUNT;
      // Start audio just before the anchor words so:
      // - The clip is short (~500s) → RunPod can't false-match to unrelated early speech
      // - Anchors appear near the beginning of the clip → accurate alignment
      // The CF Worker uses byte-proportional for corrupt VBR TOCs, so this trim is reliable.
      audioStart = Math.max(trimStart, anchors[0].start - ANCHOR_PRE_BUFFER);
    }

    console.log(`[Align${chunkLabel}] audioStart=${audioStart.toFixed(1)}s chunkAudioEnd=${chunkAudioEnd || 'eof'} anchorCount=${anchorCount}`);

    let audioResult;
    if (fullAudioBuffer) {
      // Multi-chunk: slice a proper WAV from the decoded audio (frame-accurate)
      const wavBase64 = await sliceToWavBase64(fullAudioBuffer, audioStart, chunkAudioEnd || fullAudioBuffer.duration);
      audioResult = { base64: wavBase64, format: '.wav' };
    } else {
      // Single-chunk: use the existing CF Worker path
      audioResult = await fetchAudioForAlignment(url, audioStart, chunkAudioEnd, audioDuration);
    }
    const requestBody = buildRequestBody(audioResult, requestText, aligner);
    const data = await doAlignRequest(requestBody, chunkLabel, onProgress);

    let rawWords = data.timestamps || [];
    if (rawWords.length === 0 && data.segments) {
      rawWords = data.segments.flatMap(seg => seg.words || []);
    }

    console.log(`[Align${chunkLabel}] RunPod returned ${rawWords.length} words; first=${JSON.stringify(rawWords[0])}, last=${JSON.stringify(rawWords[rawWords.length - 1])}`);

    const chunkWords = rawWords.map(t => ({
      word: t.word || t.text || '',
      start: (t.start || 0) + audioStart,
      end: (t.end || 0) + audioStart,
      confidence: t.confidence ?? t.probability ?? t.score ?? 0,
    }));

    let wordsToAdd;

    if (i > 0 && anchorCount > 0 && prevChunkWords && chunkWords.length > anchorCount) {
      // Compute calibration: median of (chunk_N_anchor_time - chunk_N+1_anchor_time).
      // Median resists outliers from boundary-inflated anchor words.
      const anchors = prevChunkWords.slice(-anchorCount);
      const diffs = anchors.map((a, k) => a.start - chunkWords[k].start);
      const sorted = [...diffs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const calibration = sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;

      if (Math.abs(calibration) < 400) {
        console.log(`[Align${chunkLabel}] Calibration: ${calibration.toFixed(2)}s`);
        const calibrated = chunkWords.map(w => ({
          ...w, start: w.start + calibration, end: w.end + calibration,
        }));
        // Replace the last anchorCount words in allWords with the calibrated chunk N+1
        // versions (chunk N's boundary timestamps are inflated by the audio buffer;
        // chunk N+1's calibrated versions are more accurate).
        allWords = allWords.slice(0, allWords.length - anchorCount);
        // Also trim any residual original words that are later than the first calibrated
        // anchor — the cut point may have left an inflated word just before the boundary.
        if (calibrated.length > 0) {
          while (allWords.length > 0 && allWords[allWords.length - 1].start > calibrated[0].start) {
            allWords.pop();
          }
        }
        allWords = allWords.concat(calibrated.slice(0, anchorCount));
        wordsToAdd = calibrated.slice(anchorCount);
      } else {
        console.warn(`[Align${chunkLabel}] Calibration out of range (${calibration.toFixed(2)}s) — keeping anchor words uncalibrated to avoid loss`);
        // Drop the inflated tail of the previous chunk (those timestamps are wrong),
        // but KEEP the current chunk's re-aligned anchor words — they may be off by
        // the uncalibrated drift, but the words themselves must not be lost.
        allWords = allWords.slice(0, allWords.length - anchorCount);
        let popped = 0;
        while (allWords.length >= 2 && popped < BOUNDARY_MAX_POPS) {
          const last = allWords[allWords.length - 1];
          const prev = allWords[allWords.length - 2];
          if (last.start - prev.start > BOUNDARY_GAP_THRESHOLD) { allWords.pop(); popped++; }
          else break;
        }
        wordsToAdd = chunkWords;
      }
    } else {
      // No anchors: trim inflated boundary words using gap detection before merging.
      if (i > 0 && allWords.length >= 2) {
        let popped = 0;
        while (allWords.length >= 2 && popped < BOUNDARY_MAX_POPS) {
          const last = allWords[allWords.length - 1];
          const prev = allWords[allWords.length - 2];
          if (last.start - prev.start > BOUNDARY_GAP_THRESHOLD) { allWords.pop(); popped++; }
          else break;
        }
      }
      wordsToAdd = chunkWords;
    }

    allWords = allWords.concat(wordsToAdd);
    prevChunkWords = wordsToAdd;

    if (allWords.length > 0) {
      chunkAudioStart = allWords[allWords.length - 1].end;
    } else {
      chunkAudioStart = chunkAudioEnd || effectiveEnd;
    }
  }

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

const TRANSCRIBE_ENDPOINT = '/api/transcribe';

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
  } else if (provider === 'mendel') {
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
