// Split an existing audio into two records at a word-level anchor.
//
// What "split" means now (v2):
//   - The parent record is updated in place. trim_end is set to the anchor
//     word's timestamp; alignment.words is truncated to words[0..anchor];
//     every transcript version on the parent has its text token-truncated
//     so the editor only shows the head half.
//   - A new audio_files row is created with the same R2 / Drive link as the
//     parent. trim_start = anchor time, trim_end = parent's previous
//     trim_end (preserved so outer bounds are maintained). alignment.words
//     and a parallel set of version rows are seeded with the tail half.
//
// Independent of cleaning: previously this function required cleanedText to
// exist on the parent. That gate is gone — split now works on any audio
// that has alignment timestamps, regardless of whether it's been cleaned.
// All available transcript versions get split, not just the cleaned one.
//
// Purpose: cleanly cut a long alignment into two playable, editable parts
// (e.g. 0–5min and 5–10min). The original record keeps the head; the new
// record covers the tail. Both remain independently editable / re-alignable.

import { createClient } from '@supabase/supabase-js';
import { getActiveLibrary } from './auth.js';
import { updateState, addVersion, updateVersion, getVersions } from './state.js';
import { syncAlignment } from './db.js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

// Generate a new id from the parent + part number, avoiding existing ids.
function nextSplitId(parentId, existingIds) {
  for (let n = 2; n < 100; n++) {
    const candidate = `${parentId}_p${n}`;
    if (!existingIds.has(candidate)) return { id: candidate, part: n };
  }
  throw new Error('Too many splits of the same parent');
}

function nextPartNumber(parentName) {
  const m = /\s*—\s*Part\s+(\d+)\s*$/.exec(parentName || '');
  return m ? parseInt(m[1], 10) + 1 : 2;
}

function derivedName(parentName, partNumber) {
  const base = (parentName || '').replace(/\s*—\s*Part\s+\d+\s*$/, '').trim();
  return `${base} — Part ${partNumber}`;
}

function fmtSec(s) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

// Split a free-form transcript string into head/tail at the given word index.
// Tokenises on whitespace runs, then re-joins with single spaces. Edited text
// with rich punctuation may land its head/tail boundary slightly differently
// than the alignment word boundary if a "word" in alignment was a punctuation
// token; for the common case this gives a clean split.
function splitTextAtWordIndex(text, wordIndex) {
  if (typeof text !== 'string' || !text.trim()) return { head: '', tail: '' };
  const tokens = text.split(/\s+/).filter(Boolean);
  const cut = Math.max(0, Math.min(wordIndex, tokens.length));
  return {
    head: tokens.slice(0, cut).join(' '),
    tail: tokens.slice(cut).join(' '),
  };
}

/**
 * Create a new audio record split from `parent` at `anchorWord`.
 *
 * Mutates parent in place: parent gets the head half (trim_end → anchor,
 * alignment.words → head, every version text → head). The new record gets
 * the tail half. Both are persisted to Supabase before returning.
 *
 * @param {object}  parent     - Parent audio row (from state.audio)
 * @param {object}  state      - Full app state
 * @param {number}  wordIndex  - Index into parent's alignment.words; the
 *                               word at this index becomes the FIRST word
 *                               of the new (tail) record.
 * @returns {Promise<{id: string, name: string, anchorTime: number, wordCount: number}>}
 */
export async function createSplitFromAudio(parent, state, wordIndex) {
  if (!parent) throw new Error('Missing parent audio');
  const parentAlignment = state.alignments?.[parent.id];
  if (!parentAlignment?.words?.[wordIndex]) {
    throw new Error('No alignment word at that index — align the parent first');
  }
  const anchor = parentAlignment.words[wordIndex];
  const anchorTime = anchor.start;
  if (!(anchorTime >= 0)) throw new Error('Anchor word has no valid start timestamp');

  // ── Word arrays ──────────────────────────────────────────────────────
  // Anchor word belongs to the TAIL (new record). Head = [0, wordIndex);
  // Tail = [wordIndex, end). Word timestamps are absolute (start-of-original-
  // file relative); we keep them as-is so the new audio's trim_start lines
  // up with the anchor's timestamp at playback.
  const allWords = Array.isArray(parentAlignment.words) ? parentAlignment.words : [];
  const headWords = allWords.slice(0, wordIndex);
  const tailWords = allWords.slice(wordIndex);

  // ── Derive new id + name ─────────────────────────────────────────────
  const existingIds = new Set((state.audio || []).map(a => a.id));
  const preferredPart = nextPartNumber(parent.name);
  const { id: newId, part } = nextSplitId(parent.id, existingIds);
  const newName = derivedName(parent.name, Math.max(preferredPart, part));

  // ── Trim math ────────────────────────────────────────────────────────
  // Parent: trim_start untouched, trim_end becomes anchorTime.
  // New:    trim_start = anchorTime, trim_end inherits parent's old
  //         trim_end (preserves the outer bound the user previously set).
  const parentTrim = state.trims?.[parent.id] || {};
  const parentTrimStart = parentTrim.start || 0;
  const parentTrimEndPrev = parentTrim.end || 0;
  const newTrimStart = anchorTime;
  const newTrimEnd   = parentTrimEndPrev; // 0 = "to end" — preserved
  const headDurationSec = Math.max(0, anchorTime - parentTrimStart);
  const parentEstSec   = (parent.estMinutes || 0) * 60;
  const tailEndSec     = parentTrimEndPrev > 0 ? parentTrimEndPrev : parentEstSec;
  const tailDurationSec = Math.max(0, tailEndSec - anchorTime);
  const headEstMin = Math.round((headDurationSec / 60) * 10) / 10;
  const tailEstMin = Math.round((tailDurationSec / 60) * 10) / 10;

  // ── Version texts to split ──────────────────────────────────────────
  // Every version with text gets split at wordIndex. The parent's existing
  // version is updated in place; a NEW version of the same type is inserted
  // for the new audio with the tail text. Manual versions are left alone
  // (they reference the original transcript, not derived from words).
  const parentVersions = (state.transcriptVersions?.[parent.id] || [])
    .filter(v => v && typeof v.text === 'string' && v.text.trim().length > 0 && v.type !== 'manual');
  const versionPlans = parentVersions.map(v => {
    const { head, tail } = splitTextAtWordIndex(v.text, wordIndex);
    return { v, head, tail };
  });

  const lib = getActiveLibrary() || 'jemedia';

  // ── Supabase write: new audio row ───────────────────────────────────
  const newAudioRow = {
    id: newId,
    name: newName,
    r2_link: parent.r2Link || null,
    drive_link: parent.driveLink || null,
    year: parent.year || null,
    month: parent.month || null,
    day: parent.day || null,
    type: parent.type || null,
    duration_minutes: tailEstMin,
    trim_start: newTrimStart,
    trim_end: newTrimEnd,
    comments: `Split from ${parent.name} at ${fmtSec(anchorTime)} (word "${anchor.word || ''}")`,
    is_selected_50hr: false,
    is_benchmark: false,
    library_id: lib,
  };
  const { error: audioErr } = await supabase.from('audio_files').insert(newAudioRow);
  if (audioErr) throw new Error(`Failed to create split audio row: ${audioErr.message}`);

  // ── Supabase write: parent audio update (trim_end + duration) ───────
  // NB: trim_start on the parent is intentionally untouched.
  const { error: parentUpdErr } = await supabase
    .from('audio_files')
    .update({ trim_end: anchorTime, duration_minutes: headEstMin })
    .eq('id', parent.id);
  if (parentUpdErr) console.warn('[split] parent audio update:', parentUpdErr.message);

  // ── Supabase write: alignment rows ──────────────────────────────────
  // Parent: overwrite words with head. New: insert tail.
  await syncAlignment(parent.id, { ...parentAlignment, words: headWords }, parent).catch(e => console.warn('[split] head alignment sync:', e));
  await syncAlignment(newId, { words: tailWords, avgConfidence: parentAlignment.avgConfidence, lowConfidenceCount: tailWords.filter(w => (w?.confidence ?? 1) < 0.5).length, alignedAt: new Date().toISOString() }, { ...parent, id: newId, name: newName }).catch(e => console.warn('[split] tail alignment sync:', e));

  // ── Mapping inheritance (best-effort) ───────────────────────────────
  const parentMapping = state.mappings?.[parent.id];
  if (parentMapping?.transcriptId) {
    const { error: mapErr } = await supabase.from('mappings').insert({
      audio_id: newId,
      transcript_id: parentMapping.transcriptId,
      confidence: parentMapping.confidence ?? 0,
      match_reason: `split from ${parent.id}`,
      confirmed_by: parentMapping.confirmedBy || 'system',
      library_id: lib,
    });
    if (mapErr) console.warn('[split] mapping insert:', mapErr.message);
  }

  // ── Local state writes ──────────────────────────────────────────────
  // 1. New audio row
  if (!state.audio) state.audio = [];
  const newAudio = {
    id: newId,
    name: newName,
    r2Link: parent.r2Link || null,
    driveLink: parent.driveLink || null,
    year: parent.year || null,
    month: parent.month || null,
    day: parent.day || null,
    type: parent.type || null,
    estMinutes: tailEstMin,
    isSelected50hr: false,
    isBenchmark: false,
    comments: newAudioRow.comments,
  };
  state.audio.push(newAudio);

  // 2. Parent estMinutes update (head duration)
  const parentEntry = state.audio.find(a => a.id === parent.id);
  if (parentEntry) parentEntry.estMinutes = headEstMin;

  // 3. Mappings inheritance
  if (parentMapping?.transcriptId) {
    if (!state.mappings) state.mappings = {};
    state.mappings[newId] = {
      transcriptId: parentMapping.transcriptId,
      confidence: parentMapping.confidence ?? 0,
      matchReason: `split from ${parent.id}`,
      confirmedBy: parentMapping.confirmedBy || 'system',
      confirmedAt: new Date().toISOString(),
    };
  }

  // 4. Trims
  if (!state.trims) state.trims = {};
  state.trims[parent.id] = { start: parentTrimStart, end: anchorTime };
  state.trims[newId]    = { start: newTrimStart,    end: newTrimEnd };

  // 5. Alignments (head/tail split, in state)
  if (!state.alignments) state.alignments = {};
  state.alignments[parent.id] = { ...parentAlignment, words: headWords };
  state.alignments[newId] = {
    words: tailWords,
    avgConfidence: parentAlignment.avgConfidence,
    lowConfidenceCount: tailWords.filter(w => (w?.confidence ?? 1) < 0.5).length,
    alignedAt: new Date().toISOString(),
  };

  // 6. Version-text splits. Parent's versions are updated in place via
  //    updateVersion (which auto-syncs edited/asr to Supabase). For the new
  //    audio, addVersion creates fresh tv_<newId>_<type>_<ts> rows and the
  //    same auto-sync persists them.
  for (const { v, head, tail } of versionPlans) {
    if (head !== v.text) {
      try {
        await Promise.resolve(updateVersion(parent.id, v.id, { text: head }));
      } catch (err) { console.warn('[split] update parent version:', err); }
    }
    try {
      addVersion(newId, {
        type: v.type,
        text: tail,
        ...(v.model     ? { model: v.model } : {}),
        ...(v.runId     ? { runId: v.runId } : {}),
        ...(v.prompt    ? { prompt: v.prompt } : {}),
        ...(v.promptLabel ? { promptLabel: v.promptLabel } : {}),
        ...(v.sourceTranscriptId ? { sourceTranscriptId: v.sourceTranscriptId } : {}),
        createdBy: 'split',
      });
    } catch (err) { console.warn('[split] add new version:', err); }
  }

  // 7. Backwards-compat legacy `cleaning` map. Some UI surfaces still read
  //    state.cleaning[audioId] directly; mirror the cleaned-version split
  //    there if a cleaned version was part of the split.
  const cleanedPlan = versionPlans.find(p => p.v.type === 'cleaned');
  if (cleanedPlan) {
    if (!state.cleaning) state.cleaning = {};
    if (state.cleaning[parent.id]) {
      state.cleaning[parent.id] = { ...state.cleaning[parent.id], cleanedText: cleanedPlan.head };
    }
    state.cleaning[newId] = { cleanedText: cleanedPlan.tail, cleanedAt: new Date().toISOString() };
  }

  // Persist the mutated state.audio via updateState (audio array keyed null)
  updateState('audio', null, state.audio);

  return { id: newId, name: newName, anchorTime, wordCount: tailWords.length };
}
