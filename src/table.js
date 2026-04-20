import { getState, getFilteredRows, getFilterCounts, getStatus, getCompletedStages, PIPELINE_STAGES, updateState } from './state.js';
import { truncateWords, formatConfidence, debounce, HEBREW_MONTHS } from './utils.js';
import { linkMatch, unlinkMatch, getSuggestedMatches } from './mapping.js';
import { isLibraryR2Url } from './auth.js';
import { syncAudioField } from './db.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Extract sicha/maamar number from filename, e.g. "Sicha 3" → "3" */
function parseSichaNum(name) {
  if (!name) return null;
  const m = name.match(/\b(?:Sicha|Mamar|Maamar)\s+(\d+)/i);
  return m ? m[1] : null;
}

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
  const proxiedUrl = isLibraryR2Url(audioUrl) ? `/api/audio?url=${encodeURIComponent(audioUrl)}` : audioUrl;
  const audio = new Audio(proxiedUrl);
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
let fiftyFilter = '';  // '' = all, 'yes' = 50hr only, 'no' = not in 50hr
let statusFilter = [];  // array of selected statuses, empty = all
let currentSort = { column: null, dir: 'asc' };
let currentPage = 1;
let searchTerm = '';
let filterYear = '';
let filterMonth = '';
let filterType = '';
let filterConfidence = '';

function buildFilter() {
  const sf = statusFilter.length === 1 ? statusFilter[0] : '';
  if (fiftyFilter === 'yes' && sf) return 'fifty-' + sf;
  if (fiftyFilter === 'yes') return 'fifty';
  if (fiftyFilter === 'no' && sf) return 'not-fifty-' + sf;
  if (fiftyFilter === 'no') return 'not-fifty';
  if (sf) return sf;
  return 'all';
}

function updateMultiSelectLabel(btn, selected, allLabel) {
  if (selected.length === 0) btn.textContent = allLabel;
  else if (selected.length <= 2) btn.textContent = selected.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
  else btn.textContent = selected.length + ' selected';
}
const PAGE_SIZE = 50;
const selectedIds = new Set();

function getSelectedRows() {
  return [...selectedIds];
}

function updateURL() {
  const params = new URLSearchParams();
  if (fiftyFilter) params.set('fifty', fiftyFilter);
  if (statusFilter.length) params.set('status', statusFilter.join(','));
  if (currentPage > 1) params.set('page', String(currentPage));
  if (searchTerm) params.set('q', searchTerm);
  if (filterYear) params.set('year', filterYear);
  if (filterMonth) params.set('month', filterMonth);
  if (filterType) params.set('type', filterType);
  if (filterConfidence) params.set('confidence', filterConfidence);
  const qs = params.toString();
  window.history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
}

let _container = null;
let _onRowExpand = null;

// ── Column definitions ─────────────────────────────────────────────
const COLUMNS = [
  { key: 'checkbox',      label: '',                  sortable: false, showWhen: () => true },
  { key: 'rowNum',        label: '#',                 sortable: false, showWhen: () => true },
  { key: 'name',          label: 'Audio Name',        sortable: true,  showWhen: () => true },
  { key: 'year',          label: 'Year',              sortable: true,  showWhen: () => true },
  { key: 'month',         label: 'Month',             sortable: true,  showWhen: () => true },
  { key: 'day',           label: 'Day',               sortable: true,  showWhen: () => true },
  { key: 'type',          label: 'Type',              sortable: true,  showWhen: () => true },
  { key: 'sichaNum',      label: 'No.',               sortable: true,  showWhen: () => true },
  { key: 'estMinutes',    label: 'Duration',          sortable: true,  showWhen: () => true },
  { key: 'firstLine',     label: 'First 15 Words',    sortable: false, showWhen: () => true },
  { key: 'transcript',    label: 'Transcript Name',   sortable: true,  showWhen: () => true },
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
  return COLUMNS.filter(c => c.showWhen(buildFilter()));
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
    year: (state.audioYears && state.audioYears[id]) || audio.year || '',
    month: (state.audioMonths && state.audioMonths[id]) || audio.month || '',
    day: (state.audioDays && state.audioDays[id]) || audio.day || '',
    type: (state.audioTypes && state.audioTypes[id]) || audio.type || '',
    sichaNum: parseSichaNum(audio.name) || '',
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
    isSelected50hr: !!audio.isSelected50hr,
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

// ── Pipeline indicator ──────────────────────────────────────────────

function renderPipelineIndicator(audioId, detail) {
  const stages = getCompletedStages(audioId);

  // Unmapped — show old-style badge
  if (!stages.mapped) {
    const badge = document.createElement('span');
    badge.className = 'status-badge status-unmapped';
    badge.textContent = 'unmapped';
    return badge;
  }

  const container = document.createElement('span');
  container.className = 'pipeline-indicator' + (detail ? ' pipeline-detail' : '');

  const stageNames = PIPELINE_STAGES; // ['mapped', 'cleaned', 'aligned', 'approved']
  for (let i = 0; i < stageNames.length; i++) {
    if (i > 0) {
      const conn = document.createElement('span');
      conn.className = 'pipeline-connector ' + (stages[stageNames[i]] ? 'done' : 'pending');
      container.appendChild(conn);
    }
    const name = stageNames[i];
    const dot = document.createElement('span');
    const isDone = stages[name];
    const isRejected = name === 'approved' && stages.rejected && !stages.approved;

    if (isRejected) {
      dot.className = 'pipeline-stage done-rejected';
      dot.textContent = '✗';
      dot.title = 'rejected';
    } else if (isDone) {
      dot.className = `pipeline-stage done-${name}`;
      dot.textContent = '✓';
      dot.title = name;
    } else {
      dot.className = 'pipeline-stage pending';
      dot.textContent = '○';
      dot.title = name;
    }
    container.appendChild(dot);
  }
  return container;
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

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(startIdx, startIdx + PAGE_SIZE);

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  cols.forEach(col => {
    const th = document.createElement('th');
    if (col.key === 'checkbox') {
      th.classList.add('cell-checkbox');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'select-all-cb';
      cb.checked = pageRows.length > 0 && pageRows.every(r => selectedIds.has(r.id));
      cb.addEventListener('change', () => {
        if (cb.checked) {
          pageRows.forEach(r => selectedIds.add(r.id));
        } else {
          pageRows.forEach(r => selectedIds.delete(r.id));
        }
        updateTable();
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
          td.classList.add('cell-checkbox');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selectedIds.has(row.id);
          cb.addEventListener('click', (e) => e.stopPropagation());
          cb.addEventListener('change', () => {
            if (cb.checked) {
              selectedIds.add(row.id);
              tr.classList.add('selected');
            } else {
              selectedIds.delete(row.id);
              tr.classList.remove('selected');
            }
            updateBulkBar();
            // Sync header checkbox
            const selectAllCb = _container?.querySelector('.select-all-cb');
            if (selectAllCb) selectAllCb.checked = pageRows.every(r => selectedIds.has(r.id));
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
        case 'year': {
          const yearSpan = document.createElement('span');
          yearSpan.className = 'editable-cell';
          yearSpan.textContent = row.year || '—';
          yearSpan.title = 'Click to edit';
          if (!row.year) yearSpan.classList.add('editable-cell-empty');
          yearSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'inline-edit-input';
            input.value = row.year;
            input.placeholder = '5748';
            input.style.width = '60px';
            input.addEventListener('click', (e2) => e2.stopPropagation());
            td.replaceChild(input, yearSpan);
            input.focus();
            input.select();
            let saved = false;
            const save = () => {
              if (saved) return;
              saved = true;
              const val = input.value.trim();
              if (val !== (row.year || '')) {
                updateState('audioYears', row.id, val);
              }
              updateTable();
            };
            input.addEventListener('blur', save);
            input.addEventListener('keydown', (ke) => {
              if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
              if (ke.key === 'Escape') { ke.preventDefault(); saved = true; input.removeEventListener('blur', save); td.replaceChild(yearSpan, input); }
            });
          });
          td.appendChild(yearSpan);
          break;
        }
        case 'month': {
          const monthSpan = document.createElement('span');
          monthSpan.className = 'editable-cell';
          monthSpan.textContent = row.month || '—';
          monthSpan.title = 'Click to edit';
          if (!row.month) monthSpan.classList.add('editable-cell-empty');
          monthSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            const select = document.createElement('select');
            select.className = 'inline-edit-select';
            const blankOpt = document.createElement('option');
            blankOpt.value = '';
            blankOpt.textContent = '—';
            select.appendChild(blankOpt);
            for (const m of HEBREW_MONTHS) {
              const opt = document.createElement('option');
              opt.value = m;
              opt.textContent = m;
              if (m === row.month) opt.selected = true;
              select.appendChild(opt);
            }
            select.addEventListener('click', (e2) => e2.stopPropagation());
            td.replaceChild(select, monthSpan);
            select.focus();
            let saved = false;
            const save = () => {
              if (saved) return;
              saved = true;
              const val = select.value;
              if (val !== (row.month || '')) {
                updateState('audioMonths', row.id, val);
              }
              updateTable();
            };
            select.addEventListener('blur', save);
            select.addEventListener('change', () => { select.blur(); });
            select.addEventListener('keydown', (ke) => {
              if (ke.key === 'Escape') { ke.preventDefault(); saved = true; select.removeEventListener('blur', save); td.replaceChild(monthSpan, select); }
            });
          });
          td.appendChild(monthSpan);
          break;
        }
        case 'day': {
          const daySpan = document.createElement('span');
          daySpan.className = 'editable-cell';
          daySpan.textContent = row.day || '—';
          daySpan.title = 'Click to edit';
          if (!row.day) daySpan.classList.add('editable-cell-empty');
          daySpan.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'inline-edit-input';
            input.value = row.day || '';
            input.min = '1';
            input.max = '30';
            input.style.width = '50px';
            input.addEventListener('click', (e2) => e2.stopPropagation());
            td.replaceChild(input, daySpan);
            input.focus();
            input.select();
            let saved = false;
            const save = () => {
              if (saved) return;
              saved = true;
              const val = input.value.trim();
              const numVal = val ? parseInt(val, 10) : '';
              if (String(numVal) !== String(row.day || '')) {
                updateState('audioDays', row.id, numVal || '');
              }
              updateTable();
            };
            input.addEventListener('blur', save);
            input.addEventListener('keydown', (ke) => {
              if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
              if (ke.key === 'Escape') { ke.preventDefault(); saved = true; input.removeEventListener('blur', save); td.replaceChild(daySpan, input); }
            });
          });
          td.appendChild(daySpan);
          break;
        }
        case 'type': {
          const CONTENT_TYPES = ['sicha', 'maamar', 'farbrengen'];
          const typeSpan = document.createElement('span');
          typeSpan.className = 'editable-cell';
          typeSpan.textContent = row.type || '—';
          typeSpan.title = 'Click to edit';
          if (!row.type) typeSpan.classList.add('editable-cell-empty');
          typeSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            const select = document.createElement('select');
            select.className = 'inline-edit-select';
            const blankOpt = document.createElement('option');
            blankOpt.value = '';
            blankOpt.textContent = '—';
            select.appendChild(blankOpt);
            for (const t of CONTENT_TYPES) {
              const opt = document.createElement('option');
              opt.value = t;
              opt.textContent = t;
              if (t === row.type) opt.selected = true;
              select.appendChild(opt);
            }
            select.addEventListener('click', (e2) => e2.stopPropagation());
            td.replaceChild(select, typeSpan);
            select.focus();
            let saved = false;
            const save = () => {
              if (saved) return;
              saved = true;
              const val = select.value;
              if (val !== (row.type || '')) {
                updateState('audioTypes', row.id, val);
              }
              updateTable();
            };
            select.addEventListener('blur', save);
            select.addEventListener('change', () => { select.blur(); });
            select.addEventListener('keydown', (ke) => {
              if (ke.key === 'Escape') { ke.preventDefault(); saved = true; select.removeEventListener('blur', save); td.replaceChild(typeSpan, select); }
            });
          });
          td.appendChild(typeSpan);
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
          td.appendChild(renderPipelineIndicator(row.id, false));
          if (row.isSelected50hr) {
            const fiftyBadge = document.createElement('span');
            fiftyBadge.className = 'status-badge status-fifty';
            fiftyBadge.textContent = '50hr';
            fiftyBadge.style.marginLeft = '4px';
            td.appendChild(fiftyBadge);
          }
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
            playBtn.setAttribute('aria-label', 'Play audio');
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
          // Unlink button — only shown when audio has a mapping
          if (state.mappings && state.mappings[row.id]) {
            const unlinkBtn = document.createElement('button');
            unlinkBtn.className = 'action-btn action-btn-danger';
            unlinkBtn.textContent = 'Unlink';
            unlinkBtn.title = 'Unlink transcript';
            unlinkBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              unlinkMatch(row.id);
              updateTable();
            });
            td.appendChild(unlinkBtn);
          }
          // 50hr toggle button
          {
            const fiftyBtn = document.createElement('button');
            fiftyBtn.className = 'action-btn fifty-toggle-btn' + (audioEntry?.isSelected50hr ? ' fifty-active' : '');
            fiftyBtn.textContent = audioEntry?.isSelected50hr ? '50hr' : '+50hr';
            fiftyBtn.title = audioEntry?.isSelected50hr ? 'Remove from 50hr set' : 'Add to 50hr set';
            fiftyBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (!audioEntry) return;
              audioEntry.isSelected50hr = !audioEntry.isSelected50hr;
              syncAudioField(row.id, 'is_selected_50hr', audioEntry.isSelected50hr).catch(console.warn);
              updateTable();
            });
            td.appendChild(fiftyBtn);
          }
          break;
        }
        default:
          td.textContent = row[col.key] != null ? row[col.key] : '';
      }
      tr.appendChild(td);
    });

    tr.addEventListener('click', (e) => {
      if (_onRowExpand) _onRowExpand(row.id, e);
      else window.open(`/detail.html?id=${encodeURIComponent(row.id)}`, '_blank');
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

    const header = document.createElement('div');
    header.className = 'card-item-header';

    const name = document.createElement('span');
    name.className = 'card-item-name';
    name.textContent = row.name;

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
    meta.appendChild(renderPipelineIndicator(row.id, false));

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
    if (currentPage > 1) { currentPage--; selectedIds.clear(); updateURL(); updateTable(); }
  });

  const pageInfo = document.createElement('span');
  pageInfo.className = 'pagination-info';
  pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'pagination-btn';
  nextBtn.textContent = 'Next';
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; selectedIds.clear(); updateURL(); updateTable(); }
  });

  nav.appendChild(prevBtn);
  nav.appendChild(pageInfo);
  nav.appendChild(nextBtn);
  return nav;
}

function updateFilterCounts() {
  // No-op — badge elements removed in filter simplification
}

// ── Bulk action bar ────────────────────────────────────────────────

function updateBulkBar() {
  const bar = _container?.querySelector('.bulk-action-bar');
  if (!bar) return;
  if (selectedIds.size > 0) {
    bar.style.display = 'flex';
    const countEl = bar.querySelector('.bulk-count');
    if (countEl) countEl.textContent = `${selectedIds.size} selected`;
  } else {
    bar.style.display = 'none';
  }
}

function buildBulkBar() {
  const bar = document.createElement('div');
  bar.className = 'bulk-action-bar';
  bar.style.display = selectedIds.size > 0 ? 'flex' : 'none';

  const count = document.createElement('span');
  count.className = 'bulk-count';
  count.textContent = `${selectedIds.size} selected`;
  bar.appendChild(count);

  // Add to 50hr
  const addFiftyBtn = document.createElement('button');
  addFiftyBtn.className = 'action-btn action-btn-primary';
  addFiftyBtn.textContent = 'Add to 50hr';
  addFiftyBtn.addEventListener('click', () => {
    const state = getState();
    for (const id of selectedIds) {
      const entry = state.audio.find(a => a.id === id);
      if (entry) {
        entry.isSelected50hr = true;
        syncAudioField(id, 'is_selected_50hr', true).catch(console.warn);
      }
    }
    selectedIds.clear();
    updateTable();
  });
  bar.appendChild(addFiftyBtn);

  // Remove from 50hr
  const rmFiftyBtn = document.createElement('button');
  rmFiftyBtn.className = 'action-btn';
  rmFiftyBtn.textContent = 'Remove from 50hr';
  rmFiftyBtn.addEventListener('click', () => {
    const state = getState();
    for (const id of selectedIds) {
      const entry = state.audio.find(a => a.id === id);
      if (entry) {
        entry.isSelected50hr = false;
        syncAudioField(id, 'is_selected_50hr', false).catch(console.warn);
      }
    }
    selectedIds.clear();
    updateTable();
  });
  bar.appendChild(rmFiftyBtn);

  // Unlink
  const unlinkBtn = document.createElement('button');
  unlinkBtn.className = 'action-btn action-btn-danger';
  unlinkBtn.textContent = 'Unlink';
  unlinkBtn.addEventListener('click', () => {
    if (!confirm(`Unlink transcripts from ${selectedIds.size} file(s)? This removes mapping, cleaning, alignment, and review data.`)) return;
    for (const id of selectedIds) {
      unlinkMatch(id);
    }
    selectedIds.clear();
    updateTable();
  });
  bar.appendChild(unlinkBtn);

  // Clear selection
  const clearBtn = document.createElement('button');
  clearBtn.className = 'action-btn';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    selectedIds.clear();
    updateTable();
  });
  bar.appendChild(clearBtn);

  return bar;
}

// ── Public API ──────────────────────────────────────────────────────

function renderTable(container, options = {}) {
  _container = container;
  _onRowExpand = options.onRowExpand || null;

  // Default status: unmapped
  statusFilter = ['unmapped'];

  // Read initial state from URL query params
  const initParams = new URLSearchParams(window.location.search);
  if (initParams.has('fifty')) fiftyFilter = initParams.get('fifty') || '';
  if (initParams.has('status')) statusFilter = initParams.get('status').split(',').filter(Boolean);
  // Legacy: support old ?filter= param
  if (initParams.has('filter')) {
    const f = initParams.get('filter').replace('50hr', 'fifty');
    if (f === 'fifty' || f.startsWith('fifty-')) {
      fiftyFilter = 'yes';
      const s = f === 'fifty' ? '' : f.replace('fifty-', '');
      statusFilter = s ? [s] : [];
    } else if (f !== 'all') {
      statusFilter = [f];
    }
  }
  if (initParams.has('page')) currentPage = parseInt(initParams.get('page') || '1', 10);
  if (initParams.has('q')) searchTerm = initParams.get('q') || '';
  if (initParams.has('year')) filterYear = initParams.get('year') || '';
  if (initParams.has('month')) filterMonth = initParams.get('month') || '';
  if (initParams.has('type')) filterType = initParams.get('type') || '';
  if (initParams.has('confidence')) filterConfidence = initParams.get('confidence') || '';
  // buildFilter() computed on demand — no cached currentFilter needed

  // Wire 50hr filter
  const fiftySelect = document.getElementById('filter-fifty');
  if (fiftySelect) {
    fiftySelect.value = fiftyFilter;
    fiftySelect.addEventListener('change', () => {
      fiftyFilter = fiftySelect.value;
      // buildFilter() computed on demand — no cached currentFilter needed
      currentPage = 1;
      selectedIds.clear();
      updateURL();
      updateTable();
    });
  }

  // Wire multi-select status dropdown
  const statusContainer = document.getElementById('filter-status');
  if (statusContainer) {
    const statusBtn = statusContainer.querySelector('.multi-select-btn');
    const statusCheckboxes = statusContainer.querySelectorAll('input[type="checkbox"]');
    statusCheckboxes.forEach(cb => { cb.checked = statusFilter.includes(cb.value); });
    updateMultiSelectLabel(statusBtn, statusFilter, 'All Statuses');
    statusBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      statusContainer.classList.toggle('open');
    });
    statusCheckboxes.forEach(cb => {
      cb.addEventListener('change', () => {
        statusFilter = [...statusCheckboxes].filter(c => c.checked).map(c => c.value);
        updateMultiSelectLabel(statusBtn, statusFilter, 'All Statuses');
        currentPage = 1;
        selectedIds.clear();
        updateURL();
        updateTable();
      });
    });
    document.addEventListener('mousedown', (e) => {
      if (!statusContainer.contains(e.target)) statusContainer.classList.remove('open');
    });
  }

  // Wire confidence filter
  const confSelect = document.getElementById('filter-confidence');
  if (confSelect) {
    confSelect.addEventListener('change', () => {
      filterConfidence = confSelect.value;
      currentPage = 1;
      selectedIds.clear();
      updateURL();
      updateTable();
    });
  }

  // Wire dropdown filters
  const yearSelect = document.getElementById('filter-year');
  const monthSelect = document.getElementById('filter-month');
  const typeSelect = document.getElementById('filter-type');

  if (yearSelect) {
    yearSelect.addEventListener('change', () => {
      filterYear = yearSelect.value;
      currentPage = 1;
      selectedIds.clear();
      updateURL();
      updateTable();
    });
  }
  if (monthSelect) {
    monthSelect.addEventListener('change', () => {
      filterMonth = monthSelect.value;
      currentPage = 1;
      selectedIds.clear();
      updateURL();
      updateTable();
    });
  }
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      filterType = typeSelect.value;
      currentPage = 1;
      selectedIds.clear();
      updateURL();
      updateTable();
    });
  }

  // Wire search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    const debouncedSearch = debounce((val) => {
      searchTerm = val;
      currentPage = 1;
      selectedIds.clear();
      updateURL();
      updateTable();
    }, 250);
    searchInput.addEventListener('input', (e) => {
      debouncedSearch(e.target.value);
    });
  }

  // Wire reset button
  const resetBtn = document.getElementById('btn-reset-filters');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      fiftyFilter = '';
      statusFilter = [];
      filterYear = '';
      filterMonth = '';
      filterType = '';
      filterConfidence = '';
      searchTerm = '';
      currentPage = 1;
      selectedIds.clear();
      if (fiftySelect) fiftySelect.value = '';
      if (statusContainer) {
        statusContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        const btn = statusContainer.querySelector('.multi-select-btn');
        if (btn) btn.textContent = 'All Statuses';
      }
      if (confSelect) confSelect.value = '';
      if (yearSelect) yearSelect.value = '';
      if (monthSelect) monthSelect.value = '';
      if (typeSelect) typeSelect.value = '';
      const si = document.getElementById('search-input');
      if (si) si.value = '';
      updateURL();
      updateTable();
    });
  }

  // Populate dropdown filters from data
  populateDropdownFilters();

  // Restore dropdown values from URL params
  if (filterYear && yearSelect) yearSelect.value = filterYear;
  if (filterMonth && monthSelect) monthSelect.value = filterMonth;
  if (filterType && typeSelect) typeSelect.value = filterType;
  if (filterConfidence && confSelect) confSelect.value = filterConfidence;
  if (searchTerm) {
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = searchTerm;
  }

  updateTable();
}

function updateTable() {
  if (!_container) return;

  // Get filtered rows from state — multi-status support
  let filteredAudio;
  if (statusFilter.length > 1) {
    // Multi-select: union results for each status
    const prefix = fiftyFilter === 'yes' ? 'fifty-' : fiftyFilter === 'no' ? 'not-fifty-' : '';
    const seen = new Set();
    filteredAudio = [];
    for (const sf of statusFilter) {
      const filter = prefix ? prefix + sf : sf;
      for (const row of getFilteredRows(filter)) {
        if (!seen.has(row.id)) { seen.add(row.id); filteredAudio.push(row); }
      }
    }
  } else {
    filteredAudio = getFilteredRows(buildFilter());
  }

  // Apply confidence filter
  if (filterConfidence) {
    const state = getState();
    filteredAudio = filteredAudio.filter(a => {
      const m = state.mappings && state.mappings[a.id];
      const conf = m ? m.confidence : null;
      switch (filterConfidence) {
        case 'perfect': return conf === 1;
        case 'strong':  return conf !== null && conf >= 0.5;
        case 'weak':    return conf !== null && conf < 0.5;
        case 'none':    return conf === null || conf === undefined;
        default:        return true;
      }
    });
  }

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

  // Update result count
  const totalAudio = getState()?.audio?.length || 0;
  const countEl = document.getElementById('filter-count');
  if (countEl) {
    countEl.textContent = rows.length === totalAudio
      ? `${rows.length} files`
      : `${rows.length} of ${totalAudio} files`;
  }

  // Build and append table
  const table = buildTable(rows);
  _container.appendChild(table);

  // Build and append card view (visible on mobile ≤480px via CSS)
  const cardView = buildCardView(rows);
  _container.appendChild(cardView);

  // Build and append pagination
  const pagination = buildPagination(rows.length);
  _container.appendChild(pagination);

  // Build and append bulk action bar
  const bulkBar = buildBulkBar();
  _container.appendChild(bulkBar);
}

export { renderTable, updateTable, getSelectedRows };
