// One-off script: backfills audio_files.type from filename parsing.
// Values: 'Sicha', 'Maamar', or null (empty).
// Run: node scripts/backfill-type.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://xqivwkksimsvxsxhnzsj.supabase.co';
// Service role key bypasses RLS
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxaXZ3a2tzaW1zdnhzeGhuenNqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzM4NDg0NywiZXhwIjoyMDg4OTYwODQ3fQ.5TE1nxI5F2jqmttdOm4h1ePzcreFu40SwhW3ogOhaZU';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function parseType(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (/\bsicha\b/i.test(name)) return 'Sicha';
  if (/\bma+[ai]?mar\b/i.test(name)) return 'Maamar';
  if (/\bfarbrengen\b/i.test(name)) return 'Farbrengen';
  return null;
}

async function fetchAll(table, columns) {
  const rows = [];
  let from = 0;
  const chunk = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + chunk - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < chunk) break;
    from += chunk;
  }
  return rows;
}

async function main() {
  console.log('Fetching all audio files...');
  const audio = await fetchAll('audio_files', 'id,name,type,library_id');
  console.log(`Found ${audio.length} audio files`);

  // Only backfill rows where type is null or empty
  const toUpdate = [];
  const typeCounts = {};

  for (const a of audio) {
    const parsed = parseType(a.name);
    typeCounts[parsed || '(empty)'] = (typeCounts[parsed || '(empty)'] || 0) + 1;

    if (!a.type && parsed) {
      toUpdate.push({ id: a.id, type: parsed, library_id: a.library_id });
    }
  }

  console.log('\nType distribution (parsed from filenames):');
  for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}`);
  }

  console.log(`\n${toUpdate.length} rows need updating (currently null/empty)`);

  if (toUpdate.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Batch update in chunks of 100
  const BATCH = 100;
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);
    const promises = batch.map(row =>
      supabase
        .from('audio_files')
        .update({ type: row.type })
        .eq('id', row.id)
        .eq('library_id', row.library_id)
    );
    const results = await Promise.all(promises);
    const errors = results.filter(r => r.error);
    if (errors.length) {
      console.error(`  ${errors.length} errors in batch ${i / BATCH + 1}:`, errors[0].error);
    }
    updated += batch.length - errors.length;
    process.stdout.write(`  Updated ${updated}/${toUpdate.length}\r`);
  }
  console.log(`\nDone. Updated ${updated} rows.`);
}

main().catch(console.error);
