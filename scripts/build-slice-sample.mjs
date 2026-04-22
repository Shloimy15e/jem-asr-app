// Build a concrete Stage 2-style 30s-slice sample from one Stage 1 folder.
// For each slice: extracts the audio window with ffmpeg and writes a JSON row
// matching ivrit-ai's HF dataset shape (audio + transcript + metadata + prev_transcript).
//
// Output layout:
//   dist-training-slices/<entry_id>/
//     slices.jsonl             ← one row per slice (HF dataset row shape, minus raw bytes)
//     slice-00/audio.mp3       ← the 30s audio chunk
//     slice-00/row.json        ← same shape as a single HF row (pretty-printed)
//     slice-01/...
//
// Usage:
//   node scripts/build-slice-sample.mjs ./dist-training/jemedia/a_1124
//   node scripts/build-slice-sample.mjs ./dist-training/jemedia/a_1124 --slice-length 30 --out ./dist-training-slices

import { readFileSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';

import { extractMp3SliceByTime } from './lib/mp3-frame-walker.mjs';

const args = process.argv.slice(2);
const entryDir = args.find(a => !a.startsWith('--')) || './dist-training/jemedia/a_1124';
const SLICE_LENGTH = parseFloat(getFlag('--slice-length', '30'));
const OUT_ROOT = getFlag('--out', './dist-training-slices');
const MERGE_GAP = 0.3;

function getFlag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const aligned = JSON.parse(readFileSync(path.join(entryDir, 'transcript.aligned.json'), 'utf8'));
const metadata = JSON.parse(readFileSync(path.join(entryDir, 'metadata.json'), 'utf8'));
const sourceAudio = path.join(entryDir, 'audio.mp3');
const entryId = path.basename(entryDir);
const outDir = path.join(OUT_ROOT, entryId);
mkdirSync(outDir, { recursive: true });

// 1. Merge segments with gap < 0.3s
const merged = [];
for (const s of aligned.segments) {
  const prev = merged[merged.length - 1];
  if (prev && s.start - prev.end < MERGE_GAP) {
    prev.end = s.end;
    prev.text = prev.text + ' ' + s.text;
  } else {
    merged.push({ start: s.start, end: s.end, text: s.text });
  }
}

// 2. Greedy-pack into ≤SLICE_LENGTH slices
const slices = [];
let current = null;
for (const seg of merged) {
  if (!current) { current = { start: seg.start, end: seg.end, segments: [seg] }; continue; }
  if (seg.end - current.start > SLICE_LENGTH) {
    slices.push(current);
    current = { start: seg.start, end: seg.end, segments: [seg] };
  } else {
    current.end = seg.end;
    current.segments.push(seg);
  }
}
if (current) slices.push(current);

// 3. Format transcripts with Whisper timestamp tokens
const tsToken = t => `<|${(Math.round(t / 0.02) * 0.02).toFixed(2)}|>`;
const formatSliceTranscript = slice => slice.segments.map(seg => {
  return `${tsToken(seg.start - slice.start)}${seg.text}${tsToken(seg.end - slice.start)}`;
}).join('');

// 4. Load the source audio once for repeated frame-walker slicing
const sourceBuf = readFileSync(sourceAudio);

// 5. Build rows + cut audio
console.log(`Entry: ${entryId}`);
console.log(`Source audio: ${sourceAudio}`);
console.log(`${aligned.segments.length} segments → ${merged.length} merged → ${slices.length} slices of ≤${SLICE_LENGTH}s`);
console.log(`Output: ${outDir}\n`);

const jsonlPath = path.join(outDir, 'slices.jsonl');
const jsonlStream = createWriteStream(jsonlPath);

for (let i = 0; i < slices.length; i++) {
  const slice = slices[i];
  const sliceDir = path.join(outDir, `slice-${String(i).padStart(2, '0')}`);
  mkdirSync(sliceDir, { recursive: true });

  const audioOut = path.join(sliceDir, 'audio.mp3');
  // Frame-accurate slice from the already-trimmed source audio. The slice's
  // t=0 corresponds to sourceAudio position slice.start, frame-aligned.
  const { startByte, endByte } = extractMp3SliceByTime(sourceBuf.buffer, slice.start, slice.end);
  writeFileSync(audioOut, Buffer.from(sourceBuf.buffer, startByte, endByte - startByte));

  const transcript = formatSliceTranscript(slice);
  const prevTranscript = i > 0 ? formatSliceTranscript(slices[i - 1]) : '';

  const row = {
    audio: { path: `slice-${String(i).padStart(2, '0')}/audio.mp3`, sampling_rate: 16000 },
    transcript,
    metadata: {
      seek: round3(slice.start),
      duration: round3(slice.end - slice.start),
      source: metadata.source_type,
      entry_id: entryId,
      quality_score: metadata.quality_score,
    },
    has_prev: i > 0,
    has_timestamps: true,
    prev_transcript: prevTranscript,
  };

  // Pretty row.json beside the audio
  writeFileSync(path.join(sliceDir, 'row.json'), JSON.stringify(row, null, 2));
  // Compact JSONL line
  jsonlStream.write(JSON.stringify(row) + '\n');

  process.stdout.write(`\r  wrote ${i + 1}/${slices.length} slices`);
}
jsonlStream.end();
console.log(`\n\nDone. Inspect ${outDir}/slice-00/ for a sample.`);

function round3(n) { return Math.round(n * 1000) / 1000; }
