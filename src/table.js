import { getState, getFilteredRows, getFilterCounts, getStatus, getCompletedStages, PIPELINE_STAGES, updateState } from './state.js';
import { truncateWords, formatConfidence, debounce, HEBREW_MONTHS } from './utils.js';
import { linkMatch, unlinkMatch, getSuggestedMatches } from './mapping.js';
import { isLibraryR2Url } from './auth.js';
import { syncAudioField } from './db.js';
import { batchClean, cleanSafe } from './cleaning.js';

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
let favoritesFilter = ''; // '' = all, 'yes' = favorites only
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
  if (favoritesFilter) params.set('fav', favoritesFilter);
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
// Column order tuned so the most-used cells (Open, Comments, First 15 words,
// Status) are visible without horizontal scroll. Additional columns can be
// hidden via the column-visibility menu (filter bar → "Columns").
//
// `defaultHidden: true` columns start hidden but can be re-enabled.
const COLUMNS = [
  { key: 'checkbox',      label: '',                  sortable: false, showWhen: () => true,  optional: false },
  { key: 'rowNum',        label: '#',                 sortable: false, showWhen: () => true,  optional: false },
  { key: 'favorite',      label: '\u2605',            sortable: false, showWhen: () => true,  optional: true },
  { key: 'actions',       label: 'Actions',           sortable: false, showWhen: () => true,  optional: false, sticky: true },
  { key: 'name',          label: 'Audio Name',        sortable: true,  showWhen: () => true,  optional: false },
  { key: 'status',        label: 'Status',            sortable: true,  showWhen: () => true,  optional: true },
  { key: 'comments',      label: 'Comments',          sortable: false, showWhen: () => true,  optional: true },
  { key: 'firstLine',     label: 'First 15 Words',    sortable: false, showWhen: () => true,  optional: true },
  { key: 'estMinutes',    label: 'Duration',          sortable: true,  showWhen: () => true,  optional: true },
  { key: 'exported',      label: 'Exported',          sortable: true,  showWhen: () => true,  optional: true },
  { key: 'transcript',    label: 'Transcript Name',   sortable: true,  showWhen: () => true,  optional: true },
  { key: 'id',            label: 'ID',                sortable: true,  showWhen: () => true,  optional: true, defaultHidden: true },
  { key: 'year',          label: 'Year',              sortable: true,  showWhen: () => true,  optional: true },
  { key: 'month',         label: 'Month',             sortable: true,  showWhen: () => true,  optional: true, defaultHidden: true },
  { key: 'day',           label: 'Day',               sortable: true,  showWhen: () => true,  optional: true, defaultHidden: true },
  { key: 'type',          label: 'Type',              sortable: true,  showWhen: () => true,  optional: true },
  { key: 'sichaNum',      label: 'No.',               sortable: true,  showWhen: () => true,  optional: true, defaultHidden: true },
];

// ── Column visibility (persisted in localStorage) ──────────────────
const COL_VIS_KEY = 'jem-asr-col-visibility-v1';
function loadColVisibility() {
  try {
    const raw = localStorage.getItem(COL_VIS_KEY);
    if (!raw) {
      // First visit — apply defaults from column defs
      const def = {};
      for (const c of COLUMNS) if (c.optional) def[c.key] = c.defaultHidden ? false : true;
      return def;
    }
    return JSON.parse(raw);
  } catch { return {}; }
}
function saveColVisibility(vis) {
  try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(vis)); } catch {}
}
let _colVisibility = loadColVisibility();
function isColVisible(c) {
  if (!c.optional) return true;
  if (Object.prototype.hasOwnProperty.call(_colVisibility, c.key)) return !!_colVisibility[c.key];
  return !c.defaultHidden;
}
function setColVisibility(key, v) {
  _colVisibility[key] = !!v;
  saveColVisibility(_colVisibility);
}

function mountColVisibilityMenu() {
  if (document.getElementById('btn-col-vis')) return; // already mounted
  const resetBtn = document.getElementById('btn-reset-filters');
  if (!resetBtn || !resetBtn.parentElement) return;

  const wrap = document.createElement('span');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';

  const btn = document.createElement('button');
  btn.id = 'btn-col-vis';
  btn.type = 'button';
  btn.className = 'col-vis-btn';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg><span>Columns</span>';

  const pop = document.createElement('div');
  pop.className = 'col-vis-pop';
  pop.setAttribute('role', 'menu');

  function rebuild() {
    pop.innerHTML = '';
    for (const c of COLUMNS) {
      if (!c.optional) continue;
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isColVisible(c);
      cb.addEventListener('change', () => {
        setColVisibility(c.key, cb.checked);
        updateTable();
      });
      const span = document.createElement('span');
      span.textContent = c.label || c.key;
      lbl.appendChild(cb);
      lbl.appendChild(span);
      pop.appendChild(lbl);
    }
  }
  rebuild();

  function open() {
    rebuild();
    pop.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
  }
  function close() {
    pop.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
  }
  function onDocClick(e) { if (!wrap.contains(e.target)) close(); }
  btn.addEventListener('click', () => {
    if (pop.classList.contains('is-open')) close(); else open();
  });

  wrap.appendChild(btn);
  wrap.appendChild(pop);
  resetBtn.parentElement.insertBefore(wrap, resetBtn);
}

// ── Density toggle (compact / cozy / spacious) ─────────────────────
const DENSITY_KEY = 'jem-asr-density-v1';
const DENSITIES = [
  { key: 'compact',  label: 'Compact'  },
  { key: 'cozy',     label: 'Cozy'     },
  { key: 'spacious', label: 'Spacious' },
];
function loadDensity() {
  try { return localStorage.getItem(DENSITY_KEY) || 'cozy'; } catch { return 'cozy'; }
}
function saveDensity(v) {
  try { localStorage.setItem(DENSITY_KEY, v); } catch {}
}
function applyDensity(v) {
  document.body.classList.remove('density-compact', 'density-cozy', 'density-spacious');
  document.body.classList.add('density-' + (v || 'cozy'));
}

function mountDensityMenu() {
  if (document.getElementById('btn-density')) return;
  const resetBtn = document.getElementById('btn-reset-filters');
  if (!resetBtn || !resetBtn.parentElement) return;

  const wrap = document.createElement('span');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';

  const btn = document.createElement('button');
  btn.id = 'btn-density';
  btn.type = 'button';
  btn.className = 'col-vis-btn';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  const current = loadDensity();
  applyDensity(current);
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg><span>Density</span>';

  const pop = document.createElement('div');
  pop.className = 'col-vis-pop';
  pop.setAttribute('role', 'menu');

  function rebuild() {
    pop.innerHTML = '';
    const cur = loadDensity();
    for (const d of DENSITIES) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'radio';
      cb.name = 'density-radio';
      cb.checked = cur === d.key;
      cb.addEventListener('change', () => {
        if (cb.checked) {
          saveDensity(d.key);
          applyDensity(d.key);
        }
      });
      const span = document.createElement('span');
      span.textContent = d.label;
      lbl.appendChild(cb);
      lbl.appendChild(span);
      pop.appendChild(lbl);
    }
  }
  rebuild();

  function open()  { rebuild(); pop.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true'); setTimeout(() => document.addEventListener('click', onDoc), 0); }
  function close() { pop.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', onDoc); }
  function onDoc(e) { if (!wrap.contains(e.target)) close(); }
  btn.addEventListener('click', () => pop.classList.contains('is-open') ? close() : open());

  wrap.appendChild(btn);
  wrap.appendChild(pop);
  resetBtn.parentElement.insertBefore(wrap, resetBtn);
}

// ── Saved views (pinned pills above the filter bar) ───────────────
// A "view" is a snapshot of the filter state: status, confidence, fifty,
// favorites, year, month, type, search. Click to apply. Built-in views
// cover the most common annotation flows; the user can save the current
// state as a custom view, persisted to localStorage.

const VIEW_KEY = 'jem-asr-saved-views-v1';
const ACTIVE_VIEW_KEY = 'jem-asr-active-view-v1';

const BUILTIN_VIEWS = [
  { id: '_all',          label: 'All',           builtin: true,
    state: { status: [], confidence: '', fifty: '', favorites: '', year: '', month: '', type: '', search: '' } },
  { id: '_unmapped',     label: 'Unmapped',      builtin: true,
    state: { status: ['unmapped'], confidence: '', fifty: '', favorites: '', year: '', month: '', type: '', search: '' } },
  { id: '_needs-clean',  label: 'Needs cleaning',builtin: true,
    state: { status: ['mapped'], confidence: '', fifty: '', favorites: '', year: '', month: '', type: '', search: '' } },
  { id: '_needs-align',  label: 'Needs alignment', builtin: true,
    state: { status: ['cleaned'], confidence: '', fifty: '', favorites: '', year: '', month: '', type: '', search: '' } },
  { id: '_approved',     label: 'Approved',      builtin: true,
    state: { status: ['approved'], confidence: '', fifty: '', favorites: '', year: '', month: '', type: '', search: '' } },
  { id: '_rejected',     label: 'Rejected',      builtin: true,
    state: { status: ['rejected'], confidence: '', fifty: '', favorites: '', year: '', month: '', type: '', search: '' } },
  { id: '_favorites',    label: 'Favorites',     builtin: true,
    state: { status: [], confidence: '', fifty: '', favorites: 'yes', year: '', month: '', type: '', search: '' } },
];

function loadUserViews() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveUserViews(views) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(views)); } catch {}
}
function getActiveViewId() {
  try { return localStorage.getItem(ACTIVE_VIEW_KEY) || ''; } catch { return ''; }
}
function setActiveViewId(id) {
  try { id ? localStorage.setItem(ACTIVE_VIEW_KEY, id) : localStorage.removeItem(ACTIVE_VIEW_KEY); } catch {}
}

function snapshotCurrentState() {
  return {
    status: [...statusFilter],
    confidence: filterConfidence,
    fifty: fiftyFilter,
    favorites: favoritesFilter,
    year: filterYear,
    month: filterMonth,
    type: filterType,
    search: searchTerm,
  };
}
function statesEqual(a, b) {
  if (!a || !b) return false;
  const sa = [...(a.status || [])].sort().join(',');
  const sb = [...(b.status || [])].sort().join(',');
  return sa === sb && a.confidence === b.confidence &&
    a.fifty === b.fifty && a.favorites === b.favorites &&
    a.year === b.year && a.month === b.month &&
    a.type === b.type && (a.search || '') === (b.search || '');
}
function applyView(view) {
  if (!view) return;
  const s = view.state || {};
  statusFilter = [...(s.status || [])];
  filterConfidence = s.confidence || '';
  fiftyFilter = s.fifty || '';
  favoritesFilter = s.favorites || '';
  filterYear = s.year || '';
  filterMonth = s.month || '';
  filterType = s.type || '';
  searchTerm = s.search || '';
  currentPage = 1;
  selectedIds.clear();

  // Sync UI controls
  const statusContainer = document.getElementById('filter-status');
  if (statusContainer) {
    const checks = statusContainer.querySelectorAll('input[type="checkbox"]');
    checks.forEach(cb => { cb.checked = statusFilter.includes(cb.value); });
    const btn = statusContainer.querySelector('.multi-select-btn');
    if (btn) updateMultiSelectLabel(btn, statusFilter, 'All Statuses');
  }
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('filter-confidence', filterConfidence);
  set('filter-fifty', fiftyFilter);
  set('filter-favorites', favoritesFilter);
  set('filter-year', filterYear);
  set('filter-month', filterMonth);
  set('filter-type', filterType);
  const search = document.getElementById('search-input');
  if (search) search.value = searchTerm;

  setActiveViewId(view.id);
  updateURL();
  updateTable();
  renderSavedViewsBar();
}

function findMatchingView() {
  const cur = snapshotCurrentState();
  const all = [...BUILTIN_VIEWS, ...loadUserViews()];
  return all.find(v => statesEqual(v.state, cur));
}

let _viewsBar = null;
function ensureSavedViewsBar() {
  if (_viewsBar && document.body.contains(_viewsBar)) return;
  // Insert before the #btn-filter-toggle (or filter-bar if missing)
  const anchor = document.getElementById('btn-filter-toggle')
              || document.getElementById('filter-bar');
  if (!anchor || !anchor.parentElement) return;
  _viewsBar = document.createElement('div');
  _viewsBar.className = 'saved-views';
  anchor.parentElement.insertBefore(_viewsBar, anchor);
}

function renderSavedViewsBar() {
  ensureSavedViewsBar();
  if (!_viewsBar) return;
  _viewsBar.innerHTML = '';

  const all = [...BUILTIN_VIEWS, ...loadUserViews()];
  const matched = findMatchingView();
  const activeId = matched ? matched.id : '';
  setActiveViewId(activeId);

  for (const v of all) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'saved-view-pill' + (v.id === activeId ? ' is-active' : '');
    pill.textContent = v.label;
    pill.title = v.builtin ? 'Built-in view' : 'Custom view (right-click to delete)';
    pill.addEventListener('click', () => applyView(v));
    if (!v.builtin) {
      pill.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (confirm(`Delete saved view "${v.label}"?`)) {
          const remaining = loadUserViews().filter(u => u.id !== v.id);
          saveUserViews(remaining);
          renderSavedViewsBar();
        }
      });
      const x = document.createElement('span');
      x.className = 'saved-view-pill__x';
      x.textContent = '×';
      x.title = 'Delete view';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete saved view "${v.label}"?`)) {
          const remaining = loadUserViews().filter(u => u.id !== v.id);
          saveUserViews(remaining);
          renderSavedViewsBar();
        }
      });
      pill.appendChild(x);
    }
    _viewsBar.appendChild(pill);
  }

  // "+ Save current view" button — appears only when current state
  // doesn't already match a known view.
  if (!matched) {
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'saved-view-pill saved-view-pill--save';
    save.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Save view</span>';
    save.addEventListener('click', () => {
      const name = prompt('Name this view (e.g. "Needs review · 2024"):');
      if (!name || !name.trim()) return;
      const id = 'u_' + Date.now().toString(36);
      const view = { id, label: name.trim(), builtin: false, state: snapshotCurrentState() };
      const list = loadUserViews();
      list.push(view);
      saveUserViews(list);
      setActiveViewId(id);
      renderSavedViewsBar();
    });
    _viewsBar.appendChild(save);
  }
}

// ── Active filter chips strip ──────────────────────────────────────
// Renders a row of small chips just above the data table summarising
// every active filter. Each chip has an × to remove just that filter.
// Visible only when at least one filter is active.
let _filterChipsEl = null;
function ensureFilterChipsHost() {
  if (_filterChipsEl && document.body.contains(_filterChipsEl)) return;
  const anchor = _container;
  if (!anchor || !anchor.parentElement) return;
  _filterChipsEl = document.createElement('div');
  _filterChipsEl.className = 'filter-chips';
  anchor.parentElement.insertBefore(_filterChipsEl, anchor);
}
function clearStatus()      { statusFilter = []; }
function clearConfidence()  { filterConfidence = ''; }
function clearFifty()       { fiftyFilter = ''; }
function clearFavorites()   { favoritesFilter = ''; }
function clearYear()        { filterYear = ''; }
function clearMonth()       { filterMonth = ''; }
function clearType()        { filterType = ''; }
function clearSearch()      { searchTerm = ''; }
function syncControlsAndUpdate() {
  // Reuse applyView's UI sync by snapshotting current state.
  applyView({ id: '_internal', label: '', state: snapshotCurrentState() });
}
function renderFilterChips() {
  ensureFilterChipsHost();
  if (!_filterChipsEl) return;
  _filterChipsEl.innerHTML = '';

  const chips = [];
  for (const s of statusFilter) {
    chips.push({ label: 'Status: ' + s.charAt(0).toUpperCase() + s.slice(1),
      onClear: () => { statusFilter = statusFilter.filter(v => v !== s); syncControlsAndUpdate(); } });
  }
  if (filterConfidence) chips.push({ label: 'Confidence: ' + filterConfidence, onClear: () => { clearConfidence(); syncControlsAndUpdate(); } });
  if (fiftyFilter)      chips.push({ label: '50hr: ' + fiftyFilter,            onClear: () => { clearFifty();      syncControlsAndUpdate(); } });
  if (favoritesFilter)  chips.push({ label: 'Favorites only',                  onClear: () => { clearFavorites();  syncControlsAndUpdate(); } });
  if (filterYear)       chips.push({ label: 'Year: ' + filterYear,             onClear: () => { clearYear();       syncControlsAndUpdate(); } });
  if (filterMonth)      chips.push({ label: 'Month: ' + filterMonth,           onClear: () => { clearMonth();      syncControlsAndUpdate(); } });
  if (filterType)       chips.push({ label: 'Type: ' + filterType,             onClear: () => { clearType();       syncControlsAndUpdate(); } });
  if (searchTerm)       chips.push({ label: '"' + searchTerm + '"',            onClear: () => { clearSearch();     syncControlsAndUpdate(); } });

  if (chips.length === 0) {
    _filterChipsEl.style.display = 'none';
    return;
  }
  _filterChipsEl.style.display = '';

  const lead = document.createElement('span');
  lead.className = 'filter-chips__lead';
  lead.textContent = 'Filters:';
  _filterChipsEl.appendChild(lead);

  for (const c of chips) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    const txt = document.createElement('span');
    txt.textContent = c.label;
    chip.appendChild(txt);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'filter-chip__x';
    x.setAttribute('aria-label', 'Remove filter ' + c.label);
    x.textContent = '×';
    x.addEventListener('click', c.onClear);
    chip.appendChild(x);
    _filterChipsEl.appendChild(chip);
  }
  if (chips.length > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'filter-chip filter-chip--clear-all';
    all.textContent = 'Clear all';
    all.addEventListener('click', () => document.getElementById('btn-reset-filters')?.click());
    _filterChipsEl.appendChild(all);
  }
}

// ── Faceted counts: compute audios per status (ignoring the status
// filter itself) so checkbox labels can show "Mapped (247)". Considers
// active 50hr / fav / search / year / month / type filters so counts
// reflect what the user would actually see if they picked the status. */
function computeStatusFacets() {
  try {
    const state = getState();
    const all = state.audio || [];
    const counts = { unmapped: 0, mapped: 0, cleaned: 0, aligned: 0, approved: 0, rejected: 0, benchmark: 0 };

    // Apply same filters as updateTable EXCEPT statusFilter
    let pool = all;
    if (fiftyFilter === 'yes') pool = pool.filter(a => a.fifty === true);
    else if (fiftyFilter === 'no') pool = pool.filter(a => a.fifty !== true);
    if (favoritesFilter === 'yes') {
      const favs = state.favorites || {};
      pool = pool.filter(a => !!favs[a.id]);
    }
    if (filterYear) pool = pool.filter(a => String(a.year || '') === String(filterYear));
    if (filterMonth) pool = pool.filter(a => String(a.month || '') === String(filterMonth));
    if (filterType) pool = pool.filter(a => (a.type || '') === filterType);

    for (const a of pool) {
      const s = getStatus(a.id);
      if (s && counts[s] !== undefined) counts[s]++;
      // Special case: an audio can be both mapped + benchmark, etc.
      // For now the primary status from getStatus is canonical.
    }
    return counts;
  } catch (_) {
    return null;
  }
}

function applyFacetCountsToStatusFilter(counts) {
  if (!counts) return;
  const container = document.getElementById('filter-status');
  if (!container) return;
  const labels = container.querySelectorAll('.multi-select-dropdown label');
  labels.forEach(lbl => {
    const cb = lbl.querySelector('input[type="checkbox"]');
    if (!cb) return;
    const key = cb.value;
    const n = counts[key];
    // Cache base label
    if (!lbl.dataset.baseLabel) {
      const txt = lbl.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
      lbl.dataset.baseLabel = txt;
    }
    const base = lbl.dataset.baseLabel;
    // Rebuild label content keeping the checkbox
    lbl.innerHTML = '';
    lbl.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = ` ${base}`;
    lbl.appendChild(span);
    if (typeof n === 'number') {
      const cnt = document.createElement('span');
      cnt.className = 'facet-count';
      cnt.textContent = n;
      lbl.appendChild(cnt);
    }
  });
}

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
  return COLUMNS.filter(c => c.showWhen(buildFilter()) && isColVisible(c));
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

  // Compute effective duration honoring trim_start / trim_end (both stored in seconds).
  // If trimmed, the displayed duration is trim_end-trim_start (or remaining-after-start).
  const trim = state.trims?.[id] || null;
  const totalSec = (audio.estMinutes || 0) * 60;
  let effectiveSec = totalSec;
  let isTrimmed = false;
  if (trim && (trim.start || trim.end)) {
    const start = trim.start || 0;
    const end = trim.end && trim.end > 0 ? trim.end : totalSec;
    if (end > start) {
      effectiveSec = end - start;
      isTrimmed = effectiveSec !== totalSec;
    }
  }
  const effectiveMin = effectiveSec / 60;
  const durationText = audio.estMinutes != null
    ? (isTrimmed
        ? `${effectiveMin.toFixed(1)} min ✂`
        : `${(audio.estMinutes).toFixed ? audio.estMinutes.toFixed(1) : audio.estMinutes} min`)
    : '';
  const durationTitle = isTrimmed
    ? `Trimmed ${effectiveMin.toFixed(1)} min · original ${audio.estMinutes} min`
    : '';

  return {
    id,
    name: (state.audioNames && state.audioNames[id]) || audio.name || '',
    year: (state.audioYears && state.audioYears[id]) || audio.year || '',
    month: (state.audioMonths && state.audioMonths[id]) || audio.month || '',
    day: (state.audioDays && state.audioDays[id]) || audio.day || '',
    type: (state.audioTypes && state.audioTypes[id]) || audio.type || '',
    sichaNum: parseSichaNum(audio.name) || '',
    estMinutes: durationText,
    estMinutesNumeric: effectiveMin,
    estMinutesTitle: durationTitle,
    isTrimmed,
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
    trainingExportedAt: audio.trainingExportedAt || null,
    trainingExportedBy: audio.trainingExportedBy || null,
  };
}

function matchesSearch(row) {
  if (filterYear && row.year !== filterYear) return false;
  if (filterMonth && row.month !== filterMonth) return false;
  if (filterType && row.type !== filterType) return false;
  if (!searchTerm) return true;
  const term = searchTerm.toLowerCase();
  return (
    String(row.id).toLowerCase().includes(term) ||
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
    // Special-case numeric-trimmed duration so we sort by minutes, not by
    // the formatted text (which has a non-numeric scissors emoji).
    if (key === 'estMinutes') {
      const av = a.estMinutesNumeric ?? -1;
      const bv = b.estMinutesNumeric ?? -1;
      return (av - bv) * dir;
    }
    if (key === 'exported') {
      const av = a.trainingExportedAt ? new Date(a.trainingExportedAt).getTime() : 0;
      const bv = b.trainingExportedAt ? new Date(b.trainingExportedAt).getTime() : 0;
      return (av - bv) * dir;
    }
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
    badge.title = 'No transcript linked yet — open the file and link / paste / generate one.';
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

    const STAGE_TIPS = {
      mapped:   'Mapped — transcript text is linked to this audio (manual paste, ASR, or matched)',
      cleaned:  'Cleaned — transcript was edited / cleaned (brackets, parentheses, intro/outro, whitespace removed)',
      aligned:  'Aligned — words have timestamps from a forced-alignment run',
      approved: 'Approved — reviewed and ready for training export',
    };
    if (isRejected) {
      dot.className = 'pipeline-stage done-rejected';
      dot.textContent = '✗';
      dot.title = 'Rejected — review marked this transcript as not usable';
    } else if (isDone) {
      dot.className = `pipeline-stage done-${name}`;
      dot.textContent = '✓';
      dot.title = STAGE_TIPS[name] || name;
    } else {
      dot.className = 'pipeline-stage pending';
      dot.textContent = '○';
      dot.title = (STAGE_TIPS[name] ? 'Pending: ' + STAGE_TIPS[name] : 'Pending: ' + name);
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
    th.classList.add('cell-' + col.key);
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
      if (col.key === 'favorite') th.classList.add('cell-favorite');
      if (col.key === 'id') th.classList.add('cell-id');
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
      // Stable per-cell class so refresh.css can sticky / style by column
      td.classList.add('cell-' + col.key);

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
        case 'favorite': {
          td.classList.add('cell-favorite');
          const favBtn = document.createElement('button');
          const isFav = !!(getState().favorites && getState().favorites[row.id]);
          favBtn.className = 'fav-toggle-btn' + (isFav ? ' fav-active' : '');
          favBtn.textContent = isFav ? '\u2605' : '\u2606';
          favBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
          favBtn.setAttribute('aria-label', favBtn.title);
          favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const nowFav = !isFav;
            updateState('favorites', row.id, nowFav ? true : null);
            updateTable();
          });
          td.appendChild(favBtn);
          break;
        }
        case 'id':
          td.classList.add('cell-id');
          td.textContent = row.id;
          td.title = 'Audio ID — use the search box to find by ID';
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
        case 'exported': {
          if (row.trainingExportedAt) {
            const badge = document.createElement('span');
            badge.className = 'status-badge status-exported';
            const d = new Date(row.trainingExportedAt);
            badge.textContent = d.toLocaleDateString();
            badge.title = `Exported for training on ${d.toLocaleString()}`
              + (row.trainingExportedBy ? ` by ${row.trainingExportedBy}` : '');
            td.appendChild(badge);
          } else {
            const dash = document.createElement('span');
            dash.style.color = 'var(--text-muted)';
            dash.textContent = '—';
            td.appendChild(dash);
          }
          break;
        }
        case 'estMinutes': {
          td.textContent = row.estMinutes || '';
          if (row.estMinutesTitle) td.title = row.estMinutesTitle;
          if (row.isTrimmed) td.style.fontVariantNumeric = 'tabular-nums';
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
  attachRowContextMenu(tbody);
  return table;
}

// ── Row context menu (right-click) ────────────────────────────────
let _ctxMenuEl = null;
function closeCtxMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
  document.removeEventListener('click', closeCtxMenu);
  document.removeEventListener('keydown', _ctxKeyClose);
  window.removeEventListener('blur', closeCtxMenu);
  window.removeEventListener('scroll', closeCtxMenu, true);
}
function _ctxKeyClose(e) { if (e.key === 'Escape') closeCtxMenu(); }
function openCtxMenu(x, y, items) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.divider) {
      const d = document.createElement('div');
      d.className = 'ctx-menu__divider';
      menu.appendChild(d);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-menu__item';
    btn.textContent = it.label;
    if (it.shortcut) {
      const k = document.createElement('kbd');
      k.textContent = it.shortcut;
      btn.appendChild(k);
    }
    btn.addEventListener('click', () => {
      try { it.onClick && it.onClick(); } finally { closeCtxMenu(); }
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  // Position with viewport clamping
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, vw - rect.width - 8);
  const py = Math.min(y, vh - rect.height - 8);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top  = `${Math.max(8, py)}px`;
  _ctxMenuEl = menu;
  setTimeout(() => {
    document.addEventListener('click', closeCtxMenu);
    document.addEventListener('keydown', _ctxKeyClose);
    window.addEventListener('blur', closeCtxMenu);
    window.addEventListener('scroll', closeCtxMenu, true);
  }, 0);
}

function attachRowContextMenu(tbody) {
  tbody.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest && e.target.closest('tr.table-row');
    if (!tr) return;
    const id = tr.getAttribute('data-audio-id');
    if (!id) return;
    e.preventDefault();
    const state = getState();
    const isFav = !!(state.favorites && state.favorites[id]);
    const items = [
      { label: 'Open',                onClick: () => { window.location.href = `/detail.html?id=${encodeURIComponent(id)}`; } },
      { label: 'Open in new tab',     shortcut: '↵',
        onClick: () => { window.open(`/detail.html?id=${encodeURIComponent(id)}`, '_blank', 'noopener'); } },
      { divider: true },
      { label: isFav ? 'Remove from favorites' : 'Add to favorites',
        onClick: () => {
          const favs = { ...(state.favorites || {}) };
          if (isFav) delete favs[id]; else favs[id] = true;
          updateState('favorites', null, favs);
          updateTable();
          if (window.__jemToast) window.__jemToast[isFav ? 'info' : 'success'](isFav ? 'Removed from favorites' : 'Added to favorites');
        } },
      { divider: true },
      { label: 'Copy ID',
        onClick: () => {
          (navigator.clipboard?.writeText(id) || Promise.reject()).then(
            () => window.__jemToast?.success(`Copied ${id}`),
            () => window.__jemToast?.error('Copy failed')
          );
        } },
      { label: 'Copy file name',
        onClick: () => {
          const audio = state.audio.find(a => a.id === id);
          const name = audio?.name || id;
          (navigator.clipboard?.writeText(name) || Promise.reject()).then(
            () => window.__jemToast?.success(`Copied "${name}"`),
            () => window.__jemToast?.error('Copy failed')
          );
        } },
    ];
    openCtxMenu(e.clientX, e.clientY, items);
  });
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

  // Bulk clean (safe passes only — no brackets/parentheses)
  const cleanBtn = document.createElement('button');
  cleanBtn.className = 'action-btn action-btn-primary';
  cleanBtn.textContent = 'Clean';
  cleanBtn.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (!confirm(`Clean ${ids.length} file(s)? Removes section markers, symbols, whitespace, and intro text. No brackets/parentheses.`)) return;
    cleanBtn.textContent = 'Cleaning...';
    cleanBtn.disabled = true;
    await batchClean(ids, getState(), (current, total) => {
      cleanBtn.textContent = `Cleaning ${current}/${total}...`;
    }, cleanSafe);
    cleanBtn.textContent = 'Clean';
    cleanBtn.disabled = false;
    selectedIds.clear();
    updateTable();
  });
  bar.appendChild(cleanBtn);

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
  if (initParams.has('fav')) favoritesFilter = initParams.get('fav') || '';
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

  // Wire favorites filter
  const favSelect = document.getElementById('filter-favorites');
  if (favSelect) {
    favSelect.value = favoritesFilter;
    favSelect.addEventListener('change', () => {
      favoritesFilter = favSelect.value;
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
      favoritesFilter = '';
      statusFilter = [];
      filterYear = '';
      filterMonth = '';
      filterType = '';
      filterConfidence = '';
      searchTerm = '';
      currentPage = 1;
      selectedIds.clear();
      if (fiftySelect) fiftySelect.value = '';
      if (favSelect) favSelect.value = '';
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

  // ── Column visibility menu ──────────────────────────────────────
  // Lives inline next to "Reset"; clicking it pops a checkbox list of
  // optional columns. Selections persist in localStorage.
  mountColVisibilityMenu();
  mountDensityMenu();
  renderSavedViewsBar();

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

  // Apply favorites filter
  if (favoritesFilter === 'yes') {
    const favs = getState().favorites || {};
    filteredAudio = filteredAudio.filter(a => !!favs[a.id]);
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

  // Empty state — when no rows after filters, show a friendly panel
  // instead of an empty table.
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <span class="empty-state__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" width="22" height="22"
             aria-hidden="true">
          <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
        </svg>
      </span>
      <div class="empty-state__title">No files match your filters</div>
      <div class="empty-state__detail">Try clearing one of the active filters
        or use the Search box at the top of the page.</div>`;
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'action-btn action-btn-primary';
    reset.style.marginTop = '12px';
    reset.textContent = 'Reset filters';
    reset.addEventListener('click', () => {
      document.getElementById('btn-reset-filters')?.click();
    });
    empty.appendChild(reset);
    _container.appendChild(empty);
    // Apply faceted counts even when empty (so user can see other options
    // would have results).
    applyFacetCountsToStatusFilter(computeStatusFacets());
    renderSavedViewsBar();
    renderFilterChips();
    return;
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

  // Update faceted counts on the Status multi-select labels
  applyFacetCountsToStatusFilter(computeStatusFacets());
  // Refresh which saved view (if any) matches the current state
  renderSavedViewsBar();
  // Active filter chips above the table
  renderFilterChips();
}

export { renderTable, updateTable, getSelectedRows };
