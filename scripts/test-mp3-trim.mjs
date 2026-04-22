// Validate frame-accurate MP3 trim helper in functions/api/align.js against
// ffmpeg's accurate-seek (-ss after -i) reference. Uses the existing trimmed
// audio at dist-training/jemedia/a_1124/audio.mp3 as the test source.
//
// Run: node scripts/test-mp3-trim.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { extractMp3SliceByTime } from './lib/mp3-frame-walker.mjs';

const SOURCE = './dist-training/jemedia/a_1124/audio.mp3';
const TMP = './tmp-mp3-trim-test';

if (!existsSync(SOURCE)) {
  console.error(`Source not found: ${SOURCE}`);
  console.error('Run `node scripts/export-approved-to-ivrit.mjs --out ./dist-training --limit 1` first.');
  process.exit(1);
}

mkdirSync(TMP, { recursive: true });

function runFfprobe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(parseFloat(out.trim())) : reject(new Error(`ffprobe exit ${code}`)));
  });
}

function runFfmpegAccurate(srcPath, dstPath, start, end) {
  // -ss/-to AFTER -i forces output-side seek (frame-accurate).
  // Use stream copy (no re-encode) to preserve raw frame bytes for comparison.
  return new Promise((resolve, reject) => {
    const args = ['-y', '-loglevel', 'error', '-i', srcPath, '-ss', String(start)];
    if (end > 0) args.push('-to', String(end));
    args.push('-c:a', 'copy', dstPath);
    const p = spawn('ffmpeg', args);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err}`)));
  });
}

const TESTS = [
  { name: 'first 30s',     start: 0,     end: 30 },
  { name: 'middle 30s',    start: 100,   end: 130 },
  { name: 'long 5min',     start: 600,   end: 900 },
  { name: 'tail to end',   start: 1500,  end: 0 },
  { name: 'small 5s',      start: 50,    end: 55 },
];

const sourceBuf = readFileSync(SOURCE);
const sourceDuration = await runFfprobe(SOURCE);
console.log(`Source: ${SOURCE}`);
console.log(`Source duration: ${sourceDuration.toFixed(3)}s, size: ${sourceBuf.length} bytes\n`);

let pass = 0, fail = 0;

for (const t of TESTS) {
  const targetEnd = t.end > 0 ? t.end : sourceDuration;
  const expectedDuration = targetEnd - t.start;

  // Walker output
  const t0 = performance.now();
  const { startByte, endByte } = extractMp3SliceByTime(sourceBuf.buffer, t.start, t.end);
  const walkerMs = (performance.now() - t0).toFixed(1);
  const walkerSlice = sourceBuf.slice(startByte, endByte);
  const walkerOutPath = path.join(TMP, `walker-${t.name.replace(/\s+/g, '_')}.mp3`);
  writeFileSync(walkerOutPath, walkerSlice);
  const walkerDuration = await runFfprobe(walkerOutPath);

  // ffmpeg reference
  const ffOutPath = path.join(TMP, `ff-${t.name.replace(/\s+/g, '_')}.mp3`);
  await runFfmpegAccurate(SOURCE, ffOutPath, t.start, t.end);
  const ffDuration = await runFfprobe(ffOutPath);
  const ffSize = readFileSync(ffOutPath).length;

  const walkerOff = walkerDuration - expectedDuration;
  const ffOff     = ffDuration     - expectedDuration;
  const tolerance = 0.05; // 50ms = ~2 MP3 frames
  const ok = Math.abs(walkerOff) < tolerance;

  console.log(`── ${t.name}  [${t.start}, ${t.end || 'end'}]  expected ${expectedDuration.toFixed(2)}s`);
  console.log(`  walker: ${walkerSlice.length} bytes, ${walkerDuration.toFixed(3)}s (Δ ${walkerOff >= 0 ? '+' : ''}${walkerOff.toFixed(3)}s) — ${walkerMs}ms`);
  console.log(`  ffmpeg: ${ffSize} bytes, ${ffDuration.toFixed(3)}s (Δ ${ffOff >= 0 ? '+' : ''}${ffOff.toFixed(3)}s)`);
  console.log(`  ${ok ? '✓ pass' : '✗ FAIL — walker outside ' + tolerance + 's tolerance'}\n`);

  if (ok) pass++; else fail++;
}

// Cleanup
rmSync(TMP, { recursive: true, force: true });

console.log(`── Result: ${pass} pass, ${fail} fail ─────────────────`);
process.exit(fail > 0 ? 1 : 0);
