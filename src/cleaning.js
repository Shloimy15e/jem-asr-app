import { getVersions, addVersion, updateVersion, updateState, getNextIteration } from './state.js';
import { loadTranscriptText } from './db.js';

// Individual cleaning passes

export function cleanBrackets(text) {
  return text.replace(/\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]/g, '');
}

export function cleanParentheses(text) {
  // Remove parenthetical editorial notes entirely (including content)
  return text.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
}

export function cleanSectionMarkers(text) {
  let t = text;
  t = t.replace(/\u05E1\u05E2\u05D9\u05E3[\s\u05D0-\u05EA\u0590-\u05FF'"\u2018\u2019\u201C\u201D]{0,10}/g, '');
  t = t.replace(/\*\s*\*\s*\*/g, '');
  t = t.replace(/^\s*\*+\s*$/gm, '');
  t = t.replace(/^\s*\d+[.)]\s*/gm, '');
  return t;
}

// Remove surrounding quotation marks from words, preserving Hebrew abbreviation
// marks that appear between two Hebrew letters (e.g., בס"ד, כ"ח, ה'תשנ"ב).
export function cleanSurroundingQuotes(text) {
  let t = text;
  // Normalize smart double quotes to ASCII "
  t = t.replace(/[\u201C\u201D]/g, '"');
  // Protect abbreviation marks: " between two Hebrew letters (like בס"ד)
  t = t.replace(/([\u05D0-\u05EA])"([\u05D0-\u05EA])/g, '$1\x00$2');
  // Protect ״ (U+05F4 gershayim) between two Hebrew letters
  t = t.replace(/([\u05D0-\u05EA])\u05F4([\u05D0-\u05EA])/g, '$1\x01$2');
  // Remove all remaining " and ״
  t = t.replace(/["״]/g, '');
  // Restore protected abbreviation marks
  t = t.replace(/\x00/g, '"');
  t = t.replace(/\x01/g, '\u05F4');
  return t;
}

// Remove dash/hyphen characters used as separators.
// Keeps hyphens inside compound words (e.g., ראשי-תיבות).
export function cleanHyphens(text) {
  let t = text;
  // Remove en dash, em dash, horizontal bar (always separators)
  t = t.replace(/[–—\u2012\u2014\u2015]/g, '');
  // Remove hyphen at beginning of line (list marker: "- item")
  t = t.replace(/^(\s*)-+\s*/gm, '$1');
  // Remove hyphen surrounded by spaces (word separator: "a - b")
  t = t.replace(/\s+-\s+/g, ' ');
  // Remove hyphen at end of line preceded by space
  t = t.replace(/\s+-\s*$/gm, '');
  return t;
}

// Collapse multiple consecutive question marks into a single one
export function cleanQuestionMarks(text) {
  return text.replace(/\?{2,}/g, '?');
}

// Remove ellipsis patterns (2+ dots or Unicode … character)
export function cleanEllipsis(text) {
  return text.replace(/\.{2,}|\u2026/g, '');
}

export function cleanSymbols(text) {
  let t = text;
  t = t.replace(/[\u200B-\u200F\uFEFF]/g, ''); // zero-width chars
  t = t.replace(/[\u2018\u2019]/g, "'");        // smart single quotes → '
  t = cleanSurroundingQuotes(t);
  t = cleanHyphens(t);
  t = cleanQuestionMarks(t);
  t = cleanEllipsis(t);
  return t;
}

// Replace dash/hyphen characters with a space, preserving word separation.
// Unlike cleanHyphens (which can remove surrounding spaces), this never
// joins words — "word-word" becomes "word word", not "wordword".
export function cleanDashesToSpace(text) {
  return text.replace(/[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, ' ');
}

export function cleanWhitespace(text) {
  let t = text;
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/^ +| +$/gm, '');
  t = t.trim();
  return t;
}

// ── Intro text removal ────────────────────────────────────────────

export function cleanIntroText(text) {
  // Remove everything up to and including "הנחה פרטית בלתי מוגה" if found near the start
  const pattern = /^([\s\S]{0,800}?הנחה\s+פרטית\s+בלתי\s+מוגה[^\n]*\n?)/;
  const m = text.match(pattern);
  if (m) return text.slice(m[1].length).replace(/^\s*\n/, '');
  return text;
}

// ── Safe clean (no brackets/parentheses — for bulk use) ──────────

export function cleanSafe(text) {
  let t = text;
  t = cleanSectionMarkers(t);
  t = cleanSymbols(t);
  t = cleanIntroText(t);
  t = cleanWhitespace(t);
  return t;
}

// ── Match extraction for interactive bracket/paren cleaning ─────────

export function findBracketMatches(text) {
  const re = /\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]/g;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ match: m[0], content: m[0].slice(1, -1), index: m.index });
  }
  return matches;
}

export function findParenMatches(text) {
  const re = /\([^()]*(?:\([^()]*\)[^()]*)*\)/g;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ match: m[0], content: m[0].slice(1, -1), index: m.index });
  }
  return matches;
}

// Apply per-match actions to text. Processes in reverse order so indices stay valid.
// actions[i] = 'delete' | 'unwrap' | 'keep'
export function applyMatchActions(text, matches, actions) {
  // Work backwards so earlier indices aren't invalidated
  const sorted = matches.map((m, i) => ({ ...m, action: actions[i] }))
    .sort((a, b) => b.index - a.index);
  let result = text;
  for (const m of sorted) {
    if (m.action === 'delete') {
      result = result.slice(0, m.index) + result.slice(m.index + m.match.length);
    } else if (m.action === 'unwrap') {
      result = result.slice(0, m.index) + m.content + result.slice(m.index + m.match.length);
    }
    // 'keep' → no change
  }
  return result;
}

// Combined minor cleaning passes (quotes, dashes, symbols, whitespace)
export function cleanMinor(text) {
  let t = text;
  t = cleanSurroundingQuotes(t);
  t = cleanDashesToSpace(t);
  t = cleanHyphens(t);
  t = cleanQuestionMarks(t);
  t = cleanEllipsis(t);
  t = cleanWhitespace(t);
  return t;
}

// Extract individual symbol/punctuation matches for the match-based preview modal.
// Returns matches compatible with openMatchPreviewModal / applyMatchActions:
//   { match: string, content: string (replacement), index: number }
// Whitespace cleanup is excluded — applied automatically as post-processing.
export function findMinorMatches(text) {
  const matches = [];
  let m;

  // Smart double quotes — remove unless between two Hebrew letters
  const smartDblRe = /[\u201C\u201D]/g;
  while ((m = smartDblRe.exec(text)) !== null) {
    const prev = m.index > 0 ? text[m.index - 1] : '';
    const next = m.index < text.length - 1 ? text[m.index + 1] : '';
    if (/[\u05D0-\u05EA]/.test(prev) && /[\u05D0-\u05EA]/.test(next)) continue;
    matches.push({ match: m[0], content: '', index: m.index });
  }

  // Regular " not between two Hebrew letters (abbreviation marks like בס"ד)
  const dblQuoteRe = /"/g;
  while ((m = dblQuoteRe.exec(text)) !== null) {
    const prev = m.index > 0 ? text[m.index - 1] : '';
    const next = m.index < text.length - 1 ? text[m.index + 1] : '';
    if (/[\u05D0-\u05EA]/.test(prev) && /[\u05D0-\u05EA]/.test(next)) continue;
    matches.push({ match: '"', content: '', index: m.index });
  }

  // ״ (gershayim) not between two Hebrew letters
  const gershRe = /\u05F4/g;
  while ((m = gershRe.exec(text)) !== null) {
    const prev = m.index > 0 ? text[m.index - 1] : '';
    const next = m.index < text.length - 1 ? text[m.index + 1] : '';
    if (/[\u05D0-\u05EA]/.test(prev) && /[\u05D0-\u05EA]/.test(next)) continue;
    matches.push({ match: '\u05F4', content: '', index: m.index });
  }

  // Dashes / hyphens → space
  const dashRe = /[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
  while ((m = dashRe.exec(text)) !== null) {
    matches.push({ match: m[0], content: ' ', index: m.index });
  }

  // Multiple question marks → single
  const multiQRe = /\?{2,}/g;
  while ((m = multiQRe.exec(text)) !== null) {
    matches.push({ match: m[0], content: '?', index: m.index });
  }

  // Ellipsis (2+ dots or Unicode …)
  const ellipsisRe = /\.{2,}|\u2026/g;
  while ((m = ellipsisRe.exec(text)) !== null) {
    matches.push({ match: m[0], content: '', index: m.index });
  }

  // Sort by position, remove overlaps
  matches.sort((a, b) => a.index - b.index);
  const filtered = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.index >= lastEnd) {
      filtered.push(match);
      lastEnd = match.index + match.match.length;
    }
  }

  return filtered;
}

export function cleanText(rawText) {
  if (!rawText) return '';
  let text = rawText;
  text = cleanBrackets(text);
  text = cleanParentheses(text);
  text = cleanSectionMarkers(text);
  text = cleanSymbols(text);
  text = cleanWhitespace(text);
  return text;
}

export function calculateCleanRate(rawText, cleanedText) {
  if (!rawText) return 100;
  const rawWords = rawText.split(/\s+/).filter(Boolean);
  const cleanedWords = cleanedText.split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return 100;
  return Math.round((cleanedWords.length / rawWords.length) * 100);
}

// TODO: This duplicates transcript-fetching logic found in detail.js and db.js.
// Should eventually be replaced with a shared helper (e.g., loadTranscriptText in db.js).
async function fetchTranscriptText(transcript) {
  if (transcript.text) return transcript.text;
  let text = null;
  if (transcript.r2TranscriptLink) {
    try {
      const filename = transcript.r2TranscriptLink.split('/').pop();
      const resp = await fetch('/api/transcript?name=' + encodeURIComponent(filename));
      if (resp.ok) text = await resp.text();
    } catch { /* network error */ }
  }
  if (!text && transcript.id) {
    text = await loadTranscriptText(transcript.id);
  }
  if (text?.trim()) {
    transcript.text = text; // cache for session
    return text;
  }
  return transcript.firstLine || '';
}

export async function batchClean(audioIds, state, onProgress, cleanFn = cleanText) {
  const total = audioIds.length;
  const startTime = Date.now();
  const failed = [];
  let succeeded = 0;

  for (let i = 0; i < total; i++) {
    const audioId = audioIds[i];
    const mapping = state.mappings[audioId];
    if (!mapping) {
      failed.push({ id: audioId, reason: 'No transcript mapping' });
      if (onProgress) onProgress(i + 1, total);
      continue;
    }

    const transcript = state.transcripts.find(t => t.id === mapping.transcriptId);
    if (!transcript) {
      failed.push({ id: audioId, reason: 'Transcript not found' });
      if (onProgress) onProgress(i + 1, total);
      continue;
    }

    const rawText = await fetchTranscriptText(transcript);
    if (!rawText) {
      failed.push({ id: audioId, reason: 'Could not fetch transcript text' });
      if (onProgress) onProgress(i + 1, total);
      continue;
    }

    const cleanedText = cleanFn(rawText);
    const cleanRate = calculateCleanRate(rawText, cleanedText);

    // Preserve the original raw text — only set originalText if not already stored
    const existing = state.cleaning && state.cleaning[audioId];
    const originalText = existing?.originalText || rawText;
    // Update the edited (working) version — cleaning and editing share one version.
    // getStatus() treats 'edited' as 'cleaned' for pipeline tracking.
    const versions = getVersions(audioId);
    const existingEdited = versions.find(v => v.type === 'edited');
    const hasAlignment = versions.some(v => v.alignment?.avgConfidence != null);
    const iteration = hasAlignment ? getNextIteration(audioId) : (existingEdited?.iteration || 1);
    if (existingEdited) {
      updateVersion(audioId, existingEdited.id, { text: cleanedText, originalText, cleanRate, iteration });
    } else {
      addVersion(audioId, { type: 'edited', text: cleanedText, originalText, cleanRate, iteration, createdBy: 'system' });
    }

    // Also sync a 'cleaned' row so the Supabase audio_pipeline_status view is accurate
    updateState('cleaning', audioId, { cleanedText, originalText, cleanRate, cleanedAt: new Date().toISOString() });

    succeeded++;
    if (onProgress) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      onProgress(i + 1, total, elapsed);
    }
  }
  return { succeeded, failed };
}
