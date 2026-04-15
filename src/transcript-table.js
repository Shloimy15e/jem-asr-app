import { getState } from './state.js';
import { truncateWords } from './utils.js';

// ── State ──────────────────────────────────────────────────────────

let _container = null;
let currentSort = { column: null, dir: 'asc' };
let currentPage = 1;
let searchTerm = '';
let filterYear = '';
let filterMonth = '';
const PAGE_SIZE = 50;

// ── Column definitions ────────────────────────────────────────────

const COLUMNS = [
  { key: 'rowNum',    label: '#',             sortable: false },
  { key: 'name',      label: 'Transcript Name', sortable: true },
  { key: 'year',      label: 'Year',          sortable: true },
  { key: 'month',     label: 'Month',         sortable: true },
  { key: 'day',       label: 'Day',           sortable: true },
  { key: 'firstLine', label: 'First Line',    sortable: false },
  { key: 'linkedAudio', label: 'Linked Audio',  sortable: true },
];

// ── Row data ──────────────────────────────────────────────────────

/** Returns { transcriptId: [{ audioId, audioName }] } */
function buildMappedAudio() {
  const state = getState();
  const map = {};
  if (state.mappings) {
    for (const [audioId, mapping] of Object.entries(state.mappings)) {
      const tid = mapping.transcriptId;
      if (!tid) continue;
      if (!map[tid]) map[tid] = [];
      const audio = state.audio.find(a => a.id === audioId);
      map[tid].push({ audioId, audioName: audio?.name || audioId });
    }
  }
  return map;
}

function getRowData(transcript, mappedAudio) {
  const linked = mappedAudio[transcript.id] || [];
  return {
    id: transcript.id,
    name: transcript.name || '',
    year: transcript.year || '',
    month: transcript.month || '',
    day: transcript.day != null ? transcript.day : '',
    firstLine: transcript.firstLine ? truncateWords(transcript.firstLine, 15) : '',
    linkedAudio: linked,
    mappedCount: linked.length,
    driveLink: transcript.driveLink,
    r2TranscriptLink: transcript.r2TranscriptLink,
  };
}

// ── Filtering & sorting ──────────────────────────────────────────

function getFilteredRows() {
  const state = getState();
  if (!state?.transcripts) return [];
  let rows = state.transcripts;

  if (filterYear) rows = rows.filter(t => t.year === filterYear);
  if (filterMonth) rows = rows.filter(t => t.month === filterMonth);
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    rows = rows.filter(t =>
      (t.name || '').toLowerCase().includes(term) ||
      (t.firstLine || '').toLowerCase().includes(term) ||
      (t.id || '').toLowerCase().includes(term)
    );
  }
  return rows;
}

function sortRows(rows, mappedAudio) {
  if (!currentSort.column) return rows;
  const col = currentSort.column;
  const dir = currentSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let va, vb;
    if (col === 'linkedAudio') {
      va = (mappedAudio[a.id] || []).length;
      vb = (mappedAudio[b.id] || []).length;
    } else {
      va = a[col]; vb = b[col];
    }
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    va = String(va || '');
    vb = String(vb || '');
    return va.localeCompare(vb) * dir;
  });
}

// ── Build table DOM ──────────────────────────────────────────────

function buildTable(rows) {
  const table = document.createElement('table');
  table.className = 'data-table';

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(startIdx, startIdx + PAGE_SIZE);

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  COLUMNS.forEach(col => {
    const th = document.createElement('th');
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
          currentSort = { column: col.key, dir: 'asc' };
        }
        currentPage = 1;
        updateTranscriptTable();
      });
    }
    if (col.key === 'firstLine') th.classList.add('rtl-cell');
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  const mappedAudio = buildMappedAudio();

  pageRows.forEach((transcript, i) => {
    const row = getRowData(transcript, mappedAudio);
    const tr = document.createElement('tr');
    tr.className = 'table-row';
    tr.setAttribute('data-transcript-id', row.id);

    COLUMNS.forEach(col => {
      const td = document.createElement('td');

      switch (col.key) {
        case 'rowNum':
          td.textContent = startIdx + i + 1;
          break;
        case 'firstLine':
          td.className = 'cell-hebrew';
          td.dir = 'rtl';
          td.textContent = row.firstLine;
          break;
        case 'linkedAudio': {
          if (row.linkedAudio.length === 0) {
            const badge = document.createElement('span');
            badge.className = 'status-badge status-unmapped';
            badge.textContent = 'unmapped';
            td.appendChild(badge);
          } else {
            row.linkedAudio.forEach((link, idx) => {
              const a = document.createElement('a');
              a.href = `/detail.html?id=${encodeURIComponent(link.audioId)}`;
              a.target = '_blank';
              a.className = 'linked-audio-link';
              a.textContent = link.audioName;
              a.addEventListener('click', (e) => e.stopPropagation());
              td.appendChild(a);
              if (idx < row.linkedAudio.length - 1) {
                td.appendChild(document.createTextNode(', '));
              }
            });
          }
          break;
        }
        default:
          td.textContent = row[col.key] != null ? row[col.key] : '';
      }
      tr.appendChild(td);
    });

    // Row click → open first linked audio detail
    tr.addEventListener('click', () => {
      if (row.linkedAudio.length > 0) {
        window.open(`/detail.html?id=${encodeURIComponent(row.linkedAudio[0].audioId)}`, '_blank');
      }
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

// ── Pagination ───────────────────────────────────────────────────

function buildPagination(totalRows) {
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const nav = document.createElement('div');
  nav.className = 'pagination';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'pagination-btn';
  prevBtn.textContent = 'Prev';
  prevBtn.disabled = currentPage <= 1;
  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; updateTranscriptTable(); }
  });

  const pageInfo = document.createElement('span');
  pageInfo.className = 'pagination-info';
  pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'pagination-btn';
  nextBtn.textContent = 'Next';
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; updateTranscriptTable(); }
  });

  nav.appendChild(prevBtn);
  nav.appendChild(pageInfo);
  nav.appendChild(nextBtn);
  return nav;
}

// ── Count badge ──────────────────────────────────────────────────

function buildCountBar(totalRows) {
  const bar = document.createElement('div');
  bar.className = 'transcript-count-bar';
  bar.textContent = `${totalRows} transcript${totalRows !== 1 ? 's' : ''}`;
  return bar;
}

// ── Public API ───────────────────────────────────────────────────

function renderTranscriptTable(container) {
  _container = container;

  // Populate year/month dropdowns from transcript data
  const state = getState();
  const years = new Set();
  const months = new Set();
  (state.transcripts || []).forEach(t => {
    if (t.year) years.add(t.year);
    if (t.month) months.add(t.month);
  });

  const yearSelect = document.getElementById('filter-year');
  const monthSelect = document.getElementById('filter-month');

  // Repopulate dropdowns with transcript values
  if (yearSelect) {
    const current = yearSelect.value;
    yearSelect.innerHTML = '<option value="">All Years</option>';
    [...years].sort().forEach(y => {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      yearSelect.appendChild(opt);
    });
    yearSelect.value = current;
  }
  if (monthSelect) {
    const current = monthSelect.value;
    monthSelect.innerHTML = '<option value="">All Months</option>';
    const monthOrder = ['Tishrei','Cheshvan','Kislev','Teves','Shvat','Adar','Adar I','Adar II','Nissan','Iyar','Sivan','Tammuz','Tamuz','Av','Elul'];
    [...months].sort((a, b) => monthOrder.indexOf(a) - monthOrder.indexOf(b)).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      monthSelect.appendChild(opt);
    });
    monthSelect.value = current;
  }

  updateTranscriptTable();
}

function updateTranscriptTable() {
  if (!_container) return;

  const filtered = getFilteredRows();
  const mappedAudio = buildMappedAudio();
  const sorted = sortRows(filtered, mappedAudio);

  // Update result count in filter bar
  const totalTranscripts = getState()?.transcripts?.length || 0;
  const countEl = document.getElementById('filter-count');
  if (countEl) {
    countEl.textContent = sorted.length === totalTranscripts
      ? `${sorted.length} transcripts`
      : `${sorted.length} of ${totalTranscripts} transcripts`;
  }

  _container.innerHTML = '';
  _container.appendChild(buildTable(sorted));
  _container.appendChild(buildPagination(sorted.length));
}

function setTranscriptFilters({ search, year, month } = {}) {
  if (search !== undefined) searchTerm = search;
  if (year !== undefined) filterYear = year;
  if (month !== undefined) filterMonth = month;
  currentPage = 1;
}

export { renderTranscriptTable, updateTranscriptTable, setTranscriptFilters };
