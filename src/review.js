import { getState, updateState } from './state.js';
import { getConfidenceLevel } from './utils.js';

/**
 * Compute LCS (Longest Common Subsequence) table for two word arrays.
 * Returns a 2D DP table used for backtracing the diff.
 */
function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/**
 * Backtrace the LCS table to produce a diff: each original word is tagged
 * as either 'kept' (present in cleaned) or 'removed'.
 */
function diffWords(original, cleaned) {
  const dp = lcsTable(original, cleaned);
  const result = [];
  let i = original.length;
  let j = cleaned.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === cleaned[j - 1]) {
      result.unshift({ word: original[i - 1], type: 'kept' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Word in cleaned but not in original (insertion) — show as kept
      result.unshift({ word: cleaned[j - 1], type: 'kept' });
      j--;
    } else {
      result.unshift({ word: original[i - 1], type: 'removed' });
      i--;
    }
  }
  return result;
}

/**
 * Find the best matching alignment word for a given cleaned word and index.
 * First tries exact index match, then searches by word text, falls back to
 * confidence 1.
 */
function findWordConfidence(alignmentWords, word, index) {
  // Try index-based match first
  if (alignmentWords[index] && alignmentWords[index].word === word) {
    return alignmentWords[index].confidence;
  }
  // Try to find by word text — pick the closest unused match
  // Simple approach: scan for any entry with matching word text
  for (let k = 0; k < alignmentWords.length; k++) {
    if (alignmentWords[k].word === word) {
      return alignmentWords[k].confidence;
    }
  }
  // No match found — default to 1 (high confidence)
  return 1;
}

export function renderReviewPanel(container, audioId, state, callbacks) {
  const entry = state.audio.find(a => a.id === audioId);
  const cleaning = state.cleaning[audioId];
  const alignment = state.alignments[audioId];
  if (!entry) return;

  // Bug fix #2: Instead of clearing the entire container (which destroys
  // audio players and other content), use a dedicated sub-div for review.
  const reviewDivId = 'review-panel-' + audioId;
  let reviewContainer = container.querySelector('#' + CSS.escape(reviewDivId));
  if (reviewContainer) {
    reviewContainer.innerHTML = '';
  } else {
    reviewContainer = document.createElement('div');
    reviewContainer.id = reviewDivId;
    container.appendChild(reviewContainer);
  }

  const panel = document.createElement('div');
  panel.className = 'review-panel';

  // Summary bar — safe DOM construction (Bug fix #4: no innerHTML with data)
  const summary = document.createElement('div');
  summary.className = 'review-summary';
  const cleanRate = cleaning ? cleaning.cleanRate : '--';
  const avgConf = alignment ? Math.round(alignment.avgConfidence * 100) : '--';
  const lowCount = alignment ? alignment.lowConfidenceCount : '--';

  const summaryItems = [
    { label: '', value: entry.name, bold: true },
    { label: 'Clean rate: ', value: cleanRate + '%', bold: true },
    { label: 'Avg confidence: ', value: avgConf + '%', bold: true },
    { label: 'Low confidence words: ', value: String(lowCount), bold: true },
  ];
  for (const item of summaryItems) {
    const span = document.createElement('span');
    span.className = 'review-summary-item';
    if (item.label) {
      span.appendChild(document.createTextNode(item.label));
    }
    const strong = document.createElement('strong');
    strong.textContent = item.value;
    span.appendChild(strong);
    summary.appendChild(span);
  }
  panel.appendChild(summary);

  // Diff view
  const diffSection = document.createElement('div');
  diffSection.className = 'review-diff';

  const originalText = cleaning ? cleaning.originalText : '';
  const cleanedText = cleaning ? cleaning.cleanedText : '';
  const originalWords = originalText.split(/\s+/).filter(Boolean);
  const cleanedWords = cleanedText.split(/\s+/).filter(Boolean);

  // Bug fix #1: Use LCS-based diff instead of Set membership
  const diff = diffWords(originalWords, cleanedWords);

  // Original text with removed words highlighted
  const origDiv = document.createElement('div');
  origDiv.className = 'review-diff-col';
  origDiv.dir = 'rtl';
  const origLabel = document.createElement('div');
  origLabel.className = 'review-diff-label';
  origLabel.textContent = 'Original';
  origDiv.appendChild(origLabel);

  const origContent = document.createElement('div');
  origContent.className = 'review-diff-content';
  diff.forEach(entry => {
    const span = document.createElement('span');
    if (entry.type === 'removed') {
      span.className = 'diff-removed';
    }
    span.textContent = entry.word + ' ';
    origContent.appendChild(span);
  });
  origDiv.appendChild(origContent);

  // Cleaned text with confidence-colored word chips
  const cleanDiv = document.createElement('div');
  cleanDiv.className = 'review-diff-col';
  cleanDiv.dir = 'rtl';
  const cleanLabel = document.createElement('div');
  cleanLabel.className = 'review-diff-label';
  cleanLabel.textContent = 'Cleaned';
  cleanDiv.appendChild(cleanLabel);

  const cleanContent = document.createElement('div');
  cleanContent.className = 'review-diff-content';
  const alignmentWords = alignment ? alignment.words : [];

  cleanedWords.forEach((word, i) => {
    const span = document.createElement('span');
    // Bug fix #3: Use word-text matching fallback instead of blind index
    const conf = findWordConfidence(alignmentWords, word, i);
    const level = getConfidenceLevel(conf);
    span.className = `word-chip confidence-${level}`;
    span.textContent = word;
    span.dataset.index = i;

    // Inline editing
    span.addEventListener('click', () => {
      span.contentEditable = 'true';
      span.focus();
    });
    span.addEventListener('blur', () => {
      span.contentEditable = 'false';
      const newWord = span.textContent.trim();
      if (newWord !== word && cleaning) {
        const words = cleaning.cleanedText.split(/\s+/).filter(Boolean);
        if (i < words.length) {
          words[i] = newWord;
          cleaning.cleanedText = words.join(' ');
          updateState('cleaning', audioId, cleaning);
        }
      }
    });
    span.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        span.blur();
      }
    });

    cleanContent.appendChild(span);
    cleanContent.appendChild(document.createTextNode(' '));
  });
  cleanDiv.appendChild(cleanContent);

  diffSection.appendChild(origDiv);
  diffSection.appendChild(cleanDiv);
  panel.appendChild(diffSection);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'review-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn btn-approve';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => {
    updateState('reviews', audioId, {
      status: 'approved',
      reviewedAt: new Date().toISOString(),
    });
    if (callbacks?.onApprove) callbacks.onApprove(audioId);
  });

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn btn-reject';
  rejectBtn.textContent = 'Reject';
  rejectBtn.addEventListener('click', () => {
    updateState('reviews', audioId, {
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
    });
    if (callbacks?.onReject) callbacks.onReject(audioId);
  });

  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn btn-skip';
  skipBtn.textContent = 'Skip';
  skipBtn.addEventListener('click', () => {
    if (callbacks?.onSkip) callbacks.onSkip(audioId);
  });

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  actions.appendChild(skipBtn);
  panel.appendChild(actions);

  reviewContainer.appendChild(panel);
}

export function approveAll(audioIds, state) {
  const now = new Date().toISOString();
  const currentState = state || getState();
  for (const audioId of audioIds) {
    // Never approve benchmark files — they are gold-standard reference only
    const audioEntry = currentState.audio.find(a => a.id === audioId);
    if (audioEntry?.isBenchmark) continue;

    updateState('reviews', audioId, {
      status: 'approved',
      reviewedAt: now,
    });
  }
}

