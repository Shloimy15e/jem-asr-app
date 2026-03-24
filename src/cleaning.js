import { updateState } from './state.js';

// Individual cleaning passes
export function cleanBrackets(text) {
  return text.replace(/\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]/g, '');
}

export function cleanParentheses(text) {
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

export function cleanSurroundingQuotes(text) {
  // Remove surrounding quotation marks (Hebrew/English: "", «», ״״, "", '')
  let t = text;
  t = t.replace(/^[""\u201C\u201D\u00AB\u00BB\u05F4\u2018\u2019']+/gm, '');
  t = t.replace(/[""\u201C\u201D\u00AB\u00BB\u05F4\u2018\u2019']+$/gm, '');
  return t;
}

export function cleanHyphens(text) {
  // Normalize em-dashes, en-dashes, multiple hyphens to a single space
  let t = text;
  t = t.replace(/[\u2014\u2013]/g, ' ');   // em-dash, en-dash → space
  t = t.replace(/-{2,}/g, ' ');            // multiple hyphens → space
  t = t.replace(/\s*-\s*-\s*/g, ' ');      // spaced double hyphens
  return t;
}

export function cleanQuestionMarks(text) {
  // Collapse multiple question marks and remove isolated/misplaced ones
  let t = text;
  t = t.replace(/\?{2,}/g, '?');           // ??? → ?
  t = t.replace(/^\s*\?\s*$/gm, '');       // lines that are just a ?
  return t;
}

export function cleanEllipsis(text) {
  // Remove ellipsis patterns (multiple dots, Unicode ellipsis character)
  let t = text;
  t = t.replace(/\u2026/g, '');            // Unicode ellipsis …
  t = t.replace(/\.{2,}/g, '');            // two or more dots
  return t;
}

export function cleanSymbols(text) {
  // Remove punctuation/symbols that aren't part of Hebrew words
  let t = text;
  t = t.replace(/[\u200B-\u200F\uFEFF]/g, '');
  t = t.replace(/[\u2018\u2019]/g, "'");
  t = t.replace(/[\u201C\u201D]/g, '"');
  t = t.replace(/[!?;:\-–—…"״]+/g, '');
  t = t.replace(/\.{2,}/g, '');
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
  if (!transcript.r2TranscriptLink) return transcript.firstLine || '';
  try {
    const resp = await fetch(transcript.r2TranscriptLink);
    if (!resp.ok) return transcript.firstLine || '';
    const text = await resp.text();
    if (text && text.trim()) {
      transcript.text = text;
      return text;
    }
  } catch {
    // CORS or network error — fall back to firstLine
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

    updateState('cleaning', audioId, {
      originalText: rawText,
      cleanedText,
      cleanRate,
      cleanedAt: new Date().toISOString(),
    });

    if (onProgress) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      onProgress(i + 1, total, elapsed);
    }
  }
}
