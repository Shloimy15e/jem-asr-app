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

const CONTENT_TYPES = ['sicha', 'maamar', 'farbrengen'];

function scoreMapping(audio, transcript) {
  let score = 0;
  const reasons = [];

  const aYear = audio.year || ''; const tYear = transcript.year || '';
  const aMonth = audio.month || ''; const tMonth = transcript.month || '';
  const aDay = audio.day || ''; const tDay = transcript.day || '';

  if (aYear && tYear && aYear === tYear) {
    score += 3; reasons.push('year');
    if (aMonth && tMonth && aMonth === tMonth) {
      score += 2; reasons.push('month');
      if (aDay && tDay && aDay === tDay) {
        score += 1; reasons.push('day');
      }
    }
  }

  const aName = (audio.name || '').toLowerCase();
  const tName = (transcript.name || '').toLowerCase();
  for (const kw of CONTENT_TYPES) {
    if (aName.includes(kw) && tName.includes(kw)) {
      score += 1; reasons.push(kw); break;
    }
  }

  return { score, reasons };
}

function flag(score) {
  if (score >= 5) return '🟢 GREEN';
  if (score >= 3) return '🟡 YELLOW';
  return '🔴 RED';
}

async function main() {
  console.log('Fetching data from Supabase...');

  const [
    { data: audio50hr, error: aErr },
    { data: allTranscripts, error: tErr },
    { data: allMappings, error: mErr },
  ] = await Promise.all([
    supabase.from('audio_files').select('id, name, year, month, day, type').eq('is_selected_50hr', true),
    supabase.from('transcripts').select('id, name, year, month, day, first_line'),
    supabase.from('mappings').select('audio_id, transcript_id, confidence, match_reason, confirmed_by'),
  ]);

  if (aErr) throw new Error('audio_files: ' + aErr.message);
  if (tErr) throw new Error('transcripts: ' + tErr.message);
  if (mErr) throw new Error('mappings: ' + mErr.message);

  console.log(`Loaded: ${audio50hr.length} 50hr files, ${allTranscripts.length} transcripts, ${allMappings.length} mappings`);

  const mappingByAudio = Object.fromEntries(allMappings.map(m => [m.audio_id, m]));
  const transcriptById = Object.fromEntries(allTranscripts.map(t => [t.id, t]));
  const mappedTranscriptIds = new Set(allMappings.map(m => m.transcript_id));

  const greens = [], yellows = [], reds = [], unmapped = [];
  const autoMapped = [];

  for (const audio of audio50hr) {
    const mapping = mappingByAudio[audio.id];
    if (!mapping) {
      unmapped.push(audio);
      continue;
    }
    const transcript = transcriptById[mapping.transcript_id];
    if (!transcript) {
      unmapped.push(audio);
      continue;
    }
    const { score, reasons } = scoreMapping(audio, transcript);
    const entry = { audio, transcript, mapping, score, reasons };
    if (score >= 5) greens.push(entry);
    else if (score >= 3) yellows.push(entry);
    else reds.push(entry);
  }

  // Auto-map unmapped files
  for (const audio of unmapped) {
    let best = null;
    for (const t of allTranscripts) {
      if (mappedTranscriptIds.has(t.id)) continue;
      const { score, reasons } = scoreMapping(audio, t);
      if (!best || score > best.score) best = { transcript: t, score, reasons };
    }
    if (best && best.score >= 4) {
      const { error } = await supabase.from('mappings').upsert({
        audio_id: audio.id,
        transcript_id: best.transcript.id,
        confidence: best.score / 7,
        match_reason: 'auto-audit: ' + best.reasons.join('+'),
        confirmed_by: 'auto-audit',
      }, { onConflict: 'audio_id', ignoreDuplicates: true });
      if (!error) {
        mappedTranscriptIds.add(best.transcript.id);
        autoMapped.push({ audio, transcript: best.transcript, score: best.score, reasons: best.reasons });
      }
    }
  }

  // Still unmapped after auto-match
  const stillUnmapped = unmapped.filter(a => !autoMapped.find(m => m.audio.id === a.id));

  // Build report
  const lines = [];
  lines.push('# Mapping Audit Report');
  lines.push(`\nGenerated: ${new Date().toISOString()}\n`);

  lines.push('## Summary\n');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total 50hr files | ${audio50hr.length} |`);
  lines.push(`| Mapped (before audit) | ${audio50hr.length - unmapped.length} |`);
  lines.push(`| Unmapped (before audit) | ${unmapped.length} |`);
  lines.push(`| 🟢 GREEN (5-7 pts) | ${greens.length} |`);
  lines.push(`| 🟡 YELLOW (3-4 pts) | ${yellows.length} |`);
  lines.push(`| 🔴 RED (0-2 pts) | ${reds.length} |`);
  lines.push(`| Auto-mapped this run | ${autoMapped.length} |`);
  lines.push(`| Still unmapped | ${stillUnmapped.length} |`);

  if (reds.length > 0) {
    lines.push('\n## 🔴 RED Mappings (likely wrong)\n');
    for (const e of reds) {
      lines.push(`### ${e.audio.name}`);
      lines.push(`- **Score:** ${e.score}/7 (${e.reasons.join(', ') || 'no matches'})`);
      lines.push(`- **Audio:** year=${e.audio.year} month=${e.audio.month} day=${e.audio.day}`);
      lines.push(`- **Transcript:** ${e.transcript.name}`);
      lines.push(`- **Transcript dates:** year=${e.transcript.year} month=${e.transcript.month} day=${e.transcript.day}`);
      if (e.transcript.first_line) lines.push(`- **First line:** ${e.transcript.first_line.slice(0, 80)}`);
      lines.push('');
    }
  }

  if (yellows.length > 0) {
    lines.push('\n## 🟡 YELLOW Mappings (needs review)\n');
    for (const e of yellows) {
      lines.push(`### ${e.audio.name}`);
      lines.push(`- **Score:** ${e.score}/7 (${e.reasons.join(', ')})`);
      lines.push(`- **Audio:** year=${e.audio.year} month=${e.audio.month} day=${e.audio.day}`);
      lines.push(`- **Transcript:** ${e.transcript.name}`);
      lines.push(`- **Transcript dates:** year=${e.transcript.year} month=${e.transcript.month} day=${e.transcript.day}`);
      if (e.transcript.first_line) lines.push(`- **First line:** ${e.transcript.first_line.slice(0, 80)}`);
      lines.push('');
    }
  }

  if (autoMapped.length > 0) {
    lines.push('\n## ✅ Auto-mapped This Run\n');
    for (const e of autoMapped) {
      lines.push(`- **${e.audio.name}** → ${e.transcript.name} (score ${e.score}/7: ${e.reasons.join('+')})`);
    }
  }

  if (stillUnmapped.length > 0) {
    lines.push('\n## ❌ Still Unmapped (no match ≥ 4)\n');
    for (const a of stillUnmapped) {
      lines.push(`- ${a.name} (year=${a.year} month=${a.month} day=${a.day})`);
    }
  }

  const report = lines.join('\n');
  const reportPath = path.join(__dirname, 'mapping-audit-report.md');
  fs.writeFileSync(reportPath, report, 'utf8');

  console.log('\n' + report);
  console.log(`\nReport written to ${reportPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
