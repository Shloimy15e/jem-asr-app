import { initState, getState, getStatus, getFilteredRows, exportState, importState, mergeSupabaseData, getAudiosByTranscriptId, addTranscript } from './state.js';
import { loadFromSupabase, splitTranscript } from './db.js';
import { renderTable, updateTable, getSelectedRows } from './table.js';
import { renderSuggestedMatches, linkMatch, unlinkMatch, renderSearchModal } from './mapping.js';
import { batchClean } from './cleaning.js';
import { batchAlign } from './alignment.js';
import { renderReviewPanel, approveAll } from './review.js';
import { renderKaraokePlayer } from './karaoke.js';
import { renderAsrConfig, runBenchmark, renderBenchmarkTable } from './benchmark.js';
import { exportCSV } from './utils.js';

// ── App init ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
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
    } else if (status === 'aligned' || status === 'approved') {
      // Show review panel
      renderReviewPanel(panel, audioId, state, {
        onApprove: () => {
          updateTable();
          expandedRow = null;
        },
        onReject: () => {
          updateTable();
          expandedRow = null;
        },
        onSkip: () => {
          expandedRow = null;
          const existingRow = document.querySelector('.expanded-panel-row');
          if (existingRow) { existingRow.remove(); return; }
          const existing = document.querySelector('.expanded-panel');
          if (existing) existing.remove();
        },
      });

      // Karaoke button for aligned rows
      if (state.alignments[audioId]) {
        const karaokeBtn = document.createElement('button');
        karaokeBtn.className = 'bulk-btn';
        karaokeBtn.textContent = 'Karaoke Player';
        karaokeBtn.addEventListener('click', () => {
          renderKaraokePlayer(audioId, getState());
        });
        panel.appendChild(karaokeBtn);
      }
    } else {
      // mapped or cleaned: show basic info + karaoke if aligned
      const info = document.createElement('div');
      info.className = 'expanded-info';
      info.textContent = `Status: ${status}`;
      panel.appendChild(info);

      if (state.alignments[audioId]) {
        const karaokeBtn = document.createElement('button');
        karaokeBtn.className = 'bulk-btn';
        karaokeBtn.textContent = 'Karaoke Player';
        karaokeBtn.addEventListener('click', () => {
          renderKaraokePlayer(audioId, getState());
        });
        panel.appendChild(karaokeBtn);
      }
    }

    // ── Mapping controls (available on ALL non-benchmark rows) ──
    if (!audio.isBenchmark) {
      const mappingBar = document.createElement('div');
      mappingBar.className = 'mapping-bar';
      mappingBar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:12px 0;border-top:1px solid var(--border);margin-top:12px;flex-wrap:wrap;';

      const currentMapping = state.mappings[audioId];
      if (currentMapping) {
        const transcript = state.transcripts.find(t => t.id === currentMapping.transcriptId);
        const label = document.createElement('span');
        label.className = 'text-secondary';
        label.style.fontSize = '0.85rem';

        // Show source document name if this is a split transcript
        const sourceName = transcript?.sourceTranscriptId
          ? (() => {
              const src = state.transcripts.find(t => t.id === transcript.sourceTranscriptId);
              return src ? ` (split from: ${src.name})` : ` (split from: ${transcript.sourceTranscriptId})`;
            })()
          : '';
        label.textContent = `Linked to: ${transcript ? transcript.name : currentMapping.transcriptId}${sourceName}`;
        mappingBar.appendChild(label);

        // Shared-transcript warning + Split button
        const sharedAudioIds = getAudiosByTranscriptId(currentMapping.transcriptId)
          .filter(id => id !== audioId);
        if (sharedAudioIds.length > 0) {
          const warning = document.createElement('span');
          warning.style.cssText = 'font-size:0.8rem;color:var(--orange,#fb923c);display:flex;align-items:center;gap:4px;';
          warning.textContent = `⚠ Shared with ${sharedAudioIds.length} other audio file${sharedAudioIds.length > 1 ? 's' : ''}`;
          mappingBar.appendChild(warning);

          const splitBtn = document.createElement('button');
          splitBtn.className = 'action-btn';
          splitBtn.style.cssText = 'background:var(--orange,#fb923c);color:#000;font-weight:600;';
          splitBtn.textContent = 'Split Transcript';
          splitBtn.title = 'Create a private copy of this transcript for this audio file only';
          splitBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            splitBtn.disabled = true;
            splitBtn.textContent = 'Splitting…';
            try {
              const newTranscript = await splitTranscript(currentMapping.transcriptId);
              addTranscript(newTranscript);
              linkMatch(audioId, newTranscript.id, currentMapping.confidence, (currentMapping.matchReason || '') + (currentMapping.matchReason ? ' [split]' : 'split'));
              updateTable();
              onRowExpand(audioId);
            } catch (err) {
              splitBtn.disabled = false;
              splitBtn.textContent = 'Split failed';
              console.error('[split]', err);
            }
          });
          mappingBar.appendChild(splitBtn);
        }

        const unlinkBtn = document.createElement('button');
        unlinkBtn.className = 'action-btn action-btn-danger';
        unlinkBtn.textContent = 'Unlink';
        unlinkBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          unlinkMatch(audioId);
          // Also clear downstream data
          if (state.cleaning[audioId]) delete state.cleaning[audioId];
          if (state.alignments[audioId]) delete state.alignments[audioId];
          if (state.reviews[audioId]) delete state.reviews[audioId];
          updateTable();
          onRowExpand(audioId);
        });
        mappingBar.appendChild(unlinkBtn);
      }

      const changeBtn = document.createElement('button');
      changeBtn.className = 'action-btn action-btn-primary';
      changeBtn.textContent = currentMapping ? 'Change Transcript' : 'Link Transcript';
      changeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renderSearchModal(document.body, getState(), (transcriptId) => {
          linkMatch(audioId, transcriptId, 1.0, 'manual search');
          // Clear downstream data when re-mapping
          if (state.cleaning[audioId]) delete state.cleaning[audioId];
          if (state.alignments[audioId]) delete state.alignments[audioId];
          if (state.reviews[audioId]) delete state.reviews[audioId];
          updateTable();
          onRowExpand(audioId);
        });
      });
      mappingBar.appendChild(changeBtn);

      panel.appendChild(mappingBar);
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
    onRowSelect: (ids) => {
      // Selection count is handled by table.js
    },
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
      // Navigate rows
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
        onRowExpand(nextAudioId);
        rows[nextIdx].scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter') {
      // Approve current expanded row
      if (expandedRow) {
        const approveBtn = document.querySelector('.expanded-panel .review-approve-btn');
        if (approveBtn) approveBtn.click();
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
      const audioEl = document.querySelector('.expanded-panel audio, .karaoke-player audio');
      if (audioEl) {
        if (audioEl.paused) audioEl.play();
        else audioEl.pause();
      }
    } else if (e.key === 'ArrowLeft') {
      // Seek -5s
      const audioEl = document.querySelector('.expanded-panel audio, .karaoke-player audio');
      if (audioEl) {
        audioEl.currentTime = Math.max(0, audioEl.currentTime - 5);
      }
    } else if (e.key === 'ArrowRight') {
      // Seek +5s
      const audioEl = document.querySelector('.expanded-panel audio, .karaoke-player audio');
      if (audioEl) {
        audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 5);
      }
    }
  });
});
