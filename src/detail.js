import { initState, getState, getStatus, getVersions, getBestVersion, addVersion, updateVersion, updateState, exportState, importState, mergeSupabaseData } from './state.js';
import { renderSuggestedMatches, linkMatch, unlinkMatch, renderSearchModal } from './mapping.js';
import { batchClean, cleanBrackets, cleanParentheses, cleanSectionMarkers, cleanSurroundingQuotes, cleanHyphens, cleanQuestionMarks, cleanEllipsis, cleanWhitespace, calculateCleanRate } from './cleaning.js';
import { alignRow } from './alignment.js';
import { renderReviewPanel } from './review.js';
import { renderKaraokePlayer } from './karaoke.js';
import { formatConfidence } from './utils.js';
import { loadAlignmentWords, loadTranscriptText, loadFromSupabase, syncAudioDuration } from './db.js';

const R2_BASE = 'https://audio.kohnai.ai';

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const audioId = params.get('id');
  const transcriptId = params.get('tid');
  const page = document.getElementById('detail-page');

  if (!audioId && !transcriptId) {
    page.innerHTML = '<div class="empty-state"><div class="empty-state-title">No audio or transcript ID specified</div></div>';
    return;
  }

  // Back button
  document.getElementById('btn-back').addEventListener('click', () => {
    window.close();
    // If window.close() is blocked (not opened by script), go to index
    window.location.href = '/';
  });

  // Load data from Supabase (single source of truth)
  page.innerHTML = '<div class="loading-state">Loading…</div>';
  let remote;
  try {
    remote = await loadFromSupabase();
  } catch (err) {
    page.innerHTML = `<div class="empty-state"><div class="empty-state-title">Failed to load data: ${err.message}</div></div>`;
    return;
  }

  initState({ audio: remote.audio, transcripts: remote.transcripts });
  mergeSupabaseData(remote);

  // Apply audioNames localStorage overrides so renamed files show correct names
  const s = getState();
  for (const [aId, name] of Object.entries(s.audioNames || {})) {
    const entry = s.audio.find(a => a.id === aId);
    if (entry) entry.name = name;
  }

  // Standalone transcript view
  if (transcriptId && !audioId) {
    const transcript = getState().transcripts.find(t => t.id === transcriptId);
    if (!transcript) {
      page.innerHTML = '<div class="empty-state"><div class="empty-state-title">Transcript not found</div></div>';
      return;
    }
    renderTranscriptPage(transcriptId, transcript, getState(), page);
    return;
  }

  // Find the audio entry
  const audio = getState().audio.find(a => a.id === audioId);
  if (!audio) {
    page.innerHTML = '<div class="empty-state"><div class="empty-state-title">Audio not found</div></div>';
    return;
  }

  renderDetailPage(audioId, audio, getState(), page);
});

function renderTranscriptPage(transcriptId, transcript, state, container) {
  container.innerHTML = '';

  // Title
  const titleBar = document.createElement('div');
  titleBar.className = 'detail-title-bar';
  const title = document.createElement('h2');
  title.className = 'editable-title';
  title.contentEditable = 'true';
  title.spellcheck = false;
  title.textContent = transcript.name;
  title.addEventListener('blur', () => {
    const newName = title.textContent.trim();
    if (newName && newName !== transcript.name) transcript.name = newName;
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
  });
  titleBar.appendChild(title);
  container.appendChild(titleBar);

  // Meta
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const items = [
    transcript.year && `Year: ${transcript.year}`,
    transcript.month && `Month: ${transcript.month}`,
  ].filter(Boolean);
  meta.textContent = items.length > 0 ? items.join('  |  ') : 'Transcript file';
  container.appendChild(meta);

  // Linked audio
  const linkedAudioIds = Object.entries(state.mappings)
    .filter(([, m]) => m.transcriptId === transcriptId)
    .map(([aId]) => aId);

  if (linkedAudioIds.length > 0) {
    const linkedSection = createSection('Linked Audio');
    linkedAudioIds.forEach(aId => {
      const a = state.audio.find(x => x.id === aId);
      if (!a) return;
      const link = document.createElement('a');
      link.href = `/detail.html?id=${encodeURIComponent(aId)}`;
      link.target = '_blank';
      link.className = 'transcript-audio-link';
      link.textContent = a.name;
      linkedSection.content.appendChild(link);
    });
    container.appendChild(linkedSection.el);
  }

  // Editable transcript text
  const textSection = createSection('Transcript Text');
  const textarea = document.createElement('textarea');
  textarea.className = 'transcript-editor';
  textarea.dir = 'rtl';
  textarea.rows = 20;
  textarea.placeholder = 'Loading transcript text...';

  if (transcript.text) {
    textarea.value = transcript.text;
  } else if (transcript.firstLine) {
    textarea.value = transcript.firstLine;
  }

  // Load full text from R2
  if (transcript.r2TranscriptLink && !transcript.text) {
    fetch(transcript.r2TranscriptLink).then(r => r.ok ? r.text() : null).then(text => {
      if (text) {
        transcript.text = text;
        textarea.value = text;
      }
    }).catch(() => {});
  }

  const saveStatus = document.createElement('span');
  saveStatus.className = 'save-status text-secondary';
  let saveTimer = null;
  textarea.addEventListener('input', () => {
    saveStatus.textContent = 'Unsaved...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      transcript.text = textarea.value;
      saveStatus.textContent = 'Saved locally';
      setTimeout(() => { saveStatus.textContent = ''; }, 2000);
    }, 800);
  });

  textSection.content.appendChild(textarea);
  textSection.content.appendChild(saveStatus);
  container.appendChild(textSection.el);
}

function renderDetailPage(audioId, audio, state, container) {
  container.innerHTML = '';
  const status = getStatus(audioId);

  // Title bar with editable name
  const titleBar = document.createElement('div');
  titleBar.className = 'detail-title-bar';
  const title = document.createElement('h2');
  title.className = 'editable-title';
  title.contentEditable = 'true';
  title.spellcheck = false;
  title.textContent = audio.name;
  title.addEventListener('blur', () => {
    const newName = title.textContent.trim();
    if (newName && newName !== audio.name) {
      audio.name = newName;
      updateState('renamedFiles', audioId, newName);
    }
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
  });
  titleBar.appendChild(title);
  const badge = document.createElement('span');
  badge.className = `status-badge status-${status}`;
  badge.textContent = status;
  titleBar.appendChild(badge);
  container.appendChild(titleBar);

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const metaItems = [
    audio.year && `Year: ${audio.year}`,
    audio.type && `Type: ${audio.type}`,
    audio.isSelected50hr && '50-Hour Set',
    audio.isBenchmark && 'Benchmark',
  ].filter(Boolean);
  meta.textContent = metaItems.join('  |  ');
  // Duration span — updated from real audio metadata
  const durationSpan = document.createElement('span');
  durationSpan.textContent = audio.estMinutes != null ? `${metaItems.length ? '  |  ' : ''}Duration: ${audio.estMinutes} min` : '';
  meta.appendChild(durationSpan);
  container.appendChild(meta);

  // === Section: Audio Player ===
  const playerSection = createSection('Audio Player');
  const audioUrl = audio.r2Link || audio.driveLink;
  if (audioUrl) {
    const playerEl = document.createElement('audio');
    playerEl.controls = true;
    playerEl.preload = 'metadata';
    playerEl.src = audioUrl;
    playerEl.className = 'audio-player';
    playerEl.addEventListener('loadedmetadata', () => {
      const realMin = parseFloat((playerEl.duration / 60).toFixed(1));
      durationSpan.textContent = `${metaItems.length ? '  |  ' : ''}Duration: ${realMin} min`;
      if (audio.estMinutes !== realMin) {
        audio.estMinutes = realMin;
        syncAudioDuration(audioId, realMin).catch(console.warn);
      }
    }, { once: true });
    playerSection.content.appendChild(playerEl);

    // Trim Controls
    renderTrimControls(audioId, playerEl, playerSection.content);
  } else {
    const noAudio = document.createElement('div');
    noAudio.className = 'no-audio';
    noAudio.textContent = 'No audio URL available';
    playerSection.content.appendChild(noAudio);
  }
  container.appendChild(playerSection.el);

  // === Section: Mapping ===
  if (!audio.isBenchmark) {
    const mappingSection = createSection('Transcript Mapping');
    const activeVersionRef = { id: getBestVersion(audioId)?.id || null };
    renderMappingSection(audioId, state, mappingSection.content, container, activeVersionRef);
    container.appendChild(mappingSection.el);

    // === Section: Cleaning + Alignment + Word View (unified) ===
    if (state.mappings[audioId]) {
      const workSection = createSection('Processing');
      const playerEl = container.querySelector('.audio-player');
      renderUnifiedWorkSection(audioId, state, workSection.content, container, playerEl, activeVersionRef);
      container.appendChild(workSection.el);
    }
  }
}

function createSection(title) {
  const el = document.createElement('section');
  el.className = 'detail-section';
  const header = document.createElement('h3');
  header.className = 'detail-section-title';
  header.textContent = title;
  el.appendChild(header);
  const content = document.createElement('div');
  content.className = 'detail-section-content';
  el.appendChild(content);
  return { el, content };
}

function renderMappingSection(audioId, state, container, pageContainer, activeVersionRef) {
  container.innerHTML = '';
  const versions = getVersions(audioId);
  const mapping = state.mappings[audioId];

  if (mapping || versions.length > 0) {
    const manual = versions.find(v => v.type === 'manual');
    const transcript = manual
      ? state.transcripts.find(t => t.id === manual.sourceTranscriptId)
      : (mapping ? state.transcripts.find(t => t.id === mapping.transcriptId) : null);

    // Header: linked transcript name + view link
    const label = document.createElement('div');
    label.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
    const strong = document.createElement('strong');
    strong.textContent = 'Linked to: ';
    label.appendChild(strong);
    label.appendChild(document.createTextNode(transcript ? transcript.name : (mapping?.transcriptId || 'unknown')));
    if (transcript) {
      const viewLink = document.createElement('a');
      viewLink.href = `/detail.html?tid=${encodeURIComponent(transcript.id)}`;
      viewLink.target = '_blank';
      viewLink.className = 'action-btn';
      viewLink.style.cssText = 'text-decoration:none;font-size:0.8rem;';
      viewLink.textContent = 'View Transcript Independently';
      label.appendChild(viewLink);
    }
    container.appendChild(label);

    // Version tabs
    if (versions.length > 0) {
      const tabBar = document.createElement('div');
      tabBar.className = 'version-tab-bar';
      const contentArea = document.createElement('div');

      let activeVersionId = getBestVersion(audioId)?.id || versions[0].id;
      if (activeVersionRef) activeVersionRef.id = activeVersionId;

      function renderVersionContent(versionId) {
        contentArea.innerHTML = '';
        const version = versions.find(v => v.id === versionId);
        if (!version) return;

        // Update tab active states
        tabBar.querySelectorAll('.version-tab').forEach(tab => {
          tab.classList.toggle('active', tab.dataset.versionId === versionId);
        });

        const isManual = version.type === 'manual';

        // Textarea (read-only for manual versions)
        const textarea = document.createElement('textarea');
        textarea.className = 'transcript-editor';
        textarea.dir = 'rtl';
        textarea.rows = 12;
        textarea.placeholder = 'Loading transcript text...';
        if (isManual) {
          textarea.readOnly = true;
          textarea.style.opacity = '0.75';
          textarea.style.cursor = 'default';
        }

        // Load text into textarea
        if (isManual) {
          // Manual versions always reflect the live transcript — never use a stale version.text cache
          if (transcript?.text) {
            textarea.value = transcript.text;
          } else if (transcript?.firstLine) {
            textarea.value = transcript.firstLine;
            const loadFullText = async () => {
              let text = null;
              if (transcript.r2TranscriptLink) {
                const res = await fetch(transcript.r2TranscriptLink).catch(() => null);
                if (res?.ok) text = await res.text().catch(() => null);
              }
              if (!text && transcript.id) {
                text = await loadTranscriptText(transcript.id);
              }
              if (text) {
                transcript.text = text; // cache on transcript object, not version
                textarea.value = text;
              }
            };
            loadFullText().catch(() => {});
          }
        } else if (version.text) {
          textarea.value = version.text;
        } else if (transcript?.firstLine) {
          textarea.value = transcript.firstLine;
          // Try R2 first, fall back to Supabase
          const loadFullText = async () => {
            let text = null;
            if (transcript.r2TranscriptLink) {
              const res = await fetch(transcript.r2TranscriptLink).catch(() => null);
              if (res?.ok) text = await res.text().catch(() => null);
            }
            if (!text && transcript.id) {
              text = await loadTranscriptText(transcript.id);
            }
            if (text && !version.text) {
              version.text = text;
              textarea.value = text;
            }
          };
          loadFullText().catch(() => {});
        }

        // Save on change (debounced) — not available for manual versions
        const saveStatus = document.createElement('span');
        saveStatus.className = 'save-status text-secondary';
        if (!isManual) {
          let saveTimer = null;
          textarea.addEventListener('input', () => {
            saveStatus.textContent = 'Unsaved...';
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
              updateVersion(audioId, version.id, { text: textarea.value });
              saveStatus.textContent = 'Saved';
              setTimeout(() => { saveStatus.textContent = ''; }, 2000);
            }, 800);
          });
        }

        contentArea.appendChild(textarea);

        // Info bar below textarea
        const infoBar = document.createElement('div');
        infoBar.style.cssText = 'display:flex;align-items:center;gap:12px;margin-top:6px;flex-wrap:wrap;';
        const typeLabel = document.createElement('span');
        typeLabel.className = `version-type-badge version-type-${version.type}`;
        typeLabel.textContent = version.type;
        infoBar.appendChild(typeLabel);
        if (isManual) {
          const lockBadge = document.createElement('span');
          lockBadge.className = 'text-secondary';
          lockBadge.textContent = '🔒 read-only';
          infoBar.appendChild(lockBadge);
        }
        if (version.cleanRate) {
          const cr = document.createElement('span');
          cr.className = 'text-secondary';
          cr.textContent = `Clean rate: ${version.cleanRate}%`;
          infoBar.appendChild(cr);
        }
        if (version.alignment) {
          const al = document.createElement('span');
          al.className = 'text-secondary';
          al.textContent = `Avg confidence: ${formatConfidence(version.alignment.avgConfidence)}`;
          infoBar.appendChild(al);
        }
        if (!isManual) infoBar.appendChild(saveStatus);

        if (isManual) {
          // "Start Editing" — creates an Edited copy of the manual text immediately
          const startEditBtn = document.createElement('button');
          startEditBtn.className = 'action-btn action-btn-primary';
          startEditBtn.textContent = 'Start Editing';
          startEditBtn.addEventListener('click', async () => {
            startEditBtn.disabled = true;
            startEditBtn.textContent = 'Loading...';
            // Ensure full text is loaded before copying
            let text = textarea.value;
            if (!version.text && transcript) {
              let full = null;
              if (transcript.r2TranscriptLink) {
                const res = await fetch(transcript.r2TranscriptLink).catch(() => null);
                if (res?.ok) full = await res.text().catch(() => null);
              }
              if (!full && transcript.id) full = await loadTranscriptText(transcript.id);
              if (full) { version.text = full; text = full; }
            }
            addVersion(audioId, {
              type: 'edited',
              parentVersionId: version.id,
              sourceTranscriptId: version.sourceTranscriptId,
              text,
              createdBy: 'user',
            });
            const s = getState();
            renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
          });
          infoBar.appendChild(startEditBtn);
        } else {
          // "Save as new edited version" button
          const saveAsBtn = document.createElement('button');
          saveAsBtn.className = 'action-btn';
          saveAsBtn.textContent = 'Save as Edited Version';
          saveAsBtn.addEventListener('click', () => {
            const newText = textarea.value;
            if (newText === version.text && version.type === 'edited') return;
            addVersion(audioId, {
              type: 'edited',
              parentVersionId: version.id,
              sourceTranscriptId: version.sourceTranscriptId || manual?.sourceTranscriptId,
              text: newText,
              createdBy: 'user',
            });
            const s = getState();
            const audio = s.audio.find(a => a.id === audioId);
            renderDetailPage(audioId, audio, s, pageContainer);
          });
          infoBar.appendChild(saveAsBtn);
        }

        contentArea.appendChild(infoBar);
      }

      // Build tabs
      for (const v of versions) {
        const tab = document.createElement('button');
        tab.className = 'version-tab';
        tab.dataset.versionId = v.id;
        tab.textContent = v.type.charAt(0).toUpperCase() + v.type.slice(1);
        if (v.id === activeVersionId) tab.classList.add('active');
        tab.addEventListener('click', () => {
          activeVersionId = v.id;
          if (activeVersionRef) activeVersionRef.id = v.id;
          renderVersionContent(v.id);
        });
        tabBar.appendChild(tab);
      }

      container.appendChild(tabBar);
      container.appendChild(contentArea);
      renderVersionContent(activeVersionId);
    } else if (transcript) {
      // No versions yet, just show text
      const textarea = document.createElement('textarea');
      textarea.className = 'transcript-editor';
      textarea.dir = 'rtl';
      textarea.rows = 12;
      textarea.value = transcript.text || transcript.firstLine || '';
      if (transcript.r2TranscriptLink && !transcript.text) {
        fetch(transcript.r2TranscriptLink).then(r => r.ok ? r.text() : null).then(text => {
          if (text) { transcript.text = text; textarea.value = text; }
        }).catch(() => {});
      }
      container.appendChild(textarea);
    }

    // Action buttons
    const btnBar = document.createElement('div');
    btnBar.style.cssText = 'display:flex;gap:8px;margin-top:12px;';

    const changeBtn = document.createElement('button');
    changeBtn.className = 'action-btn action-btn-primary';
    changeBtn.textContent = 'Change Transcript';
    changeBtn.addEventListener('click', () => {
      renderSearchModal(document.body, getState(), (transcriptId) => {
        linkMatch(audioId, transcriptId, 1.0, 'manual search');
        const s = getState();
        // Reset versions for this audio
        s.transcriptVersions[audioId] = [];
        if (s.cleaning[audioId]) delete s.cleaning[audioId];
        if (s.alignments[audioId]) delete s.alignments[audioId];
        if (s.reviews[audioId]) delete s.reviews[audioId];
        const audio = s.audio.find(a => a.id === audioId);
        renderDetailPage(audioId, audio, s, pageContainer);
      });
    });
    btnBar.appendChild(changeBtn);

    const unlinkBtn = document.createElement('button');
    unlinkBtn.className = 'action-btn action-btn-danger';
    unlinkBtn.textContent = 'Unlink';
    unlinkBtn.addEventListener('click', () => {
      unlinkMatch(audioId);
      const s = getState();
      s.transcriptVersions[audioId] = [];
      if (s.cleaning[audioId]) delete s.cleaning[audioId];
      if (s.alignments[audioId]) delete s.alignments[audioId];
      if (s.reviews[audioId]) delete s.reviews[audioId];
      const audio = s.audio.find(a => a.id === audioId);
      renderDetailPage(audioId, audio, s, pageContainer);
    });
    btnBar.appendChild(unlinkBtn);

    container.appendChild(btnBar);
  } else {
    // Unmapped: show suggestions + search
    const suggestionsDiv = document.createElement('div');
    suggestionsDiv.className = 'suggestions-container';
    renderSuggestedMatches(audioId, suggestionsDiv, state, (aId, tId) => {
      linkMatch(aId, tId, 0.8, 'user selected');
      const s = getState();
      const audio = s.audio.find(a => a.id === audioId);
      renderDetailPage(audioId, audio, s, pageContainer);
    });
    container.appendChild(suggestionsDiv);

    const searchBtn = document.createElement('button');
    searchBtn.className = 'btn btn-secondary';
    searchBtn.textContent = 'Search Transcripts';
    searchBtn.style.marginTop = '12px';
    searchBtn.addEventListener('click', () => {
      renderSearchModal(document.body, getState(), (transcriptId) => {
        linkMatch(audioId, transcriptId, 1.0, 'manual search');
        const s = getState();
        const audio = s.audio.find(a => a.id === audioId);
        renderDetailPage(audioId, audio, s, pageContainer);
      });
    });
    container.appendChild(searchBtn);

    // Create transcript from scratch
    const createBtn = document.createElement('button');
    createBtn.className = 'btn btn-secondary';
    createBtn.textContent = 'Create Transcript from Scratch';
    createBtn.style.marginTop = '8px';
    createBtn.addEventListener('click', () => {
      // Create a new manual version with empty text
      addVersion(audioId, {
        type: 'manual',
        text: '',
        createdBy: 'user',
      });
      const s = getState();
      // Create a synthetic mapping so the pipeline can proceed
      if (!s.mappings[audioId]) {
        s.mappings[audioId] = {
          transcriptId: null,
          confidence: 1.0,
          matchReason: 'created-from-scratch',
          confirmedBy: 'user',
          confirmedAt: new Date().toISOString(),
        };
      }
      const audio = s.audio.find(a => a.id === audioId);
      renderDetailPage(audioId, audio, s, pageContainer);
    });
    container.appendChild(createBtn);
  }
}

// Opens a modal showing a per-line diff preview for a cleaning pass.
// currentText: text before the pass; previewText: what the pass would produce.
// rawOriginal: the locked original transcript text (never overwritten).
// Accepted lines are applied; rejected lines keep their original content.
function openPassPreviewModal(audioId, passLabel, currentText, previewText, rawOriginal, pageContainer) {
  const origLines = currentText.split('\n');
  const cleanLines = previewText.split('\n');
  const maxLen = Math.max(origLines.length, cleanLines.length);

  const rows = [];
  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i] || '';
    const clean = cleanLines[i] || '';
    rows.push({ lineNum: i + 1, orig, clean, changed: orig !== clean, accepted: true, editedClean: clean });
  }

  const changedCount = rows.filter(r => r.changed).length;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal pass-preview-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = 'Preview: ' + passLabel;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  if (changedCount === 0) {
    const noChange = document.createElement('div');
    noChange.style.cssText = 'padding:20px;color:var(--text-secondary);text-align:center;';
    noChange.textContent = 'No changes would be made by this pass.';
    modal.appendChild(noChange);
    const doneBtn = document.createElement('button');
    doneBtn.className = 'action-btn';
    doneBtn.textContent = 'Close';
    doneBtn.style.cssText = 'margin:16px;';
    doneBtn.addEventListener('click', () => overlay.remove());
    modal.appendChild(doneBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    return;
  }

  // Stats + batch controls
  const actions = document.createElement('div');
  actions.className = 'diff-actions';

  const countLabel = document.createElement('span');
  countLabel.className = 'text-secondary';
  countLabel.textContent = changedCount + ' line' + (changedCount !== 1 ? 's' : '') + ' of ' + maxLen + ' would change';
  actions.appendChild(countLabel);

  const acceptAllBtn = document.createElement('button');
  acceptAllBtn.className = 'action-btn';
  acceptAllBtn.textContent = 'Accept All';
  acceptAllBtn.addEventListener('click', () => {
    rows.forEach(r => { if (r.changed) r.accepted = true; });
    modal.querySelectorAll('.diff-row-checkbox').forEach(cb => {
      cb.checked = true;
      cb.closest('.diff-row')?.classList.remove('diff-row-rejected');
    });
  });
  actions.appendChild(acceptAllBtn);

  const rejectAllBtn = document.createElement('button');
  rejectAllBtn.className = 'action-btn action-btn-danger';
  rejectAllBtn.textContent = 'Reject All';
  rejectAllBtn.addEventListener('click', () => {
    rows.forEach(r => { if (r.changed) r.accepted = false; });
    modal.querySelectorAll('.diff-row-checkbox').forEach(cb => {
      cb.checked = false;
      cb.closest('.diff-row')?.classList.add('diff-row-rejected');
    });
  });
  actions.appendChild(rejectAllBtn);

  const showOnlyLabel = document.createElement('label');
  showOnlyLabel.className = 'diff-filter-label';
  const showOnlyCb = document.createElement('input');
  showOnlyCb.type = 'checkbox';
  showOnlyCb.checked = true; // default: show only changed lines
  showOnlyLabel.appendChild(showOnlyCb);
  showOnlyLabel.appendChild(document.createTextNode(' Changed only'));
  actions.appendChild(showOnlyLabel);

  modal.appendChild(actions);

  // Diff rows
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'diff-rows-container';

  const rowEls = [];
  rows.forEach((row) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'diff-row' + (row.changed ? ' diff-row-changed' : '');
    if (!row.changed) rowEl.style.display = 'none'; // hidden by default (matches showOnlyCb)

    const lineNum = document.createElement('span');
    lineNum.className = 'diff-row-linenum';
    lineNum.textContent = row.lineNum;
    rowEl.appendChild(lineNum);

    if (row.changed) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'diff-row-checkbox';
      cb.checked = row.accepted;
      cb.title = 'Accept this change';
      cb.addEventListener('change', () => {
        row.accepted = cb.checked;
        rowEl.classList.toggle('diff-row-rejected', !cb.checked);
      });
      rowEl.appendChild(cb);

      // Word-level diff: original with removed words struck through
      const diffContent = document.createElement('div');
      diffContent.className = 'diff-word-content';
      diffContent.dir = 'rtl';

      if (!row.clean.trim() && row.orig.trim()) {
        const allRemoved = document.createElement('span');
        allRemoved.className = 'diff-word-removed';
        allRemoved.textContent = row.orig;
        diffContent.appendChild(allRemoved);
      } else {
        const tokens = wordDiffTokens(row.orig, row.clean);
        tokens.forEach(tok => {
          if (tok.isSpace) { diffContent.appendChild(document.createTextNode(tok.text)); return; }
          const span = document.createElement('span');
          span.textContent = tok.text;
          if (tok.removed) span.className = 'diff-word-removed';
          else if (tok.added) span.className = 'diff-word-added';
          diffContent.appendChild(span);
        });
      }
      rowEl.appendChild(diffContent);

      // Editable cleaned result
      if (row.clean.trim()) {
        const editRow = document.createElement('div');
        editRow.className = 'diff-edit-row';
        editRow.dir = 'rtl';
        editRow.contentEditable = 'true';
        editRow.textContent = row.clean;
        editRow.title = 'Edit cleaned text before accepting';
        editRow.addEventListener('blur', () => { row.editedClean = editRow.textContent; });
        rowEl.appendChild(editRow);
      }
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'diff-row-checkbox-spacer';
      rowEl.appendChild(spacer);
      const unchanged = document.createElement('span');
      unchanged.className = 'diff-unchanged';
      unchanged.dir = 'rtl';
      unchanged.textContent = row.orig;
      rowEl.appendChild(unchanged);
    }

    rowsContainer.appendChild(rowEl);
    rowEls.push({ el: rowEl, changed: row.changed });
  });

  showOnlyCb.addEventListener('change', () => {
    rowEls.forEach(r => {
      if (!r.changed) r.el.style.display = showOnlyCb.checked ? 'none' : '';
    });
  });

  modal.appendChild(rowsContainer);

  // Footer
  const applyBar = document.createElement('div');
  applyBar.className = 'diff-apply-bar';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'action-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());
  applyBar.appendChild(cancelBtn);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn-secondary';
  applyBtn.textContent = 'Apply Selected';
  applyBtn.addEventListener('click', () => {
    const finalLines = rows.map(r => r.changed ? (r.accepted ? r.editedClean : r.orig) : r.orig);
    const finalText = finalLines.join('\n');
    updateState('cleaning', audioId, {
      originalText: rawOriginal, // locked: never overwritten
      cleanedText: finalText,
      cleanRate: calculateCleanRate(rawOriginal, finalText),
      cleanedAt: new Date().toISOString(),
    });
    overlay.remove();
    const s = getState();
    renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
  });
  applyBar.appendChild(applyBtn);
  modal.appendChild(applyBar);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
  });
  document.body.appendChild(overlay);
}

function renderUnifiedWorkSection(audioId, state, container, pageContainer, playerEl, activeVersionRef) {
  const cleaning = state.cleaning[audioId];
  const alignment = state.alignments[audioId];

  // ── Cleaning buttons ──
  // Returns the text of the currently selected version tab. For manual versions
  // (or no selection), loads the raw transcript from R2 / Supabase.
  async function getCurrentText() {
    const selectedId = activeVersionRef?.id;
    if (selectedId) {
      const versions = getVersions(audioId);
      const selected = versions.find(v => v.id === selectedId);
      if (selected && selected.type !== 'manual' && selected.text) {
        return selected.text;
      }
    }
    // Manual version selected, no version selected, or version has no text yet —
    // load from the raw transcript record (R2 → Supabase fallback)
    const m = getState().mappings[audioId];
    if (!m) return '';
    const t = getState().transcripts.find(tr => tr.id === m.transcriptId);
    if (!t) return '';
    if (t.text) return t.text;
    let text = null;
    if (t.r2TranscriptLink) {
      const res = await fetch(t.r2TranscriptLink).catch(() => null);
      if (res?.ok) text = await res.text().catch(() => null);
    }
    if (!text && t.id) text = await loadTranscriptText(t.id);
    if (text) t.text = text; // cache on transcript object for this session
    return text || t.firstLine || '';
  }
  async function getOriginalText() {
    const c = getState().cleaning[audioId];
    return c?.originalText || await getCurrentText();
  }

  const cleanLabel = document.createElement('div');
  cleanLabel.className = 'section-sublabel';
  cleanLabel.textContent = 'Cleaning — click a pass to preview changes line by line';
  container.appendChild(cleanLabel);

  const btnBar = document.createElement('div');
  btnBar.className = 'clean-btn-bar';
  const passes = [
    { label: 'Remove [brackets]',        fn: cleanBrackets },
    { label: 'Remove (parentheses)',      fn: cleanParentheses },
    { label: 'Remove section markers',    fn: cleanSectionMarkers },
    { label: 'Remove surrounding quotes', fn: cleanSurroundingQuotes },
    { label: 'Remove dashes / hyphens',   fn: cleanHyphens },
    { label: 'Remove ? marks',            fn: cleanQuestionMarks },
    { label: 'Remove ellipsis (…)',       fn: cleanEllipsis },
    { label: 'Clean whitespace',          fn: cleanWhitespace },
  ];
  passes.forEach(pass => {
    const btn = document.createElement('button');
    btn.className = 'action-btn clean-pass-btn';
    btn.textContent = pass.label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const origLabel = btn.textContent;
      btn.textContent = 'Loading...';
      try {
        const rawOriginal = await getOriginalText();
        const currentText = await getCurrentText();
        const previewText = pass.fn(currentText);
        openPassPreviewModal(audioId, pass.label, currentText, previewText, rawOriginal, pageContainer);
      } finally {
        btn.textContent = origLabel;
        btn.disabled = false;
      }
    });
    btnBar.appendChild(btn);
  });
  const cleanAllBtn = document.createElement('button');
  cleanAllBtn.className = 'action-btn action-btn-primary clean-pass-btn';
  cleanAllBtn.textContent = 'Clean All (no preview)';
  cleanAllBtn.addEventListener('click', async () => {
    cleanAllBtn.textContent = 'Cleaning...';
    cleanAllBtn.disabled = true;
    await batchClean([audioId], getState(), () => {});
    const s = getState();
    renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
  });
  btnBar.appendChild(cleanAllBtn);
  container.appendChild(btnBar);

  // ── Alignment button ──
  const alignBar = document.createElement('div');
  alignBar.style.cssText = 'display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap;';

  const alignBtn = document.createElement('button');
  alignBtn.className = 'action-btn action-btn-primary';
  alignBtn.textContent = alignment ? 'Re-Align' : 'Run Alignment';
  alignBtn.addEventListener('click', async () => {
    alignBtn.textContent = 'Aligning (may take ~2.5 min)...';
    alignBtn.disabled = true;
    try {
      const textForAlignment = await getCurrentText();
      await alignRow(audioId, getState(), textForAlignment);
    } catch (err) {
      alignBtn.textContent = 'Error: ' + err.message;
      return;
    }
    const s = getState();
    renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
  });
  alignBar.appendChild(alignBtn);

  if (alignment) {
    const info = document.createElement('span');
    info.className = 'text-secondary';
    info.style.fontSize = '0.82rem';
    info.textContent = `Avg: ${formatConfidence(alignment.avgConfidence)} | Low: ${alignment.lowConfidenceCount} words`;
    alignBar.appendChild(info);
  }
  container.appendChild(alignBar);

  // ── Unified Word View (diff + karaoke in one) ──
  if (cleaning || alignment) {
    if (alignment && !alignment.words) {
      // Words not loaded at startup — fetch lazily
      const placeholder = document.createElement('div');
      placeholder.className = 'text-secondary';
      placeholder.style.cssText = 'padding:12px;font-size:0.9rem;';
      placeholder.textContent = 'Loading word timestamps...';
      container.appendChild(placeholder);
      loadAlignmentWords(audioId).then(words => {
        const fullAlignment = words ? { ...alignment, words } : alignment;
        if (words) updateState('alignments', audioId, fullAlignment);
        placeholder.remove();
        renderWordView(audioId, cleaning, fullAlignment, container, pageContainer, playerEl);
      });
    } else {
      renderWordView(audioId, cleaning, alignment, container, pageContainer, playerEl);
    }
  }
}

function renderWordView(audioId, cleaning, alignment, container, pageContainer, playerEl) {
  const origText = cleaning?.originalText || '';
  const cleanText = cleaning?.cleanedText || origText;
  const words = alignment?.words || [];

  const viewer = document.createElement('div');
  viewer.className = 'word-view';

  // Speed controls if we have audio + alignment
  if (playerEl && words.length > 0) {
    const speedBar = document.createElement('div');
    speedBar.className = 'word-view-speed-bar';
    [0.5, 1, 1.5, 2].forEach(speed => {
      const btn = document.createElement('button');
      btn.className = 'speed-btn' + (speed === 1 ? ' active' : '');
      btn.textContent = speed + 'x';
      btn.addEventListener('click', () => {
        playerEl.playbackRate = speed;
        speedBar.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      speedBar.appendChild(btn);
    });
    viewer.appendChild(speedBar);
  }

  // Word grid
  const wordGrid = document.createElement('div');
  wordGrid.className = 'word-view-grid';
  wordGrid.dir = 'rtl';

  const chipEls = [];

  // Check if alignment words are actually populated
  const hasWordText = words.length > 0 && words.some(w => (w.word || w.text || '').length > 0);

  if (words.length > 0 && !hasWordText) {
    const notice = document.createElement('div');
    notice.style.cssText = 'padding:12px;color:var(--orange);font-size:0.9rem;';
    notice.textContent = 'Alignment data has empty word text. Please re-run alignment to fix.';
    wordGrid.appendChild(notice);
  }

  if (hasWordText) {
    // We have alignment — show word chips with confidence + diff
    const removedWords = new Set();
    if (cleaning && origText !== cleanText) {
      // Find words that were in original but not in cleaned
      const origTokens = origText.split(/\s+/).filter(Boolean);
      const cleanTokens = new Set(cleanText.split(/\s+/).filter(Boolean));
      origTokens.forEach(w => { if (!cleanTokens.has(w)) removedWords.add(w); });
    }

    if (words.length > 0) console.log('[WordView] sample words:', words.slice(0, 5));
    words.forEach((w, idx) => {
      const span = document.createElement('span');
      const conf = typeof w.confidence === 'number' ? w.confidence : 1;
      const level = conf >= 0.8 ? 'high' : conf >= 0.4 ? 'mid' : 'low';
      span.className = `word-chip confidence-${level}`;
      const wordText = w.word || w.text || '';
      span.title = `"${wordText}" ${(conf * 100).toFixed(0)}% | ${w.start.toFixed(2)}s–${w.end.toFixed(2)}s`;
      span.textContent = wordText;
      span.dataset.idx = idx;

      // Click to seek
      if (playerEl) {
        span.style.cursor = 'pointer';
        const seekFn = () => { playerEl.currentTime = w.start; if (playerEl.paused) playerEl.play(); };
        span._seekHandler = seekFn;
        span.addEventListener('click', seekFn);
      }

      wordGrid.appendChild(span);
      chipEls.push(span);
    });

    // Timeupdate highlight
    if (playerEl) {
      let prevActive = null;
      const onTimeUpdate = () => {
        const t = playerEl.currentTime;
        let activeIdx = -1;
        for (let i = 0; i < words.length; i++) {
          if (t >= words[i].start && t < words[i].end) { activeIdx = i; break; }
        }
        if (prevActive !== null && prevActive !== activeIdx) {
          chipEls[prevActive]?.classList.remove('active');
        }
        if (activeIdx >= 0 && activeIdx !== prevActive) {
          chipEls[activeIdx].classList.add('active');
          chipEls[activeIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        prevActive = activeIdx;
      };
      playerEl.addEventListener('timeupdate', onTimeUpdate);
    }

    // ── Inline word editing ──
    const editModeWords = words.map(w => ({ ...w }));
    let editMode = false;

    const editBar = document.createElement('div');
    editBar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;';

    const editToggleBtn = document.createElement('button');
    editToggleBtn.className = 'btn btn-secondary';
    editToggleBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;';
    editToggleBtn.textContent = 'Edit Words';

    const saveEditsBtn = document.createElement('button');
    saveEditsBtn.className = 'btn btn-primary';
    saveEditsBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;display:none;';
    saveEditsBtn.textContent = 'Save Word Edits';

    const editStatus = document.createElement('span');
    editStatus.className = 'text-secondary';
    editStatus.style.fontSize = '0.8rem';

    editBar.appendChild(editToggleBtn);
    editBar.appendChild(saveEditsBtn);
    editBar.appendChild(editStatus);

    // Bulk text panel (all-at-once editing)
    const bulkPanel = document.createElement('div');
    bulkPanel.style.cssText = 'display:none;margin-top:8px;';
    const bulkTextarea = document.createElement('textarea');
    bulkTextarea.className = 'transcript-editor';
    bulkTextarea.dir = 'rtl';
    bulkTextarea.rows = 6;
    bulkTextarea.style.cssText = 'width:100%;box-sizing:border-box;font-size:0.85rem;';
    const bulkBtnRow = document.createElement('div');
    bulkBtnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;align-items:center;';
    const bulkApplyBtn = document.createElement('button');
    bulkApplyBtn.className = 'btn btn-secondary';
    bulkApplyBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;';
    bulkApplyBtn.textContent = 'Apply Text to Words';
    const bulkStatus = document.createElement('span');
    bulkStatus.className = 'text-secondary';
    bulkStatus.style.fontSize = '0.8rem';
    bulkBtnRow.appendChild(bulkApplyBtn);
    bulkBtnRow.appendChild(bulkStatus);
    bulkPanel.appendChild(bulkTextarea);
    bulkPanel.appendChild(bulkBtnRow);

    function startChipEdit(chip, idx) {
      if (chip.querySelector('input')) return;
      const origText = editModeWords[idx].word || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = origText;
      input.style.cssText = 'width:auto;min-width:30px;max-width:100px;font-size:inherit;padding:1px 3px;background:var(--surface);color:var(--text);border:1px solid var(--accent);border-radius:3px;box-sizing:content-box;';
      // size input dynamically
      input.size = Math.max(3, origText.length + 1);
      chip.textContent = '';
      chip.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        const val = input.value.trim() || origText;
        editModeWords[idx] = { ...editModeWords[idx], word: val };
        chip.textContent = val;
        bulkTextarea.value = editModeWords.map(w => w.word || '').join(' ');
        editStatus.textContent = '';
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { chip.textContent = origText; }
        if (e.key === 'Tab') {
          e.preventDefault();
          commit();
          const next = chipEls[idx + (e.shiftKey ? -1 : 1)];
          if (next) next.click();
        }
      });
    }

    function enterEditMode() {
      editMode = true;
      editToggleBtn.textContent = 'Exit Edit Mode';
      saveEditsBtn.style.display = '';
      bulkTextarea.value = editModeWords.map(w => w.word || '').join(' ');
      bulkPanel.style.display = '';
      chipEls.forEach((chip, idx) => {
        chip.style.cursor = 'text';
        chip._editHandler = () => startChipEdit(chip, idx);
        chip.addEventListener('click', chip._editHandler);
        // Disable seek-click while editing
        if (chip._seekHandler) chip.removeEventListener('click', chip._seekHandler);
      });
      editStatus.textContent = 'Click a word to edit it';
    }

    function exitEditMode() {
      editMode = false;
      editToggleBtn.textContent = 'Edit Words';
      saveEditsBtn.style.display = 'none';
      bulkPanel.style.display = 'none';
      editStatus.textContent = '';
      chipEls.forEach((chip, idx) => {
        if (chip._editHandler) {
          chip.removeEventListener('click', chip._editHandler);
          chip._editHandler = null;
        }
        chip.style.cursor = playerEl ? 'pointer' : '';
        // Restore seek-click
        if (playerEl && chip._seekHandler) chip.addEventListener('click', chip._seekHandler);
      });
    }

    bulkApplyBtn.addEventListener('click', () => {
      const tokens = bulkTextarea.value.trim().split(/\s+/).filter(Boolean);
      if (tokens.length !== editModeWords.length) {
        bulkStatus.style.color = 'var(--orange)';
        bulkStatus.textContent = `Word count mismatch: ${tokens.length} vs ${editModeWords.length} expected`;
        return;
      }
      tokens.forEach((tok, i) => { editModeWords[i] = { ...editModeWords[i], word: tok }; });
      chipEls.forEach((chip, i) => { chip.textContent = editModeWords[i].word; });
      bulkStatus.style.color = 'var(--green)';
      bulkStatus.textContent = `${tokens.length} words updated — click Save to keep`;
    });

    editToggleBtn.addEventListener('click', () => {
      if (!editMode) enterEditMode(); else exitEditMode();
    });

    saveEditsBtn.addEventListener('click', () => {
      // Commit any open input first
      const openInput = wordGrid.querySelector('input');
      if (openInput) openInput.blur();
      const currentState = getState();
      const currentAlignment = currentState.alignments?.[audioId] || alignment;
      updateState('alignments', audioId, { ...currentAlignment, words: editModeWords });
      exitEditMode();
      editStatus.textContent = 'Saved';
      setTimeout(() => { editStatus.textContent = ''; }, 2500);
    });

    viewer.appendChild(editBar);
    viewer.appendChild(bulkPanel);
  } else if (cleaning) {
    // No alignment yet — show line-by-line diff with word-level removed highlighting
    const origLines = origText.split('\n');
    const cleanLines = cleanText.split('\n');
    const maxLen = Math.max(origLines.length, cleanLines.length);

    for (let i = 0; i < maxLen; i++) {
      const orig = origLines[i] || '';
      const clean = cleanLines[i] || '';
      if (orig === clean) {
        // Unchanged line — plain text
        const lineSpan = document.createElement('span');
        lineSpan.className = 'word-view-line';
        lineSpan.textContent = orig;
        wordGrid.appendChild(lineSpan);
      } else {
        // Changed line — word-level diff
        const lineDiv = document.createElement('span');
        lineDiv.className = 'word-view-line word-view-line-changed';
        const tokens = wordDiffTokens(orig, clean);
        tokens.forEach(tok => {
          if (tok.isSpace) {
            lineDiv.appendChild(document.createTextNode(tok.text));
            return;
          }
          const s = document.createElement('span');
          s.textContent = tok.text;
          if (tok.removed) s.className = 'diff-word-removed';
          else if (tok.added) s.className = 'diff-word-added';
          lineDiv.appendChild(s);
        });
        wordGrid.appendChild(lineDiv);
      }
      // Line break
      wordGrid.appendChild(document.createElement('br'));
    }
  }

  viewer.appendChild(wordGrid);

  // Save as edited version button
  if (cleaning) {
    const saveBar = document.createElement('div');
    saveBar.className = 'word-view-save-bar';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-secondary';
    saveBtn.textContent = 'Save Cleaned Text as Edited Version';
    saveBtn.addEventListener('click', () => {
      addVersion(audioId, {
        type: 'edited',
        text: cleaning.cleanedText,
        alignment: alignment || undefined,
        createdBy: 'user-review',
      });
      const s = getState();
      renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
    });
    saveBar.appendChild(saveBtn);
    viewer.appendChild(saveBar);
  }

  container.appendChild(viewer);
}

function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '0:00';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
}

function renderTrimControls(audioId, playerEl, container) {
  const state = getState();
  const saved = state.trims?.[audioId] || {};
  let trimStart = saved.start || 0;
  let trimEnd = saved.end || 0;
  let duration = 0;
  let trimEndTimerId = null;
  let isDragging = false;

  const wrap = document.createElement('div');
  wrap.className = 'trim-controls';

  // Label
  const label = document.createElement('div');
  label.className = 'trim-label';
  label.textContent = 'Audio Range Selection';
  wrap.appendChild(label);

  // Slider area — taller hit zone
  const slider = document.createElement('div');
  slider.className = 'trim-slider';

  const track = document.createElement('div');
  track.className = 'trim-track';

  const range = document.createElement('div');
  range.className = 'trim-range';

  // Playhead indicator
  const playhead = document.createElement('div');
  playhead.className = 'trim-playhead';

  const handleStart = document.createElement('div');
  handleStart.className = 'trim-handle trim-handle-start';
  handleStart.title = 'Drag to set start';

  const handleEnd = document.createElement('div');
  handleEnd.className = 'trim-handle trim-handle-end';
  handleEnd.title = 'Drag to set end';

  track.appendChild(range);
  track.appendChild(playhead);
  track.appendChild(handleStart);
  track.appendChild(handleEnd);
  slider.appendChild(track);
  wrap.appendChild(slider);

  // Time inputs row
  const timeRow = document.createElement('div');
  timeRow.className = 'trim-time-row';

  const startGroup = document.createElement('div');
  startGroup.className = 'trim-time-group';
  const startLabel = document.createElement('label');
  startLabel.textContent = 'Start';
  startLabel.className = 'trim-input-label';
  const startInput = document.createElement('input');
  startInput.type = 'text';
  startInput.className = 'trim-time-input';
  startInput.value = formatTime(trimStart);
  startInput.title = 'mm:ss';
  startGroup.appendChild(startLabel);
  startGroup.appendChild(startInput);

  const endGroup = document.createElement('div');
  endGroup.className = 'trim-time-group';
  const endLabel = document.createElement('label');
  endLabel.textContent = 'End';
  endLabel.className = 'trim-input-label';
  const endInput = document.createElement('input');
  endInput.type = 'text';
  endInput.className = 'trim-time-input';
  endInput.value = formatTime(trimEnd || 0);
  endInput.title = 'mm:ss';
  endGroup.appendChild(endLabel);
  endGroup.appendChild(endInput);

  const durationInfo = document.createElement('span');
  durationInfo.className = 'trim-duration-info';

  timeRow.appendChild(startGroup);
  timeRow.appendChild(endGroup);
  timeRow.appendChild(durationInfo);
  wrap.appendChild(timeRow);

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'trim-btn-row';

  const setStartBtn = document.createElement('button');
  setStartBtn.className = 'action-btn';
  setStartBtn.textContent = 'Set Start to Playhead';

  const setEndBtn = document.createElement('button');
  setEndBtn.className = 'action-btn';
  setEndBtn.textContent = 'Set End to Playhead';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'action-btn action-btn-primary';
  previewBtn.textContent = 'Preview Trimmed';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'action-btn action-btn-danger';
  resetBtn.textContent = 'Reset';

  btnRow.appendChild(setStartBtn);
  btnRow.appendChild(setEndBtn);
  btnRow.appendChild(previewBtn);
  btnRow.appendChild(resetBtn);
  wrap.appendChild(btnRow);
  container.appendChild(wrap);

  function parseTimeInput(str) {
    const parts = str.trim().split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const s = parseInt(parts[1], 10);
      if (!isNaN(m) && !isNaN(s)) return m * 60 + s;
    }
    const n = parseFloat(str);
    return isNaN(n) ? null : n;
  }

  function getEffectiveEnd() {
    return trimEnd > 0 ? trimEnd : duration;
  }

  function updateDisplay() {
    const effEnd = getEffectiveEnd();
    const trimDuration = Math.max(0, effEnd - trimStart);
    startInput.value = formatTime(trimStart);
    endInput.value = formatTime(effEnd);
    durationInfo.textContent = 'Selected: ' + formatTime(trimDuration) +
      (duration > 0 ? ' of ' + formatTime(duration) : '');
  }

  function updateSlider() {
    if (duration <= 0) return;
    const startPct = (trimStart / duration) * 100;
    const endPct = ((trimEnd > 0 ? trimEnd : duration) / duration) * 100;
    range.style.left = startPct + '%';
    range.style.width = (endPct - startPct) + '%';
    handleStart.style.left = startPct + '%';
    handleEnd.style.left = endPct + '%';
  }

  function updatePlayhead() {
    if (duration <= 0) return;
    const pct = (playerEl.currentTime / duration) * 100;
    playhead.style.left = pct + '%';
  }

  function saveTrim() {
    updateState('trims', audioId, { start: trimStart, end: trimEnd });
    updateDisplay();
    updateSlider();
  }

  // Time input change handlers
  startInput.addEventListener('change', () => {
    const val = parseTimeInput(startInput.value);
    if (val != null && val >= 0) {
      trimStart = Math.min(val, getEffectiveEnd() - 1);
      saveTrim();
    } else {
      startInput.value = formatTime(trimStart);
    }
  });

  endInput.addEventListener('change', () => {
    const val = parseTimeInput(endInput.value);
    if (val != null && val > trimStart) {
      trimEnd = (duration > 0 && val >= duration) ? 0 : val;
      saveTrim();
    } else {
      endInput.value = formatTime(getEffectiveEnd());
    }
  });

  playerEl.addEventListener('loadedmetadata', () => {
    duration = playerEl.duration;
    if (trimStart > duration) trimStart = 0;
    if (trimEnd > duration) trimEnd = 0;
    updateDisplay();
    updateSlider();
  });

  if (playerEl.duration && isFinite(playerEl.duration)) {
    duration = playerEl.duration;
    if (trimStart > duration) trimStart = 0;
    if (trimEnd > duration) trimEnd = 0;
    updateDisplay();
    updateSlider();
  }

  // Playhead tracking
  playerEl.addEventListener('timeupdate', updatePlayhead);

  playerEl.addEventListener('play', () => {
    if (trimStart > 0 && playerEl.currentTime < trimStart) {
      playerEl.currentTime = trimStart;
    }
    startTrimEndCheck();
  });

  playerEl.addEventListener('pause', () => stopTrimEndCheck());
  playerEl.addEventListener('ended', () => stopTrimEndCheck());

  function startTrimEndCheck() {
    stopTrimEndCheck();
    const effEnd = getEffectiveEnd();
    if (effEnd <= 0 || effEnd >= duration) return;
    trimEndTimerId = setInterval(() => {
      if (playerEl.currentTime >= effEnd) {
        playerEl.pause();
        playerEl.currentTime = effEnd;
        stopTrimEndCheck();
      }
    }, 100);
  }

  function stopTrimEndCheck() {
    if (trimEndTimerId) {
      clearInterval(trimEndTimerId);
      trimEndTimerId = null;
    }
  }

  setStartBtn.addEventListener('click', () => {
    trimStart = Math.max(0, playerEl.currentTime);
    if (trimEnd > 0 && trimStart >= trimEnd) trimStart = Math.max(0, trimEnd - 1);
    saveTrim();
  });

  setEndBtn.addEventListener('click', () => {
    trimEnd = Math.min(duration || Infinity, playerEl.currentTime);
    if (trimEnd <= trimStart) trimEnd = trimStart + 1;
    if (trimEnd >= duration) trimEnd = 0;
    saveTrim();
  });

  previewBtn.addEventListener('click', () => {
    playerEl.currentTime = trimStart;
    playerEl.play();
  });

  resetBtn.addEventListener('click', () => {
    trimStart = 0;
    trimEnd = 0;
    saveTrim();
  });

  // Draggable handles with proper event isolation
  function makeDraggable(handle, onDrag) {
    function getPos(e) {
      const rect = track.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      let pct = (clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      return pct * duration;
    }

    function onStart(e) {
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    }

    function onMove(e) {
      if (!isDragging || duration <= 0) return;
      e.preventDefault();
      onDrag(getPos(e));
      updateDisplay();
      updateSlider();
    }

    function onEnd() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      saveTrim();
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });
  }

  makeDraggable(handleStart, (pos) => {
    trimStart = Math.max(0, pos);
    const effEnd = trimEnd > 0 ? trimEnd : duration;
    if (trimStart >= effEnd - 1) trimStart = effEnd - 1;
  });

  makeDraggable(handleEnd, (pos) => {
    trimEnd = Math.min(duration, pos);
    if (trimEnd <= trimStart + 1) trimEnd = trimStart + 1;
    if (trimEnd >= duration) trimEnd = 0;
  });

  // Click on track to seek (only if not dragging)
  track.addEventListener('click', (e) => {
    if (isDragging || duration <= 0) return;
    // Don't seek if clicking on a handle
    if (e.target.classList.contains('trim-handle')) return;
    const rect = track.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const time = Math.max(0, Math.min(duration, pct * duration));
    playerEl.currentTime = time;
  });

  updateDisplay();
  updateSlider();
}

// Word-level diff: returns array of {text, removed, added, isSpace} tokens.
// Both removed (orig only) and added (clean only) tokens are returned so the
// display can show ~~old~~ +new side by side.
function wordDiffTokens(origLine, cleanLine) {
  const origWords = origLine.split(/(\s+)/);
  const cleanWords = cleanLine.split(/\s+/).filter(Boolean);
  const result = [];
  let ci = 0;

  for (const token of origWords) {
    if (/^\s+$/.test(token)) {
      result.push({ text: token, isSpace: true });
      continue;
    }
    if (ci < cleanWords.length && token === cleanWords[ci]) {
      // Exact match — unchanged
      result.push({ text: token });
      ci++;
    } else {
      const ahead = cleanWords.indexOf(token, ci);
      if (ahead >= 0) {
        // Clean has extra words before this match — show them as added
        for (let j = ci; j < ahead; j++) {
          result.push({ text: cleanWords[j], added: true });
          result.push({ text: ' ', isSpace: true });
        }
        result.push({ text: token });
        ci = ahead + 1;
      } else {
        // Orig word is removed; if the next clean word is different, show it as added replacement
        result.push({ text: token, removed: true });
        if (ci < cleanWords.length && cleanWords[ci] !== token) {
          // Peek: is the clean word a modified version of this one (e.g. "שנה?" → "שנה")?
          const nextClean = cleanWords[ci];
          const nextAhead = origWords.indexOf(nextClean, origWords.indexOf(token) + 1);
          if (nextAhead < 0) {
            // Clean word doesn't appear later in orig — it's a replacement
            result.push({ text: ' ', isSpace: true });
            result.push({ text: nextClean, added: true });
            ci++;
          }
        }
      }
    }
  }
  // Any remaining clean words not matched — show as added
  for (; ci < cleanWords.length; ci++) {
    result.push({ text: ' ', isSpace: true });
    result.push({ text: cleanWords[ci], added: true });
  }
  return result;
}

function renderCleaningDiffViewer(audioId, cleaning, container, pageContainer) {
  const origLines = (cleaning.originalText || '').split('\n');
  const cleanLines = (cleaning.cleanedText || '').split('\n');
  const maxLen = Math.max(origLines.length, cleanLines.length);

  const rows = [];
  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i] || '';
    const clean = cleanLines[i] || '';
    const changed = orig !== clean;
    rows.push({ lineNum: i + 1, orig, clean, changed, accepted: true, editedClean: clean });
  }

  const changedCount = rows.filter(r => r.changed).length;
  if (changedCount === 0) return;

  const viewer = document.createElement('div');
  viewer.className = 'diff-viewer';

  // Header
  const header = document.createElement('div');
  header.className = 'diff-header';
  header.innerHTML = '<strong>Cleaning Diff</strong> — ' +
    '<span class="diff-legend-orig">Red strikethrough = removed</span> &nbsp; ' +
    'Remaining text stays. Click cleaned text to edit inline.';
  viewer.appendChild(header);

  // Action bar
  const actions = document.createElement('div');
  actions.className = 'diff-actions';

  const countLabel = document.createElement('span');
  countLabel.className = 'text-secondary';
  countLabel.textContent = changedCount + ' line' + (changedCount !== 1 ? 's' : '') + ' changed';
  actions.appendChild(countLabel);

  const acceptAllBtn = document.createElement('button');
  acceptAllBtn.className = 'action-btn';
  acceptAllBtn.textContent = 'Accept All';
  acceptAllBtn.addEventListener('click', () => {
    rows.forEach(r => { if (r.changed) r.accepted = true; });
    viewer.querySelectorAll('.diff-row-checkbox').forEach(cb => { cb.checked = true; });
  });
  actions.appendChild(acceptAllBtn);

  const rejectAllBtn = document.createElement('button');
  rejectAllBtn.className = 'action-btn action-btn-danger';
  rejectAllBtn.textContent = 'Reject All';
  rejectAllBtn.addEventListener('click', () => {
    rows.forEach(r => { if (r.changed) r.accepted = false; });
    viewer.querySelectorAll('.diff-row-checkbox').forEach(cb => { cb.checked = false; });
  });
  actions.appendChild(rejectAllBtn);

  const showOnlyChanged = document.createElement('label');
  showOnlyChanged.className = 'diff-filter-label';
  const showOnlyCb = document.createElement('input');
  showOnlyCb.type = 'checkbox';
  showOnlyChanged.appendChild(showOnlyCb);
  showOnlyChanged.appendChild(document.createTextNode(' Changed only'));
  actions.appendChild(showOnlyChanged);

  viewer.appendChild(actions);

  // Rows
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'diff-rows-container';

  const rowEls = [];
  rows.forEach((row) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'diff-row' + (row.changed ? ' diff-row-changed' : '');

    const lineNum = document.createElement('span');
    lineNum.className = 'diff-row-linenum';
    lineNum.textContent = row.lineNum;
    rowEl.appendChild(lineNum);

    if (row.changed) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'diff-row-checkbox';
      cb.checked = row.accepted;
      cb.title = 'Accept this change';
      cb.addEventListener('change', () => {
        row.accepted = cb.checked;
        rowEl.classList.toggle('diff-row-rejected', !cb.checked);
      });
      rowEl.appendChild(cb);

      // Word-level diff display: show original with removed words struck through
      const diffContent = document.createElement('div');
      diffContent.className = 'diff-word-content';
      diffContent.dir = 'rtl';

      const tokens = wordDiffTokens(row.orig, row.clean);
      tokens.forEach(tok => {
        if (tok.isSpace) {
          diffContent.appendChild(document.createTextNode(tok.text));
          return;
        }
        const span = document.createElement('span');
        span.textContent = tok.text;
        if (tok.removed) span.className = 'diff-word-removed';
        else if (tok.added) span.className = 'diff-word-added';
        diffContent.appendChild(span);
      });

      // If entire line was removed
      if (!row.clean.trim() && row.orig.trim()) {
        diffContent.innerHTML = '';
        const allRemoved = document.createElement('span');
        allRemoved.className = 'diff-word-removed';
        allRemoved.textContent = row.orig;
        diffContent.appendChild(allRemoved);
      }

      rowEl.appendChild(diffContent);

      // Editable cleaned text below
      if (row.clean.trim()) {
        const editRow = document.createElement('div');
        editRow.className = 'diff-edit-row';
        editRow.dir = 'rtl';
        editRow.contentEditable = 'true';
        editRow.textContent = row.clean;
        editRow.title = 'Edit cleaned text';
        editRow.addEventListener('blur', () => {
          row.editedClean = editRow.textContent;
        });
        rowEl.appendChild(editRow);
      }
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'diff-row-checkbox-spacer';
      rowEl.appendChild(spacer);

      const unchanged = document.createElement('span');
      unchanged.className = 'diff-unchanged';
      unchanged.dir = 'rtl';
      unchanged.textContent = row.orig;
      rowEl.appendChild(unchanged);
    }

    rowsContainer.appendChild(rowEl);
    rowEls.push({ el: rowEl, changed: row.changed });
  });

  showOnlyCb.addEventListener('change', () => {
    rowEls.forEach(r => {
      if (!r.changed) r.el.style.display = showOnlyCb.checked ? 'none' : '';
    });
  });

  viewer.appendChild(rowsContainer);

  // Bottom bar
  const applyBar = document.createElement('div');
  applyBar.className = 'diff-apply-bar';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'action-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { viewer.remove(); });
  applyBar.appendChild(cancelBtn);

  const applyInfo = document.createElement('span');
  applyInfo.className = 'text-secondary';
  applyInfo.style.fontSize = '0.82rem';
  applyInfo.textContent = 'Creates a new "Edited" version in Transcript Mapping tabs';
  applyBar.appendChild(applyInfo);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn-secondary';
  applyBtn.textContent = 'Save as Edited Version';
  applyBtn.addEventListener('click', () => {
    const finalLines = rows.map(r => {
      if (!r.changed) return r.orig;
      return r.accepted ? r.editedClean : r.orig;
    });
    const finalText = finalLines.join('\n');
    addVersion(audioId, {
      type: 'edited',
      text: finalText,
      createdBy: 'user-diff-review',
    });
    const s = getState();
    const audio = s.audio.find(a => a.id === audioId);
    renderDetailPage(audioId, audio, s, pageContainer);
  });
  applyBar.appendChild(applyBtn);
  viewer.appendChild(applyBar);

  container.appendChild(viewer);
}
