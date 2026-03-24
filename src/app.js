import { initState, getState, getStatus, exportState, importState, mergeSupabaseData } from './state.js';
import { checkAuth, signOut } from './auth.js';
import { loadFromSupabase } from './db.js';
import { renderTable, updateTable, getSelectedRows } from './table.js';
import { renderSuggestedMatches, linkMatch, renderSearchModal } from './mapping.js';
import { batchClean } from './cleaning.js';
import { batchAlign } from './alignment.js';
import { approveAll } from './review.js';

import { renderAsrConfig, runBenchmark, renderBenchmarkTable } from './benchmark.js';
import { buildAsrConfigPanel } from './asr-config.js';
import { exportCSV } from './utils.js';

// ── App init ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  if (!await checkAuth()) return;

  document.getElementById('btn-logout')?.addEventListener('click', signOut);

  const tableContainer = document.getElementById('table-container');
  tableContainer.innerHTML = '<div style="padding:3rem;text-align:center;color:var(--text-secondary,#8888aa)">Loading from Supabase…</div>';

  // Supabase is the single source of truth — no data.json needed
  const remote = await loadFromSupabase();
  if (!remote?.audio?.length) {
    tableContainer.innerHTML = '<div style="padding:2rem;text-align:center;color:#f87171;">Failed to load data from Supabase. Please refresh.</div>';
    return;
  }

  const state = initState({ audio: remote.audio, transcripts: remote.transcripts });
  mergeSupabaseData(remote);

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

  // ── Row expand handler ──────────────────────────────────────────

  let expandedRow = null;

  function onRowExpand(audioId) {
    const state = getState();
    const audio = state.audio.find(a => a.id === audioId);
    if (!audio) return;

    // Remove any existing expanded panel (and its wrapper <tr> if present)
    const existingRow = document.querySelector('.expanded-panel-row');
    const existing = existingRow || document.querySelector('.expanded-panel');
    if (existing) {
      if (expandedRow === audioId) {
        existing.remove();
        expandedRow = null;
        return;
      }
      existing.remove();
    }
    expandedRow = audioId;

    const status = getStatus(audioId);

    // Navigate to detail page for all non-unmapped, non-benchmark rows
    if (status === 'mapped' || status === 'cleaned' || status === 'aligned' || status === 'approved') {
      expandedRow = null;
      window.open(`/detail.html?id=${encodeURIComponent(audioId)}`, '_blank');
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'expanded-panel';

    // ── Always show audio player + transcript ──
    const playerSection = document.createElement('div');
    playerSection.className = 'player-section';

    // Audio player
    const audioUrl = audio.r2Link || audio.driveLink;
    if (audioUrl) {
      const playerEl = document.createElement('audio');
      playerEl.controls = true;
      playerEl.preload = 'none';
      playerEl.src = audioUrl;
      playerEl.className = 'audio-player';
      playerSection.appendChild(playerEl);
    } else {
      const noAudio = document.createElement('div');
      noAudio.className = 'no-audio';
      noAudio.textContent = 'No audio URL available';
      playerSection.appendChild(noAudio);
    }

    // Transcript display
    const mapping = state.mappings[audioId];
    if (mapping) {
      const transcript = state.transcripts.find(t => t.id === mapping.transcriptId);
      if (transcript) {
        const transcriptDiv = document.createElement('div');
        transcriptDiv.className = 'transcript-section';

        const tHeader = document.createElement('div');
        tHeader.className = 'transcript-header';
        tHeader.innerHTML = `<strong>Transcript:</strong> ${transcript.name}`;
        if (transcript.driveLink) {
          const viewLink = document.createElement('a');
          viewLink.href = transcript.driveLink;
          viewLink.target = '_blank';
          viewLink.className = 'transcript-link';
          viewLink.textContent = ' Open in Drive ↗';
          tHeader.appendChild(viewLink);
        }
        transcriptDiv.appendChild(tHeader);

        // Show first line / cleaned text
        const textContent = state.cleaning[audioId]?.cleanedText
          || transcript.firstLine
          || '';
        if (textContent) {
          const textDiv = document.createElement('div');
          textDiv.className = 'transcript-text';
          textDiv.dir = 'rtl';
          textDiv.textContent = textContent;
          transcriptDiv.appendChild(textDiv);
        }
        playerSection.appendChild(transcriptDiv);
      }
    }

    panel.appendChild(playerSection);

    // ── Status-specific content below player ──
    if (audio.isBenchmark) {
      // Benchmark row: show benchmark results + config
      const configBtn = document.createElement('button');
      configBtn.className = 'bulk-btn';
      configBtn.textContent = 'Configure ASR Models';
      configBtn.addEventListener('click', () => {
        modalContent.innerHTML = '';
        renderAsrConfig(modalContent, getState());
        openModal();
      });
      panel.appendChild(configBtn);

      const runBtn = document.createElement('button');
      runBtn.className = 'bulk-btn';
      runBtn.textContent = 'Run Benchmark';
      runBtn.addEventListener('click', async () => {
        const benchmarkIds = state.audio.filter(a => a.isBenchmark).map(a => a.id);
        const progress = document.createElement('div');
        progress.className = 'progress-bar';
        progress.textContent = 'Starting benchmark...';
        panel.appendChild(progress);
        try {
          await runBenchmark(benchmarkIds, getState(), (done, total) => {
            progress.textContent = `Benchmarking ${done} / ${total}...`;
          });
          progress.textContent = 'Benchmark complete.';
        } catch (err) {
          progress.textContent = 'Error: ' + err.message;
        }
        renderBenchmarkTable(resultsDiv, getState());
      });
      panel.appendChild(runBtn);

      const resultsDiv = document.createElement('div');
      resultsDiv.className = 'benchmark-results';
      renderBenchmarkTable(resultsDiv, getState());
      panel.appendChild(resultsDiv);

      // CRITICAL: No approve button for benchmark rows
    } else if (status === 'unmapped') {
      // Show mapping suggestions
      const suggestionsDiv = document.createElement('div');
      suggestionsDiv.className = 'suggestions-container';
      renderSuggestedMatches(suggestionsDiv, audioId, state, (aId, tId) => {
        linkMatch(aId, tId, 0.8, 'user selected');
        updateTable();
        onRowExpand(aId); // Re-render expanded panel
      });

      const searchBtn = document.createElement('button');
      searchBtn.className = 'bulk-btn';
      searchBtn.textContent = 'Search Transcripts';
      searchBtn.addEventListener('click', () => {
        renderSearchModal(document.body, getState(), (transcriptId) => {
          linkMatch(audioId, transcriptId, 1.0, 'manual search');
          updateTable();
        });
      });

      panel.appendChild(suggestionsDiv);
      panel.appendChild(searchBtn);
    }


    // Insert panel after the clicked row, wrapped in a <tr><td> for valid HTML
    const targetRow = tableContainer.querySelector(`tr[data-audio-id="${audioId}"]`);
    if (targetRow) {
      const wrapperTr = document.createElement('tr');
      wrapperTr.className = 'expanded-panel-row';
      const wrapperTd = document.createElement('td');
      const colCount = targetRow.children.length;
      wrapperTd.colSpan = colCount;
      wrapperTd.style.padding = '0';
      wrapperTd.appendChild(panel);
      wrapperTr.appendChild(wrapperTd);
      targetRow.after(wrapperTr);
    } else {
      tableContainer.appendChild(panel);
    }
  }

  // ── Render table ────────────────────────────────────────────────

  renderTable(tableContainer, {
    onRowExpand,
  });

  // ── Bulk actions ────────────────────────────────────────────────

  document.getElementById('btn-clean-selected').addEventListener('click', async () => {
    const selected = getSelectedRows();
    if (selected.length === 0) return;

    const bar = document.getElementById('bulk-selection-count');
    const originalText = bar.textContent;

    await batchClean(selected, getState(), (done, total, elapsed) => {
      bar.textContent = `Cleaning ${done} / ${total}${elapsed ? ` (${elapsed}s)` : ''}...`;
    });

    bar.textContent = originalText;
    updateTable();
  });

  document.getElementById('btn-align-selected').addEventListener('click', async () => {
    const selected = getSelectedRows();
    if (selected.length === 0) return;

    const bar = document.getElementById('bulk-selection-count');
    const originalText = bar.textContent;

    await batchAlign(selected, getState(), (done, total, elapsed) => {
      bar.textContent = `Aligning ${done} / ${total} (${elapsed}s)...`;
    });

    bar.textContent = originalText;
    updateTable();
  });

  document.getElementById('btn-approve-selected').addEventListener('click', () => {
    const selected = getSelectedRows();
    if (selected.length === 0) return;
    // Filter out benchmark rows — they cannot be approved
    const state = getState();
    const nonBenchmark = selected.filter(id => {
      const audio = state.audio.find(a => a.id === id);
      return audio && !audio.isBenchmark;
    });
    if (nonBenchmark.length === 0) return;
    approveAll(nonBenchmark, state);
    updateTable();
  });

  // ── Export / Import ─────────────────────────────────────────────

  document.getElementById('btn-asr-settings').addEventListener('click', () => {
    modalContent.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = 'ASR Provider Settings';
    heading.style.marginBottom = '12px';
    modalContent.appendChild(heading);
    buildAsrConfigPanel(modalContent);
    openModal();
  });

  document.getElementById('btn-export-state').addEventListener('click', () => {
    exportState();
  });

  const importFileInput = document.getElementById('import-file-input');
  document.getElementById('btn-import-state').addEventListener('click', () => {
    importFileInput.click();
  });
  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await importState(file);
      updateTable();
    } catch (err) {
      console.error('Import failed:', err);
    }
    importFileInput.value = '';
  });

  document.getElementById('btn-export-csv').addEventListener('click', () => {
    const state = getState();
    const approved = state.audio.filter(a => {
      return getStatus(a.id) === 'approved' && !a.isBenchmark;
    });
    if (approved.length === 0) return;

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
      const panelRow = document.querySelector('.expanded-panel-row');
      if (panelRow) {
        panelRow.remove();
        expandedRow = null;
      } else {
        const panel = document.querySelector('.expanded-panel');
        if (panel) {
          panel.remove();
          expandedRow = null;
        }
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // Select all visible rows — trigger select-all checkbox
      const selectAll = tableContainer.querySelector('.select-all-cb');
      if (selectAll && !selectAll.checked) {
        selectAll.checked = true;
        selectAll.dispatchEvent(new Event('change'));
      }
    } else if (e.key === 'e' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      exportState();
    } else if (e.key === 'E' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      document.getElementById('btn-export-csv')?.click();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Navigate rows — only highlight/select, don't expand
      e.preventDefault();
      const rows = tableContainer.querySelectorAll('tr.table-row');
      if (rows.length === 0) return;
      const currentIdx = expandedRow
        ? [...rows].findIndex(r => r.getAttribute('data-audio-id') === expandedRow)
        : -1;
      let nextIdx;
      if (e.key === 'ArrowDown') {
        nextIdx = currentIdx < rows.length - 1 ? currentIdx + 1 : 0;
      } else {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : rows.length - 1;
      }
      const nextAudioId = rows[nextIdx].getAttribute('data-audio-id');
      if (nextAudioId) {
        // Remove highlight from previous row
        const prevHighlighted = tableContainer.querySelector('tr.table-row.highlighted');
        if (prevHighlighted) prevHighlighted.classList.remove('highlighted');
        // Highlight the new row and track it
        rows[nextIdx].classList.add('highlighted');
        expandedRow = nextAudioId;
        rows[nextIdx].scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter') {
      // If a row is highlighted, expand it; otherwise approve current expanded panel
      if (expandedRow) {
        const existingPanel = document.querySelector('.expanded-panel-row');
        if (!existingPanel || existingPanel.previousElementSibling?.getAttribute('data-audio-id') !== expandedRow) {
          // No panel open for this row — expand it
          onRowExpand(expandedRow);
        } else {
          // Panel is already open — try to approve
          const approveBtn = document.querySelector('.expanded-panel .review-approve-btn');
          if (approveBtn) approveBtn.click();
        }
      }
    } else if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
      // Skip current expanded row
      if (expandedRow) {
        const skipBtn = document.querySelector('.expanded-panel .review-skip-btn');
        if (skipBtn) skipBtn.click();
      }
    } else if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
      // Reject current expanded row
      if (expandedRow) {
        const rejectBtn = document.querySelector('.expanded-panel .review-reject-btn');
        if (rejectBtn) rejectBtn.click();
      }
    } else if (e.key === 'e' && !e.ctrlKey && !e.metaKey) {
      // Toggle edit mode in review panel
      if (expandedRow) {
        const editBtn = document.querySelector('.expanded-panel .review-edit-btn');
        if (editBtn) editBtn.click();
      }
    } else if (e.key === ' ') {
      // Space = play/pause audio
      e.preventDefault();
      const audioEl = document.querySelector('.expanded-panel audio');
      if (audioEl) {
        if (audioEl.paused) audioEl.play();
        else audioEl.pause();
      }
    } else if (e.key === 'ArrowLeft') {
      // Seek -5s
      const audioEl = document.querySelector('.expanded-panel audio');
      if (audioEl) {
        audioEl.currentTime = Math.max(0, audioEl.currentTime - 5);
      }
    } else if (e.key === 'ArrowRight') {
      // Seek +5s
      const audioEl = document.querySelector('.expanded-panel audio');
      if (audioEl) {
        audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 5);
      }
    }
  });
});
