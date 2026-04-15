import { initState, getState, getStatus, getVersions, getBestVersion, addVersion, updateVersion, updateState, mergeSupabaseData, setVersionAlignment, getAlignedVersions, getPipelineStep, getIterationCount, setSegmentApprovals, getApprovedSegments, toggleSegmentApproval } from './state.js';
import { checkAuth, signOut, getCurrentUser, getUserLibraries, getActiveLibrary, setActiveLibrary, getActiveLibraryConfig, isLibraryR2Url, getAccessToken } from './auth.js';
import { renderSuggestedMatches, linkMatch, unlinkMatch, renderSearchModal } from './mapping.js';
import { batchClean, cleanSectionMarkers, cleanMinor, cleanIntroText, findBracketMatches, findParenMatches, applyMatchActions, calculateCleanRate } from './cleaning.js';
import { alignRow, transcribeAudio } from './alignment.js';
import { renderAsrConfig, runBenchmark, renderBenchmarkTable } from './benchmark.js';
import { buildAsrConfigPanel } from './asr-config.js';

import { formatConfidence, getConfidenceLevel, generateSRT, generateVTT, downloadFile } from './utils.js';
import { loadAlignmentWords, loadTranscriptText, loadFromSupabase, syncAudioDuration, syncAudioField, loadSegmentApprovals, syncSegmentApproval } from './db.js';

// Loads full transcript text using R2 first, then Supabase fallback.
// Caches on the transcript object for the session.
async function loadFullText(transcript) {
  if (transcript.text) return transcript.text;
  let text = null;
  if (transcript.r2TranscriptLink) {
    try {
      const parsed = new URL(transcript.r2TranscriptLink);
      const path = parsed.pathname.replace(/^\//, ''); // strip leading slash
      const params = new URLSearchParams({ name: path, domain: parsed.hostname });
      const res = await fetch('/api/transcript?' + params).catch(() => null);
      if (res?.ok) text = await res.text().catch(() => null);
    } catch { /* fall through to db fallback */ }
  }
  if (!text && transcript.id) {
    text = await loadTranscriptText(transcript.id);
  }
  if (text) transcript.text = text;
  return text;
}

// Renders a speed-control bar for an audio player element.
function renderSpeedBar(playerEl, speeds) {
  const speedBar = document.createElement('div');
  speedBar.className = 'word-view-speed-bar';
  speeds.forEach(speed => {
    const btn = document.createElement('button');
    btn.className = 'speed-btn' + (speed === 1 ? ' active' : '');
    btn.textContent = speed + 'x';
    btn.setAttribute('aria-label', 'Set playback speed to ' + speed + 'x');
    btn.addEventListener('click', () => {
      playerEl.playbackRate = speed;
      speedBar.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    speedBar.appendChild(btn);
  });
  return speedBar;
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!await checkAuth()) return;

  document.getElementById('btn-logout')?.addEventListener('click', signOut);

  // Load library memberships and wire the selector
  const libraries = await getUserLibraries();
  const activeLib = getActiveLibrary();
  const activeLibConfig = (libraries.find(l => l.id === activeLib) || libraries[0]) || null;
  if (activeLibConfig) {
    document.getElementById('app-title').textContent = `${activeLibConfig.name} ASR Workbench`;
    document.title = `${activeLibConfig.name} ASR — Detail`;
  }
  const libSelector = document.getElementById('library-selector');
  if (libraries.length > 1 && libSelector) {
    for (const lib of libraries) {
      const opt = document.createElement('option');
      opt.value = lib.id;
      opt.textContent = lib.name;
      if (lib.id === activeLib) opt.selected = true;
      libSelector.appendChild(opt);
    }
    libSelector.style.display = '';
    libSelector.addEventListener('change', () => {
      setActiveLibrary(libSelector.value);
      location.href = '/';
    });
  }

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
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  });

  // Load data from Supabase (single source of truth)
  page.innerHTML = '<div class="loading-state">Loading…</div>';
  let remote;
  try {
    remote = await loadFromSupabase(activeLib);
  } catch (err) {
    page.innerHTML = `<div class="empty-state"><div class="empty-state-title">Failed to load data: ${err.message}</div></div>`;
    return;
  }

  initState({ audio: remote.audio, transcripts: remote.transcripts });
  mergeSupabaseData(remote);

  // Load segment approvals for this audio file (persisted per-segment review state)
  if (audioId) {
    const approvalHashes = await loadSegmentApprovals(audioId).catch(() => []);
    setSegmentApprovals(audioId, approvalHashes);
  }

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
    if (newName && newName !== transcript.name) {
      transcript.name = newName;
      // Note: transcript rename is display-only for this session; no Supabase sync exists for transcript names yet
    }
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

  // Load full text from R2 / Supabase
  if (!transcript.text) {
    loadFullText(transcript).then(text => {
      if (text) textarea.value = text;
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
      updateState('audioNames', audioId, newName);
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

  // 50-Hour toggle button
  const fiftyBtn = document.createElement('button');
  fiftyBtn.className = 'action-btn fifty-toggle-btn';
  fiftyBtn.style.marginLeft = '12px';
  function updateFiftyBtn() {
    if (audio.isSelected50hr) {
      fiftyBtn.textContent = 'Remove from 50hr';
      fiftyBtn.classList.add('fifty-active');
    } else {
      fiftyBtn.textContent = 'Add to 50hr';
      fiftyBtn.classList.remove('fifty-active');
    }
  }
  updateFiftyBtn();
  fiftyBtn.addEventListener('click', () => {
    audio.isSelected50hr = !audio.isSelected50hr;
    syncAudioField(audioId, 'is_selected_50hr', audio.isSelected50hr).catch(console.warn);
    updateFiftyBtn();
    // Update meta text
    const metaItems = [
      audio.year && `Year: ${audio.year}`,
      audio.type && `Type: ${audio.type}`,
      audio.isSelected50hr && '50-Hour Set',
      audio.isBenchmark && 'Benchmark',
    ].filter(Boolean);
    // Keep only text nodes (not the durationSpan or button)
    for (const node of [...meta.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    }
    meta.insertBefore(document.createTextNode(metaItems.join('  |  ')), meta.firstChild);
  });
  meta.appendChild(fiftyBtn);

  container.appendChild(meta);

  // === Section: Comments ===
  const commentsSection = createSection('Comments');
  addCollapseBehavior(commentsSection.el, commentsSection.header, true);
  const commentDisplay = document.createElement('div');
  commentDisplay.className = 'detail-comment-display';
  const currentComment = audio.comments || (getState().audioComments || {})[audioId] || '';
  if (currentComment) {
    commentDisplay.textContent = currentComment;
  } else {
    commentDisplay.textContent = '+ Add comment';
    commentDisplay.classList.add('comment-placeholder');
  }
  commentDisplay.addEventListener('click', () => {
    const textarea = document.createElement('textarea');
    textarea.className = 'detail-comment-input';
    textarea.value = currentComment;
    textarea.rows = 4;
    textarea.placeholder = 'Add a comment…';
    commentsSection.content.replaceChild(textarea, commentDisplay);
    textarea.focus();
    let saved = false;
    const save = () => {
      if (saved) return;
      saved = true;
      const newVal = textarea.value.trim();
      if (newVal !== currentComment) {
        audio.comments = newVal;
        updateState('audioComments', audioId, newVal);
      }
      commentDisplay.textContent = newVal || '+ Add comment';
      commentDisplay.className = 'detail-comment-display' + (newVal ? '' : ' comment-placeholder');
      commentsSection.content.replaceChild(commentDisplay, textarea);
    };
    textarea.addEventListener('blur', save);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        saved = true;
        commentsSection.content.replaceChild(commentDisplay, textarea);
      }
    });
  });
  commentsSection.content.appendChild(commentDisplay);
  container.appendChild(commentsSection.el);

  // === Section: Audio Player ===
  const playerSection = createSection('Audio Player');
  addCollapseBehavior(playerSection.el, playerSection.header, false);

  const playerEl = document.createElement('audio');
  playerEl.controls = true;
  playerEl.preload = 'metadata';
  playerEl.className = 'audio-player';
  playerEl.addEventListener('loadedmetadata', () => {
    const realMin = parseFloat((playerEl.duration / 60).toFixed(1));
    durationSpan.textContent = `${metaItems.length ? '  |  ' : ''}Duration: ${realMin} min`;
    if (audio.estMinutes !== realMin) {
      audio.estMinutes = realMin;
      syncAudioDuration(audioId, realMin).catch(console.warn);
    }
  }, { once: true });

  if (audio.r2Link) {
    // R2 link exists — use it directly
    playerEl.src = isLibraryR2Url(audio.r2Link) ? `/api/audio?url=${encodeURIComponent(audio.r2Link)}` : audio.r2Link;
    playerSection.content.appendChild(playerEl);
    playerSection.content.appendChild(renderSpeedBar(playerEl, [1, 1.25, 1.5, 2, 2.5, 3]));
    renderTrimControls(audioId, playerEl, playerSection.content);
  } else if (audio.driveLink) {
    // No R2 link — auto-migrate from Google Drive
    const migrateStatus = document.createElement('div');
    migrateStatus.className = 'migrate-status';
    migrateStatus.textContent = 'Migrating audio from Google Drive to R2…';
    playerSection.content.appendChild(migrateStatus);
    playerSection.content.appendChild(playerEl);
    playerSection.content.appendChild(renderSpeedBar(playerEl, [1, 1.25, 1.5, 2, 2.5, 3]));
    renderTrimControls(audioId, playerEl, playerSection.content);

    // Kick off migration in background
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) { migrateStatus.textContent = 'Not authenticated — cannot migrate'; return; }
        const res = await fetch('/api/migrate-audio', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioId,
            driveLink: audio.driveLink,
            fileName: audio.name || audioId,
            libraryId: getActiveLibrary(),
          }),
        });
        const result = await res.json();
        if (!res.ok) {
          migrateStatus.textContent = 'Migration failed: ' + (result.error || res.status);
          migrateStatus.style.color = 'var(--red)';
          return;
        }
        // Success — update local state and load the player
        audio.r2Link = result.r2Link;
        playerEl.src = `/api/audio?url=${encodeURIComponent(result.r2Link)}`;
        migrateStatus.textContent = 'Migrated to R2 successfully';
        migrateStatus.style.color = 'var(--green)';
        setTimeout(() => migrateStatus.remove(), 3000);
      } catch (err) {
        migrateStatus.textContent = 'Migration error: ' + err.message;
        migrateStatus.style.color = 'var(--red)';
      }
    })();
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
    // Collapse mapping on mobile if already mapped or further along
    addCollapseBehavior(mappingSection.el, mappingSection.header, status !== 'unmapped');
    const activeVersionRef = { id: getBestVersion(audioId)?.id || null };
    renderMappingSection(audioId, state, mappingSection.content, container, activeVersionRef);
    container.appendChild(mappingSection.el);

    // === Section: Cleaning + Alignment + Word View (unified) ===
    if (state.mappings[audioId]) {
      const workSection = createSection('Processing');
      // Collapse processing on mobile only when fully approved
      addCollapseBehavior(workSection.el, workSection.header, status === 'approved');
      const playerEl = container.querySelector('.audio-player');
      renderUnifiedWorkSection(audioId, state, workSection.content, container, playerEl, activeVersionRef);
      container.appendChild(workSection.el);
    }
  } else {
    // === Benchmark file: ASR config + Run Benchmark + results ===
    const benchSection = createSection('Benchmark');
    addCollapseBehavior(benchSection.el, benchSection.header, false);

    const benchNote = document.createElement('p');
    benchNote.className = 'text-secondary';
    benchNote.style.cssText = 'font-size:0.85rem;margin-bottom:10px;';
    benchNote.textContent = 'This is a benchmark file. Configure ASR models and run them against the gold-standard transcripts to measure accuracy (WER/CER). Benchmark files cannot be approved into the training set.';
    benchSection.content.appendChild(benchNote);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;';

    const configBtn = document.createElement('button');
    configBtn.className = 'btn btn-secondary';
    configBtn.textContent = 'Configure ASR Models';
    configBtn.addEventListener('click', () => {
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      const inner = document.createElement('div');
      inner.className = 'modal';
      inner.style.cssText = 'max-width:600px;padding:24px;position:relative;';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn btn-close';
      closeBtn.textContent = '\u00D7';
      closeBtn.style.cssText = 'position:absolute;top:12px;right:12px;';
      closeBtn.addEventListener('click', () => modal.remove());
      inner.appendChild(closeBtn);
      renderAsrConfig(inner, getState());
      modal.appendChild(inner);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      document.body.appendChild(modal);
    });
    btnRow.appendChild(configBtn);

    const runBtn = document.createElement('button');
    runBtn.className = 'btn btn-primary';
    runBtn.textContent = 'Run Benchmark';
    runBtn.addEventListener('click', async () => {
      const benchmarkIds = getState().audio.filter(a => a.isBenchmark).map(a => a.id);
      const progress = document.createElement('div');
      progress.className = 'text-secondary';
      progress.style.cssText = 'padding:8px 0;font-size:0.85rem;';
      progress.textContent = 'Starting benchmark...';
      btnRow.appendChild(progress);
      runBtn.disabled = true;
      try {
        await runBenchmark(benchmarkIds, getState(), (done, total) => {
          progress.textContent = `Benchmarking ${done} / ${total}...`;
        });
        progress.textContent = 'Benchmark complete.';
      } catch (err) {
        progress.textContent = 'Error: ' + err.message;
      }
      runBtn.disabled = false;
      renderBenchmarkTable(resultsDiv, getState());
    });
    btnRow.appendChild(runBtn);

    benchSection.content.appendChild(btnRow);

    const resultsDiv = document.createElement('div');
    resultsDiv.className = 'benchmark-results';
    renderBenchmarkTable(resultsDiv, getState());
    benchSection.content.appendChild(resultsDiv);

    container.appendChild(benchSection.el);
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
  return { el, header, content };
}

function addCollapseBehavior(section, header, collapseByDefault) {
  header.style.cursor = 'pointer';
  const collapseIcon = document.createElement('span');
  collapseIcon.className = 'section-collapse-icon';
  collapseIcon.textContent = '▾';
  header.appendChild(collapseIcon);

  header.addEventListener('click', (e) => {
    if (e.target === header || e.target === collapseIcon) {
      section.classList.toggle('is-collapsed');
    }
  });

  if (window.innerWidth <= 640 && collapseByDefault) {
    section.classList.add('is-collapsed');
  }
}

function buildAsrProviderBar(audioId, state, onComplete) {
  const audio = state.audio.find(a => a.id === audioId);
  const audioUrl = audio?.r2Link || audio?.driveLink || null;

  const PROVIDERS = [
    { key: 'whisper', label: 'Whisper' },
    { key: 'gemini', label: 'Gemini' },
    { key: 'mendel', label: 'Mendel' },
  ];

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap;';

  const label = document.createElement('span');
  label.className = 'text-secondary';
  label.style.fontSize = '0.82rem';
  label.textContent = 'Generate transcript:';
  bar.appendChild(label);

  for (const { key, label: btnLabel } of PROVIDERS) {
    const btn = document.createElement('button');
    btn.className = 'action-btn action-btn-primary';
    btn.style.fontSize = '0.8rem';
    btn.textContent = btnLabel;

    btn.addEventListener('click', async () => {
      if (!audioUrl) { alert('No audio URL for this file.'); return; }
      btn.disabled = true;
      btn.textContent = `${btnLabel}…`;

      try {
        const providers = getState().transcribeProviders || {};
        const providerCfg = providers[key] || {};
        const config = { provider: key, ...providerCfg };
        const text = await transcribeAudio(audioId, audioUrl, config);
        if (!text) throw new Error('Empty transcription returned');

        // Save or update ASR version (same logic as transcribe.js)
        const versions = getVersions(audioId);
        const existing = versions.find(v => v.type === 'asr' && v.model === key);
        if (existing) {
          updateVersion(audioId, existing.id, { text, createdAt: new Date().toISOString() });
        } else {
          addVersion(audioId, { type: 'asr', text, model: key });
        }

        btn.textContent = btnLabel;
        btn.disabled = false;
        if (onComplete) onComplete();
      } catch (err) {
        console.error('[ASR] transcription failed:', err);
        btn.textContent = `${btnLabel} — failed`;
        btn.disabled = false;
      }
    });

    bar.appendChild(btn);
  }

  return bar;
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

    // Header: compact linked transcript info
    const label = document.createElement('div');
    label.className = 'mapping-header';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'mapping-transcript-name';
    nameSpan.textContent = transcript ? transcript.name : (mapping?.transcriptId || 'unknown');
    label.appendChild(nameSpan);
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
            loadFullText(transcript).then(text => {
              if (text) textarea.value = text;
            }).catch(() => {});
          }
        } else if (version.text) {
          textarea.value = version.text;
        } else if (transcript?.firstLine) {
          textarea.value = transcript.firstLine;
          loadFullText(transcript).then(text => {
            if (text && !version.text) {
              version.text = text;
              textarea.value = text;
            }
          }).catch(() => {});
        }

        // Save on change (debounced) — not available for manual versions
        const saveStatus = document.createElement('span');
        saveStatus.className = 'save-status text-secondary';
        saveStatus.style.fontSize = '0.8rem';

        function formatSaveTime(isoString) {
          if (!isoString) return '';
          const d = new Date(isoString);
          return `Saved ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }

        // Show existing save time on load
        if (!isManual && (version.updatedAt || version.createdAt)) {
          saveStatus.textContent = formatSaveTime(version.updatedAt || version.createdAt);
        }

        if (!isManual) {
          let saveTimer = null;
          textarea.addEventListener('input', () => {
            saveStatus.textContent = 'Unsaved...';
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
              const now = new Date().toISOString();
              updateVersion(audioId, version.id, { text: textarea.value, updatedAt: now });
              saveStatus.textContent = formatSaveTime(now);
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
          startEditBtn.className = 'action-btn action-btn-primary action-btn-lg';
          startEditBtn.textContent = 'Start Editing';
          startEditBtn.addEventListener('click', async () => {
            startEditBtn.disabled = true;
            startEditBtn.textContent = 'Loading...';
            // Ensure full text is loaded before copying
            let text = textarea.value;
            if (!transcript?.text && transcript) {
              const full = await loadFullText(transcript);
              if (full) { text = full; }
            } else if (transcript?.text) {
              text = transcript.text;
            }
            addVersion(audioId, {
              type: 'edited',
              parentVersionId: version.id,
              sourceTranscriptId: version.sourceTranscriptId,
              text,
              createdBy: getCurrentUser(),
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
              createdBy: getCurrentUser(),
            });
            const s = getState();
            const audio = s.audio.find(a => a.id === audioId);
            renderDetailPage(audioId, audio, s, pageContainer);
          });
          infoBar.appendChild(saveAsBtn);
        }

        contentArea.appendChild(infoBar);
      }

      // Expose re-render on the shared ref so the word view can refresh the textarea after saving edits
      if (activeVersionRef) {
        activeVersionRef.rerenderContent = () => renderVersionContent(activeVersionRef.id);
      }

      // Build tabs — hide the cleaned tab when an edited (working) version exists
      const hasEditedVersion = versions.some(v => v.type === 'edited');
      for (const v of versions) {
        if (v.type === 'cleaned' && hasEditedVersion) continue;
        const tab = document.createElement('button');
        tab.className = 'version-tab';
        tab.dataset.versionId = v.id;
        let tabLabel = v.type.charAt(0).toUpperCase() + v.type.slice(1);
        if (v.type === 'asr') {
          // Show model name if available, and mark as draft (not yet approved)
          if (v.model) tabLabel = 'ASR (' + v.model + ')';
          tabLabel += ' — draft';
        }
        tab.textContent = tabLabel;
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
      // No versions yet, just show transcript text
      // (ASR buttons added below after this block)
      // No versions yet, just show text
      const textarea = document.createElement('textarea');
      textarea.className = 'transcript-editor';
      textarea.dir = 'rtl';
      textarea.rows = 12;
      textarea.value = transcript.text || transcript.firstLine || '';
      if (!transcript.text) {
        loadFullText(transcript).then(text => {
          if (text) textarea.value = text;
        }).catch(() => {});
      }
      container.appendChild(textarea);
    }

    // Action toolbar — compact row with ASR + Change + Unlink
    const actionBar = document.createElement('div');
    actionBar.className = 'mapping-action-bar';

    // ASR provider buttons
    const asrBar = buildAsrProviderBar(audioId, state, () => {
      renderMappingSection(audioId, getState(), container, pageContainer, activeVersionRef);
    });
    actionBar.appendChild(asrBar);

    const changeBtn = document.createElement('button');
    changeBtn.className = 'action-btn';
    changeBtn.textContent = 'Change Transcript';
    changeBtn.addEventListener('click', () => {
      renderSearchModal(document.body, getState(), (transcriptId) => {
        linkMatch(audioId, transcriptId, 1.0, 'manual search');
        const s = getState();
        // Reset versions for this audio
        s.transcriptVersions[audioId] = [];
        // TODO: updateState with null does not delete Supabase rows — sync functions
        // bail on null values. Needs db.js delete helpers for cleaning/alignments/reviews.
        if (s.cleaning[audioId]) updateState('cleaning', audioId, null);
        if (s.alignments[audioId]) updateState('alignments', audioId, null);
        if (s.reviews[audioId]) updateState('reviews', audioId, null);
        // Ensure transcriptVersions reset is persisted even if no updateState fired above
        updateState('transcriptVersions', null, s.transcriptVersions);
        const audio = s.audio.find(a => a.id === audioId);
        renderDetailPage(audioId, audio, s, pageContainer);
      });
    });
    actionBar.appendChild(changeBtn);

    const unlinkBtn = document.createElement('button');
    unlinkBtn.className = 'action-btn action-btn-danger';
    unlinkBtn.textContent = 'Unlink';
    unlinkBtn.addEventListener('click', () => {
      unlinkMatch(audioId);
      const audio = s.audio.find(a => a.id === audioId);
      renderDetailPage(audioId, audio, getState(), pageContainer);
    });
    actionBar.appendChild(unlinkBtn);

    container.appendChild(actionBar);
  } else {
    // Unmapped: show suggestions + search
    const suggestionsDiv = document.createElement('div');
    suggestionsDiv.className = 'suggestions-container';
    renderSuggestedMatches(suggestionsDiv, audioId, state, (aId, tId) => {
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
        createdBy: getCurrentUser(),
      });
      const s = getState();
      // Create a synthetic mapping so the pipeline can proceed
      if (!s.mappings[audioId]) {
        updateState('mappings', audioId, {
          transcriptId: null,
          confidence: 1.0,
          matchReason: 'created-from-scratch',
          confirmedBy: getCurrentUser(),
          confirmedAt: new Date().toISOString(),
        });
      }
      const audio = s.audio.find(a => a.id === audioId);
      renderDetailPage(audioId, audio, s, pageContainer);
    });
    container.appendChild(createBtn);

    // ASR buttons — generate transcript from audio even when unmapped
    const asrBar = buildAsrProviderBar(audioId, state, () => {
      const s = getState();
      // Ensure a synthetic mapping exists so pipeline can proceed
      if (!s.mappings[audioId]) {
        updateState('mappings', audioId, {
          transcriptId: null,
          confidence: 1.0,
          matchReason: 'asr-generated',
          confirmedBy: getCurrentUser(),
          confirmedAt: new Date().toISOString(),
        });
      }
      const audio = s.audio.find(a => a.id === audioId);
      renderDetailPage(audioId, audio, s, pageContainer);
    });
    container.appendChild(asrBar);
  }
}

// Opens a modal showing a per-line diff preview for a cleaning pass.
// currentText: text before the pass; previewText: what the pass would produce.
// Character-level LCS diff: returns [{text, removed}] segments for orig vs clean.
// Removed chars (only in orig) get removed:true so they can be rendered with strikethrough.
function buildInlineDiff(orig, clean) {
  const m = orig.length, n = clean.length;
  if (m === 0) return [];
  if (n === 0) return [{ text: orig, removed: true }];

  // Build LCS table
  const dp = [];
  for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = orig[i - 1] === clean[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack: mark which chars in orig are kept (appear in LCS)
  const kept = new Uint8Array(m);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (orig[i - 1] === clean[j - 1]) { kept[i - 1] = 1; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  // Build contiguous segments
  const segs = [];
  let s = 0;
  while (s < m) {
    const removed = !kept[s];
    let e = s + 1;
    while (e < m && !kept[e] === removed) e++;
    segs.push({ text: orig.slice(s, e), removed });
    s = e;
  }
  return segs;
}

// Render orig text as inline spans: removed chars get .diff-char-removed (strikethrough),
// kept chars render as plain text nodes.
function renderInlineDiff(container, orig, clean) {
  const segs = buildInlineDiff(orig, clean || '');
  for (const seg of segs) {
    if (seg.removed) {
      const span = document.createElement('span');
      span.className = 'diff-char-removed';
      span.textContent = seg.text;
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(seg.text));
    }
  }
}

// ── Match preview modal for brackets / parentheses ──────────────────
// Shows each match individually with Delete / Unwrap / Keep options.

function openMatchPreviewModal(audioId, label, currentText, matches, rawOriginal, pageContainer) {
  if (matches.length === 0) {
    alert('No matches found.');
    return;
  }

  // Per-match action state: 'delete' | 'unwrap' | 'keep'
  const actions = matches.map(() => 'delete');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal pass-preview-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = `Preview: ${label}`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-close';
  closeBtn.textContent = '\u00D7';
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Batch action bar
  const actionBar = document.createElement('div');
  actionBar.className = 'diff-actions match-action-bar';
  const countLabel = document.createElement('span');
  countLabel.className = 'text-secondary';
  countLabel.textContent = `${matches.length} match${matches.length !== 1 ? 'es' : ''} found`;
  actionBar.appendChild(countLabel);

  function setAll(action) {
    actions.fill(action);
    rowEls.forEach((el, i) => {
      el.querySelector(`input[value="${action}"]`).checked = true;
      el.className = 'match-preview-row match-action-' + action;
    });
  }

  for (const [act, lbl] of [['delete', 'Delete All'], ['unwrap', 'Unwrap All'], ['keep', 'Keep All']]) {
    const btn = document.createElement('button');
    btn.className = 'action-btn' + (act === 'delete' ? ' action-btn-danger' : '');
    btn.textContent = lbl;
    btn.addEventListener('click', () => setAll(act));
    actionBar.appendChild(btn);
  }
  modal.appendChild(actionBar);

  // Match rows
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'diff-rows-container';
  const rowEls = [];

  matches.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'match-preview-row match-action-delete';

    const num = document.createElement('span');
    num.className = 'match-preview-num';
    num.textContent = (i + 1) + '.';

    const textWrap = document.createElement('div');
    textWrap.className = 'match-preview-text-wrap';

    // Show context around the match
    const contextBefore = currentText.slice(Math.max(0, m.index - 40), m.index);
    const contextAfter = currentText.slice(m.index + m.match.length, m.index + m.match.length + 40);
    const beforeSnip = contextBefore.includes('\n') ? contextBefore.slice(contextBefore.lastIndexOf('\n') + 1) : contextBefore;
    const afterSnip = contextAfter.includes('\n') ? contextAfter.slice(0, contextAfter.indexOf('\n')) : contextAfter;

    const ctx = document.createElement('div');
    ctx.className = 'match-preview-context';
    ctx.dir = 'rtl';
    const beforeSpan = document.createElement('span');
    beforeSpan.className = 'match-ctx-text';
    beforeSpan.textContent = beforeSnip;
    const matchSpan = document.createElement('span');
    matchSpan.className = 'match-ctx-highlight';
    matchSpan.textContent = m.match;
    const afterSpan = document.createElement('span');
    afterSpan.className = 'match-ctx-text';
    afterSpan.textContent = afterSnip;
    ctx.appendChild(beforeSpan);
    ctx.appendChild(matchSpan);
    ctx.appendChild(afterSpan);
    textWrap.appendChild(ctx);

    // Radio buttons
    const radios = document.createElement('div');
    radios.className = 'match-preview-radios';
    const name = `match-action-${i}`;
    for (const [val, lbl] of [['delete', 'Delete'], ['unwrap', 'Unwrap'], ['keep', 'Keep']]) {
      const radioLabel = document.createElement('label');
      radioLabel.className = 'match-radio-label';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = val;
      radio.checked = val === 'delete';
      radio.addEventListener('change', () => {
        actions[i] = val;
        row.className = 'match-preview-row match-action-' + val;
      });
      radioLabel.appendChild(radio);
      radioLabel.appendChild(document.createTextNode(' ' + lbl));
      radios.appendChild(radioLabel);
    }

    row.appendChild(num);
    row.appendChild(textWrap);
    row.appendChild(radios);
    rowsContainer.appendChild(row);
    rowEls.push(row);
  });

  modal.appendChild(rowsContainer);

  // Footer
  const applyBar = document.createElement('div');
  applyBar.className = 'diff-apply-bar';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'action-btn';
  cancelBtn.textContent = 'Cancel';

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn-secondary';
  applyBtn.textContent = 'Apply';
  applyBtn.addEventListener('click', () => {
    // Check if all actions are 'keep' — nothing to do
    if (actions.every(a => a === 'keep')) { closeModal(); return; }
    const finalText = applyMatchActions(currentText, matches, actions);
    const cleanRate = calculateCleanRate(rawOriginal, finalText);
    const versions = getVersions(audioId);
    const existingEdited = versions.find(v => v.type === 'edited');
    if (existingEdited) {
      updateVersion(audioId, existingEdited.id, { text: finalText, originalText: rawOriginal, cleanRate, createdAt: new Date().toISOString() });
    } else {
      addVersion(audioId, { type: 'edited', text: finalText, originalText: rawOriginal, cleanRate, createdBy: getCurrentUser() });
    }
    closeModal();
    const s = getState();
    renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
  });

  applyBar.appendChild(cancelBtn);
  applyBar.appendChild(applyBtn);
  modal.appendChild(applyBar);

  overlay.appendChild(modal);
  function closeModal() {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  }
  function escHandler(e) { if (e.key === 'Escape') closeModal(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(overlay);
}

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
  // closeBtn click is bound later via closeModal()
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

      // Single row with inline strikethrough on removed chars
      const diffBlock = document.createElement('div');
      diffBlock.className = 'diff-block diff-inline';
      diffBlock.dir = 'rtl';
      renderInlineDiff(diffBlock, row.orig, row.clean);
      rowEl.appendChild(diffBlock);
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
  // cancelBtn click is bound later via closeModal()
  applyBar.appendChild(cancelBtn);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn-secondary';
  applyBtn.textContent = 'Apply Selected';
  applyBtn.addEventListener('click', () => {
    const finalLines = rows.map(r => r.changed ? (r.accepted ? r.editedClean : r.orig) : r.orig);
    const finalText = finalLines.join('\n');
    const cleanRate = calculateCleanRate(rawOriginal, finalText);
    // Update the edited (working) version — cleaning and manual editing share one version.
    // getStatus() treats 'edited' as 'cleaned' for pipeline tracking.
    const versions = getVersions(audioId);
    const existingEdited = versions.find(v => v.type === 'edited');
    if (existingEdited) {
      updateVersion(audioId, existingEdited.id, { text: finalText, originalText: rawOriginal, cleanRate, createdAt: new Date().toISOString() });
    } else {
      addVersion(audioId, { type: 'edited', text: finalText, originalText: rawOriginal, cleanRate, createdBy: getCurrentUser() });
    }
    closeModal();
    const s = getState();
    renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
  });
  applyBar.appendChild(applyBtn);
  modal.appendChild(applyBar);

  overlay.appendChild(modal);
  function closeModal() {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  }
  function escHandler(e) {
    if (e.key === 'Escape') closeModal();
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  // Re-bind close button and cancel button to use unified closeModal
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(overlay);
}


function renderUnifiedWorkSection(audioId, state, container, pageContainer, playerEl, activeVersionRef) {
  const cleaning = state.cleaning[audioId];
  const alignment = state.alignments[audioId];

  // ── Shared text helpers ──
  async function getCurrentText() {
    const selectedId = activeVersionRef?.id;
    if (selectedId) {
      const versions = getVersions(audioId);
      const selected = versions.find(v => v.id === selectedId);
      if (selected && selected.type !== 'manual' && selected.text) {
        return selected.text;
      }
    }
    const m = getState().mappings[audioId];
    if (!m) return '';
    const t = getState().transcripts.find(tr => tr.id === m.transcriptId);
    if (!t) return '';
    const text = await loadFullText(t);
    return text || t.firstLine || '';
  }
  async function getOriginalText() {
    const c = getState().cleaning[audioId];
    return c?.originalText || await getCurrentText();
  }

  // ── Pipeline stepper ──
  const step = getPipelineStep(audioId);
  const iterCount = getIterationCount(audioId);
  container.appendChild(renderPipelineStepper(step, iterCount));

  // ── Next-step hint ──
  const currentStatus = getStatus(audioId);
  const nextStepHints = {
    'mapped':  'Next: run Cleaning to prepare the transcript',
    'cleaned': 'Next: run Alignment to get word timestamps',
    'aligned': 'Next: review and approve in the Review section',
  };
  if (nextStepHints[currentStatus]) {
    const hint = document.createElement('p');
    hint.className = 'next-step-hint';
    hint.style.cssText = 'font-size:0.8rem;color:var(--text-secondary);margin-top:4px;';
    hint.textContent = nextStepHints[currentStatus];
    container.appendChild(hint);
  }

  // ── Progress card (when alignment exists) ──
  if (alignment) {
    container.appendChild(renderProgressCard(alignment));
  }

  // ── Step panels ──
  function buildPassButtons(targetEl) {
    const btnBar = document.createElement('div');
    btnBar.className = 'clean-btn-bar';

    // ── Brackets — match preview modal ──
    const bracketsBtn = document.createElement('button');
    bracketsBtn.className = 'action-btn clean-pass-btn';
    bracketsBtn.textContent = 'Remove [brackets]';
    bracketsBtn.addEventListener('click', async () => {
      bracketsBtn.disabled = true;
      bracketsBtn.textContent = 'Loading...';
      try {
        const rawOriginal = await getOriginalText();
        const currentText = await getCurrentText();
        const matches = findBracketMatches(currentText);
        openMatchPreviewModal(audioId, 'Remove [brackets]', currentText, matches, rawOriginal, pageContainer);
      } finally {
        bracketsBtn.textContent = 'Remove [brackets]';
        bracketsBtn.disabled = false;
      }
    });
    btnBar.appendChild(bracketsBtn);

    // ── Parentheses — match preview modal ──
    const parenBtn = document.createElement('button');
    parenBtn.className = 'action-btn clean-pass-btn';
    parenBtn.textContent = 'Remove (parentheses)';
    parenBtn.addEventListener('click', async () => {
      parenBtn.disabled = true;
      parenBtn.textContent = 'Loading...';
      try {
        const rawOriginal = await getOriginalText();
        const currentText = await getCurrentText();
        const matches = findParenMatches(currentText);
        openMatchPreviewModal(audioId, 'Remove (parentheses)', currentText, matches, rawOriginal, pageContainer);
      } finally {
        parenBtn.textContent = 'Remove (parentheses)';
        parenBtn.disabled = false;
      }
    });
    btnBar.appendChild(parenBtn);

    // ── Section markers — existing line-diff modal ──
    const sectionBtn = document.createElement('button');
    sectionBtn.className = 'action-btn clean-pass-btn';
    sectionBtn.textContent = 'Remove section markers';
    sectionBtn.addEventListener('click', async () => {
      sectionBtn.disabled = true;
      sectionBtn.textContent = 'Loading...';
      try {
        const rawOriginal = await getOriginalText();
        const currentText = await getCurrentText();
        const previewText = cleanSectionMarkers(currentText);
        openPassPreviewModal(audioId, 'Remove section markers', currentText, previewText, rawOriginal, pageContainer);
      } finally {
        sectionBtn.textContent = 'Remove section markers';
        sectionBtn.disabled = false;
      }
    });
    btnBar.appendChild(sectionBtn);

    // ── Symbols & whitespace — combined minor passes, line-diff modal ──
    const minorBtn = document.createElement('button');
    minorBtn.className = 'action-btn clean-pass-btn';
    minorBtn.textContent = 'Clean symbols & whitespace';
    minorBtn.addEventListener('click', async () => {
      minorBtn.disabled = true;
      minorBtn.textContent = 'Loading...';
      try {
        const rawOriginal = await getOriginalText();
        const currentText = await getCurrentText();
        const previewText = cleanMinor(currentText);
        openPassPreviewModal(audioId, 'Clean symbols & whitespace', currentText, previewText, rawOriginal, pageContainer);
      } finally {
        minorBtn.textContent = 'Clean symbols & whitespace';
        minorBtn.disabled = false;
      }
    });
    btnBar.appendChild(minorBtn);

    // ── Remove intro text ──
    const introBtn = document.createElement('button');
    introBtn.className = 'action-btn clean-pass-btn';
    introBtn.textContent = 'Remove intro text';
    introBtn.addEventListener('click', async () => {
      introBtn.disabled = true;
      introBtn.textContent = 'Loading...';
      try {
        const rawOriginal = await getOriginalText();
        const currentText = await getCurrentText();
        const previewText = cleanIntroText(currentText);
        if (previewText === currentText) {
          introBtn.textContent = 'No intro found';
          setTimeout(() => { introBtn.textContent = 'Remove intro text'; }, 2000);
          return;
        }
        openPassPreviewModal(audioId, 'Remove intro text', currentText, previewText, rawOriginal, pageContainer);
      } finally {
        introBtn.textContent = 'Remove intro text';
        introBtn.disabled = false;
      }
    });
    btnBar.appendChild(introBtn);

    // ── Clean All ──
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
    targetEl.appendChild(btnBar);
  }

  function buildAlignButton(targetEl) {
    const alignBar = document.createElement('div');
    alignBar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
    const alignBtn = document.createElement('button');
    alignBtn.className = 'action-btn action-btn-primary action-btn-lg';
    const audioName = state.audio.find(a => a.id === audioId)?.name || audioId;
    const alignLabel = alignment ? `Re-align ${audioName}` : `Run alignment for ${audioName}`;
    alignBtn.textContent = alignment ? 'Re-Align' : 'Run Alignment';
    alignBtn.setAttribute('aria-label', alignLabel);
    alignBtn.addEventListener('click', async () => {
      alignBtn.textContent = 'Aligning (may take ~2.5 min)...';
      alignBtn.disabled = true;
      // Remove any previous error message
      const prevErr = alignBar.parentNode?.querySelector('.alignment-error-msg');
      if (prevErr) prevErr.remove();
      alignBtn.classList.remove('btn-error');
      try {
        const textForAlignment = await getCurrentText();
        const currentVersionId = activeVersionRef?.id || null;
        await alignRow(audioId, getState(), textForAlignment, currentVersionId, (attempt, maxRetries) => {
          if (attempt === 1) {
            alignBtn.textContent = 'Warming up GPU (may take ~2 min)…';
          } else {
            alignBtn.textContent = `Retrying… (${attempt}/${maxRetries})`;
          }
        });
      } catch (err) {
        console.error('[Alignment] Failed for', audioId, ':', err);
        // Persistent error state
        alignBtn.textContent = 'Alignment failed — retry?';
        alignBtn.disabled = false;
        alignBtn.classList.add('btn-error');
        const errMsg = document.createElement('p');
        errMsg.className = 'alignment-error-msg';
        errMsg.textContent = `Alignment failed: ${err.message || 'unknown error'}`;
        alignBar.parentNode.insertBefore(errMsg, alignBar.nextSibling);
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
    targetEl.appendChild(alignBar);
  }

  // ASR provider buttons are now inline in the Transcript Mapping section

  // ── Cleaning section (always visible) ──
  const cleanSection = document.createElement('div');
  cleanSection.style.cssText = 'margin-bottom:14px;';
  const cleanLabel = document.createElement('div');
  cleanLabel.className = 'section-sublabel';
  cleanLabel.textContent = 'Cleaning — click a pass to preview changes line by line';
  cleanSection.appendChild(cleanLabel);
  buildPassButtons(cleanSection);
  container.appendChild(cleanSection);

  // ── Align section (always visible) ──
  const alignSection = document.createElement('div');
  alignSection.style.cssText = 'margin-bottom:14px;';
  buildAlignButton(alignSection);
  container.appendChild(alignSection);

  // ── Word view (always visible when alignment exists, placeholder otherwise) ──
  if (alignment && !alignment.words) {
    const placeholder = document.createElement('div');
    placeholder.className = 'text-secondary';
    placeholder.style.cssText = 'padding:12px;font-size:0.9rem;';
    placeholder.textContent = 'Loading word timestamps...';
    container.appendChild(placeholder);
    loadAlignmentWords(audioId).then(words => {
      const fullAlignment = words ? { ...alignment, words } : alignment;
      if (words) updateState('alignments', audioId, fullAlignment);
      placeholder.remove();
      renderWordView(audioId, cleaning, fullAlignment, container, pageContainer, playerEl, activeVersionRef);
      renderIterationHistory(audioId, container, pageContainer, playerEl);
    });
  } else if (alignment) {
    renderWordView(audioId, cleaning, alignment, container, pageContainer, playerEl, activeVersionRef);
    renderIterationHistory(audioId, container, pageContainer, playerEl);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'word-view-placeholder';
    placeholder.textContent = 'Run alignment above to see word-level timestamps and confidence scores.';
    container.appendChild(placeholder);
  }
}

function renderPipelineStepper(step, iterCount) {
  const steps = [
    { id: 'clean',    label: 'Clean',   num: '1' },
    { id: 'align',    label: 'Align',   num: '2' },
    { id: 'review',   label: 'Review',  num: '3' },
    { id: 'approved', label: 'Approve', num: '✓' },
  ];
  const order = steps.map(s => s.id);
  const activeIdx = order.indexOf(step);

  const stepper = document.createElement('div');
  stepper.className = 'pipeline-stepper';

  steps.forEach((s, i) => {
    const stepEl = document.createElement('div');
    const isCompleted = i < activeIdx;
    const isActive = i === activeIdx;
    stepEl.className = 'pipeline-step' + (isActive ? ' active' : '') + (isCompleted ? ' completed' : '');

    const circle = document.createElement('div');
    circle.className = 'pipeline-step-circle';
    circle.textContent = isCompleted ? '✓' : s.num;

    const label = document.createElement('div');
    label.className = 'pipeline-step-label';
    label.textContent = s.label;

    stepEl.appendChild(circle);
    stepEl.appendChild(label);
    stepper.appendChild(stepEl);

    if (i < steps.length - 1) {
      const connector = document.createElement('div');
      connector.className = 'pipeline-connector' + (isCompleted ? ' completed' : '');
      stepper.appendChild(connector);
    }
  });

  if (iterCount > 1) {
    const badge = document.createElement('div');
    badge.className = 'pipeline-iteration-badge';
    badge.textContent = `Round ${iterCount}`;
    stepper.appendChild(badge);
  }

  return stepper;
}

function renderProgressCard(alignment) {
  const card = document.createElement('div');
  card.className = 'pipeline-progress-card';

  const words = alignment.words ?? [];
  const total = words.length;
  const highConf = words.filter(w => (w.confidence ?? w.probability ?? w.score ?? 0) >= 0.8).length;
  const pct = total > 0 ? Math.round((highConf / total) * 100) : 0;
  const low = alignment.lowConfidenceCount ?? 0;

  const header = document.createElement('div');
  header.className = 'pipeline-progress-header';

  const statConf = document.createElement('span');
  statConf.className = 'pipeline-progress-stat';
  statConf.innerHTML = `<strong>${pct}%</strong> high-confidence words`;
  header.appendChild(statConf);

  if (low > 0) {
    const statLow = document.createElement('span');
    statLow.className = 'pipeline-progress-stat';
    statLow.innerHTML = `&nbsp;·&nbsp;<strong style="color:var(--red)">${low}</strong> low-confidence`;
    header.appendChild(statLow);
  }

  if (alignment.alignedAt) {
    const statDate = document.createElement('span');
    statDate.className = 'pipeline-progress-stat';
    statDate.style.marginLeft = 'auto';
    statDate.textContent = `Aligned ${new Date(alignment.alignedAt).toLocaleDateString()}`;
    header.appendChild(statDate);
  }

  card.appendChild(header);

  const barWrap = document.createElement('div');
  barWrap.className = 'pipeline-progress-bar-wrap';
  const barFill = document.createElement('div');
  barFill.className = 'pipeline-progress-bar-fill' + (pct >= 80 ? '' : pct >= 50 ? ' bar-mid' : ' bar-low');
  barFill.style.width = pct + '%';
  barWrap.appendChild(barFill);
  card.appendChild(barWrap);

  return card;
}

function renderIterationHistory(audioId, container, pageContainer, playerEl) {
  const alignedVersions = getAlignedVersions(audioId);
  if (alignedVersions.length === 0) return;

  const wrap = document.createElement('div');
  wrap.className = 'iteration-history';

  const header = document.createElement('div');
  header.className = 'iteration-history-header';
  const headerTitle = document.createElement('span');
  headerTitle.textContent = `Iteration History (${alignedVersions.length})`;
  const chevron = document.createElement('span');
  chevron.className = 'iteration-history-chevron';
  chevron.textContent = '▸';
  header.appendChild(chevron);
  header.appendChild(headerTitle);
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'iteration-history-body';
  body.style.display = 'none';
  wrap.appendChild(body);

  header.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    chevron.textContent = open ? '▸' : '▾';
  });

  alignedVersions.forEach((v, i) => {
    const iterNum = v.iteration || (i + 1);
    const isLast = i === alignedVersions.length - 1;
    const row = document.createElement('div');
    row.className = 'iteration-row' + (isLast ? ' current' : '');

    const badge = document.createElement('span');
    badge.className = 'iteration-badge';
    badge.textContent = `v${iterNum}`;

    const detail = document.createElement('span');
    detail.className = 'iteration-row-detail';
    const conf = v.alignment?.avgConfidence != null ? formatConfidence(v.alignment.avgConfidence) : '—';
    const low = v.alignment?.lowConfidenceCount ?? '?';
    const date = v.alignment?.alignedAt ? new Date(v.alignment.alignedAt).toLocaleDateString() : '';
    const typeLabel = v.type === 'manual' ? 'original' : v.type;
    const byLabel = v.createdBy && v.createdBy !== 'system' && v.createdBy !== 'imported' ? v.createdBy : '';
    detail.textContent = [
      `${conf} avg`,
      `${low} low`,
      typeLabel,
      byLabel,
      date,
    ].filter(Boolean).join(' · ');

    const actions = document.createElement('span');
    actions.className = 'iteration-row-actions';

    if (!isLast) {
      const compareBtn = document.createElement('button');
      compareBtn.className = 'action-btn';
      compareBtn.style.cssText = 'font-size:0.75rem;padding:2px 8px;';
      compareBtn.textContent = 'Compare with current';
      compareBtn.addEventListener('click', () => {
        const current = alignedVersions[alignedVersions.length - 1];
        // Remove existing compare view and open fresh
        container.querySelector('.compare-view')?.remove();
        renderCompareView(audioId, [v, current], container, pageContainer, playerEl);
      });
      actions.appendChild(compareBtn);
    } else {
      const cur = document.createElement('span');
      cur.className = 'text-secondary';
      cur.style.fontSize = '0.75rem';
      cur.textContent = 'current';
      actions.appendChild(cur);
    }

    row.appendChild(badge);
    row.appendChild(detail);
    row.appendChild(actions);
    body.appendChild(row);
  });

  container.appendChild(wrap);
}

function renderApproveBar(audioId, container, pageContainer) {
  const approveBar = document.createElement('div');
  approveBar.className = 'seg-approve-bar';
  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn btn-primary seg-approve-btn';
  const approveStatus = document.createElement('span');
  approveStatus.className = 'text-secondary';
  approveStatus.style.fontSize = '0.85rem';
  approveBar.appendChild(approveBtn);
  approveBar.appendChild(approveStatus);

  // Re-clean & Re-align button -- shown only when status is rejected
  const reCleanBtn = document.createElement('button');
  reCleanBtn.className = 'btn btn-secondary';
  reCleanBtn.style.cssText = 'margin-left:8px;';
  reCleanBtn.textContent = 'Re-clean & Re-align';
  reCleanBtn.title = 'Clear rejection, return file to mapped state for re-cleaning and re-alignment';
  reCleanBtn.style.display = 'none';
  approveBar.appendChild(reCleanBtn);

  container.appendChild(approveBar);

  function sync() {
    const s = getState();
    const review = s.reviews?.[audioId];
    const isApproved = review?.status === 'approved';
    const isRejected = review?.status === 'rejected';
    approveBtn.textContent = isApproved ? '✓ Approved for Training' : 'Approve for Training';
    approveBtn.className = isApproved
      ? 'btn btn-secondary seg-approve-btn'
      : 'btn btn-primary seg-approve-btn';
    if (isApproved) {
      const date = review.reviewedAt ? new Date(review.reviewedAt).toLocaleDateString() : '';
      const by = review.approvedBy || '';
      approveStatus.textContent = [by, date ? 'on ' + date : ''].filter(Boolean).join(' ');
      approveStatus.style.color = '';
    } else if (isRejected) {
      approveStatus.textContent = 'Rejected — needs re-cleaning';
      approveStatus.style.color = 'var(--red)';
    } else {
      approveStatus.textContent = '';
      approveStatus.style.color = '';
    }
    reCleanBtn.style.display = isRejected ? '' : 'none';
  }
  sync();

  approveBtn.addEventListener('click', () => {
    const s = getState();
    const isApproved = s.reviews?.[audioId]?.status === 'approved';
    if (isApproved) {
      updateState('reviews', audioId, { ...s.reviews[audioId], status: 'rejected', reviewedAt: new Date().toISOString() });
    } else {
      updateState('reviews', audioId, { status: 'approved', approvedBy: getCurrentUser(), reviewedAt: new Date().toISOString() });
    }
    sync();
  });

  reCleanBtn.addEventListener('click', () => {
    // Clear rejection -- return to mapped/cleaned state so the file can be re-processed
    updateState('reviews', audioId, null);
    sync();
    // Re-render full detail page if pageContainer is available
    if (pageContainer) {
      const s = getState();
      const audio = s.audio.find(a => a.id === audioId);
      if (audio) renderDetailPage(audioId, audio, s, pageContainer);
    }
  });
}

function renderCompareView(audioId, alignedVersions, container, pageContainer, playerEl) {
  // Remove any previous compare view
  container.querySelector('.compare-view')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'compare-view';

  // Header
  const header = document.createElement('div');
  header.className = 'compare-header';
  const title = document.createElement('h4');
  title.textContent = 'Compare Aligned Versions';
  title.style.margin = '0';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.style.cssText = 'font-size:1.2rem;padding:2px 8px;';
  closeBtn.addEventListener('click', () => wrap.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);
  wrap.appendChild(header);

  // Two-column layout
  const columns = document.createElement('div');
  columns.className = 'compare-columns';

  // State for the two selected versions
  const selected = [
    alignedVersions.length >= 2 ? alignedVersions[alignedVersions.length - 2] : alignedVersions[0],
    alignedVersions[alignedVersions.length - 1],
  ];

  // Build a map from word position to the other side's confidence for diff highlighting
  function buildConfidenceMap(words) {
    const map = {};
    words.forEach((w, i) => {
      map[i] = w.confidence ?? 0;
    });
    return map;
  }

  function renderColumn(colIdx) {
    const col = document.createElement('div');
    col.className = 'compare-column';

    // Version selector dropdown
    const selector = document.createElement('select');
    selector.className = 'compare-selector';
    alignedVersions.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      const label = v.type.charAt(0).toUpperCase() + v.type.slice(1);
      const date = v.alignment?.alignedAt ? new Date(v.alignment.alignedAt).toLocaleDateString() : '';
      const avg = v.alignment?.avgConfidence != null ? ` (${(v.alignment.avgConfidence * 100).toFixed(0)}%)` : '';
      opt.textContent = `${label}${avg} ${date}`;
      if (v.id === selected[colIdx].id) opt.selected = true;
      selector.appendChild(opt);
    });
    selector.addEventListener('change', () => {
      selected[colIdx] = alignedVersions[parseInt(selector.value)];
      rebuildColumns();
    });
    col.appendChild(selector);

    const version = selected[colIdx];
    const words = version.alignment?.words || [];
    const otherWords = selected[1 - colIdx]?.alignment?.words || [];
    const otherConfMap = buildConfidenceMap(otherWords);

    // Stats bar
    const stats = document.createElement('div');
    stats.className = 'compare-stats';
    const avg = version.alignment?.avgConfidence;
    const low = version.alignment?.lowConfidenceCount ?? 0;
    const wordCount = words.length;
    stats.innerHTML = `<span>Words: <strong>${wordCount}</strong></span>` +
      `<span>Avg: <strong>${avg != null ? (avg * 100).toFixed(0) + '%' : '—'}</strong></span>` +
      `<span>Low confidence: <strong style="color:var(--red)">${low}</strong></span>`;
    col.appendChild(stats);

    // Word grid with chips
    const grid = document.createElement('div');
    grid.className = 'compare-word-grid';
    grid.dir = 'rtl';

    const chipEls = [];
    words.forEach((w, idx) => {
      const span = document.createElement('span');
      const conf = typeof w.confidence === 'number' ? w.confidence : 1;
      const level = getConfidenceLevel(conf);
      span.className = `word-chip confidence-${level}`;
      const wordText = w.word || w.text || '';
      span.textContent = wordText;
      span.title = `"${wordText}" ${(conf * 100).toFixed(0)}% | ${(w.start ?? 0).toFixed(2)}s–${(w.end ?? 0).toFixed(2)}s`;

      // Confidence diff indicator vs the other column
      if (otherWords.length > 0 && idx < otherWords.length) {
        const otherConf = otherConfMap[idx] ?? 0;
        const diff = conf - otherConf;
        if (diff > 0.1) {
          span.classList.add('confidence-improved');
        } else if (diff < -0.1) {
          span.classList.add('confidence-degraded');
        }
      }

      // Click to seek audio
      if (playerEl) {
        span.style.cursor = 'pointer';
        span.addEventListener('click', () => {
          playerEl.currentTime = w.start;
          if (playerEl.paused) playerEl.play();
        });
      }

      grid.appendChild(span);
      chipEls.push(span);
    });

    // Timeupdate highlight for this column
    if (playerEl && chipEls.length > 0) {
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
      // Store cleanup ref
      col._timeUpdateHandler = onTimeUpdate;
      playerEl.addEventListener('timeupdate', onTimeUpdate);
    }

    col.appendChild(grid);
    return col;
  }

  function rebuildColumns() {
    // Clean up old timeupdate listeners
    columns.querySelectorAll('.compare-column').forEach(col => {
      if (col._timeUpdateHandler && playerEl) {
        playerEl.removeEventListener('timeupdate', col._timeUpdateHandler);
      }
    });
    columns.innerHTML = '';
    columns.appendChild(renderColumn(0));
    columns.appendChild(renderColumn(1));
  }

  rebuildColumns();
  wrap.appendChild(columns);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'compare-legend';
  legend.innerHTML = '<span class="compare-legend-item"><span class="compare-legend-dot confidence-improved"></span> Improved vs other</span>' +
    '<span class="compare-legend-item"><span class="compare-legend-dot confidence-degraded"></span> Degraded vs other</span>' +
    '<span class="compare-legend-item">Click any word to hear it</span>';
  wrap.appendChild(legend);

  container.appendChild(wrap);
  // Scroll into view
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Karaoke canvas frame renderer ─────────────────────────────────────────────
function drawKaraokeFrame(ctx, words, currentTime, title, W, H) {
  // Background
  ctx.fillStyle = '#0f0f1a';
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.save();
  ctx.font = '22px Arial';
  ctx.fillStyle = '#7777aa';
  ctx.textAlign = 'center';
  ctx.direction = 'ltr';
  ctx.fillText(title, W / 2, 38);
  ctx.restore();

  if (!words.length) return;

  // Find active word index
  let activeIdx = -1;
  for (let i = 0; i < words.length; i++) {
    if (currentTime >= words[i].s && currentTime <= words[i].e) { activeIdx = i; break; }
  }
  if (activeIdx === -1) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (currentTime > words[i].s) { activeIdx = i; break; }
    }
  }

  // Group words into lines of ~7
  const LINE_SIZE = 7;
  const numLines = Math.ceil(words.length / LINE_SIZE);
  const currentLine = Math.floor(Math.max(0, activeIdx) / LINE_SIZE);

  const CENTER_Y = H / 2 + 10;
  const LINE_SPACING = 90;
  const GAP = 12;

  for (let offset = -1; offset <= 1; offset++) {
    const li = currentLine + offset;
    if (li < 0 || li >= numLines) continue;

    const lineWords = words.slice(li * LINE_SIZE, (li + 1) * LINE_SIZE);
    const y = CENTER_Y + offset * LINE_SPACING;
    const isCurrent = offset === 0;

    if (!isCurrent) {
      ctx.save();
      ctx.font = '36px Arial';
      ctx.fillStyle = offset < 0 ? '#55556a' : '#444458';
      ctx.textAlign = 'center';
      ctx.direction = 'rtl';
      ctx.fillText(lineWords.map(w => w.w).join(' '), W / 2, y);
      ctx.restore();
    } else {
      // Measure word widths for this line
      ctx.font = 'bold 50px Arial';
      const widths = lineWords.map(w => ctx.measureText(w.w).width);
      const totalWidth = widths.reduce((s, v) => s + v, 0) + GAP * (lineWords.length - 1);

      // RTL: word[0] is rightmost; draw from right edge of centered block
      let x = W / 2 + totalWidth / 2;

      lineWords.forEach((word, wi) => {
        const globalIdx = li * LINE_SIZE + wi;
        const isActive = globalIdx === activeIdx;
        const isPast = globalIdx < activeIdx;
        const w = widths[wi];

        if (isActive) {
          // Highlight pill behind active word
          ctx.save();
          ctx.fillStyle = 'rgba(37,99,235,0.45)';
          const pad = 10, h = 62;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(x - w - pad, y - 50, w + pad * 2, h, 10);
          } else {
            ctx.rect(x - w - pad, y - 50, w + pad * 2, h);
          }
          ctx.fill();
          ctx.restore();
        }

        ctx.save();
        ctx.font = 'bold 50px Arial';
        ctx.fillStyle = isActive ? '#88bbff' : isPast ? '#555578' : '#aaaacc';
        ctx.textAlign = 'right';
        ctx.direction = 'rtl';
        ctx.fillText(word.w, x, y);
        ctx.restore();

        x -= w + GAP;
      });
    }
  }

  // Progress bar
  const lastEnd = words[words.length - 1]?.e || 1;
  const progress = Math.min(currentTime / lastEnd, 1);
  ctx.fillStyle = '#1e1e30';
  ctx.fillRect(40, H - 24, W - 80, 10);
  ctx.fillStyle = '#2563eb';
  ctx.fillRect(40, H - 24, (W - 80) * progress, 10);
}

// ── Karaoke video recorder ─────────────────────────────────────────────────────
// Returns a cancel() function. Calls onStatus(text) with progress, onDone() when file downloaded.
// Fast karaoke video export using WebCodecs + webm-muxer (no real-time playback).
// Returns a cancel() function synchronously; encoding runs in the background.
function startKaraokeVideoExport(words, playerEl, audioName, onStatus, onDone) {
  let cancelled = false;
  const cancel = () => { cancelled = true; };

  (async () => {
    try {
      if (!window.VideoEncoder || !window.AudioEncoder || !window.VideoFrame || !window.AudioData) {
        throw new Error('WebCodecs not supported in this browser — try Chrome 94+');
      }

      // Load webm-muxer from CDN (lightweight ~30 KB, loaded once)
      onStatus('Loading encoder...');
      const { Muxer, ArrayBufferTarget } = await import(
        'https://cdn.jsdelivr.net/npm/webm-muxer@5.0.3/build/webm-muxer.mjs'
      );

      const W = 1280, H = 720, FPS = 25;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');

      // Proxy URL for CORS access
      const rawSrc = playerEl.src;
      let audioSrc = rawSrc;
      try {
        const u = new URL(rawSrc, location.href);
        if (isLibraryR2Url(rawSrc)) audioSrc = `/api/audio?url=${encodeURIComponent(rawSrc)}`;
      } catch { /* keep rawSrc */ }

      // Fetch and decode audio
      onStatus('Fetching audio...');
      const audioResp = await fetch(audioSrc);
      if (!audioResp.ok) throw new Error(`Audio fetch failed: ${audioResp.status}`);
      const audioBuffer = await audioResp.arrayBuffer();
      if (cancelled) return;

      onStatus('Decoding audio...');
      const audioCtx = new AudioContext({ sampleRate: 48000 });
      const decoded = await audioCtx.decodeAudioData(audioBuffer);
      audioCtx.close();
      if (cancelled) return;

      const duration = words[words.length - 1]?.e || decoded.duration;
      const totalFrames = Math.ceil(duration * FPS);

      // Set up muxer
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: { codec: 'V_VP9', width: W, height: H, frameRate: FPS },
        audio: { codec: 'A_OPUS', sampleRate: 48000, numberOfChannels: 1 },
        firstTimestampBehavior: 'offset',
      });

      // Video encoder
      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { throw e; },
      });
      videoEncoder.configure({
        codec: 'vp09.00.10.08', width: W, height: H,
        bitrate: 2_500_000, framerate: FPS,
      });

      // Audio encoder
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: e => { throw e; },
      });
      audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 128000 });

      // Encode audio in chunks
      onStatus('Encoding audio...');
      const channelData = decoded.numberOfChannels > 1
        ? (() => { const m = new Float32Array(decoded.length); const l = decoded.getChannelData(0); const r = decoded.getChannelData(1); for (let i = 0; i < m.length; i++) m[i] = (l[i] + r[i]) / 2; return m; })()
        : decoded.getChannelData(0);
      const CHUNK = 4096;
      for (let i = 0; i < channelData.length; i += CHUNK) {
        if (cancelled) return;
        const len = Math.min(CHUNK, channelData.length - i);
        const data = new AudioData({
          format: 'f32', sampleRate: 48000, numberOfFrames: len, numberOfChannels: 1,
          timestamp: Math.round(i / 48000 * 1_000_000),
          data: channelData.subarray(i, i + len),
        });
        audioEncoder.encode(data);
        data.close();
      }
      await audioEncoder.flush();

      // Encode video frames (fast — no real-time playback)
      for (let f = 0; f < totalFrames; f++) {
        if (cancelled) return;
        drawKaraokeFrame(ctx, words, f / FPS, audioName, W, H);
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round(f / FPS * 1_000_000),
          duration: Math.round(1_000_000 / FPS),
        });
        videoEncoder.encode(frame, { keyFrame: f % (FPS * 5) === 0 });
        frame.close();
        if (f % 75 === 0) {
          onStatus(`Encoding video ${Math.round(f / totalFrames * 100)}% (${formatTime(f / FPS)} / ${formatTime(duration)})`);
          await new Promise(r => setTimeout(r, 0));
        }
      }
      await videoEncoder.flush();
      muxer.finalize();

      if (cancelled) return;
      const blob = new Blob([target.buffer], { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${audioName}.webm`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      onDone(`Done! Saved as ${audioName}.webm`);
    } catch (err) {
      if (!cancelled) onDone(`Error: ${err?.message || String(err)}`);
    }
  })();

  return cancel;
}

function generateKaraokeHTML(words, audioSrc, title) {
  const wordsJson = JSON.stringify(words.map(w => ({ w: w.word || w.text || '', s: +(w.start ?? 0).toFixed(3), e: +(w.end ?? 0).toFixed(3) })));
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g,'&lt;')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#1a1a2e;color:#e8e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:20px}
h1{font-size:1.1rem;color:#8888cc;margin-bottom:16px;text-align:center;direction:rtl}
#player{width:100%;max-width:700px;margin-bottom:16px}
#stage{width:100%;max-width:700px;background:#111128;border-radius:12px;padding:20px 24px;min-height:120px;display:flex;flex-wrap:wrap;gap:6px 10px;direction:rtl;align-content:flex-start}
.w{padding:4px 6px;border-radius:6px;font-size:1.3rem;cursor:pointer;transition:background .1s,color .1s;color:#9090b0}
.w.active{background:#2563eb;color:#fff;font-weight:bold}
.w.past{color:#c8c8e0}
</style>
</head>
<body>
<h1>${title.replace(/</g,'&lt;')}</h1>
<audio id="player" controls src="${audioSrc}"></audio>
<div id="stage"></div>
<script>
const words=${wordsJson};
const stage=document.getElementById('stage');
const player=document.getElementById('player');
const chips=words.map((w,i)=>{
  const s=document.createElement('span');
  s.className='w';s.textContent=w.w;
  s.addEventListener('click',()=>{player.currentTime=w.s;player.play();});
  stage.appendChild(s);return s;
});
let lastIdx=-1;
player.addEventListener('timeupdate',()=>{
  const t=player.currentTime;
  let found=-1;
  for(let i=0;i<words.length;i++){if(t>=words[i].s&&t<words[i].e){found=i;break;}}
  if(found===lastIdx)return;
  if(lastIdx>=0){chips[lastIdx].classList.remove('active');chips[lastIdx].classList.add('past');}
  if(found>=0){chips[found].classList.add('active');chips[found].scrollIntoView({block:'nearest',behavior:'smooth'});}
  lastIdx=found;
});
</script>
</body>
</html>`;
}

function renderWordView(audioId, cleaning, alignment, container, pageContainer, playerEl, activeVersionRef) {
  const origText = cleaning?.originalText || '';
  const cleanedTextFallback = cleaning?.cleanedText || origText;
  const words = alignment?.words ?? [];

  const viewer = document.createElement('div');
  viewer.className = 'word-view';

  if (playerEl && words.length > 0) {
    viewer.appendChild(renderSpeedBar(playerEl, [0.5, 1, 1.25, 1.5, 2, 2.5, 3]));
  }

  // ── No alignment words: show diff view ──
  if (!words.length) {
    const wordGrid = document.createElement('div');
    wordGrid.className = 'word-view-grid';
    wordGrid.dir = 'rtl';

    if (words.length > 0) {
      // words array exists but all empty text
      const notice = document.createElement('div');
      notice.style.cssText = 'padding:12px;color:var(--orange);font-size:0.9rem;';
      notice.textContent = 'Alignment data has empty word text. Please re-run alignment to fix.';
      wordGrid.appendChild(notice);
    } else if (cleaning) {
      const origLines = origText.split('\n');
      const cleanLines = cleanedTextFallback.split('\n');
      const maxLen = Math.max(origLines.length, cleanLines.length);
      for (let i = 0; i < maxLen; i++) {
        const orig = origLines[i] || '';
        const clean = cleanLines[i] || '';
        if (orig === clean) {
          const lineSpan = document.createElement('span');
          lineSpan.className = 'word-view-line';
          lineSpan.textContent = orig;
          wordGrid.appendChild(lineSpan);
        } else {
          const removedLine = document.createElement('div');
          removedLine.className = 'word-view-line diff-line-removed';
          renderInlineDiff(removedLine, orig, clean);
          wordGrid.appendChild(removedLine);
          if (clean.trim()) {
            const addedLine = document.createElement('div');
            addedLine.className = 'word-view-line diff-line-added';
            addedLine.textContent = clean;
            wordGrid.appendChild(addedLine);
          }
        }
        wordGrid.appendChild(document.createElement('br'));
      }
    }

    viewer.appendChild(wordGrid);

    container.appendChild(viewer);
    return;
  }

  // ── Segment-based word review UI ──

  // Group words into segments by time gap
  const GAP_THRESHOLD = 1.0;
  const segments = (() => {
    const segs = [];
    let cur = [words[0]];
    for (let i = 1; i < words.length; i++) {
      if ((words[i].start - words[i - 1].end) > GAP_THRESHOLD) { segs.push(cur); cur = [words[i]]; }
      else cur.push(words[i]);
    }
    segs.push(cur);
    return segs;
  })();

  const editModeWords = words.map(w => ({ ...w }));
  // insertions[segIdx][posInSeg] = [{word, start, end}]
  // posInSeg=0 means before first word; posInSeg=N means after last word
  const insertions = {}; // segIdx → { posInSeg → [{word,start,end}] }
  const approvedHashes = getApprovedSegments(audioId); // persistent, DB-backed Set
  let currentSegIdx = 0;
  let problemFilterActive = false;
  const editMode = true; // always on — chips are always directly editable
  let chipEls = [];

  // Compute a stable hash for a segment based on its word text
  function segHash(segIdx) {
    return (segments[segIdx] || []).map(w => w.word || '').join(' ').trim();
  }

  // Problem segment: 3+ consecutive low-confidence (red) words
  function isProblemSegment(segIdx) {
    const seg = segments[segIdx] || [];
    let consecutive = 0;
    for (const w of seg) {
      if ((w.confidence ?? 1) < 0.4) {
        if (++consecutive >= 3) return true;
      } else {
        consecutive = 0;
      }
    }
    return false;
  }

  // ── Segment navigation header ──
  const segHeader = document.createElement('div');
  segHeader.className = 'seg-header';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn btn-secondary seg-nav-btn';
  prevBtn.textContent = '‹';
  prevBtn.title = 'Previous segment';

  const segInfo = document.createElement('div');
  segInfo.className = 'seg-info';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn btn-secondary seg-nav-btn';
  nextBtn.textContent = '›';
  nextBtn.title = 'Next segment';

  const nextUnreviewedBtn = document.createElement('button');
  nextUnreviewedBtn.className = 'btn btn-secondary';
  nextUnreviewedBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;margin-left:auto;';
  nextUnreviewedBtn.textContent = 'Next Unreviewed';

  segHeader.appendChild(prevBtn);
  segHeader.appendChild(segInfo);
  segHeader.appendChild(nextBtn);

  if (playerEl) {
    const playPauseBtn = document.createElement('button');
    playPauseBtn.className = 'btn btn-secondary seg-nav-btn';
    playPauseBtn.style.cssText = 'font-size:1rem;min-width:38px;';
    const updatePlayBtn = () => {
      playPauseBtn.textContent = playerEl.paused ? '▶' : '⏸';
      playPauseBtn.setAttribute('aria-label', playerEl.paused ? 'Play audio' : 'Pause audio');
    };
    updatePlayBtn();
    playPauseBtn.addEventListener('click', () => { if (playerEl.paused) playerEl.play(); else playerEl.pause(); });
    playerEl.addEventListener('play', updatePlayBtn);
    playerEl.addEventListener('pause', updatePlayBtn);
    segHeader.appendChild(playPauseBtn);
  }

  segHeader.appendChild(nextUnreviewedBtn);
  viewer.appendChild(segHeader);

  // ── Stats bar ──
  const statsBar = document.createElement('div');
  statsBar.className = 'seg-stats';
  viewer.appendChild(statsBar);

  // ── Two-column layout ──
  const mainLayout = document.createElement('div');
  mainLayout.className = 'seg-main-layout';

  const leftPanel = document.createElement('div');
  leftPanel.className = 'seg-left';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'seg-toolbar';

  const problemFilterBtn = document.createElement('button');
  problemFilterBtn.className = 'btn btn-secondary';
  problemFilterBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;';
  problemFilterBtn.title = 'Show only segments with 3+ consecutive low-confidence (red) words';
  function updateProblemFilterBtn() {
    const n = segments.filter((_, i) => isProblemSegment(i)).length;
    problemFilterBtn.textContent = `⚠ Problems (${n})`;
    problemFilterBtn.classList.toggle('seg-filter-active', problemFilterActive);
  }
  updateProblemFilterBtn();
  problemFilterBtn.addEventListener('click', () => {
    problemFilterActive = !problemFilterActive;
    updateProblemFilterBtn();
    // Jump to first problem segment when activating if current isn't one
    if (problemFilterActive && !isProblemSegment(currentSegIdx)) {
      const first = segments.findIndex((_, i) => isProblemSegment(i));
      if (first >= 0) { currentSegIdx = first; renderSegmentChips(); }
    }
    updateSegHeader();
    if (sidebar._renderList) sidebar._renderList();
  });

  const editStatus = document.createElement('span');
  editStatus.className = 'text-secondary';
  editStatus.style.cssText = 'font-size:0.8rem;min-width:60px;';

  // Export buttons
  const exportSrtBtn = document.createElement('button');
  exportSrtBtn.className = 'btn btn-secondary';
  exportSrtBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;';
  exportSrtBtn.textContent = 'SRT';
  exportSrtBtn.title = 'Download subtitle file (.srt)';

  const exportVttBtn = document.createElement('button');
  exportVttBtn.className = 'btn btn-secondary';
  exportVttBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;';
  exportVttBtn.textContent = 'VTT';
  exportVttBtn.title = 'Download subtitle file (.vtt)';

  const exportKaraokeBtn = document.createElement('button');
  exportKaraokeBtn.className = 'btn btn-secondary';
  exportKaraokeBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;';
  exportKaraokeBtn.textContent = '🎤 Karaoke';
  exportKaraokeBtn.title = 'Download self-contained karaoke HTML player';

  const exportVideoBtn = document.createElement('button');
  exportVideoBtn.className = 'btn btn-secondary';
  exportVideoBtn.style.cssText = 'font-size:0.8rem;padding:4px 10px;';
  exportVideoBtn.textContent = '🎬 Export Video';
  exportVideoBtn.title = 'Record karaoke video file (runs in real-time)';

  const videoStatus = document.createElement('span');
  videoStatus.className = 'text-secondary';
  videoStatus.style.cssText = 'font-size:0.78rem;';

  toolbar.appendChild(problemFilterBtn);
  toolbar.appendChild(editStatus);
  toolbar.appendChild(exportSrtBtn);
  toolbar.appendChild(exportVttBtn);
  toolbar.appendChild(exportKaraokeBtn);
  toolbar.appendChild(exportVideoBtn);
  toolbar.appendChild(videoStatus);
  leftPanel.appendChild(toolbar);

  // Word grid
  const wordGrid = document.createElement('div');
  wordGrid.className = 'word-view-grid seg-word-grid';
  wordGrid.dir = 'rtl';
  leftPanel.appendChild(wordGrid);

  // Bulk edit panel (always visible)
  const bulkPanel = document.createElement('div');
  bulkPanel.style.cssText = 'margin-top:8px;';
  const bulkHint = document.createElement('div');
  bulkHint.className = 'text-secondary';
  bulkHint.style.cssText = 'font-size:0.75rem;margin-bottom:4px;';
  bulkHint.textContent = 'Edit segment text below — blur to apply. Same word count keeps timestamps; different count redistributes evenly.';
  bulkPanel.appendChild(bulkHint);
  const bulkTextarea = document.createElement('textarea');
  bulkTextarea.className = 'transcript-editor';
  bulkTextarea.dir = 'rtl';
  bulkTextarea.rows = 4;
  bulkTextarea.style.cssText = 'width:100%;box-sizing:border-box;font-size:0.85rem;';
  const bulkBtnRow = document.createElement('div');
  bulkBtnRow.style.cssText = 'margin-top:4px;';
  const bulkStatus = document.createElement('span');
  bulkStatus.className = 'text-secondary';
  bulkStatus.style.fontSize = '0.78rem';
  bulkBtnRow.appendChild(bulkStatus);
  bulkPanel.appendChild(bulkTextarea);
  bulkPanel.appendChild(bulkBtnRow);
  leftPanel.appendChild(bulkPanel);

  // Mark reviewed button
  const markReviewedBtn = document.createElement('button');
  markReviewedBtn.className = 'btn btn-primary seg-mark-reviewed-btn';
  leftPanel.appendChild(markReviewedBtn);

  // ── Sidebar ──
  const sidebar = document.createElement('div');
  sidebar.className = 'seg-sidebar';

  mainLayout.appendChild(leftPanel);
  mainLayout.appendChild(sidebar);
  viewer.appendChild(mainLayout);

  // ── Legend ──
  const legend = document.createElement('div');
  legend.className = 'seg-legend';
  [['confidence-high', 'High confidence'], ['confidence-mid', 'Medium confidence'], ['confidence-low', 'Low confidence']].forEach(([cls, label]) => {
    const item = document.createElement('span');
    item.className = 'seg-legend-item';
    const dot = document.createElement('span');
    dot.className = `seg-legend-dot word-chip ${cls}`;
    dot.textContent = 'א';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    item.appendChild(dot);
    item.appendChild(lbl);
    legend.appendChild(item);
  });
  viewer.appendChild(legend);

  renderApproveBar(audioId, viewer, pageContainer);

  // === LOGIC ===

  function fmtSec(s) {
    if (s == null || isNaN(s)) return '?';
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }

  function findNextUnreviewed() {
    for (let i = 0; i < segments.length; i++) {
      if (approvedHashes.has(segHash(i))) continue;
      if (problemFilterActive && !isProblemSegment(i)) continue;
      return i;
    }
    return -1;
  }

  function updateStats() {
    const approvedCount = segments.filter((_, i) => approvedHashes.has(segHash(i))).length;
    const total = segments.length;
    const unapprovedProblems = segments.filter((_, i) => isProblemSegment(i) && !approvedHashes.has(segHash(i))).length;
    statsBar.innerHTML = '';
    [
      ['Approved', approvedCount, 'var(--green)'],
      ['Remaining', total - approvedCount, 'var(--orange)'],
      ['Progress', Math.round(approvedCount / total * 100) + '%', 'var(--accent)'],
      ['Problems', unapprovedProblems, 'var(--red)'],
    ].forEach(([label, val, color]) => {
      const item = document.createElement('span');
      item.className = 'seg-stat-item';
      const lbl = document.createElement('span');
      lbl.className = 'seg-stat-label';
      lbl.textContent = label;
      const valEl = document.createElement('span');
      valEl.className = 'seg-stat-val';
      valEl.style.color = color;
      valEl.textContent = val;
      item.appendChild(lbl);
      item.appendChild(valEl);
      statsBar.appendChild(item);
    });
  }

  function updateSegHeader() {
    const seg = segments[currentSegIdx];
    if (!seg) return;
    segInfo.innerHTML = '';
    const pos = document.createElement('span');
    pos.className = 'seg-position';
    pos.textContent = `${currentSegIdx + 1} / ${segments.length}`;
    const times = document.createElement('span');
    times.className = 'seg-time-range';
    times.textContent = `${fmtSec(seg[0]?.start)} – ${fmtSec(seg[seg.length - 1]?.end)}`;
    const wc = document.createElement('span');
    wc.className = 'seg-word-count';
    wc.textContent = `${seg.length} words`;
    segInfo.appendChild(pos);
    segInfo.appendChild(times);
    segInfo.appendChild(wc);
    if (isProblemSegment(currentSegIdx)) {
      const badge = document.createElement('span');
      badge.className = 'seg-problem-badge';
      badge.textContent = '⚠ problem';
      segInfo.appendChild(badge);
    }

    prevBtn.disabled = currentSegIdx === 0;
    nextBtn.disabled = currentSegIdx === segments.length - 1;
    nextUnreviewedBtn.disabled = findNextUnreviewed() === -1;

    const isApproved = approvedHashes.has(segHash(currentSegIdx));
    markReviewedBtn.textContent = isApproved ? '✓ Approved' : 'Approve Segment';
    markReviewedBtn.className = isApproved
      ? 'btn btn-secondary seg-mark-reviewed-btn seg-approved-btn'
      : 'btn btn-primary seg-mark-reviewed-btn';
  }

  function getSegInsertions(segIdx, posInSeg) {
    return insertions[segIdx]?.[posInSeg] || [];
  }

  function addInsertion(segIdx, posInSeg, word, start, end) {
    if (!insertions[segIdx]) insertions[segIdx] = {};
    if (!insertions[segIdx][posInSeg]) insertions[segIdx][posInSeg] = [];
    insertions[segIdx][posInSeg].push({ word, start, end });
  }

  function interpolateTimestamps(segIdx, posInSeg) {
    const seg = segments[segIdx] || [];
    const prev = posInSeg > 0 ? seg[posInSeg - 1] : null;
    const next = posInSeg < seg.length ? seg[posInSeg] : null;
    const prevEnd = prev?.end ?? (next?.start != null ? next.start - 0.5 : 0);
    const nextStart = next?.start ?? (prevEnd + 0.5);
    const mid = (prevEnd + nextStart) / 2;
    return { start: Math.max(0, mid - 0.05), end: mid + 0.05 };
  }

  function startAddWord(plusBtn, segIdx, posInSeg) {
    if (plusBtn.querySelector('input')) return;
    const { start, end } = interpolateTimestamps(segIdx, posInSeg);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'new word';
    input.dir = 'rtl';
    input.style.cssText = 'width:80px;font-size:inherit;padding:2px 4px;background:var(--surface);color:var(--text);border:1px solid var(--accent);border-radius:3px;';
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '✓';
    confirmBtn.style.cssText = 'font-size:0.75rem;padding:0 4px;color:var(--green);background:none;border:none;cursor:pointer;line-height:1;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✗';
    cancelBtn.style.cssText = 'font-size:0.75rem;padding:0 4px;color:var(--text-secondary);background:none;border:none;cursor:pointer;line-height:1;';
    plusBtn.textContent = '';
    plusBtn.appendChild(input);
    plusBtn.appendChild(confirmBtn);
    plusBtn.appendChild(cancelBtn);
    input.focus();
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const val = input.value.trim();
      if (val) addInsertion(segIdx, posInSeg, val, start, end);
      renderSegmentChips();
      refreshBulkTextarea();
      scheduleAutoSave();
    };
    const cancel = () => { if (done) return; done = true; renderSegmentChips(); };
    confirmBtn.addEventListener('mousedown', e => { e.preventDefault(); commit(); });
    cancelBtn.addEventListener('mousedown', e => { e.preventDefault(); cancel(); });
    input.addEventListener('blur', e => { setTimeout(() => { if (!done) commit(); }, 150); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  function refreshBulkTextarea() {
    const segWords = segments[currentSegIdx] || [];
    const tokens = [];
    for (let pos = 0; pos <= segWords.length; pos++) {
      getSegInsertions(currentSegIdx, pos).forEach(ins => tokens.push(ins.word));
      if (pos < segWords.length) {
        const gi = words.indexOf(segWords[pos]);
        if (gi >= 0 && editModeWords[gi]?._deleted) continue;
        tokens.push(gi >= 0 ? (editModeWords[gi]?.word || segWords[pos].word || '') : (segWords[pos].word || ''));
      }
    }
    bulkTextarea.value = tokens.join(' ');
  }

  function startChipEdit(chip, globalIdx) {
    if (chip.querySelector('input')) return;
    const origWord = editModeWords[globalIdx]?.word || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = origWord;
    input.style.cssText = 'width:auto;min-width:30px;max-width:120px;font-size:inherit;padding:1px 3px;background:var(--surface);color:var(--text);border:1px solid var(--accent);border-radius:3px;box-sizing:content-box;';
    input.size = Math.max(3, origWord.length + 1);
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '✓';
    confirmBtn.title = 'Confirm';
    confirmBtn.style.cssText = 'font-size:0.75rem;padding:0 4px;color:var(--green);background:none;border:none;cursor:pointer;line-height:1;';
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete word';
    deleteBtn.style.cssText = 'font-size:0.75rem;padding:0 4px;color:var(--red);background:none;border:none;cursor:pointer;line-height:1;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✗';
    cancelBtn.title = 'Cancel';
    cancelBtn.style.cssText = 'font-size:0.75rem;padding:0 4px;color:var(--text-secondary);background:none;border:none;cursor:pointer;line-height:1;';
    chip.textContent = '';
    chip.appendChild(input);
    chip.appendChild(confirmBtn);
    chip.appendChild(deleteBtn);
    chip.appendChild(cancelBtn);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const val = input.value.trim() || origWord;
      editModeWords[globalIdx] = { ...editModeWords[globalIdx], word: val, _deleted: false };
      chip.textContent = val;
      refreshBulkTextarea();
      scheduleAutoSave();
    };
    const doDelete = () => {
      if (done) return; done = true;
      editModeWords[globalIdx] = { ...editModeWords[globalIdx], _deleted: true };
      chip.textContent = origWord;
      chip.classList.add('word-deleted');
      chip.style.cursor = 'pointer';
      // Allow clicking deleted chip to un-delete
      chip.onclick = () => {
        editModeWords[globalIdx] = { ...editModeWords[globalIdx], _deleted: false };
        chip.classList.remove('word-deleted');
        chip.onclick = null;
        chip.addEventListener('click', () => startChipEdit(chip, globalIdx));
        refreshBulkTextarea();
        scheduleAutoSave();
      };
      refreshBulkTextarea();
      scheduleAutoSave();
    };
    const cancel = () => { if (done) return; done = true; chip.textContent = origWord; };
    confirmBtn.addEventListener('mousedown', e => { e.preventDefault(); commit(); });
    deleteBtn.addEventListener('mousedown', e => { e.preventDefault(); doDelete(); });
    cancelBtn.addEventListener('mousedown', e => { e.preventDefault(); cancel(); });
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Delete' && input.value === '') { e.preventDefault(); doDelete(); }
      if (e.key === 'Tab') {
        e.preventDefault(); commit();
        const curPos = chipEls.findIndex(c => c === chip);
        const nextChip = chipEls[curPos + (e.shiftKey ? -1 : 1)];
        if (nextChip) { const gi = parseInt(nextChip.dataset.globalIdx, 10); if (!isNaN(gi)) startChipEdit(nextChip, gi); }
      }
    });
  }

  function renderSegmentChips() {
    wordGrid.innerHTML = '';
    chipEls = [];
    const segWords = segments[currentSegIdx] || [];

    if (segWords.length === 0) {
      const notice = document.createElement('div');
      notice.style.cssText = 'padding:16px;color:var(--text-secondary);font-size:0.9rem;text-align:center;';
      notice.textContent = 'Empty segment.';
      wordGrid.appendChild(notice);
      return;
    }

    const addPlusBtn = (posInSeg) => {
      const btn = document.createElement('span');
      btn.className = 'word-add-btn';
      btn.textContent = '+';
      btn.title = 'Insert word here';
      btn.addEventListener('click', () => startAddWord(btn, currentSegIdx, posInSeg));
      wordGrid.appendChild(btn);
    };

    segWords.forEach((w, posInSeg) => {
      // Insertions before this position
      if (editMode) {
        getSegInsertions(currentSegIdx, posInSeg).forEach(ins => {
          const iSpan = document.createElement('span');
          iSpan.className = 'word-chip confidence-high word-inserted';
          iSpan.textContent = ins.word;
          iSpan.title = `Inserted: ${fmtSec(ins.start)}–${fmtSec(ins.end)}`;
          wordGrid.appendChild(iSpan);
        });
        addPlusBtn(posInSeg);
      }

      const globalIdx = words.indexOf(w);
      const isDeleted = globalIdx >= 0 && editModeWords[globalIdx]?._deleted;
      const conf = typeof w.confidence === 'number' ? w.confidence : 1;
      const span = document.createElement('span');
      span.className = `word-chip confidence-${getConfidenceLevel(conf)}${isDeleted ? ' word-deleted' : ''}`;
      const wordText = (globalIdx >= 0 ? editModeWords[globalIdx]?.word : null) || w.word || w.text || '';
      span.title = isDeleted ? `Deleted — click to restore` : `${(conf * 100).toFixed(0)}% | ${fmtSec(w.start)}–${fmtSec(w.end)}`;
      span.textContent = wordText;
      span.dataset.globalIdx = String(globalIdx);

      if (isDeleted && editMode) {
        span.style.cursor = 'pointer';
        span.addEventListener('click', () => {
          editModeWords[globalIdx] = { ...editModeWords[globalIdx], _deleted: false };
          span.classList.remove('word-deleted');
          span.title = `${(conf * 100).toFixed(0)}% | ${fmtSec(w.start)}–${fmtSec(w.end)}`;
          span.style.cursor = 'text';
          span.onclick = null;
          span.addEventListener('click', () => startChipEdit(span, globalIdx));
          refreshBulkTextarea();
        });
      } else if (editMode && globalIdx >= 0) {
        span.style.cursor = 'text';
        span.addEventListener('click', () => startChipEdit(span, globalIdx));
      } else if (playerEl) {
        span.style.cursor = isDeleted ? 'default' : 'pointer';
        if (!isDeleted) {
          const seekFn = () => { playerEl.currentTime = w.start; if (playerEl.paused) playerEl.play(); };
          span._seekHandler = seekFn;
          span.addEventListener('click', seekFn);
        }
      }

      wordGrid.appendChild(span);
      if (!isDeleted) chipEls.push(span);
    });

    // Insertions and final + button after last word
    if (editMode) {
      getSegInsertions(currentSegIdx, segWords.length).forEach(ins => {
        const iSpan = document.createElement('span');
        iSpan.className = 'word-chip confidence-high word-inserted';
        iSpan.textContent = ins.word;
        iSpan.title = `Inserted: ${fmtSec(ins.start)}–${fmtSec(ins.end)}`;
        wordGrid.appendChild(iSpan);
      });
      addPlusBtn(segWords.length);
    }

    if (editMode) refreshBulkTextarea();
  }

  const SIDEBAR_LIMIT = 8;

  function renderSidebar() {
    sidebar.innerHTML = '';
    let showAll = segments.length <= SIDEBAR_LIMIT;

    const title = document.createElement('div');
    title.style.cssText = 'font-size:0.72rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;';
    title.textContent = `Segments (${segments.length})`;
    sidebar.appendChild(title);

    const listEl = document.createElement('div');
    listEl.className = 'seg-sidebar-list';
    sidebar.appendChild(listEl);

    function renderList() {
      listEl.innerHTML = '';
      const count = showAll ? segments.length : Math.min(SIDEBAR_LIMIT, segments.length);
      for (let i = 0; i < count; i++) {
        const seg = segments[i];
        const isProb = isProblemSegment(i);
        const isApproved = approvedHashes.has(segHash(i));
        if (problemFilterActive && !isProb) continue; // hide non-problem segs when filter active
        const item = document.createElement('div');
        item.className = 'seg-sidebar-item'
          + (i === currentSegIdx ? ' active' : '')
          + (isApproved ? ' reviewed' : '');

        if (isApproved) {
          const check = document.createElement('span');
          check.className = 'seg-sidebar-check';
          check.textContent = '✓';
          item.appendChild(check);
        } else if (isProb) {
          const warn = document.createElement('span');
          warn.className = 'seg-sidebar-warn';
          warn.textContent = '⚠';
          item.appendChild(warn);
        }

        const numEl = document.createElement('span');
        numEl.className = 'seg-sidebar-num';
        numEl.textContent = i + 1;

        const infoEl = document.createElement('div');
        infoEl.className = 'seg-sidebar-info';
        const timeSpan = document.createElement('span');
        timeSpan.textContent = `${fmtSec(seg[0]?.start)}–${fmtSec(seg[seg.length - 1]?.end)}`;
        const wcSpan = document.createElement('span');
        wcSpan.textContent = seg.length + 'w';
        infoEl.appendChild(timeSpan);
        infoEl.appendChild(wcSpan);

        item.appendChild(numEl);
        item.appendChild(infoEl);
        item.addEventListener('click', () => goToSegment(i));
        listEl.appendChild(item);
      }
    }

    renderList();
    sidebar._renderList = renderList;

    if (segments.length > SIDEBAR_LIMIT) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-secondary';
      toggleBtn.style.cssText = 'font-size:0.72rem;padding:3px 8px;margin-top:4px;width:100%;';
      toggleBtn.textContent = `Show all ${segments.length}…`;
      sidebar.appendChild(toggleBtn);
      toggleBtn.addEventListener('click', () => {
        showAll = !showAll;
        toggleBtn.textContent = showAll ? 'Show less' : `Show all ${segments.length}…`;
        renderList();
      });
    }
  }

  function goToSegment(idx) {
    if (idx < 0 || idx >= segments.length) return;
    currentSegIdx = idx;
    if (playerEl) {
      playerEl.currentTime = segments[idx][0]?.start ?? 0;
      if (playerEl.paused) playerEl.play().catch(() => {});
    }
    renderSegmentChips();
    updateSegHeader();
    updateStats();
    if (sidebar._renderList) sidebar._renderList();
  }

  // ── Karaoke highlight + auto-advance ──
  if (playerEl) {
    if (playerEl._wordViewTimeUpdate) playerEl.removeEventListener('timeupdate', playerEl._wordViewTimeUpdate);
    let prevActiveChip = null;
    const onTimeUpdate = () => {
      const t = playerEl.currentTime;
      let found = null;
      for (const chip of chipEls) {
        const gi = parseInt(chip.dataset.globalIdx, 10);
        if (isNaN(gi)) continue;
        const w = words[gi];
        if (w && t >= w.start && t < w.end) { found = chip; break; }
      }
      if (prevActiveChip && prevActiveChip !== found) prevActiveChip.classList.remove('active');
      if (found && found !== prevActiveChip) {
        found.classList.add('active');
        // Only auto-scroll when the word view section is actually in the viewport
        const rect = container.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          found.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
      prevActiveChip = found;

      // Pause at the end of the current segment — only when word view is visible
      // (avoids interfering with the top audio player when user is scrolled up)
      const segWords = segments[currentSegIdx];
      if (segWords?.length && !playerEl.paused) {
        const wvRect = container.getBoundingClientRect();
        if (wvRect.top < window.innerHeight && wvRect.bottom > 0) {
          const segEnd = segWords[segWords.length - 1].end;
          if (t >= segEnd) playerEl.pause();
        }
      }
    };
    playerEl._wordViewTimeUpdate = onTimeUpdate;
    playerEl.addEventListener('timeupdate', onTimeUpdate);
  }

  function getCurrentWords() {
    return words.map((w, i) => editModeWords[i] ? { ...w, ...editModeWords[i] } : w).filter(w => !w._deleted);
  }

  // ── Auto-save: commit edits to state after a short debounce ──
  let _saveTimer = null;
  function scheduleAutoSave() {
    clearTimeout(_saveTimer);
    editStatus.textContent = 'Editing…';
    _saveTimer = setTimeout(() => commitEdits(), 1500);
  }

  function commitEdits() {
    clearTimeout(_saveTimer);
    const openInput = wordGrid.querySelector('input');
    if (openInput) openInput.blur(); // commit any open inline edit first

    const currentAlignment = getState().alignments?.[audioId] || alignment;
    const finalWords = [];
    let addedCount = 0;
    let deletedCount = 0;
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      for (let pos = 0; pos <= seg.length; pos++) {
        (insertions[s]?.[pos] || []).forEach(ins => {
          finalWords.push({ word: ins.word, start: ins.start, end: ins.end, confidence: 1 });
          addedCount++;
        });
        if (pos < seg.length) {
          const gi = words.indexOf(seg[pos]);
          const ew = gi >= 0 ? editModeWords[gi] : null;
          if (ew?._deleted) { deletedCount++; continue; }
          finalWords.push(ew ? { ...ew, _deleted: undefined } : seg[pos]);
        }
      }
    }

    const updatedAlignment = { ...currentAlignment, words: finalWords };
    updateState('alignments', audioId, updatedAlignment);
    const versionId = activeVersionRef?.id;
    if (versionId) {
      setVersionAlignment(audioId, versionId, updatedAlignment);
      const newText = finalWords.map(w => w.word || w.text || '').join(' ');
      updateVersion(audioId, versionId, { text: newText, updatedAt: new Date().toISOString() });
      activeVersionRef?.rerenderContent?.();
    }

    // Update live arrays in-place so karaoke/seek stays in sync
    words.splice(0, words.length, ...finalWords);
    const newSegs = [];
    if (words.length) {
      let cur = [words[0]];
      for (let i = 1; i < words.length; i++) {
        if ((words[i].start - words[i - 1].end) > GAP_THRESHOLD) { newSegs.push(cur); cur = [words[i]]; }
        else cur.push(words[i]);
      }
      newSegs.push(cur);
    }
    segments.splice(0, segments.length, ...newSegs);
    editModeWords.splice(0, editModeWords.length, ...finalWords.map(w => ({ ...w })));
    Object.keys(insertions).forEach(k => delete insertions[k]);

    renderSegmentChips();
    const parts = [];
    if (addedCount) parts.push(`+${addedCount}`);
    if (deletedCount) parts.push(`−${deletedCount}`);
    editStatus.textContent = parts.length ? `Saved (${parts.join(', ')})` : 'Saved ✓';
    setTimeout(() => { editStatus.textContent = ''; }, 2000);
  }

  function getExportBaseName() {
    const state = getState();
    const audio = state.audio?.find(a => a.id === audioId);
    return (audio?.name || audioId).replace(/\.[^.]+$/, '');
  }

  exportSrtBtn.addEventListener('click', () => {
    const srt = generateSRT(getCurrentWords());
    if (!srt) { alert('No aligned words to export.'); return; }
    downloadFile(srt, `${getExportBaseName()}.srt`, 'text/plain');
  });

  exportVttBtn.addEventListener('click', () => {
    const vtt = generateVTT(getCurrentWords());
    if (!vtt) { alert('No aligned words to export.'); return; }
    downloadFile(vtt, `${getExportBaseName()}.vtt`, 'text/vtt');
  });

  exportKaraokeBtn.addEventListener('click', () => {
    const exportWords = getCurrentWords();
    if (!exportWords.length) { alert('No aligned words to export.'); return; }
    const state = getState();
    const audio = state.audio?.find(a => a.id === audioId);
    const r2Link = audio?.r2Link;
    const audioSrc = r2Link
      ? `https://jem-asr-app.pages.dev/api/audio?url=${encodeURIComponent(r2Link)}`
      : (playerEl?.src || '');
    const baseName = getExportBaseName();
    const html = generateKaraokeHTML(exportWords, audioSrc, baseName);
    downloadFile(html, `${baseName}-karaoke.html`, 'text/html');
  });

  let cancelVideoExport = null;
  exportVideoBtn.addEventListener('click', async () => {
    if (cancelVideoExport) {
      cancelVideoExport();
      cancelVideoExport = null;
      exportVideoBtn.textContent = '🎬 Export Video';
      videoStatus.textContent = '';
      return;
    }
    if (!playerEl) { alert('No audio player found.'); return; }
    const exportWords = getCurrentWords();
    if (!exportWords.length) { alert('No aligned words to export.'); return; }

    // Normalize to {w, s, e} for the renderer
    const normWords = exportWords.map(w => ({
      w: w.word || w.text || '',
      s: w.start ?? 0,
      e: w.end ?? 0,
    }));

    exportVideoBtn.textContent = '⏹ Cancel Recording';
    videoStatus.textContent = 'Starting...';

    try {
      cancelVideoExport = startKaraokeVideoExport(
        normWords,
        playerEl,
        getExportBaseName(),
        text => { videoStatus.textContent = text; },
        msg => {
          cancelVideoExport = null;
          exportVideoBtn.textContent = '🎬 Export Video';
          videoStatus.textContent = msg;
          setTimeout(() => { videoStatus.textContent = ''; }, 5000);
        }
      );
    } catch (err) {
      cancelVideoExport = null;
      exportVideoBtn.textContent = '🎬 Export Video';
      videoStatus.textContent = `Error: ${err?.message || String(err) || 'unknown'}`;
    }
  });

  // Bulk textarea auto-applies on blur (no button needed)
  function applyBulkText() {
    const segWords = segments[currentSegIdx] || [];
    const tokens = bulkTextarea.value.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;

    if (tokens.length === segWords.length) {
      tokens.forEach((tok, i) => {
        const gi = words.indexOf(segWords[i]);
        if (gi >= 0) editModeWords[gi] = { ...editModeWords[gi], word: tok };
      });
    } else {
      const segStart = segWords[0]?.start ?? 0;
      const segEnd = segWords[segWords.length - 1]?.end ?? segStart + 1;
      const dur = (segEnd - segStart) / tokens.length;
      segWords.forEach(w => {
        const gi = words.indexOf(w);
        if (gi >= 0) editModeWords[gi] = { ...editModeWords[gi], _deleted: true };
      });
      if (!insertions[currentSegIdx]) insertions[currentSegIdx] = {};
      insertions[currentSegIdx][0] = tokens.map((tok, i) => ({
        word: tok,
        start: +(segStart + i * dur).toFixed(3),
        end: +(segStart + (i + 1) * dur).toFixed(3),
      }));
    }

    renderSegmentChips();
    scheduleAutoSave();
  }

  bulkTextarea.addEventListener('blur', applyBulkText);

  prevBtn.addEventListener('click', () => {
    if (problemFilterActive) {
      let idx = currentSegIdx - 1;
      while (idx >= 0 && !isProblemSegment(idx)) idx--;
      if (idx >= 0) goToSegment(idx);
    } else {
      goToSegment(currentSegIdx - 1);
    }
  });
  nextBtn.addEventListener('click', () => {
    if (problemFilterActive) {
      let idx = currentSegIdx + 1;
      while (idx < segments.length && !isProblemSegment(idx)) idx++;
      if (idx < segments.length) goToSegment(idx);
    } else {
      goToSegment(currentSegIdx + 1);
    }
  });
  nextUnreviewedBtn.addEventListener('click', () => { const idx = findNextUnreviewed(); if (idx >= 0) goToSegment(idx); });

  markReviewedBtn.addEventListener('click', () => {
    const hash = segHash(currentSegIdx);
    const audioEntry = getState().audio?.find(a => a.id === audioId);
    const isNowApproved = toggleSegmentApproval(audioId, hash);
    syncSegmentApproval(audioId, hash, isNowApproved, getCurrentUser(), audioEntry).catch(console.warn);
    updateStats();
    updateSegHeader();
    if (sidebar._renderList) sidebar._renderList();
  });

  // Initial render
  renderSegmentChips();
  updateSegHeader();
  updateStats();
  renderSidebar();

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
      document.body.style.userSelect = 'none';
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
      document.body.style.userSelect = '';
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

