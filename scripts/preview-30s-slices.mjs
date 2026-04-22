// Preview what ivrit-ai's create_dataset.py would produce from one Stage-1 folder.
// Re-implements its greedy 30s segment-packing in JS. Does NOT touch audio —
// just shows how segments would be grouped and what the Whisper-formatted
// transcript strings would look like, including the `prev_transcript` field.
//
// Usage: node scripts/preview-30s-slices.mjs <entry-folder> [--slice-length 30] [--show N]

import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const entryDir = args.find(a => !a.startsWith('--')) || './dist-training/jemedia/a_1124';
const SLICE_LENGTH = parseFloat(getFlag('--slice-length', '30'));
const SHOW = parseInt(getFlag('--show', '3'), 10);
const MERGE_GAP = 0.3;

function getFlag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const aligned = JSON.parse(readFileSync(path.join(entryDir, 'transcript.aligned.json'), 'utf8'));
const segments = aligned.segments;

// Step 1: merge segments with gap < 0.3s (matches merge_slice_segments)
const merged = [];
for (const s of segments) {
  const prev = merged[merged.length - 1];
  if (prev && s.start - prev.end < MERGE_GAP) {
    prev.end = s.end;
    prev.text = prev.text + ' ' + s.text;
    prev.words = [...prev.words, ...s.words];
  } else {
    merged.push({ ...s, words: [...s.words] });
  }
}

// Step 2: greedy pack into slices of <= SLICE_LENGTH
const slices = [];
let current = null;
for (const seg of merged) {
  if (!current) {
    current = { start: seg.start, end: seg.end, segments: [seg] };
    continue;
  }
  // Would adding this segment push the slice past 30s from its start?
  if (seg.end - current.start > SLICE_LENGTH) {
    slices.push(current);
    current = { start: seg.start, end: seg.end, segments: [seg] };
  } else {
    current.end = seg.end;
    current.segments.push(seg);
  }
}
if (current) slices.push(current);

// Step 3: format each slice's transcript with Whisper timestamp tokens (0.02s quantisation)
function tsToken(t) {
  const q = Math.round(t / 0.02) * 0.02;
  return `<|${q.toFixed(2)}|>`;
}
function formatSliceTranscript(slice) {
  const parts = [];
  for (const seg of slice.segments) {
    const relStart = seg.start - slice.start;
    const relEnd = seg.end - slice.start;
    parts.push(`${tsToken(relStart)}${seg.text}${tsToken(relEnd)}`);
  }
  return parts.join('');
}

const rows = slices.map((slice, i) => ({
  audio: `[${(slice.end - slice.start).toFixed(2)}s of MP3 bytes]`,
  transcript: formatSliceTranscript(slice),
  metadata: {
    seek: round3(slice.start),
    duration: round3(slice.end - slice.start),
    source: 'jemedia',
    entry_id: path.basename(entryDir),
  },
  has_prev: i > 0,
  has_timestamps: true,
  prev_transcript: i > 0 ? formatSliceTranscript(slices[i - 1]) : '',
}));

console.log(`Entry: ${entryDir}`);
console.log(`Input: ${segments.length} segments → ${merged.length} after merge → ${slices.length} slices of ≤${SLICE_LENGTH}s\n`);

const durations = slices.map(s => s.end - s.start);
const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
const min = Math.min(...durations);
const max = Math.max(...durations);
console.log(`Slice durations: min ${min.toFixed(2)}s · avg ${avg.toFixed(2)}s · max ${max.toFixed(2)}s\n`);

console.log(`── Showing first ${Math.min(SHOW, rows.length)} slice(s) ─────────────────────\n`);
for (let i = 0; i < Math.min(SHOW, rows.length); i++) {
  const r = rows[i];
  console.log(`── Slice ${i} ──────────────────────────────────────────────────`);
  console.log(`metadata:       ${JSON.stringify(r.metadata)}`);
  console.log(`has_prev:       ${r.has_prev}`);
  console.log(`has_timestamps: ${r.has_timestamps}`);
  console.log(`audio:          ${r.audio}`);
  console.log(`transcript:     ${r.transcript}`);
  if (r.has_prev) {
    console.log(`prev_transcript:${r.prev_transcript}`);
  }
  console.log();
}

function round3(n) { return Math.round(n * 1000) / 1000; }
