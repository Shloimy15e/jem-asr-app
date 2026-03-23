import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envRaw = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const env = Object.fromEntries(
  envRaw.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

function extractSichaNumber(name) {
  const m = name.match(/sicha\s*(\d+)/i) || name.match(/\bS(\d+)\b/);
  return m ? parseInt(m[1]) : null;
}

function scoreMatch(audio, transcript) {
  let score = 0;
  const reasons = [];
  if (audio.year && transcript.year && audio.year === transcript.year) {
    score += 3; reasons.push('year');
    if (audio.month && transcript.month && audio.month === transcript.month) {
      score += 2; reasons.push('month');
      if (audio.day && transcript.day && audio.day === transcript.day) {
        score += 1; reasons.push('day');
      }
    }
  }
  const aName = (audio.name || '').toLowerCase();
  const tName = (transcript.name || '').toLowerCase();
  for (const kw of ['sicha', 'maamar', 'farbrengen']) {
    if (aName.includes(kw) && tName.includes(kw)) { score += 1; reasons.push(kw); break; }
  }
  return { score, reasons };
}

async function main() {
  const [
    { data: audio50hr },
    { data: allTranscripts },
    { data: allMappings },
  ] = await Promise.all([
    supabase.from('audio_files').select('id, name, year, month, day').eq('is_selected_50hr', true),
    supabase.from('transcripts').select('id, name, year, month, day, first_line'),
    supabase.from('mappings').select('audio_id, transcript_id'),
  ]);

  const mappedAudioIds = new Set(allMappings.map(m => m.audio_id));
  const mappedTranscriptIds = new Set(allMappings.map(m => m.transcript_id));
  const unmapped = audio50hr.filter(a => !mappedAudioIds.has(a.id));

  console.log(`Unmapped 50hr files: ${unmapped.length}`);

  const lines = ['\n\n## Deep Unmapped Analysis\n'];
  lines.push(`${unmapped.length} files remain unmapped after initial audit.\n`);

  // Group unmapped by date
  const byDate = {};
  for (const a of unmapped) {
    const key = `${a.year}|${a.month}|${a.day}`;
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(a);
  }

  const autoMapped = [];

  for (const [dateKey, audioGroup] of Object.entries(byDate)) {
    const [year, month, day] = dateKey.split('|');
    const label = `${month} ${day} ${year}`;
    lines.push(`### ${label} (${audioGroup.length} audio files)`);

    // Find transcripts for this date
    const exactMatch = allTranscripts.filter(t =>
      t.year === year && t.month === month && t.day === day && !mappedTranscriptIds.has(t.id)
    );
    const monthMatch = allTranscripts.filter(t =>
      t.year === year && t.month === month && t.day !== day && !mappedTranscriptIds.has(t.id)
    );
    const yearMatch = allTranscripts.filter(t =>
      t.year === year && t.month !== month && !mappedTranscriptIds.has(t.id)
    ).slice(0, 3);

    if (exactMatch.length > 0) {
      lines.push(`**Exact date transcripts (${exactMatch.length}):**`);
      exactMatch.forEach(t => lines.push(`  - ${t.name}`));

      if (audioGroup.length > 1 && exactMatch.length === 1) {
        lines.push(`⚠️ **Multi-audio single transcript** — this transcript likely covers multiple sichos. Consider splitting.`);
        // Map all audio to this transcript (they'll need splitting later)
        for (const audio of audioGroup) {
          const { score, reasons } = scoreMatch(audio, exactMatch[0]);
          if (score >= 3) {
            const { error } = await supabase.from('mappings').upsert({
              audio_id: audio.id,
              transcript_id: exactMatch[0].id,
              confidence: score / 7,
              match_reason: 'auto-audit-deep: ' + reasons.join('+') + ' [needs-split]',
              confirmed_by: 'auto-audit-deep',
            }, { onConflict: 'audio_id', ignoreDuplicates: true });
            if (!error) {
              autoMapped.push({ audio, transcript: exactMatch[0], score, note: 'needs-split' });
              mappedTranscriptIds.add(exactMatch[0].id);
            }
          }
        }
      } else if (exactMatch.length >= audioGroup.length) {
        // Try to match by sicha number
        for (const audio of audioGroup) {
          const audioSicha = extractSichaNumber(audio.name);
          let best = null;
          for (const t of exactMatch) {
            if (mappedTranscriptIds.has(t.id)) continue;
            const tSicha = extractSichaNumber(t.name);
            const { score, reasons } = scoreMatch(audio, t);
            const sichaBonus = (audioSicha && tSicha && audioSicha === tSicha) ? 1 : 0;
            const total = score + sichaBonus;
            if (!best || total > best.total) best = { t, total, reasons, sichaBonus };
          }
          if (best && best.total >= 3) {
            const { error } = await supabase.from('mappings').upsert({
              audio_id: audio.id,
              transcript_id: best.t.id,
              confidence: best.total / 7,
              match_reason: 'auto-audit-deep: ' + best.reasons.join('+') + (best.sichaBonus ? '+sicha#' : ''),
              confirmed_by: 'auto-audit-deep',
            }, { onConflict: 'audio_id', ignoreDuplicates: true });
            if (!error) {
              autoMapped.push({ audio, transcript: best.t, score: best.total });
              mappedTranscriptIds.add(best.t.id);
            }
          }
        }
      }
    } else if (monthMatch.length > 0) {
      lines.push(`No exact-date transcripts. Month matches (${monthMatch.length}): ${monthMatch.slice(0,3).map(t=>t.name).join(', ')}`);
    } else if (yearMatch.length > 0) {
      lines.push(`No month match. Year-only candidates: ${yearMatch.map(t=>t.name).join(', ')}`);
    } else {
      lines.push(`❌ No transcripts found for this date in the catalog.`);
    }
    lines.push('');
  }

  lines.push(`\n### Auto-mapped in deep audit: ${autoMapped.length}`);
  for (const e of autoMapped) {
    const note = e.note ? ` ⚠️ ${e.note}` : '';
    lines.push(`- **${e.audio.name}** → ${e.transcript.name} (score ${e.score}/7)${note}`);
  }

  const stillUnmapped = unmapped.filter(a => !autoMapped.find(m => m.audio.id === a.id));
  lines.push(`\n### Still unmapped after deep audit: ${stillUnmapped.length}`);
  for (const a of stillUnmapped) {
    lines.push(`- ${a.name} — no matching transcripts in catalog`);
  }

  const addition = lines.join('\n');
  fs.appendFileSync(path.join(__dirname, 'mapping-audit-report.md'), addition, 'utf8');
  console.log(addition);
  console.log('\nAppended to mapping-audit-report.md');
}

main().catch(err => { console.error(err); process.exit(1); });
