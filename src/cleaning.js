import { updateState, getVersions, addVersion, updateVersion } from './state.js';
import { loadTranscriptText } from './db.js';

// Individual cleaning passes

export function cleanBrackets(text) {
  return text.replace(/\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]/g, '');
}

export function cleanParentheses(text) {
  // Strip the parentheses characters but keep the words inside
  return text.replace(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, '$1');
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

// Remove question mark characters
export function cleanQuestionMarks(text) {
  return text.replace(/\?/g, '');
}

// Remove sequences of 2 or more consecutive dots (ellipsis)
export function cleanEllipsis(text) {
  return text.replace(/\.{2,}/g, '');
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

export function cleanWhitespace(text) {
  let t = text;
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/^ +| +$/gm, '');
  t = t.trim();
  return t;
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

export async function batchClean(audioIds, state, onProgress) {
  const total = audioIds.length;
  const startTime = Date.now();

  for (let i = 0; i < total; i++) {
    const audioId = audioIds[i];
    const mapping = state.mappings[audioId];
    if (!mapping) { if (onProgress) onProgress(i + 1, total); continue; }

    const transcript = state.transcripts.find(t => t.id === mapping.transcriptId);
    if (!transcript) { if (onProgress) onProgress(i + 1, total); continue; }

    const rawText = await fetchTranscriptText(transcript);
    if (!rawText) { if (onProgress) onProgress(i + 1, total); continue; }

    const cleanedText = cleanText(rawText);
    const cleanRate = calculateCleanRate(rawText, cleanedText);

    // Preserve the original raw text — only set originalText if not already stored
    const existing = state.cleaning && state.cleaning[audioId];
    const originalText = existing?.originalText || rawText;
    updateState('cleaning', audioId, {
      originalText,
      cleanedText,
      cleanRate,
      cleanedAt: new Date().toISOString(),
    });
    // Create or update a cleaned version so version tabs stay in sync
    const versions = getVersions(audioId);
    const existingCleaned = versions.find(v => v.type === 'cleaned');
    if (existingCleaned) {
      updateVersion(audioId, existingCleaned.id, {
        text: cleanedText,
        originalText,
        cleanRate,
      });
    } else {
      addVersion(audioId, {
        type: 'cleaned',
        text: cleanedText,
        originalText,
        cleanRate,
        createdBy: 'system',
      });
    }

    if (onProgress) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      onProgress(i + 1, total, elapsed);
    }
  }
}
