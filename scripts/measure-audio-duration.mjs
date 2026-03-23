import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse .env
const envRaw = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const env = Object.fromEntries(
  envRaw.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

// MPEG1 Layer3 bitrate table (kbps), indexed by bitrate_index
const BITRATE_TABLE = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];

async function measureDuration(id, url) {
  const resp = await fetch(url, {
    headers: { Range: 'bytes=0-8191' },
    signal: AbortSignal.timeout(15000),
  });

  // Get total file size from Content-Range: bytes 0-8191/TOTAL
  let totalSize = null;
  const cr = resp.headers.get('content-range');
  if (cr) {
    const m = cr.match(/\/(\d+)$/);
    if (m) totalSize = parseInt(m[1]);
  }
  // Fallback: content-length of a non-ranged response
  if (!totalSize) {
    const cl = resp.headers.get('content-length');
    if (cl) totalSize = parseInt(cl);
  }

  if (!totalSize) throw new Error('Could not determine file size');

  const buf = Buffer.from(await resp.arrayBuffer());

  // Find first MP3 sync word
  let bitrate = 128; // default fallback
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) {
      const bitrateIdx = (buf[i + 2] >> 4) & 0x0F;
      const detected = BITRATE_TABLE[bitrateIdx];
      if (detected > 0) {
        bitrate = detected;
        break;
      }
    }
  }

  const durationMinutes = totalSize / (bitrate * 125 * 60);
  return Math.round(durationMinutes * 100) / 100;
}

async function main() {
  console.log('Fetching audio files from Supabase...');
  const { data: files, error } = await supabase
    .from('audio_files')
    .select('id, name, r2_link, duration_minutes')
    .or('is_selected_50hr.eq.true,is_benchmark.eq.true');

  if (error) throw new Error(error.message);
  console.log(`Found ${files.length} files. Processing in batches of 5...`);

  const results = [];
  const BATCH = 5;

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH).filter(f => f.r2_link);
    const settled = await Promise.allSettled(
      batch.map(f => measureDuration(f.id, f.r2_link).then(mins => ({ id: f.id, mins })))
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
      else results.push({ id: batch[settled.indexOf(s)]?.id, error: s.reason?.message });
    }
    if ((i + BATCH) % 25 === 0 || i + BATCH >= files.length) {
      process.stdout.write(`Progress: ${Math.min(i + BATCH, files.length)}/${files.length}\n`);
    }
  }

  const successes = results.filter(r => r.mins != null);
  const failures = results.filter(r => r.error);
  console.log(`\nMeasured ${successes.length} files, ${failures.length} failed.`);

  // Batch update Supabase
  console.log('Updating Supabase...');
  let updated = 0;
  for (let i = 0; i < successes.length; i += 50) {
    const chunk = successes.slice(i, i + 50);
    await Promise.all(chunk.map(r =>
      supabase.from('audio_files').update({ duration_minutes: r.mins }).eq('id', r.id)
    ));
    updated += chunk.length;
    process.stdout.write(`Updated: ${updated}/${successes.length}\n`);
  }

  const durations = successes.map(r => r.mins);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const min = Math.min(...durations);
  const max = Math.max(...durations);

  console.log('\n=== RESULTS ===');
  console.log(`Attempted: ${files.filter(f => f.r2_link).length}`);
  console.log(`Succeeded: ${successes.length}`);
  console.log(`Failed:    ${failures.length}`);
  console.log(`Avg duration: ${avg.toFixed(2)} min`);
  console.log(`Min duration: ${min.toFixed(2)} min`);
  console.log(`Max duration: ${max.toFixed(2)} min`);

  if (failures.length > 0) {
    console.log('\nFailed files:');
    failures.slice(0, 10).forEach(f => console.log(`  ${f.id}: ${f.error}`));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
