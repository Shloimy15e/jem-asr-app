// Split an existing audio into a new record at a word-level anchor.
//
// Creates a brand-new audio_files row (standalone — no parent_id, no FK). The
// new record shares the parent's r2Link / driveLink / year / month / type, but
// has its own trim_start (= anchor word's timestamp) and its own cleanedText
// (= words from the anchor onwards). The parent is untouched.
//
// Purpose: when the tail of a long alignment is noisy, you split at a good
// word and treat the tail as its own standalone file with a fresh lifecycle
// (map/clean/align/review). The original record keeps its full alignment and
// remains independently editable.

import { createClient } from '@supabase/supabase-js';
import { getActiveLibrary } from './auth.js';
import { updateState } from './state.js';

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

/**
 * Pull the cleaned text for an audio from any of the locations the app has
 * historically used: the active version, any 'edited'/'cleaned' version, or
 * the legacy state.cleaning slot.
 */
function resolveParentText(state, parentId) {
  const versions = state.transcriptVersions?.[parentId];
  if (Array.isArray(versions) && versions.length > 0) {
    const preferOrder = ['edited', 'cleaned', 'manual'];
    for (const t of preferOrder) {
      const v = [...versions].reverse().find(v => v.type === t && (v.text || '').trim());
      if (v) return v.text;
    }
    const anyWithText = [...versions].reverse().find(v => (v.text || '').trim());
    if (anyWithText) return anyWithText.text;
  }
  return state.cleaning?.[parentId]?.cleanedText || '';
}

/**
 * Create a new audio record split from `parent` at `anchorWord`.
 *
 * @param {object}   parent       - Parent audio row (from state.audio)
 * @param {object}   state        - Full app state
 * @param {number}   wordIndex    - Index into parent's alignment.words
 * @param {object}  [opts]
 * @param {string}  [opts.parentText] - Override parent text (e.g. from getCurrentText())
 * @returns {Promise<{id: string, name: string, anchorTime: number}>}
 */
export async function createSplitFromAudio(parent, state, wordIndex, opts = {}) {
  if (!parent) throw new Error('Missing parent audio');
  const parentAlignment = state.alignments?.[parent.id];
  if (!parentAlignment?.words?.[wordIndex]) {
    throw new Error('No alignment word at that index — align the parent first');
  }
  const anchor = parentAlignment.words[wordIndex];
  const anchorTime = anchor.start;
  if (!(anchorTime >= 0)) throw new Error('Anchor word has no valid start timestamp');

  const parentText = (opts.parentText ?? resolveParentText(state, parent.id) ?? '').toString();
  if (!parentText.trim()) {
    throw new Error('Parent has no cleaned text to split — re-clean the source first');
  }
  const tokens = parentText.trim().split(/\s+/).filter(t => t.length > 0);
  if (wordIndex >= tokens.length) {
    throw new Error(`Anchor index ${wordIndex} out of range (${tokens.length} tokens)`);
  }
  const tailText = tokens.slice(wordIndex).join(' ');

  // Derive new id + name
  const existingIds = new Set((state.audio || []).map(a => a.id));
  const preferredPart = nextPartNumber(parent.name);
  const { id: newId, part } = nextSplitId(parent.id, existingIds);
  const newName = derivedName(parent.name, Math.max(preferredPart, part));

  const parentTrimEnd = state.trims?.[parent.id]?.end || 0;
  const parentEstSec  = (parent.estMinutes || 0) * 60;
  const effectiveEnd  = parentTrimEnd > 0 ? parentTrimEnd : parentEstSec;
  const tailSec       = Math.max(0, effectiveEnd - anchorTime);
  const tailMin       = tailSec / 60;

  const lib = getActiveLibrary() || 'jemedia';

  // Build the new audio row in the app's camelCase shape
  const newAudio = {
    id: newId,
    name: newName,
    r2Link: parent.r2Link || null,
    driveLink: parent.driveLink || null,
    year: parent.year || null,
    month: parent.month || null,
    day: parent.day || null,
    type: parent.type || null,
    estMinutes: Math.round(tailMin * 10) / 10,
    isSelected50hr: false,
    isBenchmark: false,
    comments: `Split from ${parent.name} at ${fmtSec(anchorTime)} (word "${anchor.word}")`,
  };

  // ── Supabase writes ─────────────────────────────────────────────────
  // Insert the full row in one shot so duration/trim/comments all land together.
  const { error: audioErr } = await supabase.from('audio_files').insert({
    id: newId,
    name: newName,
    r2_link: newAudio.r2Link,
    drive_link: newAudio.driveLink,
    year: newAudio.year,
    month: newAudio.month,
    day: newAudio.day,
    type: newAudio.type,
    duration_minutes: newAudio.estMinutes,
    trim_start: anchorTime,
    trim_end: 0,
    comments: newAudio.comments,
    is_selected_50hr: false,
    is_benchmark: false,
    library_id: lib,
  });
  if (audioErr) throw new Error(`Failed to create split audio row: ${audioErr.message}`);

  // Mapping — inherit the parent's transcript link if any
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

  // Cleaning — tail of the parent's cleaned text
  // Stored in transcript_edits with version='cleaned' (same pattern as syncCleaning)
  const { error: cleanErr } = await supabase.from('transcript_edits').insert({
    audio_id: newId,
    version: 'cleaned',
    text: tailText,
    created_at: new Date().toISOString(),
    created_by: 'system',
    library_id: lib,
  });
  if (cleanErr) console.warn('[split] cleaning insert:', cleanErr.message);

  // ── Local state writes ──────────────────────────────────────────────
  if (!state.audio) state.audio = [];
  state.audio.push(newAudio);

  // updateState already fires a Supabase sync, which would double-write. We
  // already did the inserts above; just mirror into local state + localStorage.
  if (!state.mappings) state.mappings = {};
  if (parentMapping?.transcriptId) {
    state.mappings[newId] = {
      transcriptId: parentMapping.transcriptId,
      confidence: parentMapping.confidence ?? 0,
      matchReason: `split from ${parent.id}`,
      confirmedBy: parentMapping.confirmedBy || 'system',
      confirmedAt: new Date().toISOString(),
    };
  }
  if (!state.cleaning) state.cleaning = {};
  state.cleaning[newId] = { cleanedText: tailText, cleanedAt: new Date().toISOString() };
  if (!state.trims) state.trims = {};
  state.trims[newId] = { start: anchorTime, end: 0 };

  // Persist the mutated state.audio via updateState (audio array is keyed null)
  updateState('audio', null, state.audio);

  return { id: newId, name: newName, anchorTime, wordCount: tokens.length - wordIndex };
}
