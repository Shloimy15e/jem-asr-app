import { createClient } from '@supabase/supabase-js';
import { getActiveLibrary, getCurrentUser, getCurrentUserId } from './auth.js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

// Parse the 'asr-...' version key written to transcript_edits.
// Two shapes coexist:
//   'asr-<model>'             (legacy / no-prompt; one row per model)
//   'asr-<model>-<unix-ms>'   (prompted / history-mode; unique per run)
// Returns { model, runId? }.
function parseAsrVersionKey(versionKey) {
  const stripped = (versionKey || '').replace(/^asr-/, '');
  const m = stripped.match(/^(.*)-(\d{10,})$/);
  return m ? { model: m[1], runId: m[2] } : { model: stripped, runId: null };
}

// ── Audio file FK guard ──────────────────────────────────────────────
// Many tables have audio_id FK → audio_files.id, so we upsert the file
// before writing related rows.

// Shared field mapping for audio_files rows (camelCase app → snake_case DB).
// Does NOT include duration_minutes — that is managed separately by syncAudioDuration.
function toAudioRow(a) {
  return {
    id: a.id,
    name: a.name,
    r2_link: a.r2Link || null,
    drive_link: a.driveLink || null,
    year: a.year || null,
    month: a.month || null,
    day: a.day || null,
    type: a.type || null,
    is_selected_50hr: a.isSelected50hr || false,
    is_benchmark: a.isBenchmark || false,
    library_id: getActiveLibrary() || 'jemedia',
  };
}

async function ensureAudioFile(audio) {
  if (!audio) return;
  // ignoreDuplicates: true — only inserts if the row is missing (FK guard).
  // Never updates existing rows, so it cannot overwrite name, duration, or any
  // other field that is managed by dedicated sync helpers (syncAudioField, etc.).
  const { error } = await supabase.from('audio_files').upsert(
    toAudioRow(audio),
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (error) console.warn('[DB] ensureAudioFile:', error.message);
}

// ── Activity logging ────────────────────────────────────────────────

export async function logActivity(action, targetId, targetName, details = {}) {
  const { error } = await supabase.from('activity_log').insert({
    user_email: getCurrentUser(),
    action,
    target_id: targetId || null,
    target_name: targetName || null,
    details,
    library_id: getActiveLibrary() || 'jemedia',
  });
  if (error) console.warn('[DB] logActivity:', error.message);
}

// ── Per-table sync helpers ───────────────────────────────────────────

export async function syncMapping(audioId, mapping, audioEntry) {
  if (!mapping) return;
  await ensureAudioFile(audioEntry);
  const { error } = await supabase.from('mappings').upsert(
    {
      audio_id: audioId,
      transcript_id: mapping.transcriptId,
      confidence: mapping.confidence,
      match_reason: mapping.matchReason,
      confirmed_by: mapping.confirmedBy,
      // confirmed_at is not a column — created_at is auto-set on insert
      library_id: getActiveLibrary() || 'jemedia',
    },
    { onConflict: 'audio_id' },
  );
  if (error) console.warn('[DB] syncMapping:', error.message);
  else logActivity('mapping_confirmed', audioId, audioEntry?.name, { transcriptId: mapping.transcriptId });
}

export async function deleteMapping(audioId) {
  const { error } = await supabase.from('mappings').delete()
    .eq('audio_id', audioId)
    .eq('library_id', getActiveLibrary() || 'jemedia');
  if (error) console.warn('[DB] deleteMapping:', error.message);
  else logActivity('mapping_removed', audioId);
}

/** Delete all work data for an audio file from Supabase (transcript_edits, alignments, reviews, segment_approvals). */
export async function deleteAllWorkData(audioId) {
  const lib = getActiveLibrary() || 'jemedia';
  const deletes = [
    supabase.from('transcript_edits').delete().eq('audio_id', audioId).eq('library_id', lib),
    supabase.from('alignments').delete().eq('audio_id', audioId).eq('library_id', lib),
    supabase.from('reviews').delete().eq('audio_id', audioId).eq('library_id', lib),
    supabase.from('segment_approvals').delete().eq('audio_id', audioId),
  ];
  const results = await Promise.allSettled(deletes);
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.error) {
      console.warn(`[DB] deleteAllWorkData[${i}]:`, r.value.error.message);
    }
  });
}

export async function syncCleaning(audioId, cleaningData, audioEntry) {
  if (!cleaningData) return;
  await ensureAudioFile(audioEntry);
  const { error } = await supabase.from('transcript_edits').upsert(
    {
      audio_id: audioId,
      version: 'cleaned',
      text: cleaningData.cleanedText,
      original_text: cleaningData.originalText,
      clean_rate: cleaningData.cleanRate,
      created_at: cleaningData.cleanedAt || new Date().toISOString(),
      created_by: 'system',
      library_id: getActiveLibrary() || 'jemedia',
    },
    { onConflict: 'audio_id,version' },
  );
  if (error) console.warn('[DB] syncCleaning:', error.message);
  else logActivity('cleaning_run', audioId, audioEntry?.name, { cleanRate: cleaningData.cleanRate });
}

export async function syncEdited(audioId, text, audioEntry) {
  if (text == null) return;
  await ensureAudioFile(audioEntry);
  const { error } = await supabase.from('transcript_edits').upsert(
    {
      audio_id: audioId,
      version: 'edited',
      text,
      created_at: new Date().toISOString(),
      created_by: 'user',
      library_id: getActiveLibrary() || 'jemedia',
    },
    { onConflict: 'audio_id,version' },
  );
  if (error) console.warn('[DB] syncEdited:', error.message);
  else logActivity('transcript_edited', audioId, audioEntry?.name);
}

export async function syncAsr(audioId, text, modelName, audioEntry, opts = {}) {
  if (text == null) return;
  await ensureAudioFile(audioEntry);
  // Two version-key shapes coexist for back-compat:
  //  - Legacy / no-prompt: `asr-<model>` (one row per model, upserted)
  //  - Prompted/append:    `asr-<model>-<unix-ms>` (unique per run)
  // The runId opt is provided by the caller when they want history-mode.
  const baseKey = `asr-${modelName || 'unknown'}`;
  const versionKey = opts.runId ? `${baseKey}-${opts.runId}` : baseKey;
  const row = {
    audio_id: audioId,
    version: versionKey,
    text,
    created_at: new Date().toISOString(),
    created_by: modelName || 'asr',
    library_id: getActiveLibrary() || 'jemedia',
  };
  // Only include the prompt columns when there's actual data — keeps the
  // upsert backwards-compatible with environments that haven't yet run the
  // 20260427_add_asr_prompt_columns migration. PostgREST rejects unknown
  // columns even when the value is null.
  if (opts.prompt) row.prompt = opts.prompt;
  if (opts.promptLabel) row.prompt_label = opts.promptLabel;
  let { error } = await supabase.from('transcript_edits').upsert(
    row,
    { onConflict: 'audio_id,version' },
  );
  // Self-heal: if the columns don't exist yet, retry without them so the
  // text and version key still land on the server. Users see prompt info
  // in their local state until the migration is applied.
  if (error && (row.prompt !== undefined || row.prompt_label !== undefined)
      && /column .*(prompt|prompt_label)/i.test(error.message || '')) {
    delete row.prompt;
    delete row.prompt_label;
    const retry = await supabase.from('transcript_edits').upsert(
      row,
      { onConflict: 'audio_id,version' },
    );
    error = retry.error;
  }
  if (error) console.warn('[DB] syncAsr:', error.message);
}

export async function syncAlignment(audioId, alignmentData, audioEntry) {
  if (!alignmentData) return;
  await ensureAudioFile(audioEntry);
  const { error } = await supabase.from('alignments').upsert(
    {
      audio_id: audioId,
      words: alignmentData.words,
      avg_confidence: alignmentData.avgConfidence,
      low_confidence_count: alignmentData.lowConfidenceCount,
      aligned_at: alignmentData.alignedAt,
      library_id: getActiveLibrary() || 'jemedia',
    },
    { onConflict: 'audio_id' },
  );
  if (error) console.warn('[DB] syncAlignment:', error.message);
  else logActivity('alignment_completed', audioId, audioEntry?.name);
}

export async function syncReview(audioId, reviewData, audioEntry) {
  if (!reviewData) return;
  await ensureAudioFile(audioEntry);
  const { error } = await supabase.from('reviews').upsert(
    {
      audio_id: audioId,
      status: reviewData.status,
      edited_text: reviewData.editedText || null,
      reviewed_at: reviewData.reviewedAt,
      library_id: getActiveLibrary() || 'jemedia',
    },
    { onConflict: 'audio_id' },
  );
  if (error) console.warn('[DB] syncReview:', error.message);
  else logActivity('review_' + reviewData.status, audioId, audioEntry?.name);
}

// ── Dispatch helper used by state.js ────────────────────────────────
// Called fire-and-forget after every updateState() call.

export async function syncFavorite(audioId, isFavorite) {
  const userId = getCurrentUserId();
  if (!userId) return;
  const lib = getActiveLibrary() || 'jemedia';
  if (isFavorite) {
    const { error } = await supabase.from('user_favorites').upsert(
      { user_id: userId, audio_id: audioId, library_id: lib },
      { onConflict: 'user_id,audio_id,library_id' },
    );
    if (error) console.warn('[DB] syncFavorite (add):', error.message);
  } else {
    const { error } = await supabase.from('user_favorites').delete()
      .eq('user_id', userId)
      .eq('audio_id', audioId)
      .eq('library_id', lib);
    if (error) console.warn('[DB] syncFavorite (remove):', error.message);
  }
}

export async function loadFavorites(libraryId = null) {
  const userId = getCurrentUserId();
  if (!userId) return {};
  const lib = libraryId || getActiveLibrary() || 'jemedia';
  const { data, error } = await supabase.from('user_favorites')
    .select('audio_id')
    .eq('user_id', userId)
    .eq('library_id', lib);
  if (error) { console.warn('[DB] loadFavorites:', error.message); return {}; }
  const favs = {};
  (data || []).forEach(r => { favs[r.audio_id] = true; });
  return favs;
}

export async function syncAudioField(audioId, column, value) {
  const { error } = await supabase
    .from('audio_files')
    .update({ [column]: value })
    .eq('id', audioId)
    .eq('library_id', getActiveLibrary() || 'jemedia');
  if (error) console.warn(`[DB] syncAudioField(${column}):`, error.message);
}

async function syncAudioName(audioId, newName) {
  return syncAudioField(audioId, 'name', newName);
}

async function syncAudioComment(audioId, comment) {
  return syncAudioField(audioId, 'comments', comment || null);
}

export async function syncAudioDuration(audioId, durationMinutes) {
  const { error } = await supabase
    .from('audio_files')
    .update({ duration_minutes: durationMinutes })
    .eq('id', audioId)
    .eq('library_id', getActiveLibrary() || 'jemedia');
  if (error) console.warn('[DB] syncAudioDuration:', error.message);
}

async function syncAudioTrim(audioId, trim) {
  const { error } = await supabase
    .from('audio_files')
    .update({ trim_start: trim?.start || 0, trim_end: trim?.end || 0 })
    .eq('id', audioId)
    .eq('library_id', getActiveLibrary() || 'jemedia');
  if (error) console.warn('[DB] syncAudioTrim:', error.message);
}

export function syncStateKey(key, audioId, value, audioEntry) {
  switch (key) {
    case 'audioNames':
      syncAudioName(audioId, value).catch(console.warn);
      break;
    case 'audioComments':
      syncAudioComment(audioId, value).catch(console.warn);
      break;
    case 'audioYears':
      syncAudioField(audioId, 'year', value || null).catch(console.warn);
      break;
    case 'audioMonths':
      syncAudioField(audioId, 'month', value || null).catch(console.warn);
      break;
    case 'audioDays':
      syncAudioField(audioId, 'day', value ? parseInt(value, 10) : null).catch(console.warn);
      break;
    case 'audioTypes':
      syncAudioField(audioId, 'type', value || null).catch(console.warn);
      break;
    case 'trims':
      syncAudioTrim(audioId, value).catch(console.warn);
      break;
    case 'mappings':
      syncMapping(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'cleaning':
      syncCleaning(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'edited':
      syncEdited(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'alignments':
      syncAlignment(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'reviews':
      syncReview(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'favorites':
      syncFavorite(audioId, !!value).catch(console.warn);
      break;
    default:
      break;
  }
}

// ── Bulk seed helpers ────────────────────────────────────────────────
// Called once on startup when data.json has changed, to ensure the full
// catalog and pre-matched mappings exist in Supabase.

const CHUNK = 200;

export async function bulkSyncAudioFiles(audioArray) {
  for (let i = 0; i < audioArray.length; i += CHUNK) {
    const rows = audioArray.slice(i, i + CHUNK).map(a => ({
      ...toAudioRow(a),
      // Seeding includes duration — detail page will correct later if needed
      duration_minutes: a.estMinutes || null,
      library_id: getActiveLibrary() || 'jemedia',
    }));
    const { error } = await supabase.from('audio_files').upsert(rows, { onConflict: 'id' });
    if (error) console.warn('[DB] bulkSyncAudioFiles:', error.message);
  }
}

export async function bulkSyncTranscripts(transcriptArray) {
  for (let i = 0; i < transcriptArray.length; i += CHUNK) {
    const rows = transcriptArray.slice(i, i + CHUNK).map(t => ({
      id: t.id,
      name: t.name,
      year: t.year || null,
      month: t.month || null,
      day: t.day || null,
      first_line: t.firstLine || null,
      drive_link: t.driveLink || null,
      r2_transcript_link: t.r2TranscriptLink || null,
      library_id: getActiveLibrary() || 'jemedia',
    }));
    const { error } = await supabase.from('transcripts').upsert(rows, { onConflict: 'id' });
    if (error) console.warn('[DB] bulkSyncTranscripts:', error.message);
  }
}

// ── Global transcript text search ───────────────────────────────────
// Searches transcript full text in Supabase using ilike.

export async function searchTranscriptText(term, libraryId = null) {
  const lib = libraryId || getActiveLibrary();
  if (!term || term.length < 2) return [];
  const pattern = `%${term}%`;
  const { data, error } = await supabase
    .from('transcripts')
    .select('id, name, year, month, day, first_line, text')
    .eq('library_id', lib)
    .or(`text.ilike.${pattern},first_line.ilike.${pattern},name.ilike.${pattern}`)
    .limit(50);
  if (error) {
    console.warn('[DB] searchTranscriptText:', error.message);
    return [];
  }
  return data || [];
}

// ── Lazy detail loaders ──────────────────────────────────────────────
// Called from the detail page — loads the heavy fields not fetched at startup.

export async function loadAlignmentWords(audioId) {
  const { data, error } = await supabase
    .from('alignments')
    .select('words')
    .eq('audio_id', audioId)
    .single();
  if (error || !data) return null;
  return data.words || [];
}

export async function loadTranscriptText(transcriptId) {
  const { data, error } = await supabase
    .from('transcripts')
    .select('text')
    .eq('id', transcriptId)
    .single();
  if (error || !data) return null;
  return data.text || null;
}

export async function loadSegmentApprovals(audioId) {
  const { data, error } = await supabase
    .from('segment_approvals')
    .select('segment_hash')
    .eq('audio_id', audioId);
  if (error) { console.warn('[DB] loadSegmentApprovals:', error.message); return []; }
  return (data || []).map(r => r.segment_hash);
}

export async function syncSegmentApproval(audioId, segHash, approved, approvedBy, audioEntry) {
  if (!segHash) return;
  await ensureAudioFile(audioEntry);
  if (approved) {
    const { error } = await supabase.from('segment_approvals').upsert(
      {
        audio_id: audioId,
        segment_hash: segHash,
        approved_at: new Date().toISOString(),
        approved_by: approvedBy || 'user',
        library_id: getActiveLibrary() || 'jemedia',
      },
      { onConflict: 'audio_id,segment_hash' },
    );
    if (error) console.warn('[DB] syncSegmentApproval (approve):', error.message);
    else logActivity('segment_approved', audioId, null, { segmentHash: segHash });
  } else {
    const { error } = await supabase.from('segment_approvals')
      .delete()
      .eq('audio_id', audioId)
      .eq('segment_hash', segHash);
    if (error) console.warn('[DB] syncSegmentApproval (unapprove):', error.message);
    else logActivity('segment_unapproved', audioId, null, { segmentHash: segHash });
  }
}

// ── Split transcript ─────────────────────────────────────────────────
// Creates a new transcript record derived from an existing one.
// The new record gets source_transcript_id = originalId for traceability.
// Returns the new transcript object in camelCase (ready to push into state).

export async function splitTranscript(originalId) {
  const { data: orig, error: fetchErr } = await supabase
    .from('transcripts')
    .select('*')
    .eq('id', originalId)
    .single();
  if (fetchErr || !orig) throw new Error('Could not fetch original transcript: ' + (fetchErr?.message || 'not found'));

  const newId = `t_${Date.now()}`;
  const { data: created, error: insertErr } = await supabase
    .from('transcripts')
    .insert({
      id: newId,
      name: orig.name,
      year: orig.year,
      month: orig.month,
      day: orig.day,
      first_line: orig.first_line,
      drive_link: orig.drive_link,
      r2_transcript_link: orig.r2_transcript_link,
      text: orig.text || null,
      source_transcript_id: orig.source_transcript_id || originalId,
      library_id: getActiveLibrary() || 'jemedia',
    })
    .select()
    .single();
  if (insertErr) throw new Error('Could not create split transcript: ' + insertErr.message);

  return {
    id: created.id,
    name: created.name,
    year: created.year,
    month: created.month,
    day: created.day,
    firstLine: created.first_line,
    driveLink: created.drive_link,
    r2TranscriptLink: created.r2_transcript_link,
    sourceTranscriptId: created.source_transcript_id,
  };
}

// Must be called AFTER bulkSyncAudioFiles (FK constraint on audio_id).
export async function bulkSyncMappings(mappingsObj) {
  const rows = Object.entries(mappingsObj).map(([audioId, m]) => ({
    audio_id: audioId,
    transcript_id: m.transcriptId,
    confidence: m.confidence,
    match_reason: m.matchReason,
    confirmed_by: m.confirmedBy,
    // no confirmed_at column — created_at is auto-set
    library_id: getActiveLibrary() || 'jemedia',
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    // onConflict: don't overwrite user-confirmed mappings with imported ones
    const { error } = await supabase.from('mappings').upsert(
      rows.slice(i, i + CHUNK),
      { onConflict: 'audio_id', ignoreDuplicates: true },
    );
    if (error) console.warn('[DB] bulkSyncMappings:', error.message);
  }
}

// ── Bulk load from Supabase on startup ──────────────────────────────
// Fetch all rows from a table, paginating through Supabase's 1000-row server limit.
// When libraryId is provided, filters rows to that library only.
async function fetchAll(table, columns = '*', libraryId = null) {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (libraryId) query = query.eq('library_id', libraryId);
    const { data, error } = await query;
    if (error) { console.warn(`[DB] fetchAll ${table}:`, error.message); break; }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Returns the full catalog (audio + transcripts arrays) plus all work data.
// This is now the PRIMARY source — app.js no longer uses data.json.
// libraryId defaults to the active library from auth context.

export async function loadFromSupabase(libraryId = null) {
  const lib = libraryId || getActiveLibrary();
  try {
    const [
      audioData,
      transcriptData,
      mappingsData,
      alignmentsData,
      reviewsData,
      editsData,
      favoritesData,
    ] = await Promise.all([
      fetchAll('audio_files', '*', lib),
      fetchAll('transcripts', 'id,name,year,month,day,first_line,drive_link,r2_transcript_link,source_transcript_id', lib),
      fetchAll('mappings', '*', lib),
      fetchAll('alignments', 'audio_id,avg_confidence,low_confidence_count,aligned_at', lib),
      fetchAll('reviews', '*', lib),
      fetchAll('transcript_edits', '*', lib),
      loadFavorites(lib),
    ]);

    // errors are logged inside fetchAll

    // Sort by ID — numeric suffix for JEM-style IDs (0001), lexicographic fallback for others
    const byId = (a, b) => {
      const na = parseInt(a.id), nb = parseInt(b.id);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };

    const audio = (audioData || []).sort(byId).map(a => ({
      id: a.id,
      name: a.name,
      year: a.year,
      month: a.month,
      day: a.day,
      type: a.type,
      estMinutes: a.duration_minutes,
      isSelected50hr: a.is_selected_50hr,
      isBenchmark: a.is_benchmark,
      comments: a.comments || '',
      r2Link: a.r2_link,
      driveLink: a.drive_link,
      trimStart: a.trim_start || 0,
      trimEnd: a.trim_end || 0,
      trainingExportedAt: a.training_exported_at || null,
      trainingExportedBy: a.training_exported_by || null,
    }));

    const trims = {};
    audio.forEach(a => {
      if (a.trimStart || a.trimEnd) {
        trims[a.id] = { start: a.trimStart, end: a.trimEnd };
      }
    });

    const transcripts = (transcriptData || []).sort(byId).map(t => ({
      id: t.id,
      name: t.name,
      year: t.year,
      month: t.month,
      day: t.day,
      firstLine: t.first_line,
      // text omitted at startup — fetched lazily in detail page
      driveLink: t.drive_link,
      r2TranscriptLink: t.r2_transcript_link,
      sourceTranscriptId: t.source_transcript_id || null,
    }));

    const mappings = {};
    (mappingsData || []).forEach(m => {
      mappings[m.audio_id] = {
        transcriptId: m.transcript_id,
        confidence: m.confidence,
        matchReason: m.match_reason,
        confirmedBy: m.confirmed_by,
        confirmedAt: m.created_at,
      };
    });

    const alignments = {};
    (alignmentsData || []).forEach(a => {
      alignments[a.audio_id] = {
        // words omitted at startup — fetched lazily in detail page
        avgConfidence: a.avg_confidence,
        lowConfidenceCount: a.low_confidence_count,
        alignedAt: a.aligned_at,
      };
    });

    const reviews = {};
    (reviewsData || []).forEach(r => {
      reviews[r.audio_id] = {
        status: r.status,
        editedText: r.edited_text,
        reviewedAt: r.reviewed_at,
      };
    });

    const cleaning = {};
    (editsData || []).filter(e => e.version === 'cleaned').forEach(e => {
      cleaning[e.audio_id] = {
        cleanedText: e.text,
        originalText: e.original_text,
        cleanRate: e.clean_rate,
        cleanedAt: e.created_at,
      };
    });

    const edited = {};
    (editsData || []).filter(e => e.version === 'edited').forEach(e => {
      edited[e.audio_id] = {
        text: e.text,
        createdAt: e.created_at,
      };
    });

    // asr[audioId] = array of { text, model, createdAt, runId?, prompt?, promptLabel? }
    // Version keys take two shapes:
    //   - 'asr-<model>'             (legacy / no-prompt; one row per model)
    //   - 'asr-<model>-<unix-ms>'   (prompted / history-mode; unique per run)
    // The trailing 10+ digit group is the runId; we strip it back off the model.
    const asr = {};
    (editsData || []).filter(e => e.version.startsWith('asr-')).forEach(e => {
      if (!asr[e.audio_id]) asr[e.audio_id] = [];
      const parsed = parseAsrVersionKey(e.version);
      asr[e.audio_id].push({
        text: e.text,
        model: parsed.model,
        runId: parsed.runId,
        createdAt: e.created_at,
        prompt: e.prompt || null,
        promptLabel: e.prompt_label || null,
      });
    });

    const favorites = favoritesData || {};

    return { audio, transcripts, mappings, alignments, reviews, cleaning, trims, edited, asr, favorites };
  } catch (err) {
    console.warn('[DB] loadFromSupabase failed:', err.message);
    return null;
  }
}

// Lightweight loader for the detail page — fetches only the data needed for one audio file.
// Returns the same shape as loadFromSupabase() so callers don't need to change.
export async function loadForDetailPage(audioId, libraryId = null) {
  const lib = libraryId || getActiveLibrary();
  try {
    // Parent + siblings query: split IDs follow <parentId>_p<N> (see split.js).
    // Fetch rows whose id starts with parentId; client-side filter below keeps
    // only the exact parent and its _p<N> children. This lets renderDetailPage
    // show split-relationship links without needing the full audio_files list.
    const partMatch = /^(.+)_p(\d+)$/.exec(audioId);
    const parentId = partMatch ? partMatch[1] : audioId;
    const prefixPattern = parentId.replace(/[%_]/g, (c) => '\\' + c);

    const [
      audioFamilyRes,
      transcriptData,
      mappingRow,
      alignmentRow,
      reviewRow,
      editsRows,
    ] = await Promise.all([
      supabase.from('audio_files').select('*').like('id', `${prefixPattern}%`).eq('library_id', lib),
      fetchAll('transcripts', 'id,name,year,month,day,first_line,drive_link,r2_transcript_link,source_transcript_id', lib),
      supabase.from('mappings').select('*').eq('audio_id', audioId).eq('library_id', lib).maybeSingle(),
      supabase.from('alignments').select('audio_id,avg_confidence,low_confidence_count,aligned_at').eq('audio_id', audioId).eq('library_id', lib).maybeSingle(),
      supabase.from('reviews').select('*').eq('audio_id', audioId).eq('library_id', lib).maybeSingle(),
      supabase.from('transcript_edits').select('*').eq('audio_id', audioId).eq('library_id', lib),
    ]);

    const byId = (a, b) => {
      const na = parseInt(a.id), nb = parseInt(b.id);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };

    // Keep only the exact parent and its _p<N> children — the LIKE query can
    // match unrelated IDs like "a_10130" that share the same prefix.
    const partRe = new RegExp('^' + prefixPattern.replace(/\\([%_])/g, '$1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(_p\\d+)?$');
    const audioRows = (audioFamilyRes.data || []).filter(r => partRe.test(r.id)).sort(byId);
    const audio = audioRows.map(a => ({
      id: a.id, name: a.name, year: a.year, month: a.month, day: a.day, type: a.type,
      estMinutes: a.duration_minutes, isSelected50hr: a.is_selected_50hr, isBenchmark: a.is_benchmark,
      comments: a.comments || '', r2Link: a.r2_link, driveLink: a.drive_link,
      trimStart: a.trim_start || 0, trimEnd: a.trim_end || 0,
      trainingExportedAt: a.training_exported_at || null,
      trainingExportedBy: a.training_exported_by || null,
    }));

    const trims = {};
    audio.forEach(x => { if (x.trimStart || x.trimEnd) trims[x.id] = { start: x.trimStart, end: x.trimEnd }; });

    const transcripts = (transcriptData || []).sort(byId).map(t => ({
      id: t.id, name: t.name, year: t.year, month: t.month, day: t.day,
      firstLine: t.first_line, driveLink: t.drive_link,
      r2TranscriptLink: t.r2_transcript_link, sourceTranscriptId: t.source_transcript_id || null,
    }));

    const mappings = {};
    const m = mappingRow.data;
    if (m) mappings[m.audio_id] = { transcriptId: m.transcript_id, confidence: m.confidence, matchReason: m.match_reason, confirmedBy: m.confirmed_by, confirmedAt: m.created_at };

    const alignments = {};
    const al = alignmentRow.data;
    if (al) alignments[al.audio_id] = { avgConfidence: al.avg_confidence, lowConfidenceCount: al.low_confidence_count, alignedAt: al.aligned_at };

    const reviews = {};
    const rv = reviewRow.data;
    if (rv) reviews[rv.audio_id] = { status: rv.status, editedText: rv.edited_text, reviewedAt: rv.reviewed_at };

    const edits = editsRows.data || [];
    const cleaning = {};
    edits.filter(e => e.version === 'cleaned').forEach(e => {
      cleaning[e.audio_id] = { cleanedText: e.text, originalText: e.original_text, cleanRate: e.clean_rate, cleanedAt: e.created_at };
    });
    const edited = {};
    edits.filter(e => e.version === 'edited').forEach(e => {
      edited[e.audio_id] = { text: e.text, createdAt: e.created_at };
    });
    const asr = {};
    edits.filter(e => e.version.startsWith('asr-')).forEach(e => {
      if (!asr[e.audio_id]) asr[e.audio_id] = [];
      const parsed = parseAsrVersionKey(e.version);
      asr[e.audio_id].push({
        text: e.text,
        model: parsed.model,
        runId: parsed.runId,
        createdAt: e.created_at,
        prompt: e.prompt || null,
        promptLabel: e.prompt_label || null,
      });
    });

    return { audio, transcripts, mappings, alignments, reviews, cleaning, trims, edited, asr };
  } catch (err) {
    console.warn('[DB] loadForDetailPage failed:', err.message);
    return null;
  }
}
