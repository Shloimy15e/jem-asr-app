import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

// ── Audio file FK guard ──────────────────────────────────────────────
// Many tables have audio_id FK → audio_files.id, so we upsert the file
// before writing related rows.

async function ensureAudioFile(audio) {
  if (!audio) return;
  const { error } = await supabase.from('audio_files').upsert(
    {
      id: audio.id,
      name: audio.name,
      r2_link: audio.r2Link || null,
      drive_link: audio.driveLink || null,
      year: audio.year || null,
      month: audio.month || null,
      day: audio.day || null,
      type: audio.type || null,
      duration_minutes: audio.estMinutes || null,
      is_selected_50hr: audio.isSelected50hr || false,
      is_benchmark: audio.isBenchmark || false,
    },
    { onConflict: 'id' },
  );
  if (error) console.warn('[DB] ensureAudioFile:', error.message);
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
    },
    { onConflict: 'audio_id' },
  );
  if (error) console.warn('[DB] syncMapping:', error.message);
}

export async function deleteMapping(audioId) {
  const { error } = await supabase.from('mappings').delete().eq('audio_id', audioId);
  if (error) console.warn('[DB] deleteMapping:', error.message);
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
    },
    { onConflict: 'audio_id,version' },
  );
  if (error) console.warn('[DB] syncCleaning:', error.message);
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
    },
    { onConflict: 'audio_id' },
  );
  if (error) console.warn('[DB] syncAlignment:', error.message);
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
    },
    { onConflict: 'audio_id' },
  );
  if (error) console.warn('[DB] syncReview:', error.message);
}

// ── Dispatch helper used by state.js ────────────────────────────────
// Called fire-and-forget after every updateState() call.

async function syncAudioName(audioId, newName) {
  const { error } = await supabase
    .from('audio_files')
    .update({ name: newName })
    .eq('id', audioId);
  if (error) console.warn('[DB] syncAudioName:', error.message);
}

async function syncAudioComment(audioId, comment) {
  const { error } = await supabase
    .from('audio_files')
    .update({ comments: comment || null })
    .eq('id', audioId);
  if (error) console.warn('[DB] syncAudioComment:', error.message);
}

export function syncStateKey(key, audioId, value, audioEntry) {
  switch (key) {
    case 'audioNames':
      syncAudioName(audioId, value).catch(console.warn);
      break;
    case 'audioComments':
      syncAudioComment(audioId, value).catch(console.warn);
      break;
    case 'mappings':
      syncMapping(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'cleaning':
      syncCleaning(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'alignments':
      syncAlignment(audioId, value, audioEntry).catch(console.warn);
      break;
    case 'reviews':
      syncReview(audioId, value, audioEntry).catch(console.warn);
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
      id: a.id,
      name: a.name,
      r2_link: a.r2Link || null,
      drive_link: a.driveLink || null,
      year: a.year || null,
      month: a.month || null,
      day: a.day || null,
      type: a.type || null,
      duration_minutes: a.estMinutes || null,
      is_selected_50hr: a.isSelected50hr || false,
      is_benchmark: a.isBenchmark || false,
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
    }));
    const { error } = await supabase.from('transcripts').upsert(rows, { onConflict: 'id' });
    if (error) console.warn('[DB] bulkSyncTranscripts:', error.message);
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
async function fetchAll(table, columns = '*') {
  const PAGE = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
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

export async function loadFromSupabase() {
  try {
    const [
      audioData,
      transcriptData,
      mappingsData,
      alignmentsData,
      reviewsData,
      editsData,
    ] = await Promise.all([
      fetchAll('audio_files'),
      fetchAll('transcripts', 'id,name,year,month,day,first_line,text,drive_link,r2_transcript_link,source_transcript_id'),
      fetchAll('mappings'),
      fetchAll('alignments'),
      fetchAll('reviews'),
      fetchAll('transcript_edits'),
    ]);

    // errors are logged inside fetchAll

    // Sort by numeric ID suffix for consistent ordering
    const byId = (a, b) => parseInt(a.id.slice(2)) - parseInt(b.id.slice(2));

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
    }));

    const transcripts = (transcriptData || []).sort(byId).map(t => ({
      id: t.id,
      name: t.name,
      year: t.year,
      month: t.month,
      day: t.day,
      firstLine: t.first_line,
      text: t.text || null,
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
        words: a.words,
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

    return { audio, transcripts, mappings, alignments, reviews, cleaning };
  } catch (err) {
    console.warn('[DB] loadFromSupabase failed:', err.message);
    return null;
  }
}
