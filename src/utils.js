export function parseHebrewDate(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const yearMatch = base.match(/\b(5[67]\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : null;

  const months = [
    'Tishrei', 'Cheshvan', 'Kislev', 'Teves', 'Teives', 'Shvat', 'Shevat', 'Adar',
    'Adar I', 'Adar II', 'Nissan', 'Iyar', 'Sivan', 'Tammuz', 'Tamuz',
    'Av', 'Elul',
  ];
  let month = null;
  const lowerBase = base.toLowerCase().replace(/[-_]/g, ' ');
  for (const m of months) {
    if (lowerBase.includes(m.toLowerCase())) {
      month = m;
      break;
    }
  }

  const dayMatch = base.match(/(?:^|[-_ ])(\d{1,2})(?:$|[-_ .])/);
  const day = dayMatch ? parseInt(dayMatch[1], 10) : null;

  return { year, month, day };
}

export function normalizeYiddish(text) {
  if (!text) return '';
  let result = text;
  // Strip nikkud and cantillation marks (U+0591-U+05C7)
  result = result.replace(/[\u0591-\u05C7]/g, '');
  // Strip punctuation (keep Hebrew letters U+05D0-U+05EA, spaces, and basic alphanumerics)
  result = result.replace(/[^\u05D0-\u05F4\w\s]/g, '');
  // Lowercase any Latin characters
  result = result.toLowerCase();
  // Collapse whitespace
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

export function levenshtein(refWords, hypWords) {
  const n = refWords.length;
  const m = hypWords.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j - 1], // substitution
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
        );
      }
    }
  }

  // Backtrace to get operations
  const operations = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && refWords[i - 1] === hypWords[j - 1]) {
      operations.unshift({ type: 'C', ref: refWords[i - 1], hyp: hypWords[j - 1] });
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      operations.unshift({ type: 'S', ref: refWords[i - 1], hyp: hypWords[j - 1] });
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      operations.unshift({ type: 'D', ref: refWords[i - 1], hyp: null });
      i--;
    } else {
      operations.unshift({ type: 'I', ref: null, hyp: hypWords[j - 1] });
      j--;
    }
  }

  return { distance: dp[n][m], operations };
}

export function calculateWER(reference, hypothesis) {
  const refNorm = normalizeYiddish(reference);
  const hypNorm = normalizeYiddish(hypothesis);
  const refWords = refNorm.split(/\s+/).filter(Boolean);
  const hypWords = hypNorm.split(/\s+/).filter(Boolean);

  if (refWords.length === 0) {
    return { wer: hypWords.length > 0 ? 1 : 0, cer: 0, substitutions: 0, insertions: hypWords.length, deletions: 0, total: 0 };
  }

  const { distance, operations } = levenshtein(refWords, hypWords);
  const substitutions = operations.filter(o => o.type === 'S').length;
  const insertions = operations.filter(o => o.type === 'I').length;
  const deletions = operations.filter(o => o.type === 'D').length;
  const wer = distance / refWords.length;

  // CER: character-level
  const refChars = refNorm.replace(/\s/g, '').split('');
  const hypChars = hypNorm.replace(/\s/g, '').split('');
  const charResult = levenshtein(refChars, hypChars);
  const cer = refChars.length > 0 ? charResult.distance / refChars.length : 0;

  return { wer, cer, substitutions, insertions, deletions, total: refWords.length };
}

export function generateSRT(words) {
  if (!words || words.length === 0) return '';
  const segments = groupWordSegments(words);
  const lines = [];
  segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatSRTTime(seg.start)} --> ${formatSRTTime(seg.end)}`);
    lines.push(seg.text);
    lines.push('');
  });
  return lines.join('\n');
}

export function generateVTT(words) {
  if (!words || words.length === 0) return '';
  const segments = groupWordSegments(words);
  const lines = ['WEBVTT', ''];
  segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatVTTTime(seg.start)} --> ${formatVTTTime(seg.end)}`);
    lines.push(seg.text);
    lines.push('');
  });
  return lines.join('\n');
}

function groupWordSegments(words) {
  const segments = [];
  let current = null;

  for (const w of words) {
    if (!current) {
      current = { start: w.start, end: w.end, words: [w.word] };
    } else if (w.start - current.end > 0.5 || current.words.length >= 10) {
      current.text = current.words.join(' ');
      segments.push(current);
      current = { start: w.start, end: w.end, words: [w.word] };
    } else {
      current.end = w.end;
      current.words.push(w.word);
    }
  }
  if (current) {
    current.text = current.words.join(' ');
    segments.push(current);
  }
  return segments;
}

function formatSubtitleTime(seconds, separator) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.min(Math.round((seconds % 1) * 1000), 999);
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${String(ms).padStart(3, '0')}`;
}

function formatSRTTime(seconds) {
  return formatSubtitleTime(seconds, ',');
}

function formatVTTTime(seconds) {
  return formatSubtitleTime(seconds, '.');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function exportCSV(rows, columns) {
  const header = columns.map(c => `"${c.label}"`).join(',');
  const body = rows.map(row =>
    columns.map(c => {
      const val = typeof c.value === 'function' ? c.value(row) : row[c.key];
      const str = val == null ? '' : String(val).replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
      return `"${str}"`;
    }).join(',')
  );
  const csv = [header, ...body].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jem-asr-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function truncateWords(text, n) {
  if (!text) return '';
  const words = text.split(/\s+/);
  if (words.length <= n) return text;
  return words.slice(0, n).join(' ') + '...';
}

export function formatConfidence(score) {
  if (score == null) return '\u2014';
  return Math.round(score * 100) + '%';
}

export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function getConfidenceLevel(conf) {
  return conf >= 0.8 ? 'high' : conf >= 0.4 ? 'mid' : 'low';
}

export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
