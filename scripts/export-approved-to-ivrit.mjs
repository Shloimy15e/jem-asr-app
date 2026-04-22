// Export approved 50hr audio files → ivrit-ai Stage 1 folder structure.
//
// Produces one directory per audio under <out>/<library>/<audio_id>/ with:
//   - audio.mp3               (trimmed if trim_start/trim_end > 0)
//   - transcript.aligned.json (stable_whisper WhisperResult shape)
//   - metadata.json           (ivrit-ai NormalizedEntryMetadata shape, language=yi)
//
// Next step (run yourself after this script succeeds):
//   git clone https://github.com/ivrit-ai/asr-training /tmp/asr-training
//   cd /tmp/asr-training && pip install -r requirements.txt
//   python create_dataset.py <out>/<library> \
//     --segments_filename_glob 'transcript.aligned.json' \
//     --output_folder <out>/parquet
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env to bypass RLS.
// No ffmpeg needed — trimming is done in pure JS via scripts/lib/mp3-frame-walker.mjs.
//
// Usage:
//   node scripts/export-approved-to-ivrit.mjs --out ./dist-training
//   node scripts/export-approved-to-ivrit.mjs --out ./dist-training --library jemedia
//   node scripts/export-approved-to-ivrit.mjs --dry-run --limit 3
//   node scripts/export-approved-to-ivrit.mjs --out ./dist-training --resume
//   node scripts/export-approved-to-ivrit.mjs --out ./dist-training --id a_1124
//   node scripts/export-approved-to-ivrit.mjs --out ./dist-training --id a_1124 --force

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { segmentWords } from './lib/segment-words.mjs';
import { extractMp3SliceByTime } from './lib/mp3-frame-walker.mjs';

// ── Supabase credentials (from .env) ─────────────────────────────────────
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from the project .env. Falls back
// to VITE_SUPABASE_URL since that's already set for the Vite build. The
// service key bypasses RLS so the script can read across libraries.
function loadEnv() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!existsSync(envPath)) return {};
  const raw = readFileSync(envPath, 'utf8');
  return Object.fromEntries(
    raw.split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}
const env = { ...loadEnv(), ...process.env };
const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('\n❌ Missing Supabase credentials.\n');
  console.error('  Add to .env (or export as env vars):');
  console.error('    SUPABASE_URL=https://<project-ref>.supabase.co');
  console.error('    SUPABASE_SERVICE_KEY=<service-role-JWT>\n');
  console.error('  The service role key is under Supabase Dashboard → Settings → API.\n');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── CLI args ─────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const OUT_ROOT = args.out || './dist-training';
const LIBRARY_FILTER = args.library || null;
const ID_FILTER = args.id || null;         // target a single audio_id
const DRY_RUN = !!args['dry-run'];
const LIMIT = args.limit ? parseInt(args.limit, 10) : null;
const RESUME = !!args.resume;
const FORCE  = !!args.force;                // re-export even if output exists

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

// ── Supabase helpers ─────────────────────────────────────────────────────
async function fetchAll(table, columns, filters = []) {
  const rows = [];
  let from = 0;
  const chunk = 1000;
  while (true) {
    let q = supabase.from(table).select(columns).range(from, from + chunk - 1);
    for (const f of filters) q = q[f.op](f.col, f.val);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...data);
    if (data.length < chunk) break;
    from += chunk;
  }
  return rows;
}

async function fetchAlignmentWords(audioId, libraryId) {
  const { data, error } = await supabase
    .from('alignments')
    .select('words, avg_confidence')
    .eq('audio_id', audioId)
    .eq('library_id', libraryId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── Audio fetch + frame-accurate trim ──────────────────────────────────
// Uses the same MP3 frame walker as the Cloudflare Worker (see
// functions/api/align.js:extractMp3SliceByTime). Frame-accurate within one
// MP3 frame (~26 ms), no ffmpeg subprocess, no XING TOC interpolation error.
//
// Replaces the old `ffmpeg -ss <start> -to <end> -i source.mp3 -c:a libmp3lame`
// path which used ffmpeg's fast input-seek. That seek can land 1–3 s off on
// low-bitrate VBR-ish MP3s, making the trimmed audio mismatched with the
// stored word timestamps (which are in original-audio coordinates).
async function fetchAndTrimMp3(url, trimStart, trimEnd) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = await res.arrayBuffer();

  if (!trimStart && !trimEnd) return new Uint8Array(buf);

  const { startByte, endByte } = extractMp3SliceByTime(buf, trimStart, trimEnd);
  return new Uint8Array(buf, startByte, endByte - startByte);
}

// ── Word timestamp shifting ──────────────────────────────────────────────
// Alignment word times are stored in ORIGINAL audio coordinates (see
// src/alignment.js line 435-439: "pod-time 0 corresponds to real-time
// trimStart, so we add trimStart back"). After trimming the audio on disk,
// subtract trim_start so timestamps start at 0.
function shiftWords(words, trimStart, trimEnd) {
  if (!trimStart && !trimEnd) return words.slice();
  const out = [];
  for (const w of words) {
    if (typeof w.start !== 'number' || typeof w.end !== 'number') continue;
    if (trimStart && w.end < trimStart) continue;
    if (trimEnd && w.start > trimEnd) continue;
    out.push({
      ...w,
      start: Math.max(0, w.start - (trimStart || 0)),
      end: Math.max(0, w.end - (trimStart || 0)),
    });
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('── JEM → ivrit-ai Stage 1 export ──────────────────────────');
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Library filter: ${LIBRARY_FILTER || '(all)'}`);
  if (ID_FILTER) console.log(`ID filter:      ${ID_FILTER}`);
  console.log(`Dry run: ${DRY_RUN}   Limit: ${LIMIT || '∞'}   Resume: ${RESUME}   Force: ${FORCE}`);
  console.log();

  // 1. Fetch all approved reviews
  console.log('Fetching approved reviews…');
  const reviewFilters = [{ op: 'eq', col: 'status', val: 'approved' }];
  if (LIBRARY_FILTER) reviewFilters.push({ op: 'eq', col: 'library_id', val: LIBRARY_FILTER });
  if (ID_FILTER)      reviewFilters.push({ op: 'eq', col: 'audio_id',   val: ID_FILTER });
  const reviews = await fetchAll('reviews', 'audio_id, library_id, edited_text, reviewed_at', reviewFilters);
  console.log(`  ${reviews.length} approved reviews`);

  // 2. Fetch candidate audio_files (50hr, not benchmark) for those audio_ids
  const candidateIds = reviews.map(r => r.audio_id);
  if (candidateIds.length === 0) {
    if (ID_FILTER) console.log(`No approved review for audio_id="${ID_FILTER}". Exiting.`);
    else           console.log('Nothing approved yet. Exiting.');
    return;
  }

  console.log('Fetching audio metadata…');
  // Chunk the IN query to avoid URL size limits
  const audioRows = [];
  const ID_CHUNK = 200;
  for (let i = 0; i < candidateIds.length; i += ID_CHUNK) {
    const chunk = candidateIds.slice(i, i + ID_CHUNK);
    let q = supabase
      .from('audio_files')
      .select('id, library_id, name, year, month, day, type, r2_link, trim_start, trim_end, duration_minutes, is_selected_50hr, is_benchmark')
      .in('id', chunk)
      .eq('is_selected_50hr', true)
      .eq('is_benchmark', false);
    if (LIBRARY_FILTER) q = q.eq('library_id', LIBRARY_FILTER);
    const { data, error } = await q;
    if (error) throw error;
    audioRows.push(...data);
  }
  console.log(`  ${audioRows.length} approved + 50hr + non-benchmark audio rows`);

  // 3. Fetch mappings + transcript names for nice metadata
  const mappingRows = [];
  for (let i = 0; i < audioRows.length; i += ID_CHUNK) {
    const chunk = audioRows.slice(i, i + ID_CHUNK).map(a => a.id);
    const { data, error } = await supabase
      .from('mappings')
      .select('audio_id, library_id, transcript_id, confidence, match_reason')
      .in('audio_id', chunk);
    if (error) throw error;
    mappingRows.push(...data);
  }
  const mappingByAudio = new Map(mappingRows.map(m => [`${m.library_id}:${m.audio_id}`, m]));

  const transcriptIds = [...new Set(mappingRows.map(m => m.transcript_id).filter(Boolean))];
  const transcriptNameById = new Map();
  for (let i = 0; i < transcriptIds.length; i += ID_CHUNK) {
    const chunk = transcriptIds.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase.from('transcripts').select('id, name').in('id', chunk);
    if (error) throw error;
    data.forEach(t => transcriptNameById.set(t.id, t.name));
  }

  // 4. Apply limit
  const candidates = LIMIT ? audioRows.slice(0, LIMIT) : audioRows;
  console.log(`\nProcessing ${candidates.length} file(s)…\n`);

  const reviewByKey = new Map(reviews.map(r => [`${r.library_id}:${r.audio_id}`, r]));

  let ok = 0, skipped = 0, failed = 0;
  const failures = [];

  for (const audio of candidates) {
    const audioKey = `${audio.library_id}:${audio.id}`;
    const label = `[${audio.library_id}/${audio.id}]`;
    const outDir = path.join(OUT_ROOT, audio.library_id, audio.id);

    try {
      // Resume check — skip if output already exists unless --force
      if (RESUME && !FORCE && hasAllOutputs(outDir)) {
        console.log(`${label} ⏭  already complete (--resume)`);
        skipped++;
        continue;
      }

      // Check r2_link
      if (!audio.r2_link) {
        console.log(`${label} ⚠  no r2_link — skipping`);
        failures.push({ id: audio.id, library: audio.library_id, reason: 'no r2_link' });
        failed++;
        continue;
      }

      // Fetch alignment words
      const alignment = await fetchAlignmentWords(audio.id, audio.library_id);
      if (!alignment || !alignment.words || !Array.isArray(alignment.words) || alignment.words.length === 0) {
        console.log(`${label} ⚠  no alignment words — skipping`);
        failures.push({ id: audio.id, library: audio.library_id, reason: 'no alignment' });
        failed++;
        continue;
      }

      const trimStart = Number(audio.trim_start) || 0;
      const trimEnd = Number(audio.trim_end) || 0;

      // Shift word timestamps to exported-audio coordinates
      const shiftedWords = shiftWords(alignment.words, trimStart, trimEnd);
      if (shiftedWords.length === 0) {
        console.log(`${label} ⚠  all words fall outside trim window — skipping`);
        failures.push({ id: audio.id, library: audio.library_id, reason: 'empty after trim shift' });
        failed++;
        continue;
      }

      // Group into segments
      const segments = segmentWords(shiftedWords);
      if (segments.length === 0) {
        console.log(`${label} ⚠  segmentation produced no segments — skipping`);
        failures.push({ id: audio.id, library: audio.library_id, reason: 'no segments' });
        failed++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`${label} ✓  ${shiftedWords.length} words → ${segments.length} segments   trim=${trimStart}-${trimEnd || 'end'}   name="${audio.name}"`);
        ok++;
        continue;
      }

      // Write output files
      mkdirSync(outDir, { recursive: true });

      // Fetch source from R2 and frame-accurate-trim to audio.mp3.
      // No ffmpeg, no re-encode — the slice is a byte-exact subset of the
      // source MP3 frames, which keeps timestamps aligned with the stored
      // per-word alignment data.
      const audioOutPath = path.join(outDir, 'audio.mp3');
      const slice = await fetchAndTrimMp3(audio.r2_link, trimStart, trimEnd);
      writeFileSync(audioOutPath, slice);

      // Build transcript.aligned.json
      const aligned = {
        language: 'yi',
        segments,
      };
      writeFileSync(path.join(outDir, 'transcript.aligned.json'), JSON.stringify(aligned, null, 2));

      // Build metadata.json (ivrit-ai NormalizedEntryMetadata shape)
      const mapping = mappingByAudio.get(audioKey);
      const transcriptName = mapping ? transcriptNameById.get(mapping.transcript_id) : null;
      const review = reviewByKey.get(audioKey);
      const reviewText = review?.edited_text ?? null;
      const alignedText = segments.map(s => s.text).join(' ');
      const textDiffers = reviewText != null && reviewText.trim() !== alignedText.trim();

      const segmentDurations = segments.map(s => s.end - s.start);
      const avgSegmentDuration = segmentDurations.length ? mean(segmentDurations) : 0;
      const wordsCount = segments.reduce((n, s) => n + s.words.length, 0);
      const totalDuration = segments.length ? segments[segments.length - 1].end : 0;
      const avgWordsPerMinute = totalDuration > 0 ? (wordsCount / (totalDuration / 60)) : 0;

      const metadata = {
        source_type: audio.library_id,
        source_id: audio.library_id,
        source_entry_id: audio.id,
        document_language: 'yi',
        segments_count: segments.length,
        words_count: wordsCount,
        quality_score: round3(alignment.avg_confidence ?? mean(segments.map(s => s.probability))),
        per_segment_quality_scores: segments.map(s => ({
          start: s.start,
          end: s.end,
          probability: s.probability,
        })),
        avg_words_per_segment: round2(wordsCount / segments.length),
        avg_segment_duration: round3(avgSegmentDuration),
        avg_words_per_minute: Math.round(avgWordsPerMinute),
        jem: {
          name: audio.name || null,
          year: audio.year || null,
          month: audio.month || null,
          day: audio.day || null,
          type: audio.type || null,
          transcript_name: transcriptName || null,
          duration_minutes: audio.duration_minutes || null,
          trim_start: trimStart,
          trim_end: trimEnd,
          review_edited_text_differs: textDiffers,
          reviewed_at: review?.reviewed_at || null,
        },
      };
      writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

      const sz = statSync(audioOutPath).size;
      console.log(`${label} ✓  ${segments.length} seg · ${wordsCount} words · ${formatBytes(sz)}   "${audio.name}"`);
      ok++;
    } catch (err) {
      console.error(`${label} ✗  ${err.message}`);
      failures.push({ id: audio.id, library: audio.library_id, reason: err.message });
      failed++;
    }
  }

  // Summary
  console.log();
  console.log('── Summary ────────────────────────────────────────────────');
  console.log(`Succeeded: ${ok}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Failed:    ${failed}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.library}/${f.id}  —  ${f.reason}`);
  }
  if (!DRY_RUN && ok > 0) {
    console.log('\nNext step:');
    console.log(`  git clone https://github.com/ivrit-ai/asr-training /tmp/asr-training`);
    console.log(`  cd /tmp/asr-training && pip install -r requirements.txt`);
    console.log(`  python create_dataset.py ${path.resolve(OUT_ROOT)}/${LIBRARY_FILTER || '<library>'} \\`);
    console.log(`    --segments_filename_glob 'transcript.aligned.json' \\`);
    console.log(`    --output_folder ${path.resolve(OUT_ROOT)}/parquet`);
  }
}

function hasAllOutputs(dir) {
  const files = ['audio.mp3', 'transcript.aligned.json', 'metadata.json'];
  return files.every(f => existsSync(path.join(dir, f)));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
