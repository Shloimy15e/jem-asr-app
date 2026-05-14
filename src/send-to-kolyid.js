// "Send to KolYid" outbound exporter.
//
// The browser already has audio metadata + alignment data loaded into state,
// so this module assembles the payload locally and POSTs it to
// /api/send-to-kolyid (a Cloudflare Worker that adds the cross-app bearer
// token + writes back tracking columns on success).
//
// Used by:
//   - the per-row button on the detail page
//   - the bulk-action-bar button on the index table
//
// On a successful 2xx response we mutate state.audio[idx].kolyidImported{At,By}
// and state.audio[idx].kolyidTranscriptUrl in place so the table badge appears
// immediately without reloading.

import { supabase } from './db.js';
import { loadAlignmentWords } from './db.js';
import { getActiveLibrary, getActiveLibraryConfig, getCurrentUser } from './auth.js';
import { getState } from './state.js';

/**
 * Treat only absolute http/https URLs as URL-shaped. Relative paths in
 * r2TranscriptLink (e.g. "transcripts-txt/foo.txt" for older imports) are
 * dropped from the payload — the receiver's `nullable | url` rule rejects
 * everything else.
 */
function isHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolve the transcript text we want to ship. Three places hold one, in
 * decreasing freshness order: the operator's in-flight edits, the cleaned
 * output of the auto-cleaner, and the original transcript that lives on the
 * mapped state.transcripts row (cached by detail.js / cleaning.js when the
 * operator opened the file).
 */
function resolveTranscriptText(state, audioId) {
  const mapping = state.mappings?.[audioId];
  const mappedTranscript = mapping
    ? (state.transcripts || []).find(t => t.id === mapping.transcriptId)
    : null;

  return state.edited?.[audioId]?.text?.trim()
    || state.cleaning?.[audioId]?.cleanedText?.trim()
    || mappedTranscript?.text?.trim()
    || '';
}

/**
 * Returns { ok: boolean, reason?: string } — predicate that mirrors the
 * receiver's validation. Tells the UI whether the row is sendable; the bulk
 * action skips ineligible rows with this reason exposed in the failure list.
 *
 * Alignment is intentionally NOT required here: KolYid will run its own
 * aligner when the payload omits the alignment key, which lets us export
 * in-review transcripts that haven't been aligned yet.
 */
export function canSendToKolyid(audioId) {
  const state = getState();
  const audio = state.audio.find(a => a.id === audioId);
  if (!audio) return { ok: false, reason: 'Audio not found in state' };
  if (!audio.r2Link) return { ok: false, reason: 'Audio has no R2 link' };

  if (!resolveTranscriptText(state, audioId)) {
    return { ok: false, reason: 'No transcript text yet' };
  }

  return { ok: true };
}

/**
 * Build the JSON payload that matches KolYid's /api/imports/jem-asr contract.
 * Alignment is optional: when an alignment row exists for the audio we lazy-fetch
 * its words (omitted from the startup query) and embed them; otherwise we omit
 * the alignment key entirely and KolYid runs its own aligner.
 */
export async function buildPayload(audioId) {
  const state = getState();
  const audio = state.audio.find(a => a.id === audioId);
  if (!audio) throw new Error(`Audio ${audioId} not in state`);

  const alignment = state.alignments?.[audioId] || null;
  let words = null;
  if (alignment) {
    words = Array.isArray(alignment.words) && alignment.words.length > 0
      ? alignment.words
      : await loadAlignmentWords(audioId);
  }

  // Word-join is a last-ditch fallback when alignment exists but no canonical
  // text was ever loaded — covers historical rows where only the aligned
  // words made it into state.
  const text = resolveTranscriptText(state, audioId)
    || (Array.isArray(words) && words.length > 0
      ? words.map(w => (w.word ?? w.text ?? '')).filter(Boolean).join(' ')
      : '');
  if (!text) throw new Error(`No transcript text for ${audioId}`);

  const mapping = state.mappings?.[audioId];
  const transcript = mapping
    ? state.transcripts.find(t => t.id === mapping.transcriptId)
    : null;

  const libraryConfig = getActiveLibraryConfig();
  const libraryId = getActiveLibrary() || 'jemedia';
  const libraryName = libraryConfig?.name || libraryId;

  const durationSeconds = (typeof audio.estMinutes === 'number' && audio.estMinutes > 0)
    ? audio.estMinutes * 60
    : null;

  const alignmentPayload = (alignment && Array.isArray(words) && words.length > 0)
    ? {
      alignment: {
        provider: alignment.aligner || 'kohnai_align',
        ...(alignment.model ? { model: alignment.model } : {}),
        avg_confidence: alignment.avgConfidence ?? null,
        low_confidence_count: alignment.lowConfidenceCount ?? 0,
        aligned_at: alignment.alignedAt || new Date().toISOString(),
        words: words
          .map(w => ({
            word: String(w.word ?? w.text ?? '').trim(),
            start: typeof w.start === 'number' ? w.start : 0,
            end: typeof w.end === 'number' ? w.end : 0,
            ...(typeof w.confidence === 'number' ? { confidence: w.confidence } : {}),
          }))
          .filter(w => w.word !== ''),
      },
    }
    : {};

  return {
    source: {
      app: 'jem_asr_app',
      library_id: libraryId,
      library_name: libraryName,
      audio_id: String(audio.id),
      // exported_by is filled by the Worker from the verified JWT — sending
      // a hint here keeps offline payload inspection readable.
      exported_by: getCurrentUser() || null,
    },
    audio: {
      name: audio.name,
      url: audio.r2Link,
      ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
    },
    transcript: {
      name: transcript?.name || audio.name,
      text,
      ...(isHttpUrl(transcript?.r2TranscriptLink) ? { source_url: transcript.r2TranscriptLink } : {}),
      ...alignmentPayload,
    },
  };
}

/**
 * Send a single audio file to KolYid. On success, mutates state in-place
 * so the UI badge shows up immediately without a reload.
 *
 * Resolves to { ok, transcriptUrl?, error?, status? } — never throws.
 */
export async function sendOneToKolyid(audioId) {
  const eligibility = canSendToKolyid(audioId);
  if (!eligibility.ok) {
    return { ok: false, error: eligibility.reason };
  }

  const state = getState();
  const audio = state.audio.find(a => a.id === audioId);
  const libraryId = getActiveLibrary() || 'jemedia';

  let payload;
  try {
    payload = await buildPayload(audioId);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Use the live Supabase session so the Worker can verify the caller and
  // write back to audio_files under the user's RLS context.
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'Not signed in' };
  }

  let response;
  try {
    response = await fetch('/api/send-to-kolyid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        audio_id: audioId,
        library_id: libraryId,
        payload,
      }),
    });
  } catch (err) {
    return { ok: false, error: 'Network error: ' + err.message };
  }

  let body = null;
  try { body = await response.json(); } catch { /* leave null */ }

  if (!response.ok) {
    const message = body?.error
      || body?.kolyid_body?.message
      || `Send failed (HTTP ${response.status})`;
    return { ok: false, status: response.status, error: message };
  }

  // 200 = full success; 207 = imported on KolYid but local bookkeeping failed.
  // In both cases the transcript exists on KolYid — surface the warning.
  const transcriptUrl = body?.transcript_url || null;

  if (audio) {
    audio.kolyidImportedAt = new Date().toISOString();
    audio.kolyidImportedBy = getCurrentUser() || null;
    audio.kolyidTranscriptUrl = transcriptUrl;
  }

  if (response.status === 207) {
    return { ok: true, transcriptUrl, warning: body?.warning || 'Imported but failed to record locally' };
  }

  return { ok: true, transcriptUrl };
}

/**
 * Install the "Send to KolYid" button into a bulk-action bar that's already
 * been built. Kept here (instead of inline in table.js's buildBulkBar) so
 * that this feature's diff in table.js is a single one-line `import().then(...)`
 * call far from the bulk-bar internals — minimizes merge conflicts when
 * other feature branches add their own bulk-bar buttons.
 *
 * @param {HTMLElement} bar
 * @param {() => string[]} getSelectedIds
 * @param {() => void} clearSelection
 */
export function installSendToKolyidBulkButton(bar, getSelectedIds, clearSelection) {
  const sendBtn = document.createElement('button');
  sendBtn.className = 'action-btn action-btn-primary';
  sendBtn.textContent = 'Send to KolYid';
  sendBtn.addEventListener('click', async () => {
    const ids = getSelectedIds();
    if (!ids.length) return;
    if (!confirm(`Send ${ids.length} file(s) to KolYid?`)) return;
    sendBtn.disabled = true;
    sendBtn.textContent = `Sending 0/${ids.length}…`;
    const summary = await sendManyToKolyid(ids, {
      onProgress: (done, total, { successes, failures }) => {
        sendBtn.textContent = `Sending ${done}/${total} (${successes} ok, ${failures} fail)`;
      },
    });
    sendBtn.textContent = 'Send to KolYid';
    sendBtn.disabled = false;
    if (summary.failures > 0) {
      const errorList = summary.results
        .filter(r => !r.ok)
        .slice(0, 10)
        .map(r => `${r.audioId}: ${r.error}`)
        .join('\n');
      alert(`Sent ${summary.successes}/${summary.successes + summary.failures}.\n\nFailures:\n${errorList}`);
    } else {
      alert(`Sent ${summary.successes} file(s) to KolYid.`);
    }
    clearSelection();
  });
  bar.appendChild(sendBtn);
}

/**
 * Send many audio files with bounded concurrency. Calls onProgress after
 * each request resolves. Reports failures individually so the bulk action
 * UI can show "imported 8/10 — 2 failed".
 *
 * Resolves to { successes, failures, results: [{audioId, ok, error?, transcriptUrl?}] }.
 */
export async function sendManyToKolyid(audioIds, { concurrency = 1, onProgress } = {}) {
  const queue = [...audioIds];
  const results = [];
  let successes = 0;
  let failures = 0;

  async function worker() {
    while (queue.length > 0) {
      const audioId = queue.shift();
      const result = await sendOneToKolyid(audioId);
      results.push({ audioId, ...result });
      if (result.ok) successes++; else failures++;
      onProgress?.(results.length, audioIds.length, { successes, failures });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, audioIds.length) }, () => worker());
  await Promise.all(workers);

  return { successes, failures, results };
}
