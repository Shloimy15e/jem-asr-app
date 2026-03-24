import { getState, getFilteredRows, getFilterCounts, getStatus, updateState } from './state.js';
import { truncateWords, formatConfidence, debounce } from './utils.js';
import { linkMatch, getSuggestedMatches } from './mapping.js';

// ── Inline audio player ─────────────────────────────────────────────
let _activeInlinePlayer = null;

function stopInlinePlayer() {
  if (_activeInlinePlayer) {
    _activeInlinePlayer.audio.pause();
    _activeInlinePlayer.audio.src = '';
    _activeInlinePlayer.btn.textContent = '\u25B6';
    _activeInlinePlayer.btn.classList.remove('playing');
    _activeInlinePlayer = null;
  }
}

function toggleInlinePlay(btn, audioUrl, audioId) {
  if (_activeInlinePlayer && _activeInlinePlayer.id === audioId) {
    if (_activeInlinePlayer.audio.paused) {
      _activeInlinePlayer.audio.play();
      btn.textContent = '\u25A0';
      btn.classList.add('playing');
    } else {
      _activeInlinePlayer.audio.pause();
      btn.textContent = '\u25B6';
      btn.classList.remove('playing');
    }
    return;
  }
  stopInlinePlayer();
  const audio = new Audio(audioUrl);
  audio.play();
  btn.textContent = '\u25A0';
  btn.classList.add('playing');
  audio.addEventListener('ended', () => {
    btn.textContent = '\u25B6';
    btn.classList.remove('playing');
    _activeInlinePlayer = null;
  });
  _activeInlinePlayer = { audio, btn, id: audioId };
}

// ── Internal state ──────────────────────────────────────────────────
let currentFilter = 'fifty';
let currentSort = { column: null, dir: 'asc' };
let currentPage = 1;
let searchTerm = '';
let filterYear = '';
let filterMonth = '';
let filterType = '';
let selectedIds = new Set();
const PAGE_SIZE = 50;

let _container = null;
let _onRowExpand = null;
let _onRowSelect = null;

// ── Column definitions ─────────────────────────────────────────────
const COLUMNS = [
  { key: 'checkbox',      label: '',                  sortable: false, showWhen: () => true },
  { key: 'rowNum',        label: '#',                 sortable: false, showWhen: () => true },
  { key: 'name',          label: 'Audio Name',        sortable: true,  showWhen: () => true },
  { key: 'year',          label: 'Year',              sortable: true,  showWhen: () => true },
  { key: 'type',          label: 'Type',              sortable: true,  showWhen: () => true },
  { key: 'estMinutes',    label: 'Duration',          sortable: true,  showWhen: () => true },
  { key: 'firstLine',     label: 'First 15 Words',    sortable: false, showWhen: (f) => !filterMatchesStatus(f, ['unmapped']) },
  { key: 'transcript',    label: 'Transcript Name',   sortable: true,  showWhen: (f) => !filterMatchesStatus(f, ['unmapped']) },
  { key: 'matchConf',     label: 'Match Confidence',  sortable: true,  showWhen: (f) => !filterMatchesStatus(f, ['unmapped']) },
  { key: 'cleanRate',     label: 'Clean Rate',        sortable: true,  showWhen: (f) => !filterMatchesStatus(f, ['unmapped', 'mapped']) },
  { key: 'avgConf',       label: 'Avg. Confidence',   sortable: true,  showWhen: (f) => !filterMatchesStatus(f, ['unmapped', 'mapped', 'cleaned']) },
  { key: 'lowConfWords',  label: 'Low Conf. Words',   sortable: true,  showWhen: (f) => !filterMatchesStatus(f, ['unmapped', 'mapped', 'cleaned']) },
  { key: 'comments',      label: 'Comments',          sortable: false, showWhen: () => true },
  { key: 'status',        label: 'Status',            sortable: true,  showWhen: () => true },
  { key: 'actions',       label: 'Actions',           sortable: false, showWhen: () => true },
];

// Filter keys from HTML data-filter attributes are passed directly to state.js
// since getFilteredRows now accepts both 'fifty-*' and '50hr-*' variants.

function filterMatchesStatus(filter, statuses) {
  // Check direct match
  if (statuses.includes(filter)) return true;
  // Check compound keys like 'fifty-unmapped' or '50hr-mapped'
  const parts = filter.split('-');
  const status = parts[parts.length - 1];
  if ((parts[0] === 'fifty' || parts[0] === '50hr') && statuses.includes(status)) return true;
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────

function getVisibleColumns() {
  return COLUMNS.filter(c => c.showWhen(currentFilter));
}

function getTranscriptForAudio(audioId) {
  const state = getState();
  const mapping = state.mappings && state.mappings[audioId];
  if (!mapping) return null;
  const transcripts = state.transcripts || [];
  return transcripts.find(t => t.id === mapping.transcriptId) || null;
}

function getRowData(audio) {
  const state = getState();
  const id = audio.id;
  const status = getStatus(id);
  const mapping = state.mappings && state.mappings[id];
  const cleaning = state.cleaning && state.cleaning[id];
  const alignment = state.alignments && state.alignments[id];
  const transcript = getTranscriptForAudio(id);

  return {
    id,
    name: (state.audioNames && state.audioNames[id]) || audio.name || '',
    year: audio.year || '',
    month: audio.month || '',
    type: audio.type || '',
    estMinutes: audio.estMinutes != null ? audio.estMinutes + ' min' : '',
    firstLine: transcript ? truncateWords(transcript.firstLine || '', 15) : '',
    transcript: transcript ? transcript.name : '',
    matchConf: mapping ? formatConfidence(mapping.confidence) : '',
    cleanRate: cleaning ? cleaning.cleanRate + '%' : '',
    avgConf: alignment ? formatConfidence(alignment.avgConfidence) : '',
    lowConfWords: alignment ? alignment.lowConfidenceCount : '',
    comments: audio.comments || '',
    status,
    isBenchmark: !!audio.isBenchmark,
  };
}

function matchesSearch(row) {
  if (filterYear && row.year !== filterYear) return false;
  if (filterMonth && row.month !== filterMonth) return false;
  if (filterType && row.type !== filterType) return false;
  if (!searchTerm) return true;
  const term = searchTerm.toLowerCase();
  return (
    row.name.toLowerCase().includes(term) ||
    row.transcript.toLowerCase().includes(term) ||
    row.firstLine.toLowerCase().includes(term)
  );
}

function populateDropdownFilters() {
  const state = getState();
  if (!state || !state.audio) return;

  const years = new Set();
  const months = new Set();
  const types = new Set();

  state.audio.forEach(a => {
    if (a.year) years.add(a.year);
    if (a.month) months.add(a.month);
    if (a.type) types.add(a.type);
  });

  const yearSelect = document.getElementById('filter-year');
  const monthSelect = document.getElementById('filter-month');
  const typeSelect = document.getElementById('filter-type');

  if (yearSelect && yearSelect.options.length <= 1) {
    [...years].sort().forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearSelect.appendChild(opt);
    });
  }

  if (monthSelect && monthSelect.options.length <= 1) {
    [...months].sort().forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      monthSelect.appendChild(opt);
    });
  }

  if (typeSelect && typeSelect.options.length <= 1) {
    [...types].sort().forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      typeSelect.appendChild(opt);
    });
  }
}

function sortRows(rows) {
  if (!currentSort.column) return rows;
  const key = currentSort.column;
  const dir = currentSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    // Parse numeric-looking values
    if (typeof va === 'string') {
      const na = parseFloat(va);
      const nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
    }
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

function getStatusClass(status) {
  const map = {
    unmapped: 'status-unmapped',
    mapped: 'status-mapped',
    cleaned: 'status-cleaned',
    aligned: 'status-aligned',
    approved: 'status-approved',
    rejected: 'status-rejected',
  };
  return map[status] || 'status-unmapped';
}

// ── Remap modal ─────────────────────────────────────────────────────

function openRemapModal(audioId) {
  const state = getState();
  const audio = state.audio.find(a => a.id === audioId);
  if (!audio) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal remap-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = 'Change Transcript';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-close';
  closeBtn.textContent = '\u00D7';
  function closeRemapModal() {
    document.removeEventListener('keydown', escHandler);
    overlay.remove();
  }
  closeBtn.addEventListener('click', closeRemapModal);
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const sub = document.createElement('div');
  sub.className = 'remap-subtitle';
  sub.textContent = (state.audioNames && state.audioNames[audioId]) || audio.name || audioId;
  modal.appendChild(sub);

  // Suggested matches
  const suggestions = getSuggestedMatches(audio, state.transcripts, state.mappings);
  if (suggestions.length > 0) {
    const suggestSection = document.createElement('div');
    suggestSection.className = 'remap-section';
    const suggestLabel = document.createElement('div');
    suggestLabel.className = 'remap-section-label';
    suggestLabel.textContent = 'Closest matches';
    suggestSection.appendChild(suggestLabel);

    for (const s of suggestions) {
      const transcript = state.transcripts.find(t => t.id === s.transcriptId);
      if (!transcript) continue;
      const row = document.createElement('div');
      row.className = 'suggestion-row';

      const badge = document.createElement('span');
      badge.className = 'confidence-badge';
      badge.textContent = formatConfidence(s.score);
      if (s.score >= 0.8) badge.classList.add('confidence-high');
      else if (s.score >= 0.4) badge.classList.add('confidence-mid');
      else badge.classList.add('confidence-low');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'suggestion-name';
      nameSpan.textContent = transcript.name;

      const reason = document.createElement('span');
      reason.className = 'suggestion-reason text-secondary';
      reason.textContent = s.matchReason;

      const selectBtn = document.createElement('button');
      selectBtn.className = 'action-btn action-btn-primary';
      selectBtn.textContent = 'Select';
      selectBtn.style.flexShrink = '0';
      selectBtn.addEventListener('click', () => {
        linkMatch(audioId, s.transcriptId, s.score, s.matchReason);
        closeRemapModal();
        updateTable();
      });

      row.appendChild(badge);
      row.appendChild(nameSpan);
      row.appendChild(reason);
      row.appendChild(selectBtn);
      suggestSection.appendChild(row);
    }
    modal.appendChild(suggestSection);
  }

  // Search divider
  const divider = document.createElement('div');
  divider.className = 'remap-divider';
  divider.textContent = 'Search all transcripts';
  modal.appendChild(divider);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'search-input remap-search';
  searchInput.placeholder = 'Filter by name or text…';
  modal.appendChild(searchInput);

  const results = document.createElement('div');
  results.className = 'remap-results';

  function renderResults() {
    results.innerHTML = '';
    const term = searchInput.value.toLowerCase();
    const filtered = state.transcripts.filter(t => {
      if (!term) return true;
      return (t.name || '').toLowerCase().includes(term) ||
             (t.firstLine || '').toLowerCase().includes(term);
    });
    for (const t of filtered.slice(0, 60)) {
      const row = document.createElement('div');
      row.className = 'search-result-row';
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = t.name || t.id;
      const preview = document.createElement('span');
      preview.className = 'result-preview hebrew-text';
      preview.dir = 'rtl';
      preview.textContent = truncateWords(t.firstLine || '', 12);
      const selectBtn = document.createElement('button');
      selectBtn.className = 'action-btn action-btn-primary';
      selectBtn.textContent = 'Select';
      selectBtn.style.flexShrink = '0';
      selectBtn.addEventListener('click', () => {
        linkMatch(audioId, t.id, 1.0, 'manual');
        closeRemapModal();
        updateTable();
      });
      row.appendChild(name);
      row.appendChild(preview);
      row.appendChild(selectBtn);
      results.appendChild(row);
    }
  }

  searchInput.addEventListener('input', renderResults);
  modal.appendChild(results);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeRemapModal(); });
  function escHandler(e) {
    if (e.key === 'Escape') closeRemapModal();
  }
  document.addEventListener('keydown', escHandler);

  document.body.appendChild(overlay);
  renderResults();
  searchInput.focus();
}

// ── Build table DOM ─────────────────────────────────────────────────

function buildTable(rows) {
  const cols = getVisibleColumns();
  const table = document.createElement('table');
  table.className = 'data-table';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  cols.forEach(col => {
    const th = document.createElement('th');
    if (col.key === 'checkbox') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'select-all-cb';
      cb.checked = rows.length > 0 && rows.every(r => selectedIds.has(r.id));
      cb.addEventListener('change', () => {
        if (cb.checked) {
          rows.forEach(r => selectedIds.add(r.id));
        } else {
          rows.forEach(r => selectedIds.delete(r.id));
        }
        updateTable();
        _fireRowSelect();
      });
      th.appendChild(cb);
    } else {
      th.textContent = col.label;
      if (col.sortable) {
        th.classList.add('sortable');
        if (currentSort.column === col.key) {
          th.classList.add(currentSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
        th.addEventListener('click', () => {
          if (currentSort.column === col.key) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            currentSort.column = col.key;
            currentSort.dir = 'asc';
          }
          currentPage = 1;
          updateTable();
        });
      }
    }
    if (col.key === 'firstLine') th.classList.add('rtl-cell');
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(startIdx, startIdx + PAGE_SIZE);

  pageRows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.className = 'table-row';
    tr.setAttribute('data-audio-id', row.id);
    if (row.isBenchmark) tr.classList.add('benchmark-row');
    if (selectedIds.has(row.id)) tr.classList.add('selected');

    cols.forEach(col => {
      const td = document.createElement('td');

      switch (col.key) {
        case 'checkbox': {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'row-checkbox';
          cb.checked = selectedIds.has(row.id);
          cb.addEventListener('change', (e) => {
            e.stopPropagation();
            if (cb.checked) {
              selectedIds.add(row.id);
            } else {
              selectedIds.delete(row.id);
            }
            updateTable();
            _fireRowSelect();
          });
          td.appendChild(cb);
          break;
        }
        case 'rowNum':
          td.textContent = startIdx + i + 1;
          break;
        case 'name': {
          const nameSpan = document.createElement('span');
          nameSpan.className = 'audio-name-editable';
          nameSpan.textContent = row.name;
          nameSpan.title = 'Click to edit';
          nameSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'audio-name-input';
            input.value = row.name;
            input.addEventListener('click', (e) => e.stopPropagation());
            td.replaceChild(input, nameSpan);
            input.focus();
            input.select();
            let saved = false;
            const save = () => {
              if (saved) return;
              saved = true;
              const newName = input.value.trim();
              if (newName && newName !== row.name) {
                updateState('audioNames', row.id, newName);
              }
              updateTable();
            };
            input.addEventListener('blur', save);
            input.addEventListener('keydown', (ke) => {
              if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
              if (ke.key === 'Escape') {
                ke.preventDefault();
                saved = true;
                input.removeEventListener('blur', save);
                td.replaceChild(nameSpan, input);
              }
            });
          });
          td.appendChild(nameSpan);
          break;
        }
        case 'transcript': {
          if (row.transcript) {
            const link = document.createElement('span');
            link.className = 'transcript-remap-link';
            link.textContent = row.transcript;
            link.title = 'Click to change transcript';
            link.addEventListener('click', (e) => {
              e.stopPropagation();
              openRemapModal(row.id);
            });
            td.appendChild(link);
          } else {
            const mapBtn = document.createElement('button');
            mapBtn.className = 'action-btn';
            mapBtn.textContent = 'Map';
            mapBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              openRemapModal(row.id);
            });
            td.appendChild(mapBtn);
          }
          break;
        }
        case 'firstLine':
          td.textContent = row.firstLine;
          td.classList.add('cell-hebrew');
          break;
        case 'comments': {
          const commentSpan = document.createElement('span');
          commentSpan.className = 'comment-cell';
          commentSpan.textContent = row.comments || '+ Add comment';
          commentSpan.title = 'Click to edit';
          if (!row.comments) commentSpan.classList.add('comment-placeholder');
          commentSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            const textarea = document.createElement('textarea');
            textarea.className = 'comment-input';
            textarea.value = row.comments || '';
            textarea.rows = 3;
            td.replaceChild(textarea, commentSpan);
            textarea.focus();
            let saved = false;
            const save = () => {
              if (saved) return;
              saved = true;
              const newVal = textarea.value.trim();
              if (newVal !== row.comments) {
                updateState('audioComments', row.id, newVal);
              }
              updateTable();
            };
            textarea.addEventListener('blur', save);
            textarea.addEventListener('keydown', (ke) => {
              if (ke.key === 'Escape') {
                ke.preventDefault();
                saved = true;
                textarea.removeEventListener('blur', save);
                td.replaceChild(commentSpan, textarea);
              }
            });
          });
          td.appendChild(commentSpan);
          break;
        }
        case 'status': {
          const badge = document.createElement('span');
          badge.className = `status-badge ${getStatusClass(row.status)}`;
          badge.textContent = row.status;
          td.appendChild(badge);
          break;
        }
        case 'actions': {
          // Play button
          const state = getState();
          const audioEntry = state.audio.find(a => a.id === row.id);
          const playUrl = audioEntry?.r2Link || audioEntry?.driveLink;
          if (playUrl) {
            const playBtn = document.createElement('button');
            playBtn.className = 'action-btn row-play-btn';
            playBtn.textContent = '\u25B6';
            playBtn.title = 'Play';
            playBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              toggleInlinePlay(playBtn, playUrl, row.id);
            });
            td.appendChild(playBtn);
          }
          // Open button — opens detail.html in a new tab
          const btn = document.createElement('button');
          btn.className = 'action-btn action-btn-primary';
          btn.textContent = 'Open';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.open(`/detail.html?id=${encodeURIComponent(row.id)}`, '_blank');
          });
          td.appendChild(btn);
          break;
        }
        default:
          td.textContent = row[col.key] != null ? row[col.key] : '';
      }
      tr.appendChild(td);
    });

    tr.addEventListener('click', () => {
      if (_onRowExpand) _onRowExpand(row.id);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function buildCardView(rows) {
  const container = document.createElement('div');
  container.className = 'card-view';

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(startIdx, startIdx + PAGE_SIZE);

  pageRows.forEach(row => {
    const card = document.createElement('div');
    card.className = 'card-item';
    if (selectedIds.has(row.id)) card.classList.add('selected');

    const header = document.createElement('div');
    header.className = 'card-item-header';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'row-checkbox';
    cb.checked = selectedIds.has(row.id);
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) selectedIds.add(row.id);
      else selectedIds.delete(row.id);
      updateTable();
      _fireRowSelect();
    });

    const name = document.createElement('span');
    name.className = 'card-item-name';
    name.textContent = row.name;

    header.appendChild(cb);
    header.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'card-item-meta';
    if (row.year) {
      const yearSpan = document.createElement('span');
      yearSpan.textContent = row.year;
      meta.appendChild(yearSpan);
    }
    if (row.type) {
      const typeSpan = document.createElement('span');
      typeSpan.textContent = row.type;
      meta.appendChild(typeSpan);
    }
    const badge = document.createElement('span');
    badge.className = `status-badge ${getStatusClass(row.status)}`;
    badge.textContent = row.status;
    meta.appendChild(badge);

    card.appendChild(header);
    card.appendChild(meta);

    if (row.firstLine) {
      const preview = document.createElement('div');
      preview.className = 'card-item-preview';
      preview.dir = 'rtl';
      preview.textContent = row.firstLine;
      card.appendChild(preview);
    }

    const actions = document.createElement('div');
    actions.className = 'card-item-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'action-btn action-btn-primary';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`/detail.html?id=${encodeURIComponent(row.id)}`, '_blank');
    });
    actions.appendChild(openBtn);

    card.appendChild(actions);

    card.addEventListener('click', () => {
      window.open(`/detail.html?id=${encodeURIComponent(row.id)}`, '_blank');
    });

    container.appendChild(card);
  });

  return container;
}

function buildPagination(totalRows) {
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const nav = document.createElement('div');
  nav.className = 'pagination';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'pagination-btn';
  prevBtn.textContent = 'Prev';
  prevBtn.disabled = currentPage <= 1;
  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; updateTable(); }
  });

  const pageInfo = document.createElement('span');
  pageInfo.className = 'pagination-info';
  pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'pagination-btn';
  nextBtn.textContent = 'Next';
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; updateTable(); }
  });

  nav.appendChild(prevBtn);
  nav.appendChild(pageInfo);
  nav.appendChild(nextBtn);
  return nav;
}

function updateFilterCounts() {
  const counts = getFilterCounts();
  const map = {
    'count-fifty': 'fifty',
    'count-fifty-unmapped': 'fifty-unmapped',
    'count-fifty-mapped': 'fifty-mapped',
    'count-fifty-cleaned': 'fifty-cleaned',
    'count-fifty-aligned': 'fifty-aligned',
    'count-fifty-approved': 'fifty-approved',
    'count-all': 'all',
    'count-unmapped': 'unmapped',
    'count-approved': 'approved',
    'count-benchmark': 'benchmark',
  };
  for (const [elId, stateKey] of Object.entries(map)) {
    const el = document.getElementById(elId);
    if (el) el.textContent = counts[stateKey] != null ? counts[stateKey] : 0;
  }
}

function updateFilterPills() {
  const pills = document.querySelectorAll('.filter-pill');
  pills.forEach(pill => {
    const filter = pill.getAttribute('data-filter');
    pill.classList.toggle('active', filter === currentFilter);
  });
}

function updateBulkCount() {
  const el = document.getElementById('bulk-selection-count');
  if (el) el.textContent = `${selectedIds.size} selected`;
}

function _fireRowSelect() {
  updateBulkCount();
  if (_onRowSelect) _onRowSelect([...selectedIds]);
}

// ── Public API ──────────────────────────────────────────────────────

function renderTable(container, options = {}) {
  _container = container;
  _onRowExpand = options.onRowExpand || null;
  _onRowSelect = options.onRowSelect || null;

  if (options.filter) currentFilter = options.filter;

  // Wire filter pills
  const pills = document.querySelectorAll('.filter-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      currentFilter = pill.getAttribute('data-filter');
      currentPage = 1;
      selectedIds.clear();
      updateTable();
      _fireRowSelect();
      if (_container) _container.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Wire dropdown filters
  const yearSelect = document.getElementById('filter-year');
  const monthSelect = document.getElementById('filter-month');
  const typeSelect = document.getElementById('filter-type');

  if (yearSelect) {
    yearSelect.addEventListener('change', () => {
      filterYear = yearSelect.value;
      currentPage = 1;
      updateTable();
    });
  }
  if (monthSelect) {
    monthSelect.addEventListener('change', () => {
      filterMonth = monthSelect.value;
      currentPage = 1;
      updateTable();
    });
  }
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      filterType = typeSelect.value;
      currentPage = 1;
      updateTable();
    });
  }

  // Wire search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    const debouncedSearch = debounce((val) => {
      searchTerm = val;
      currentPage = 1;
      updateTable();
    }, 250);
    searchInput.addEventListener('input', (e) => {
      debouncedSearch(e.target.value);
    });
  }

  // Populate dropdown filters from data
  populateDropdownFilters();

  updateTable();
}

function updateTable() {
  if (!_container) return;

  // Get filtered rows from state
  const filteredAudio = getFilteredRows(currentFilter);

  // Build row data
  let rows = filteredAudio.map(getRowData);

  // Apply search
  rows = rows.filter(matchesSearch);

  // Apply sort
  rows = sortRows(rows);

  // Stop any playing inline audio before clearing
  stopInlinePlayer();

  // Clear container
  _container.innerHTML = '';

  // Update UI
  updateFilterCounts();
  updateFilterPills();
  updateBulkCount();

  // Build and append table
  const table = buildTable(rows);
  _container.appendChild(table);

  // Build and append card view (visible on mobile ≤480px via CSS)
  const cardView = buildCardView(rows);
  _container.appendChild(cardView);

  // Build and append pagination
  const pagination = buildPagination(rows.length);
  _container.appendChild(pagination);
}

function getSelectedRows() {
  return [...selectedIds];
}

export { renderTable, updateTable, getSelectedRows };
