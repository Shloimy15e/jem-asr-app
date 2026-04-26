// Pure helper: group a flat array of word-timestamps into segments compatible
// with stable_whisper's WhisperResult JSON schema. No I/O, no Supabase.
//
// JEM's alignment stores words as a flat array: [{word, start, end, confidence}, ...].
// ivrit-ai's Stage 2 (create_dataset.py) expects segment-grouped data matching
// stable_whisper's WhisperResult schema:
// [{id, seek, start, end, text, words: [{word, start, end, probability}]}, ...].
// Each word.word carries a LEADING SPACE (Whisper tokenizer convention) so
// stable_whisper can rebuild segment text by simple concatenation. No
// segment-level probability field — Segment.__init__ rejects unknown kwargs.
//
// Segmentation rule: start a new segment whenever the gap between consecutive
// words exceeds `gapThreshold` seconds, OR the current segment would exceed
// `maxSegmentDuration` seconds.
//
// ivrit-ai's Stage 2 will further merge adjacent segments with gap < 0.3s via
// `merge_slice_segments` during 30-second slice packing, so our boundaries
// only need to be "reasonable", not optimal.

export function segmentWords(words, opts = {}) {
  const gapThreshold = opts.gapThreshold ?? 0.5;
  const maxSegmentDuration = opts.maxSegmentDuration ?? 15;

  if (!Array.isArray(words) || words.length === 0) return [];

  const segments = [];
  let current = null;

  for (const w of words) {
    if (!w || typeof w.start !== 'number' || typeof w.end !== 'number') continue;
    const word = String(w.word ?? '').trim();
    if (!word) continue;

    const probability = typeof w.confidence === 'number' ? w.confidence : 0.5;

    if (!current) {
      current = { start: w.start, end: w.end, words: [{ word, start: w.start, end: w.end, probability }] };
      continue;
    }

    const gap = w.start - current.end;
    const wouldExceed = (w.end - current.start) > maxSegmentDuration;

    if (gap > gapThreshold || wouldExceed) {
      segments.push(current);
      current = { start: w.start, end: w.end, words: [{ word, start: w.start, end: w.end, probability }] };
    } else {
      current.end = w.end;
      current.words.push({ word, start: w.start, end: w.end, probability });
    }
  }
  if (current) segments.push(current);

  return segments.map((s, i) => {
    return {
      id: i,
      seek: 0,
      start: round3(s.start),
      end: round3(s.end),
      text: s.words.map(w => w.word).join(' '),
      words: s.words.map(w => ({
        word: ' ' + w.word,
        start: round3(w.start),
        end: round3(w.end),
        probability: round3(w.probability),
      })),
    };
  });
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
