import './app-shell.js';
import { setContextualSections } from './app-shell.js';
import { registerSource } from './command-palette.js';
import { initState, getState, getStatus, mergeSupabaseData } from './state.js';
import { checkAuth, signOut, getUserLibraries, getActiveLibrary, setActiveLibrary } from './auth.js';
import { loadFromSupabase } from './db.js';
import { renderTable, updateTable } from './table.js';
import { renderTranscriptTable, updateTranscriptTable, setTranscriptFilters } from './transcript-table.js';
import { renderGlobalTranscriptSearch } from './mapping.js';


import { buildAsrConfigPanel } from './asr-config.js';
import { exportCSV } from './utils.js';

// ── App init ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  if (!await checkAuth()) return;

  document.getElementById('btn-logout')?.addEventListener('click', signOut);

  // Load library memberships and wire the selector
  const libraries = await getUserLibraries();
  if (libraries.length === 0) {
    document.getElementById('table-container').innerHTML =
      '<div style="padding:2rem;text-align:center;color:#f87171;">You have no library access. Contact an administrator.</div>';
    return;
  }

  const activeLib = getActiveLibrary();
  const activeLibConfig = libraries.find(l => l.id === activeLib) || libraries[0];
  document.getElementById('app-title').textContent = `${activeLibConfig.name} ASR Workbench`;
  document.title = `${activeLibConfig.name} ASR Workbench`;

  // Show Admin link if user has admin role in any library
  if (libraries.some(l => l.role === 'admin')) {
    const adminBtn = document.getElementById('btn-admin');
    if (adminBtn) adminBtn.style.display = '';
  }

  const libSelector = document.getElementById('library-selector');
  if (libraries.length > 1) {
    for (const lib of libraries) {
      const opt = document.createElement('option');
      opt.value = lib.id;
      opt.textContent = lib.name;
      if (lib.id === activeLib) opt.selected = true;
      libSelector.appendChild(opt);
    }
    libSelector.style.display = '';
    libSelector.addEventListener('change', () => {
      const newLib = libraries.find(l => l.id === libSelector.value)?.name || libSelector.value;
      if (!confirm(`Switch to "${newLib}"? Any unsaved offline work in the current library will not be migrated.`)) {
        // Revert selector to current active library
        libSelector.value = activeLib;
        return;
      }
      setActiveLibrary(libSelector.value);
      location.reload();
    });
  }

  const tableContainer = document.getElementById('table-container');
  tableContainer.innerHTML = '<div class="loading-state">Loading…</div>';

  // Supabase is the single source of truth — no data.json needed
  const remote = await loadFromSupabase(activeLib);
  if (!remote?.audio?.length) {
    tableContainer.innerHTML = '<div style="padding:2rem;text-align:center;color:#f87171;">Failed to load data from Supabase. Please refresh.</div>';
    return;
  }

  const state = initState({ audio: remote.audio, transcripts: remote.transcripts });
  mergeSupabaseData(remote);

  // If no 50hr files in this library, default filter to 'all'
  const has50hr = remote.audio.some(a => a.isSelected50hr);

  const modalOverlay = document.getElementById('modal-overlay');
  const modalContent = document.getElementById('modal-content');
  const modalClose = document.getElementById('modal-close');

  // ── Modal helpers ───────────────────────────────────────────────

  function openModal() {
    modalOverlay.hidden = false;
  }

  function closeModal() {
    modalOverlay.hidden = true;
    modalContent.innerHTML = '';
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // ── Render table ────────────────────────────────────────────────

  renderTable(tableContainer, {
    filter: 'unmapped',
  });

  // ── Tab switching (Audio / Transcripts) ─────────────────────────

  let activeTab = 'audio';
  const tabBtns = document.querySelectorAll('#tab-bar .tab-btn');
  const audioOnlyEls = document.querySelectorAll('[data-tab="audio"]:not(.tab-btn)');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab === activeTab) return;
      activeTab = tab;
      tabBtns.forEach(b => b.classList.toggle('active', b === btn));

      // Show/hide audio-only filter controls
      audioOnlyEls.forEach(el => el.style.display = tab === 'audio' ? '' : 'none');

      // Clear and re-render
      tableContainer.innerHTML = '';
      if (tab === 'audio') {
        renderTable(tableContainer, { filter: 'unmapped' });
      } else {
        renderTranscriptTable(tableContainer);
      }
    });
  });

  // Wire shared filter controls to active tab
  const yearSelect = document.getElementById('filter-year');
  const monthSelect = document.getElementById('filter-month');
  const searchInput = document.getElementById('search-input');

  function onSharedFilterChange() {
    if (activeTab === 'transcripts') {
      setTranscriptFilters({
        year: yearSelect?.value || '',
        month: monthSelect?.value || '',
        search: searchInput?.value || '',
      });
      updateTranscriptTable();
    }
    // Audio table handles its own filter wiring internally
  }

  yearSelect?.addEventListener('change', onSharedFilterChange);
  monthSelect?.addEventListener('change', onSharedFilterChange);
  searchInput?.addEventListener('input', onSharedFilterChange);

  // Reset button for transcript tab
  const resetBtn = document.getElementById('btn-reset-filters');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (activeTab === 'transcripts') {
        if (yearSelect) yearSelect.value = '';
        if (monthSelect) monthSelect.value = '';
        if (searchInput) searchInput.value = '';
        setTranscriptFilters({ year: '', month: '', search: '' });
        updateTranscriptTable();
      }
    });
  }

  // ── Mobile filter drawer toggle ─────────────────────────────────

  const filterToggleBtn = document.getElementById('btn-filter-toggle');
  const filterBar = document.getElementById('filter-bar');
  const filterToggleLabel = document.getElementById('filter-toggle-label');

  function updateFilterToggleLabel() {
    // Show the active filter name in the toggle button
    const activeEl = filterBar && filterBar.querySelector('.filter-pill.active');
    if (filterToggleLabel && activeEl) {
      filterToggleLabel.textContent = activeEl.textContent.replace(/\d+/g, '').trim();
    }
  }

  if (filterToggleBtn && filterBar) {
    filterToggleBtn.addEventListener('click', () => {
      const isOpen = filterBar.classList.toggle('is-open');
      filterToggleBtn.setAttribute('aria-expanded', String(isOpen));
    });
    // Close drawer when a pill is clicked
    filterBar.addEventListener('click', (e) => {
      if (e.target.closest('.filter-pill')) {
        filterBar.classList.remove('is-open');
        filterToggleBtn.setAttribute('aria-expanded', 'false');
        updateFilterToggleLabel();
      }
    });
    updateFilterToggleLabel();
  }

  // ── Mobile toolbar overflow menu ────────────────────────────────

  const toolbarMoreBtn = document.getElementById('btn-toolbar-more');
  const toolbar = toolbarMoreBtn && toolbarMoreBtn.closest('.toolbar');

  if (toolbarMoreBtn && toolbar) {
    toolbarMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toolbar.classList.toggle('overflow-open');
    });
    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!toolbar.contains(e.target)) {
        toolbar.classList.remove('overflow-open');
      }
    });
  }

  // ── Export / Import ─────────────────────────────────────────────

  document.getElementById('btn-search-transcripts').addEventListener('click', () => {
    renderGlobalTranscriptSearch(document.body);
  });

  document.getElementById('btn-asr-settings').addEventListener('click', () => {
    modalContent.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = 'ASR Provider Settings';
    heading.style.marginBottom = '12px';
    modalContent.appendChild(heading);
    buildAsrConfigPanel(modalContent);
    openModal();
  });


  document.getElementById('btn-export-csv').addEventListener('click', () => {
    const state = getState();
    const approved = state.audio.filter(a => {
      return getStatus(a.id) === 'approved' && !a.isBenchmark;
    });
    if (approved.length === 0) return;

    const approvedFiles = approved;
    const totalHours = approvedFiles.reduce((sum, a) => sum + (a.estMinutes || 0), 0) / 60;
    if (!confirm(`Export ${approvedFiles.length} approved files (≈${totalHours.toFixed(1)} hrs) as training CSV?`)) return;

    const columns = [
      { label: 'Audio ID', key: 'id' },
      { label: 'Audio Name', key: 'name' },
      { label: 'Year', key: 'year' },
      { label: 'Type', key: 'type' },
      { label: 'Audio URL', value: (row) => row.r2Link || row.driveLink || '' },
      { label: 'Transcript', value: (row) => {
        const m = state.mappings[row.id];
        const t = m ? state.transcripts.find(x => x.id === m.transcriptId) : null;
        return t ? t.name : '';
      }},
      { label: 'Cleaned Text', value: (row) => state.cleaning[row.id]?.cleanedText || '' },
      { label: 'Avg Confidence', value: (row) => {
        const a = state.alignments[row.id];
        return a ? Math.round(a.avgConfidence * 100) + '%' : '';
      }},
    ];
    exportCSV(approved, columns);
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) {
      if (e.key === 'Escape') {
        e.target.blur();
        closeModal();
      }
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('search-input')?.focus();
    } else if (e.key === 'Escape') {
      closeModal();
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // Select all visible rows — trigger select-all checkbox
      const selectAll = tableContainer.querySelector('.select-all-cb');
      if (selectAll && !selectAll.checked) {
        selectAll.checked = true;
        selectAll.dispatchEvent(new Event('change'));
      }
    } else if (e.key === 'E' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      document.getElementById('btn-export-csv')?.click();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Navigate rows — highlight/select
      e.preventDefault();
      const rows = tableContainer.querySelectorAll('tr.table-row');
      if (rows.length === 0) return;
      const highlighted = tableContainer.querySelector('tr.table-row.highlighted');
      const currentIdx = highlighted ? [...rows].indexOf(highlighted) : -1;
      let nextIdx;
      if (e.key === 'ArrowDown') {
        nextIdx = currentIdx < rows.length - 1 ? currentIdx + 1 : 0;
      } else {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : rows.length - 1;
      }
      if (highlighted) highlighted.classList.remove('highlighted');
      rows[nextIdx].classList.add('highlighted');
      rows[nextIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      // Open highlighted row in detail page
      const highlighted = tableContainer.querySelector('tr.table-row.highlighted');
      if (highlighted) {
        const audioId = highlighted.getAttribute('data-audio-id');
        if (audioId) window.open(`/detail.html?id=${encodeURIComponent(audioId)}`, '_blank');
      }
    }
  });

  // ── Rail contextual section: Quick filters ─────────────────────
  const setStatusFilter = (value) => {
    const status = document.getElementById('filter-status');
    if (!status) return;
    const checks = status.querySelectorAll('input[type="checkbox"]');
    checks.forEach(cb => { cb.checked = value === '__clear__' ? false : (cb.value === value); });
    // Trigger change on the first matching one to flush
    (checks[0] || checks).dispatchEvent(new Event('change', { bubbles: true }));
  };
  setContextualSections([
    {
      heading: 'Quick filters',
      items: [
        { label: 'Unmapped',     icon: 'alertCircle', onClick: () => setStatusFilter('unmapped') },
        { label: 'Mapped',       icon: 'check2',      onClick: () => setStatusFilter('mapped') },
        { label: 'Cleaned',      icon: 'sparkles',    onClick: () => setStatusFilter('cleaned') },
        { label: 'Approved',     icon: 'check',       onClick: () => setStatusFilter('approved') },
        { label: 'Show all',     icon: 'refresh',     onClick: () => document.getElementById('btn-reset-filters')?.click() },
      ],
    },
  ]);

  // ── Command palette: register audios + transcripts as searchable ──
  registerSource(() => {
    const s = getState();
    return (s.audio || []).slice(0, 500).map(a => ({
      id: 'audio-' + a.id,
      label: a.name || a.id,
      detail: a.id,
      group: 'Audio',
      icon: 'audio',
      onRun: () => { location.href = `/detail.html?id=${encodeURIComponent(a.id)}`; },
    }));
  });
});
