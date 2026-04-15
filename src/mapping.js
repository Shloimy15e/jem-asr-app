import { getState, updateState, saveToStorage } from './state.js';
import { deleteMapping, searchTranscriptText } from './db.js';
import { getCurrentUser } from './auth.js';
import { truncateWords, formatConfidence, debounce } from './utils.js';

const CONTENT_TYPES = ['sicha', 'maamar', 'farbrengen'];

function scoreMatch(audio, transcript) {
  let score = 0;
  const reasons = [];

  const aYear = audio.year || '';
  const tYear = transcript.year || '';
  const aMonth = audio.month || '';
  const tMonth = transcript.month || '';
  const aDay = audio.day;
  const tDay = transcript.day;

  if (aYear && tYear && aYear === tYear) {
    if (aMonth && tMonth && aMonth === tMonth) {
      if (aDay && tDay && aDay === tDay) {
        score = 1.0;
        reasons.push('exact date');
      } else {
        score = 0.5;
        reasons.push('year+month');
      }
    } else {
      score = 0.25;
      reasons.push('year only');
    }
  }

  const aName = (audio.name || '').toLowerCase();
  const tName = (transcript.name || '').toLowerCase();
  for (const kw of CONTENT_TYPES) {
    if (aName.includes(kw) && tName.includes(kw)) {
      score += 0.15;
      reasons.push(kw);
      break;
    }
  }

  // Prefer transcripts that have firstLine text (content we can verify)
  // and slightly boost if the audio's content-type keyword appears in the firstLine.
  if (transcript.firstLine) {
    score += 0.05;
    const firstLineLower = transcript.firstLine.toLowerCase();
    for (const kw of CONTENT_TYPES) {
      if (aName.includes(kw) && firstLineLower.includes(kw)) {
        score += 0.05;
        reasons.push(`text:${kw}`);
        break;
      }
    }
  }

  return { score: Math.min(score, 1.0), matchReason: reasons.join(' + ') };
}

export function getSuggestedMatches(audioItem, allTranscripts, existingMappings) {
  const mappedTranscriptIds = new Set(
    Object.values(existingMappings || {}).map(m => m.transcriptId)
  );

  const scored = [];
  for (const t of allTranscripts) {
    if (mappedTranscriptIds.has(t.id)) continue;
    const { score, matchReason } = scoreMatch(audioItem, t);
    if (score > 0) {
      scored.push({
        transcriptId: t.id,
        score,
        matchReason,
        firstName: t.firstLine || '',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

export function renderSuggestedMatches(container, audioId, state, onLink) {
  container.innerHTML = '';
  const audio = state.audio.find(a => a.id === audioId);
  if (!audio) return;

  const suggestions = getSuggestedMatches(audio, state.transcripts, state.mappings);
  if (suggestions.length === 0) {
    const noSuggestions = document.createElement('span');
    noSuggestions.className = 'text-secondary';
    noSuggestions.textContent = 'No suggestions found';
    container.appendChild(noSuggestions);
    return;
  }

  const list = document.createElement('div');
  list.className = 'suggestions-list';

  for (const s of suggestions) {
    const row = document.createElement('div');
    row.className = 'suggestion-row';
    row.addEventListener('click', () => onLink(audioId, s.transcriptId, s.score, s.matchReason));

    const badge = document.createElement('span');
    badge.className = 'confidence-badge';
    badge.textContent = formatConfidence(s.score);
    if (s.score >= 0.8) badge.classList.add('confidence-high');
    else if (s.score >= 0.4) badge.classList.add('confidence-mid');
    else badge.classList.add('confidence-low');

    const preview = document.createElement('span');
    preview.className = 'suggestion-preview hebrew-text';
    preview.dir = 'rtl';
    preview.textContent = truncateWords(s.firstName, 15);

    const reason = document.createElement('span');
    reason.className = 'suggestion-reason text-secondary';
    reason.textContent = s.matchReason;

    row.appendChild(badge);
    row.appendChild(preview);
    row.appendChild(reason);
    list.appendChild(row);
  }

  container.appendChild(list);
}

export function linkMatch(audioId, transcriptId, score, reason) {
  updateState('mappings', audioId, {
    transcriptId,
    confidence: score,
    matchReason: reason,
    confirmedBy: getCurrentUser(),
    confirmedAt: new Date().toISOString(),
  });
}

export function unlinkMatch(audioId) {
  const state = getState();
  if (!state) return;
  if (state.mappings && state.mappings[audioId]) {
    delete state.mappings[audioId];
    // Remove from Supabase so the deletion persists across sessions
    deleteMapping(audioId).catch(console.warn);
  }
  if (state.transcriptVersions && state.transcriptVersions[audioId]) {
    delete state.transcriptVersions[audioId];
  }
  // Persist deletions to localStorage (direct mutations above bypass updateState)
  saveToStorage();
}

export function renderSearchModal(container, state, onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal search-modal';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const headerTitle = document.createElement('h2');
  headerTitle.textContent = 'Search Transcripts';
  header.appendChild(headerTitle);

  // Shared close handler — removes overlay and cleans up the Escape listener
  const onKey = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  function closeModal() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => closeModal());
  header.appendChild(closeBtn);

  const filters = document.createElement('div');
  filters.className = 'search-filters';

  const years = [...new Set(state.transcripts.map(t => t.year).filter(Boolean))].sort();
  const months = [...new Set(state.transcripts.map(t => t.month).filter(Boolean))];
  const types = [...new Set(state.transcripts.map(t => t.type).filter(Boolean))];

  const yearSelect = createSelect('year', 'All Years', years);
  const monthSelect = createSelect('month', 'All Months', months);
  const typeSelect = createSelect('type', 'All Types', types);

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'search-input';
  textInput.placeholder = 'Search by name or text...';

  filters.appendChild(yearSelect);
  filters.appendChild(monthSelect);
  filters.appendChild(typeSelect);
  filters.appendChild(textInput);

  const results = document.createElement('div');
  results.className = 'search-results';

  function renderResults() {
    results.innerHTML = '';
    const yearVal = yearSelect.value;
    const monthVal = monthSelect.value;
    const typeVal = typeSelect.value;
    const textVal = textInput.value.toLowerCase();

    const filtered = state.transcripts.filter(t => {
      if (yearVal && t.year !== yearVal) return false;
      if (monthVal && t.month !== monthVal) return false;
      if (typeVal && t.type !== typeVal) return false;
      if (textVal) {
        const name = (t.name || '').toLowerCase();
        const first = (t.firstLine || '').toLowerCase();
        if (!name.includes(textVal) && !first.includes(textVal)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      results.innerHTML = '';
      const noResults = document.createElement('div');
      noResults.className = 'text-secondary';
      noResults.style.padding = '1rem';
      noResults.textContent = 'No transcripts found';
      results.appendChild(noResults);
      return;
    }

    for (const t of filtered.slice(0, 100)) {
      const rowWrapper = document.createElement('div');

      const row = document.createElement('div');
      row.className = 'search-result-row';

      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = t.name || t.id;

      const preview = document.createElement('span');
      preview.className = 'result-preview hebrew-text';
      preview.dir = 'rtl';
      preview.textContent = truncateWords(t.firstLine || '', 15);

      const previewBtn = document.createElement('button');
      previewBtn.className = 'search-result-preview-btn';
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const existing = rowWrapper.querySelector('.search-result-expanded');
        if (existing) { existing.remove(); return; }
        const expanded = document.createElement('div');
        expanded.className = 'search-result-expanded';
        expanded.textContent = 'Loading...';
        rowWrapper.appendChild(expanded);
        if (t.text) {
          expanded.textContent = t.text;
        } else if (t.r2TranscriptLink) {
          try {
            const filename = t.r2TranscriptLink.split('/').pop();
            const resp = await fetch('/api/transcript?name=' + encodeURIComponent(filename));
            if (resp.ok) {
              t.text = await resp.text();
              expanded.textContent = t.text;
            } else {
              expanded.textContent = t.firstLine || 'Could not load transcript';
            }
          } catch {
            expanded.textContent = t.firstLine || 'Could not load transcript';
          }
        } else {
          expanded.textContent = t.firstLine || 'No content available';
        }
      });

      const selectBtn = document.createElement('button');
      selectBtn.className = 'action-btn action-btn-primary';
      selectBtn.textContent = 'Select';
      selectBtn.style.flexShrink = '0';
      selectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(t.id);
        closeModal();
      });

      row.appendChild(name);
      row.appendChild(preview);
      row.appendChild(previewBtn);
      row.appendChild(selectBtn);
      rowWrapper.appendChild(row);
      results.appendChild(rowWrapper);
    }
  }

  yearSelect.addEventListener('change', renderResults);
  monthSelect.addEventListener('change', renderResults);
  typeSelect.addEventListener('change', renderResults);
  textInput.addEventListener('input', renderResults);

  modal.appendChild(header);
  modal.appendChild(filters);
  modal.appendChild(results);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', onKey);

  container.appendChild(overlay);
  renderResults();
}

// ── Global transcript text search ───────────────────────────────────
// Searches across all transcript content via Supabase full-text query.

export function renderGlobalTranscriptSearch(container) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal search-modal global-transcript-search';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const headerTitle = document.createElement('h2');
  headerTitle.textContent = 'Search All Transcripts';
  header.appendChild(headerTitle);

  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  function closeModal() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', closeModal);
  header.appendChild(closeBtn);

  const searchRow = document.createElement('div');
  searchRow.className = 'global-search-input-row';

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'search-input';
  textInput.placeholder = 'Search transcript content…';
  textInput.autofocus = true;
  searchRow.appendChild(textInput);

  const results = document.createElement('div');
  results.className = 'search-results';

  const statusLine = document.createElement('div');
  statusLine.className = 'global-search-status';

  let searching = false;

  async function doSearch() {
    const term = textInput.value.trim();
    if (term.length < 2) {
      results.innerHTML = '';
      statusLine.textContent = 'Type at least 2 characters to search';
      return;
    }
    if (searching) return;
    searching = true;
    statusLine.textContent = 'Searching…';
    results.innerHTML = '';

    try {
      const hits = await searchTranscriptText(term);
      searching = false;

      if (hits.length === 0) {
        statusLine.textContent = 'No transcripts found';
        return;
      }
      statusLine.textContent = `Found ${hits.length} transcript${hits.length > 1 ? 's' : ''}`;

      const state = getState();

      for (const t of hits) {
        const rowWrapper = document.createElement('div');
        rowWrapper.className = 'global-search-result';

        const row = document.createElement('div');
        row.className = 'search-result-row';

        const nameEl = document.createElement('span');
        nameEl.className = 'result-name';
        nameEl.textContent = t.name || t.id;
        nameEl.title = t.name || t.id;

        // Build snippet around the match
        const snippet = document.createElement('span');
        snippet.className = 'result-preview hebrew-text';
        snippet.dir = 'rtl';
        const fullText = t.text || t.first_line || '';
        snippet.innerHTML = getHighlightedSnippet(fullText, term);

        // Find mapped audio for this transcript
        const mappedAudioId = Object.entries(state.mappings || {})
          .find(([, m]) => m.transcriptId === t.id)?.[0];

        const actions = document.createElement('div');
        actions.className = 'global-search-actions';

        if (mappedAudioId) {
          const openBtn = document.createElement('button');
          openBtn.className = 'action-btn action-btn-primary';
          openBtn.textContent = 'Open';
          openBtn.title = 'Open in new tab';
          openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.open(`/detail.html?id=${encodeURIComponent(mappedAudioId)}`, '_blank');
          });
          actions.appendChild(openBtn);
        } else {
          const badge = document.createElement('span');
          badge.className = 'text-secondary';
          badge.textContent = 'Not mapped';
          badge.style.fontSize = '0.8rem';
          actions.appendChild(badge);
        }

        row.appendChild(nameEl);
        row.appendChild(snippet);
        row.appendChild(actions);
        rowWrapper.appendChild(row);
        results.appendChild(rowWrapper);
      }
    } catch (err) {
      searching = false;
      statusLine.textContent = 'Search error: ' + err.message;
    }
  }

  const debouncedSearch = debounce(doSearch, 400);
  textInput.addEventListener('input', debouncedSearch);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  });

  modal.appendChild(header);
  modal.appendChild(searchRow);
  modal.appendChild(statusLine);
  modal.appendChild(results);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', onKey);

  container.appendChild(overlay);
  setTimeout(() => textInput.focus(), 50);
}

function getHighlightedSnippet(text, term, contextChars = 60) {
  if (!text) return '';
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const idx = lowerText.indexOf(lowerTerm);
  if (idx === -1) {
    // No match in text body — just show start
    const preview = text.substring(0, 120);
    return escapeHtml(preview) + (text.length > 120 ? '…' : '');
  }
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + term.length + contextChars);
  let before = escapeHtml(text.substring(start, idx));
  let match = escapeHtml(text.substring(idx, idx + term.length));
  let after = escapeHtml(text.substring(idx + term.length, end));
  let result = '';
  if (start > 0) result += '…';
  result += `${before}<mark>${match}</mark>${after}`;
  if (end < text.length) result += '…';
  return result;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createSelect(name, placeholder, options) {
  const select = document.createElement('select');
  select.className = 'filter-select';
  select.name = name;

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = placeholder;
  select.appendChild(defaultOpt);

  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    select.appendChild(o);
  }

  return select;
}
