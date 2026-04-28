import './app-shell.js';
import { initState, getState, getStatus, getCompletedStages, PIPELINE_STAGES, getVersions, getBestVersion, addVersion, updateVersion, updateState, mergeSupabaseData, setVersionAlignment, getAlignedVersions, getPipelineStep, getIterationCount, setSegmentApprovals, getApprovedSegments, toggleSegmentApproval } from './state.js';
import { checkAuth, signOut, getCurrentUser, getUserLibraries, getActiveLibrary, setActiveLibrary, getActiveLibraryConfig, isLibraryR2Url, getAccessToken } from './auth.js';
import { renderSuggestedMatches, linkMatch, unlinkMatch, renderSearchModal } from './mapping.js';
import { batchClean, cleanSectionMarkers, cleanMinor, cleanIntroText, cleanWhitespace, findBracketMatches, findParenMatches, findMinorMatches, applyMatchActions, calculateCleanRate } from './cleaning.js';
import { alignRow, transcribeAudio, ALIGNER_OPTIONS, getAlignerChoice, setAlignerChoice } from './alignment.js';
import { createSplitFromAudio } from './split.js';
import { renderAsrConfig, runBenchmark, renderBenchmarkTable } from './benchmark.js';
import { buildAsrConfigPanel } from './asr-config.js';
import { getMergedVertexEndpoints } from './vertex-registry.js';

import { formatConfidence, getConfidenceLevel, generateSRT, generateVTT, downloadFile, diffWords } from './utils.js';
import { loadAlignmentWords, loadTranscriptText, loadForDetailPage, syncAudioDuration, syncAudioField, loadSegmentApprovals, syncSegmentApproval } from './db.js';

// ── Pipeline indicator for detail page ──────────────────────────────

function renderDetailPipeline(audioId) {
  const stages = getCompletedStages(audioId);

  // Unmapped — show old-style badge
  if (!stages.mapped) {
    const badge = document.createElement('span');
    badge.className = 'status-badge status-unmapped';
    badge.textContent = 'unmapped';
    return badge;
  }

  const container = document.createElement('span');
  container.className = 'pipeline-indicator pipeline-detail';

  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    if (i > 0) {
      const conn = document.createElement('span');
      conn.className = 'pipeline-connector ' + (stages[PIPELINE_STAGES[i]] ? 'done' : 'pending');
      container.appendChild(conn);
    }
    const name = PIPELINE_STAGES[i];
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
    remote = await loadForDetailPage(audioId, activeLib);
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

// In-memory override for the "active" version per audio, written by the
// version picker. Survives renderDetailPage re-renders (which otherwise reset
// activeVersionRef to getBestVersion) but resets on full page reload — that's
// fine, we just need the user's choice to stick while they're on the page.
const _pickedVersionByAudio = new Map();

// In-memory override for the "compare to" target version per audio, used by
// the diff panel below the version picker. Same lifetime / reset semantics
// as _pickedVersionByAudio. A null value means "no comparison active".
const _compareVersionByAudio = new Map();

function renderDetailPage(audioId, audio, state, container) {
  container.innerHTML = '';
  const status = getStatus(audioId);

  // Track this audio in the "Recently viewed" list (rail nav on table page)
  try {
    const KEY = 'jem-asr-recent-views-v1';
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    const filtered = list.filter(it => it && it.id !== audioId);
    filtered.unshift({ id: audioId, name: audio.name || audioId, at: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(filtered.slice(0, 12)));
  } catch (_) { /* no-op */ }

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

  // Prev / Next sibling navigation (J / K keyboard) — uses the natural
  // order of state.audio so users can sweep through the library without
  // bouncing to the table page.
  const navWrap = document.createElement('span');
  navWrap.className = 'detail-prevnext';
  const allIds = (state.audio || []).map(a => a.id);
  const idx = allIds.indexOf(audioId);
  const prevId = idx > 0 ? allIds[idx - 1] : null;
  const nextId = idx >= 0 && idx < allIds.length - 1 ? allIds[idx + 1] : null;
  function goTo(id) {
    if (!id) return;
    window.location.href = `/detail.html?id=${encodeURIComponent(id)}`;
  }
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'detail-prevnext__btn';
  prevBtn.disabled = !prevId;
  prevBtn.title = prevId ? `Previous: ${(state.audio.find(a=>a.id===prevId)||{}).name || prevId} (K)` : 'No previous file';
  prevBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  prevBtn.addEventListener('click', () => goTo(prevId));
  const counter = document.createElement('span');
  counter.className = 'detail-prevnext__counter';
  counter.textContent = idx >= 0 ? `${idx + 1} / ${allIds.length}` : '';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'detail-prevnext__btn';
  nextBtn.disabled = !nextId;
  nextBtn.title = nextId ? `Next: ${(state.audio.find(a=>a.id===nextId)||{}).name || nextId} (J)` : 'No next file';
  nextBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  nextBtn.addEventListener('click', () => goTo(nextId));
  navWrap.appendChild(prevBtn);
  navWrap.appendChild(counter);
  navWrap.appendChild(nextBtn);
  titleBar.appendChild(navWrap);

  // J / K keyboard shortcuts (only when not typing in an editor)
  if (!window._detailPrevNextWired) {
    window._detailPrevNextWired = true;
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'j' || e.key === 'J') {
        const btn = document.querySelector('.detail-prevnext__btn:nth-child(3)');
        if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      } else if (e.key === 'k' || e.key === 'K') {
        const btn = document.querySelector('.detail-prevnext__btn:nth-child(1)');
        if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      }
    });
  }

  // Pipeline progress indicator
  titleBar.appendChild(renderDetailPipeline(audioId));
  // Save indicator chip (right-aligned)
  const saveChip = document.createElement('span');
  saveChip.className = 'save-indicator';
  saveChip.style.marginInlineStart = 'auto';
  saveChip.dataset.role = 'save-indicator';
  saveChip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>All changes saved</span>';
  titleBar.appendChild(saveChip);
  container.appendChild(titleBar);

  // Split-relationship links — parent + sibling parts. Split IDs follow
  // `<parentId>_p<n>` (see split.js:nextSplitId) so the whole hierarchy is
  // derivable from `state.audio` without any schema change.
  const partMatch = /^(.+)_p(\d+)$/.exec(audioId);
  const parentId = partMatch ? partMatch[1] : audioId;
  const siblingIds = (state.audio || [])
    .map(a => a.id)
    .filter(id => id !== audioId && (id === parentId || new RegExp('^' + parentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_p\\d+$').test(id)))
    .sort((a, b) => {
      const ma = /_p(\d+)$/.exec(a); const mb = /_p(\d+)$/.exec(b);
      return (ma ? +ma[1] : 1) - (mb ? +mb[1] : 1);
    });
  if (siblingIds.length > 0) {
    const row = document.createElement('div');
    row.className = 'split-links-row';
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 10px;font-size:0.82rem;color:var(--text-secondary,#666);';
    const label = document.createElement('span');
    label.textContent = partMatch ? 'Parts:' : 'Split parts:';
    row.appendChild(label);
    const linkFor = (id) => {
      const a = (state.audio || []).find(x => x.id === id);
      const link = document.createElement('a');
      link.href = `/detail?id=${encodeURIComponent(id)}`;
      link.style.cssText = 'color:var(--primary,#2962ff);text-decoration:none;padding:2px 8px;border:1px solid var(--border,#ddd);border-radius:10px;';
      const m = /_p(\d+)$/.exec(id);
      link.textContent = m ? `Part ${m[1]}` : 'Parent';
      link.title = a?.name || id;
      return link;
    };
    // For a part: show parent first, then siblings
    if (partMatch) row.appendChild(linkFor(parentId));
    siblingIds.filter(id => id !== parentId).forEach(id => row.appendChild(linkFor(id)));
    container.appendChild(row);
  }

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

  // Training-export status (set by scripts/export-approved-to-ivrit.mjs).
  // Renders only when the file has been exported, so reviewers can tell at a
  // glance which files are already in the training set vs. still need work.
  if (audio.trainingExportedAt) {
    const exportedRow = document.createElement('div');
    exportedRow.className = 'training-exported-row';
    const badge = document.createElement('span');
    badge.className = 'status-badge status-exported';
    badge.textContent = '✓ Exported for Training';
    const when = new Date(audio.trainingExportedAt).toLocaleString();
    const detail = document.createElement('span');
    detail.className = 'training-exported-detail';
    detail.textContent = audio.trainingExportedBy
      ? `${when} · by ${audio.trainingExportedBy}`
      : when;
    exportedRow.appendChild(badge);
    exportedRow.appendChild(detail);
    container.appendChild(exportedRow);
  }

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

  // === Section: Mapping (always shown, including benchmark files) ===
  const mappingSection = createSection('Transcript Mapping');
  // Collapse mapping on mobile if already mapped or further along
  addCollapseBehavior(mappingSection.el, mappingSection.header, status !== 'unmapped');
  // Honor a version-picker override if the user selected one this session.
  const pickedId = _pickedVersionByAudio.get(audioId);
  const pickedValid = pickedId && (getVersions(audioId) || []).some(v => v.id === pickedId);
  const activeVersionRef = { id: pickedValid ? pickedId : (getBestVersion(audioId)?.id || null) };
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

  // === Benchmark section — only for benchmark files ===
  if (audio.isBenchmark) {
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
  // Publish rail nav after sections are mounted
  setTimeout(publishDetailRailSections, 0);
  // Hook autosave indicator into editable surfaces
  setTimeout(() => attachSaveIndicator(container), 0);
}

// ────────────────────────────────────────────────────────────────────
// Save-indicator hook: turns the chip in .detail-title-bar into a live
// status. On blur of any contenteditable / textarea / input within the
// detail page, briefly show "Saving…" then "Saved · Xs ago". Uses
// optimistic UI — the actual persistence is handled elsewhere; we just
// reflect the lifecycle visually.
// ────────────────────────────────────────────────────────────────────
let _lastSaveAt = null;
let _saveTickInterval = null;
function setSaveIndicator(state, opts = {}) {
  const chip = document.querySelector('.save-indicator[data-role="save-indicator"]');
  if (!chip) return;
  chip.classList.remove('save-indicator--saving', 'save-indicator--saved', 'save-indicator--error');
  if (state === 'saving') {
    chip.classList.add('save-indicator--saving');
    chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>Saving…</span>';
  } else if (state === 'saved') {
    chip.classList.add('save-indicator--saved');
    _lastSaveAt = Date.now();
    refreshSavedLabel();
    if (!_saveTickInterval) _saveTickInterval = setInterval(refreshSavedLabel, 15000);
  } else if (state === 'error') {
    chip.classList.add('save-indicator--error');
    chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>' + (opts.detail || 'Save failed') + '</span>';
  } else {
    chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>All changes saved</span>';
  }
}
function refreshSavedLabel() {
  const chip = document.querySelector('.save-indicator[data-role="save-indicator"]');
  if (!chip || !_lastSaveAt) return;
  const sec = Math.max(1, Math.round((Date.now() - _lastSaveAt) / 1000));
  let phrase;
  if (sec < 60) phrase = `Saved · ${sec}s ago`;
  else if (sec < 3600) phrase = `Saved · ${Math.round(sec / 60)}m ago`;
  else phrase = 'Saved';
  if (chip.classList.contains('save-indicator--saved')) {
    chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>' + phrase + '</span>';
  }
}

let _attachedSave = new WeakSet();
function attachSaveIndicator(container) {
  if (!container) return;
  const targets = container.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]');
  targets.forEach(el => {
    if (_attachedSave.has(el)) return;
    _attachedSave.add(el);
    let dirty = false;
    el.addEventListener('input', () => {
      dirty = true;
      setSaveIndicator('saving');
    });
    el.addEventListener('blur', () => {
      if (!dirty) return;
      dirty = false;
      // Optimistic: assume the underlying save will succeed since the
      // existing handlers already commit on blur.
      setTimeout(() => setSaveIndicator('saved'), 350);
    });
  });
}

// Cmd+S forces a flush by blurring the active editor (which triggers
// the existing save handlers).
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
    const active = document.activeElement;
    if (active && (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      e.preventDefault();
      active.blur();
      // Re-focus shortly so the user can keep editing
      setTimeout(() => active.focus && active.focus(), 50);
    }
  }
});

function createSection(title) {
  const el = document.createElement('section');
  el.className = 'detail-section';
  // Slug for in-page jump from rail / cmdk
  const slug = String(title || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug) el.id = `section-${slug}`;
  el.dataset.sectionTitle = title;
  const header = document.createElement('h3');
  header.className = 'detail-section-title';
  header.textContent = title;
  el.appendChild(header);
  const content = document.createElement('div');
  content.className = 'detail-section-content';
  el.appendChild(content);
  return { el, header, content };
}

// Walk the rendered detail page and publish a "Sections" rail block so
// the user can jump between Audio Player / Mapping / Versions / etc.
function publishDetailRailSections() {
  try {
    const sections = Array.from(document.querySelectorAll('.detail-section'));
    if (sections.length === 0) return;
    const items = sections.map(sec => ({
      label: sec.dataset.sectionTitle || sec.id || 'Section',
      icon: 'layoutGrid',
      onClick: (e) => {
        if (e) e.preventDefault();
        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return false;
      },
    }));
    import('./app-shell.js').then(mod => {
      if (typeof mod.setContextualSections === 'function') {
        mod.setContextualSections([{ heading: 'On this page', items }]);
      }
    });
  } catch (e) { /* no-op */ }
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

// Turn an endpoint name into a model-key slug. Falls back to the endpoint's
// trailing id digits if no name is set.
function geminiSlug(ep) {
  if (!ep) return 'unknown';
  const base = (ep.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base) return base;
  if (ep.endpointId) return `ep-${String(ep.endpointId).slice(-6)}`;
  return 'unknown';
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

  // Per-call bias / prompt area — Whisper ignores. Gemini uses it as the
  // user-turn prompt; Mendel uses it as the YL `context` field. Compact on
  // the detail bar; an "Edit fullscreen" link opens an overlay for longer
  // prompts. Last value persists across pages via the same localStorage key
  // as the dedicated Transcribe page.
  const promptWrap = document.createElement('div');
  promptWrap.style.cssText = 'flex:1;min-width:240px;display:flex;flex-direction:column;gap:4px;';
  // System instruction (Vertex/Gemini only) — separate top-level field.
  // Compact one-line input; the fullscreen overlay exposes a multi-line view.
  const sysInput = document.createElement('input');
  sysInput.type = 'text';
  sysInput.className = 'gemini-prompt-input';
  sysInput.placeholder = 'Optional system instruction (Gemini only) — sets tone/format rules separate from the per-call prompt.';
  sysInput.title = 'Sent to Vertex as systemInstruction. Mendel and Whisper ignore.';
  sysInput.style.cssText = 'width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:0.78rem;background:var(--surface);color:var(--text);outline:none;transition:border-color 150ms, box-shadow 150ms;';
  sysInput.addEventListener('focus', () => { sysInput.style.borderColor = 'var(--accent)'; sysInput.style.boxShadow = '0 0 0 3px var(--accent-dim)'; });
  sysInput.addEventListener('blur',  () => { sysInput.style.borderColor = 'var(--border)'; sysInput.style.boxShadow = 'none'; });
  try {
    const savedSys = localStorage.getItem('jem-asr-last-gemini-system');
    if (savedSys) sysInput.value = savedSys;
  } catch {}
  sysInput.addEventListener('input', () => {
    try { localStorage.setItem('jem-asr-last-gemini-system', sysInput.value); } catch {}
  });
  promptWrap.appendChild(sysInput);
  const promptInput = document.createElement('textarea');
  promptInput.className = 'gemini-prompt-input';
  promptInput.rows = 2;
  promptInput.placeholder = 'Optional bias / context — Whisper ignores this; Gemini uses it as the prompt, Mendel uses it as `context` (vocabulary hint).';
  promptInput.title = 'Used as Gemini prompt and Mendel `context` field. Whisper ignores this.';
  promptInput.style.cssText = 'width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:0.85rem;line-height:1.45;resize:vertical;font-family:inherit;background:var(--surface);color:var(--text);outline:none;transition:border-color 150ms, box-shadow 150ms;';
  promptInput.addEventListener('focus', () => { promptInput.style.borderColor = 'var(--accent)'; promptInput.style.boxShadow = '0 0 0 3px var(--accent-dim)'; });
  promptInput.addEventListener('blur',  () => { promptInput.style.borderColor = 'var(--border)'; promptInput.style.boxShadow = 'none'; });
  try {
    const saved = localStorage.getItem('jem-asr-last-gemini-prompt');
    if (saved) promptInput.value = saved;
  } catch {}
  promptInput.addEventListener('input', () => {
    try { localStorage.setItem('jem-asr-last-gemini-prompt', promptInput.value); } catch {}
  });
  promptWrap.appendChild(promptInput);
  // Subtle hint row
  const promptHint = document.createElement('div');
  promptHint.style.cssText = 'font-size:0.72rem;color:var(--text-muted);display:flex;justify-content:space-between;gap:6px;';
  const promptHintText = document.createElement('span');
  promptHintText.textContent = 'Each Gemini run is saved as a new version with a timestamp.';
  promptHint.appendChild(promptHintText);
  const fullscreenLink = document.createElement('a');
  fullscreenLink.href = '#';
  fullscreenLink.textContent = 'Expand';
  fullscreenLink.style.cssText = 'color:var(--accent);text-decoration:none;font-weight:600;';
  fullscreenLink.addEventListener('click', (e) => {
    e.preventDefault();
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px;';
    const dlg = document.createElement('div');
    dlg.style.cssText = 'background:var(--surface);border-radius:var(--radius-2xl);box-shadow:var(--shadow-lg);width:min(900px,92vw);max-height:88vh;display:flex;flex-direction:column;padding:22px;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
    const title = document.createElement('h3');
    title.textContent = 'Edit Gemini prompt';
    title.style.cssText = 'margin:0;font-size:1rem;font-weight:700;letter-spacing:-0.01em;';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'action-btn';
    done.textContent = 'Done';
    head.appendChild(title);
    head.appendChild(done);
    const area = document.createElement('textarea');
    area.value = promptInput.value;
    area.style.cssText = 'flex:1;width:100%;min-height:50vh;padding:14px 16px;border:1px solid var(--border);border-radius:var(--radius);font-size:0.95rem;line-height:1.6;font-family:inherit;resize:vertical;outline:none;';
    area.addEventListener('focus', () => { area.style.borderColor = 'var(--accent)'; area.style.boxShadow = '0 0 0 3px var(--accent-dim)'; });
    area.addEventListener('blur',  () => { area.style.borderColor = 'var(--border)'; area.style.boxShadow = 'none'; });
    dlg.appendChild(head);
    dlg.appendChild(area);
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);
    area.focus();
    const close = () => {
      promptInput.value = area.value;
      try { localStorage.setItem('jem-asr-last-gemini-prompt', area.value); } catch {}
      document.body.removeChild(overlay);
    };
    done.addEventListener('click', close);
    overlay.addEventListener('click', (e2) => { if (e2.target === overlay) close(); });
  });
  promptHint.appendChild(fullscreenLink);
  promptWrap.appendChild(promptHint);
  bar.appendChild(promptWrap);

  for (const { key, label: btnLabel } of PROVIDERS) {
    const btn = document.createElement('button');
    btn.className = 'action-btn action-btn-primary';
    btn.style.fontSize = '0.8rem';
    btn.textContent = btnLabel;

    // For Gemini, a dropdown next to the button lets the user pick which
    // tuned endpoint to use, out of the list configured in ASR Settings.
    let geminiPicker = null;
    if (key === 'gemini') {
      const providers = getState().transcribeProviders || {};
      const g = providers.gemini || { endpoints: [], selectedId: null };
      const endpoints = Array.isArray(g.endpoints) ? g.endpoints : [];
      if (endpoints.length > 0) {
        geminiPicker = document.createElement('select');
        geminiPicker.className = 'gemini-endpoint-picker';
        geminiPicker.style.cssText = 'padding:3px 6px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:0.8rem;background:#fff;';
        geminiPicker.setAttribute('aria-label', 'Select Gemini endpoint');
        endpoints.forEach((ep) => {
          const opt = document.createElement('option');
          opt.value = ep.id;
          opt.textContent = ep.name || `Endpoint ${ep.endpointId?.slice(-6) || '?'}`;
          if (ep.id === g.selectedId) opt.selected = true;
          geminiPicker.appendChild(opt);
        });
        geminiPicker.addEventListener('change', (e) => {
          const s = getState();
          s.transcribeProviders.gemini.selectedId = e.target.value;
          updateState('transcribeProviders', null, s.transcribeProviders);
        });
      }
    }

    btn.addEventListener('click', async () => {
      if (!audioUrl) { alert('No audio URL for this file.'); return; }
      btn.disabled = true;
      btn.textContent = `${btnLabel}…`;

      try {
        const providers = getState().transcribeProviders || {};
        let providerCfg = providers[key] || {};
        let saveModel = key;
        let prompt = null;
        let promptLabel = null;
        if (key === 'gemini') {
          // Resolve from the merged registry+local list so curated global
          // endpoints are usable on a fresh hostname (e.g. staging) where
          // localStorage has no saved custom endpoints yet.
          const { merged, selected: defaultSel } = await getMergedVertexEndpoints(getState());
          const g = providers.gemini || {};
          const selected = merged.find(e => e.id === g.selectedId) || defaultSel;
          if (!selected || !selected.projectId || !selected.endpointId) {
            alert('No Gemini endpoint configured. Open ASR Settings to add one.');
            btn.disabled = false;
            btn.textContent = btnLabel;
            return;
          }
          providerCfg = { projectId: selected.projectId, region: selected.region, endpointId: selected.endpointId };
          saveModel = `gemini-${geminiSlug(selected)}`;
          const raw = (promptInput?.value || '').trim();
          prompt = raw.length > 0 ? raw : null;
          promptLabel = raw.length > 0
            ? (raw.length > 32 ? raw.slice(0, 32) + '\u2026' : raw)
            : 'default';
          // Optional Vertex systemInstruction — separate from the per-call
          // user-turn prompt. Read straight off the inline input on the
          // detail toolbar.
          const sysRaw = (sysInput?.value || '').trim();
          if (sysRaw.length > 0) providerCfg.systemInstruction = sysRaw;
        } else if (key === 'mendel') {
          // Mendel: route the prompt textarea into YL's `context` bias field,
          // and pull rapid/timestamps toggles from the persisted settings.
          const raw = (promptInput?.value || '').trim();
          if (raw.length > 0) {
            prompt = raw;
            promptLabel = raw.length > 32 ? raw.slice(0, 32) + '\u2026' : raw;
          }
          const m = providers.mendel || {};
          providerCfg = {
            ...(m.endpoint ? { endpoint: m.endpoint } : {}),
            rapid: m.rapid === true,
            timestamps: m.timestamps === true,
          };
        }
        const config = { provider: key, ...providerCfg };
        if (prompt) config.prompt = prompt;
        const text = await transcribeAudio(audioId, audioUrl, config);
        if (!text) throw new Error('Empty transcription returned');

        // Gemini: append every run as a distinct version with a unique runId
        // so prompted variants and reruns coexist for side-by-side comparison.
        // Whisper / Mendel: keep the existing dedup-per-model behavior.
        if (key === 'gemini') {
          const runId = String(Date.now());
          addVersion(audioId, {
            type: 'asr',
            text,
            model: saveModel,
            runId,
            prompt,
            promptLabel,
            createdAt: new Date().toISOString(),
          });
        } else {
          const versions = getVersions(audioId);
          const existing = versions.find(v => v.type === 'asr' && v.model === saveModel);
          if (existing) {
            updateVersion(audioId, existing.id, { text, createdAt: new Date().toISOString() });
          } else {
            addVersion(audioId, { type: 'asr', text, model: saveModel });
          }
        }

        btn.textContent = btnLabel;
        btn.disabled = false;
        if (onComplete) onComplete();
      } catch (err) {
        console.error('[ASR] transcription failed:', err);
        if (err && err.code === 'INSUFFICIENT_CREDITS') {
          btn.textContent = btnLabel;
          btn.disabled = false;
          if (typeof window !== 'undefined' && window.confirm(
            (err.message || 'Insufficient credits.') + '\n\nOpen Billing now?'
          )) {
            window.location.href = '/billing.html';
          }
          return;
        }
        btn.textContent = `${btnLabel} — failed`;
        btn.disabled = false;
      }
    });

    bar.appendChild(btn);
    if (geminiPicker) bar.appendChild(geminiPicker);
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

    // Set active version ref to best version (edited > cleaned > manual)
    if (versions.length > 0) {
      const pickedId = _pickedVersionByAudio.get(audioId);
      const pickedValid = pickedId && versions.some(v => v.id === pickedId);
      const activeVersionId = pickedValid ? pickedId : (getBestVersion(audioId)?.id || versions[0].id);
      if (activeVersionRef) activeVersionRef.id = activeVersionId;
    }

    // Compact info bar — version metadata only, no textarea (text editor is in the word view).
    // Use the ACTIVE version (which honors the picker override) rather than
    // always the best one, so metadata/controls reflect what the user picked.
    const activeVersion = versions.find(v => v.id === activeVersionRef?.id) || getBestVersion(audioId);
    const bestVersion = activeVersion;
    if (bestVersion) {
      const infoBar = document.createElement('div');
      infoBar.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px;';
      // Version picker — let the user switch between all saved versions for
      // this audio (manual / edited / cleaned / asr-<model>) instead of being
      // stuck on whatever getBestVersion picked. Empty versions are still
      // listed so users can see they exist, but marked so they're obvious.
      // Render whenever there is at least one comparable surface — i.e.
      // multiple versions OR a single version + a mapped transcript (so the
      // user can compare ASR vs. the manual / original transcript).
      const SYN_MANUAL_ID = '__synthetic_manual__';
      const hasManualVersion = versions.some(v => v.type === 'manual');
      const canSynthesizeManual = !!transcript && !hasManualVersion;
      const showPickers = versions.length > 1 || canSynthesizeManual;
      if (showPickers) {
        const picker = document.createElement('select');
        picker.className = 'version-picker';
        picker.style.cssText = 'padding:3px 8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:0.85rem;background:#fff;';
        picker.setAttribute('aria-label', 'Select transcript version');
        // 'Manual (original)' is clearer than just 'Original' since users
        // type the word "manual" when they mean the typed/imported text.
        const byType = { edited: 'Edited', cleaned: 'Cleaned', asr: 'ASR', manual: 'Manual (original)' };
        // Look up Gemini endpoint display names so "asr (gemini-yiddish-v3-large)"
        // renders as "ASR (gemini: Yiddish v3 large)".
        const geminiEndpoints = (getState().transcribeProviders?.gemini?.endpoints) || [];
        const prettyAsr = (model, v) => {
          let base;
          if (!model) base = 'ASR';
          else if (model === 'gemini') base = 'ASR (gemini)';
          else if (model.startsWith('gemini-')) {
            const slug = model.slice('gemini-'.length);
            const ep = geminiEndpoints.find(e => geminiSlug(e) === slug);
            base = `ASR (gemini: ${ep?.name || slug})`;
          } else {
            base = `ASR (${model})`;
          }
          // Append the prompt label and run timestamp where present so each
          // Gemini run is visually unique in the dropdown.
          const parts = [base];
          if (v?.promptLabel) parts.push(`\u2014 ${v.promptLabel}`);
          if (v?.runId) {
            const t = new Date(parseInt(v.runId, 10));
            if (!isNaN(t.getTime())) parts.push(`@ ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
          }
          return parts.join(' ');
        };
        const labelFor = (v) => v.type === 'asr' ? prettyAsr(v.model, v) : (byType[v.type] || v.type);
        versions.forEach((v) => {
          const opt = document.createElement('option');
          opt.value = v.id;
          const empty = !(typeof v.text === 'string' && v.text.trim().length > 0);
          opt.textContent = empty ? `${labelFor(v)} — (empty)` : labelFor(v);
          if (v.id === activeVersionRef?.id) opt.selected = true;
          picker.appendChild(opt);
        });
        picker.addEventListener('change', (e) => {
          _pickedVersionByAudio.set(audioId, e.target.value);
          if (activeVersionRef) activeVersionRef.id = e.target.value;
          const s = getState();
          renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
        });
        infoBar.appendChild(picker);

        // ── Compare-to picker ────────────────────────────────────
        // Lets the user pin a second version and see a word-level diff
        // against the active one. "(none)" hides the diff panel.
        const comparePicker = document.createElement('select');
        comparePicker.className = 'version-compare-picker';
        comparePicker.style.cssText = 'padding:3px 8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:0.85rem;background:#fff;';
        comparePicker.setAttribute('aria-label', 'Compare active version against another');
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'Compare to\u2026 (none)';
        comparePicker.appendChild(noneOpt);
        const compareTargetId = _compareVersionByAudio.get(audioId) || null;
        versions.forEach((v) => {
          if (v.id === activeVersionRef?.id) return; // can't compare to itself
          // Include all versions even if text isn't loaded — manual versions
          // often start empty until first opened; we lazy-load on pick.
          const empty = !(typeof v.text === 'string' && v.text.trim().length > 0);
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = empty ? `${labelFor(v)} \u2014 (load on pick)` : labelFor(v);
          if (v.id === compareTargetId) opt.selected = true;
          comparePicker.appendChild(opt);
        });
        // Synthetic "Manual (original transcript)" option — appears when no
        // manual version record exists yet (e.g. ASR-only run with mapped
        // transcript, or migration glitch). Picking it lazy-loads the
        // transcript text and creates a real manual version.
        if (canSynthesizeManual) {
          const opt = document.createElement('option');
          opt.value = SYN_MANUAL_ID;
          opt.textContent = 'Manual (original transcript) — (load on pick)';
          if (compareTargetId === SYN_MANUAL_ID) opt.selected = true;
          comparePicker.appendChild(opt);
        }
        comparePicker.addEventListener('change', async (e) => {
          const val = e.target.value || null;
          if (val) {
            if (val === SYN_MANUAL_ID && transcript) {
              // Lazy-create a real manual version from the mapped transcript
              try {
                const text = await loadFullText(transcript);
                addVersion(audioId, {
                  type: 'manual',
                  sourceTranscriptId: transcript.id,
                  text: text || '',
                  createdAt: new Date().toISOString(),
                  createdBy: 'detail-page-synthesized',
                });
                const newVersions = getVersions(audioId);
                const created = newVersions.find(v => v.type === 'manual');
                if (created) _compareVersionByAudio.set(audioId, created.id);
              } catch (err) {
                console.warn('Failed to load original transcript for compare:', err);
              }
            } else {
              // Lazy-load text for the picked version (especially manual /
              // cleaned imported from Supabase metadata where text is fetched
              // on demand).
              const target = versions.find(v => v.id === val);
              const isEmpty = target && !(typeof target.text === 'string' && target.text.trim().length > 0);
              if (isEmpty) {
                try {
                  if (target.type === 'manual' && transcript) {
                    const text = await loadFullText(transcript);
                    if (text) target.text = text;
                  } else if (target.type === 'cleaned' || target.type === 'edited' || target.type === 'asr') {
                    const { loadTranscriptText } = await import('./db.js');
                    const text = await loadTranscriptText(audioId, target.id);
                    if (text) target.text = text;
                  }
                } catch (err) {
                  console.warn('Failed to load comparison version text:', err);
                }
              }
              _compareVersionByAudio.set(audioId, val);
            }
          } else {
            _compareVersionByAudio.delete(audioId);
          }
          const s = getState();
          renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
        });
        infoBar.appendChild(comparePicker);
      } else {
        const typeLabel = document.createElement('span');
        typeLabel.className = `version-type-badge version-type-${bestVersion.type}`;
        typeLabel.textContent = bestVersion.type.charAt(0).toUpperCase() + bestVersion.type.slice(1);
        infoBar.appendChild(typeLabel);
      }
      if (bestVersion.cleanRate) {
        const cr = document.createElement('span');
        cr.className = 'text-secondary';
        cr.style.fontSize = '0.8rem';
        cr.textContent = `Clean rate: ${bestVersion.cleanRate}%`;
        infoBar.appendChild(cr);
      }
      if (bestVersion.alignment) {
        const al = document.createElement('span');
        al.className = 'text-secondary';
        al.style.fontSize = '0.8rem';
        al.textContent = `Avg confidence: ${formatConfidence(bestVersion.alignment.avgConfidence)}`;
        infoBar.appendChild(al);
      }
      if (bestVersion.updatedAt || bestVersion.createdAt) {
        const ts = document.createElement('span');
        ts.className = 'text-secondary';
        ts.style.fontSize = '0.8rem';
        const d = new Date(bestVersion.updatedAt || bestVersion.createdAt);
        ts.textContent = `Saved ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        infoBar.appendChild(ts);
      }
      // If only manual version exists, offer Start Editing
      if (bestVersion.type === 'manual' && !versions.some(v => v.type === 'edited')) {
        const startBtn = document.createElement('button');
        startBtn.className = 'action-btn action-btn-primary';
        startBtn.textContent = 'Start Editing';
        startBtn.addEventListener('click', async () => {
          startBtn.disabled = true;
          startBtn.textContent = 'Loading...';
          let text = transcript?.text;
          if (!text && transcript) text = await loadFullText(transcript);
          addVersion(audioId, { type: 'edited', sourceTranscriptId: mapping?.transcriptId, text: text || '', createdBy: getCurrentUser() });
          const s = getState();
          renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
        });
        infoBar.appendChild(startBtn);
      }
      container.appendChild(infoBar);

      // ── Diff panel ──────────────────────────────────────────────
      // Renders when the user has picked a Compare-to target. Word-level
      // diff between activeVersion (left side, "current") and the target
      // (right side, "comparison"). Right-to-left so Yiddish renders
      // correctly. Equal runs use neutral colour, additions are green,
      // deletions are red w/ strikethrough.
      const compareTargetId = _compareVersionByAudio.get(audioId);
      if (compareTargetId) {
        const target = versions.find(v => v.id === compareTargetId);
        if (target && bestVersion && target.id !== bestVersion.id) {
          const diffPanel = document.createElement('div');
          diffPanel.className = 'version-diff-panel';
          diffPanel.style.cssText = 'margin-top:10px;border:1px solid var(--border,#ccc);border-radius:8px;padding:10px;background:#fafafa;';

          const diffHeader = document.createElement('div');
          diffHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:0.78rem;color:var(--text-secondary);margin-bottom:6px;';
          const labelLeft = bestVersion.type === 'asr' ? `ASR (${bestVersion.model || '?'})` : (bestVersion.type || 'current');
          const labelRight = target.type === 'asr' ? `ASR (${target.model || '?'})` : (target.type || 'compare');
          const headLine = document.createElement('span');
          headLine.appendChild(document.createTextNode('Diff vs '));
          const rightLabel = document.createElement('strong');
          rightLabel.textContent = labelRight;
          headLine.appendChild(rightLabel);
          headLine.appendChild(document.createTextNode(' \u2014 '));
          const addLegend = document.createElement('span');
          addLegend.style.color = '#198754';
          addLegend.textContent = 'green = added';
          headLine.appendChild(addLegend);
          headLine.appendChild(document.createTextNode(', '));
          const delLegend = document.createElement('span');
          delLegend.style.cssText = 'color:#dc3545;text-decoration:line-through;';
          delLegend.textContent = 'red = removed';
          headLine.appendChild(delLegend);
          headLine.appendChild(document.createTextNode(' (relative to '));
          const leftLabel = document.createElement('strong');
          leftLabel.textContent = labelLeft;
          headLine.appendChild(leftLabel);
          headLine.appendChild(document.createTextNode(')'));
          const closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.textContent = 'Hide diff';
          closeBtn.className = 'action-btn';
          closeBtn.style.cssText = 'font-size:0.75rem;padding:2px 8px;';
          closeBtn.addEventListener('click', () => {
            _compareVersionByAudio.delete(audioId);
            const s = getState();
            renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
          });
          diffHeader.appendChild(headLine);
          diffHeader.appendChild(closeBtn);
          diffPanel.appendChild(diffHeader);

          const body = document.createElement('div');
          body.dir = 'rtl';
          body.style.cssText = 'white-space:pre-wrap;line-height:1.7;font-size:0.95rem;max-height:50vh;overflow:auto;padding:6px 8px;background:#fff;border:1px solid var(--border-light,#eee);border-radius:6px;';

          const leftText = (bestVersion.text || '').toString();
          const rightText = (target.text || '').toString();
          const ops = diffWords(leftText, rightText);
          for (const op of ops) {
            if (op.op === 'eq') {
              body.appendChild(document.createTextNode(op.text));
            } else {
              const span = document.createElement('span');
              span.textContent = op.text;
              if (op.op === 'add') {
                span.style.cssText = 'background:#e6f4ea;color:#0f5132;border-radius:2px;padding:0 1px;';
              } else {
                span.style.cssText = 'background:#fdecea;color:#842029;text-decoration:line-through;border-radius:2px;padding:0 1px;';
              }
              body.appendChild(span);
            }
          }
          diffPanel.appendChild(body);
          container.appendChild(diffPanel);
        }
      }
    } else if (!versions.length && transcript) {
      // No versions yet — offer "Start Editing" to create an edited version
      const startBtn = document.createElement('button');
      startBtn.className = 'action-btn action-btn-primary';
      startBtn.textContent = 'Start Editing';
      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Loading...';
        let text = transcript.text;
        if (!text) text = await loadFullText(transcript);
        addVersion(audioId, { type: 'edited', sourceTranscriptId: mapping?.transcriptId, text: text || '', createdBy: getCurrentUser() });
        const s = getState();
        renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
      });
      container.appendChild(startBtn);
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

function openMatchPreviewModal(audioId, label, currentText, matches, rawOriginal, pageContainer, opts, pushUndo = () => {}) {
  if (matches.length === 0) {
    alert('No matches found.');
    return;
  }

  opts = opts || {};
  const actionSet = opts.actions || [['delete', 'Delete'], ['unwrap', 'Unwrap'], ['keep', 'Keep']];
  const defaultAction = opts.defaultAction || actionSet[0][0];

  // Per-match action state
  const actions = matches.map(() => defaultAction);

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

  for (const [act, lbl] of actionSet) {
    const btn = document.createElement('button');
    btn.className = 'action-btn' + (act === actionSet[0][0] ? ' action-btn-danger' : '');
    btn.textContent = lbl + ' All';
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
    row.className = 'match-preview-row match-action-' + defaultAction;

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
    for (const [val, lbl] of actionSet) {
      const radioLabel = document.createElement('label');
      radioLabel.className = 'match-radio-label';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = val;
      radio.checked = val === defaultAction;
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
    pushUndo(currentText, label);
    let finalText = applyMatchActions(currentText, matches, actions);
    if (opts.postProcess) finalText = opts.postProcess(finalText);
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
function openPassPreviewModal(audioId, passLabel, currentText, previewText, rawOriginal, pageContainer, pushUndo = () => {}) {
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
    pushUndo(currentText, passLabel);
    const finalLines = rows.map(r => r.changed ? (r.accepted ? r.editedClean : r.orig) : r.orig);
    const finalText = finalLines.join('\n');
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


// Module-level undo stack — persists across re-renders within the same page session
if (!window._undoStack) window._undoStack = {}; // keyed by audioId

function renderUnifiedWorkSection(audioId, state, container, pageContainer, playerEl, activeVersionRef) {
  const cleaning = state.cleaning[audioId];
  const alignment = state.alignments[audioId];
  const undoStack = window._undoStack[audioId] || (window._undoStack[audioId] = []);

  function pushUndo(text, label) {
    if (!text) return;
    undoStack.push({ text, label, time: new Date().toISOString() });
    if (undoStack.length > 20) undoStack.shift(); // cap at 20
  }

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
  async function getManualText() {
    const m = getState().mappings[audioId];
    if (!m) return '';
    const t = getState().transcripts.find(tr => tr.id === m.transcriptId);
    if (!t) return '';
    const text = await loadFullText(t);
    return text || t.firstLine || '';
  }
  function buildViewToggle(onEdited, onManual) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';
    const editedBtn = document.createElement('button');
    const manualBtn = document.createElement('button');
    editedBtn.textContent = 'Edited';
    manualBtn.textContent = 'Manual (original)';
    let mode = 'edited';
    function refresh() {
      editedBtn.className = mode === 'edited' ? 'action-btn action-btn-primary' : 'action-btn';
      manualBtn.className = mode === 'manual' ? 'action-btn action-btn-primary' : 'action-btn';
    }
    editedBtn.addEventListener('click', async () => { if (mode === 'edited') return; mode = 'edited'; refresh(); await onEdited(); });
    manualBtn.addEventListener('click', async () => { if (mode === 'manual') return; mode = 'manual'; refresh(); await onManual(); });
    refresh();
    bar.appendChild(editedBtn);
    bar.appendChild(manualBtn);
    return { bar, getMode: () => mode };
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

  // (Progress card with high-confidence % + low-confidence red bar removed
  // per user feedback — alignment confidence now lives only on the version
  // info bar / iteration history.)

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
        openMatchPreviewModal(audioId, 'Remove [brackets]', currentText, matches, rawOriginal, pageContainer, undefined, pushUndo);
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
        openMatchPreviewModal(audioId, 'Remove (parentheses)', currentText, matches, rawOriginal, pageContainer, undefined, pushUndo);
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
        openPassPreviewModal(audioId, 'Remove section markers', currentText, previewText, rawOriginal, pageContainer, pushUndo);
      } finally {
        sectionBtn.textContent = 'Remove section markers';
        sectionBtn.disabled = false;
      }
    });
    btnBar.appendChild(sectionBtn);

    // ── Symbols & whitespace — match-based preview (like brackets/parens) ──
    const minorBtn = document.createElement('button');
    minorBtn.className = 'action-btn clean-pass-btn';
    minorBtn.textContent = 'Clean symbols & whitespace';
    minorBtn.addEventListener('click', async () => {
      minorBtn.disabled = true;
      minorBtn.textContent = 'Loading...';
      try {
        const rawOriginal = await getOriginalText();
        const currentText = await getCurrentText();
        const matches = findMinorMatches(currentText);
        openMatchPreviewModal(audioId, 'Clean symbols & whitespace', currentText, matches, rawOriginal, pageContainer, {
          actions: [['unwrap', 'Remove'], ['keep', 'Keep']],
          defaultAction: 'unwrap',
          postProcess: cleanWhitespace,
        }, pushUndo);
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
        openPassPreviewModal(audioId, 'Remove intro text', currentText, previewText, rawOriginal, pageContainer, pushUndo);
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

  // ── Split anchor state (per-render) ──
  // Shared object so the karaoke sidebar (renderWordView, a top-level fn that
  // does NOT close over this scope) and the Split-here bar below the Align
  // button can read/write the same anchor. `refresh` is overwritten by
  // buildAlignButton once the DOM bar exists.
  const splitState = { anchor: null, refresh: () => {} };

  // Local fmtSec — buildAlignButton needs it for the split bar label and the
  // confirm dialog, but renderWordView's fmtSec (line ~2601) is scoped to that
  // function. Without this, the refresh callback and the Split button click
  // both throw ReferenceError silently and the bar appears empty.
  const fmtSec = (s) => {
    if (s == null || isNaN(s)) return '?';
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  };

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
        if (err && err.code === 'INSUFFICIENT_CREDITS') {
          alignBtn.textContent = 'Run Alignment';
          alignBtn.disabled = false;
          alignBtn.classList.add('btn-error');
          const errMsg = document.createElement('p');
          errMsg.className = 'alignment-error-msg';
          errMsg.innerHTML =
            (err.message || 'Insufficient credits.') +
            ' <a href="/billing.html" style="color:var(--accent);text-decoration:underline;">Open Billing →</a>';
          alignBar.parentNode.insertBefore(errMsg, alignBar.nextSibling);
          return;
        }
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

    // ── Aligner chooser ──
    const alignerWrap = document.createElement('label');
    alignerWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:0.82rem;color:var(--text-secondary,#666);';
    alignerWrap.textContent = 'Aligner:';
    const alignerSelect = document.createElement('select');
    alignerSelect.style.cssText = 'padding:4px 8px;border-radius:6px;border:1px solid var(--border,#ccc);font-size:0.82rem;';
    alignerSelect.setAttribute('aria-label', 'Choose aligner pod');
    for (const opt of ALIGNER_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      alignerSelect.appendChild(o);
    }
    alignerSelect.value = getAlignerChoice();
    alignerSelect.addEventListener('change', (e) => setAlignerChoice(e.target.value));
    alignerWrap.appendChild(alignerSelect);
    alignBar.appendChild(alignerWrap);

    if (alignment) {
      const info = document.createElement('span');
      info.className = 'text-secondary';
      info.style.fontSize = '0.82rem';
      const alignedDate = alignment.alignedAt
        ? (() => {
            const d = new Date(alignment.alignedAt);
            return ` | Aligned ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          })()
        : '';
      const alignerTag = alignment.aligner ? ` | ${alignment.aligner}` : '';
      info.textContent = `Avg: ${formatConfidence(alignment.avgConfidence)} | Low: ${alignment.lowConfidenceCount} words${alignedDate}${alignerTag}`;
      alignBar.appendChild(info);
    }
    targetEl.appendChild(alignBar);

    // ── Split-from-here row (hidden until a chip is shift-clicked) ──
    // Shown below the Align bar. State lives in the shared `splitState` object
    // so the karaoke sidebar (renderWordView) can mutate it via shift-click.
    const splitBar = document.createElement('div');
    splitBar.style.cssText = 'display:none;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;padding:6px 10px;background:var(--surface-2,#f5f5f7);border:1px dashed var(--border,#ccc);border-radius:6px;font-size:0.82rem;';
    splitBar.setAttribute('data-role', 'split-bar');

    const splitLabel = document.createElement('span');
    splitLabel.setAttribute('data-role', 'split-label');
    splitLabel.style.cssText = 'color:var(--text-secondary,#666);';
    splitBar.appendChild(splitLabel);

    const splitBtn = document.createElement('button');
    splitBtn.className = 'action-btn action-btn-primary';
    splitBtn.textContent = 'Split here → new Part';
    splitBar.appendChild(splitBtn);

    const splitClear = document.createElement('button');
    splitClear.className = 'action-btn';
    splitClear.textContent = 'Clear';
    splitBar.appendChild(splitClear);

    splitClear.addEventListener('click', () => {
      splitState.anchor = null;
      splitState.refresh();
    });

    splitBtn.addEventListener('click', async () => {
      const a = splitState.anchor;
      if (!a) return;
      const parent = state.audio.find(x => x.id === audioId);
      if (!parent) return;
      const confirmMsg = `Create a new Part from "${a.word}" at ${fmtSec(a.time)}?\n\n` +
        `The new record will share the same audio file but start at ${fmtSec(a.time)} with the remaining ${a.tailLen} words as its cleaned text. The current record is unchanged.`;
      if (!confirm(confirmMsg)) return;
      splitBtn.disabled = true;
      splitBtn.textContent = 'Creating…';
      try {
        const res = await createSplitFromAudio(parent, getState(), a.wordIndex);
        window.location.href = `/detail?id=${encodeURIComponent(res.id)}`;
      } catch (err) {
        console.error('[Split] Failed:', err);
        alert(`Split failed: ${err.message || err}`);
        splitBtn.disabled = false;
        splitBtn.textContent = 'Split here → new Part';
      }
    });

    targetEl.appendChild(splitBar);
    splitState.refresh = () => {
      const a = splitState.anchor;
      if (!a) {
        splitBar.style.display = 'none';
        return;
      }
      splitBar.style.display = 'flex';
      splitLabel.textContent = `Split from "${a.word}" @ ${fmtSec(a.time)} (${a.tailLen} words to the end)`;
    };
    splitState.refresh();
  }

  // ASR provider buttons are now inline in the Transcript Mapping section

  // ── Cleaning section (always visible) ──
  const cleanSection = document.createElement('div');
  cleanSection.style.cssText = 'margin-bottom:14px;';
  const cleanLabel = document.createElement('div');
  cleanLabel.className = 'section-sublabel';
  cleanLabel.textContent = 'Cleaning — click a pass to preview changes line by line';
  cleanLabel.title = 'Cleaning prepares the raw transcript for word-level alignment by removing things the audio does not contain (e.g. bracketed editor notes, parenthetical asides, section markers, leading/trailing intro text, double spaces).';
  cleanSection.appendChild(cleanLabel);
  const cleanHelp = document.createElement('div');
  cleanHelp.style.cssText = 'font-size:0.78rem;color:var(--text-secondary);margin:-2px 0 8px;line-height:1.5;';
  cleanHelp.textContent = 'What is "cleaned"? Removes editor-only text that\'s not actually spoken (e.g. [bracketed notes], (parentheticals), section markers, intro/outro, double spaces) so the transcript matches what the speaker said. Required before alignment.';
  cleanSection.appendChild(cleanHelp);
  buildPassButtons(cleanSection);

  // Revert button — undo last cleaning operation
  const revertRow = document.createElement('div');
  revertRow.style.cssText = 'margin-top:8px;display:flex;align-items:center;gap:8px;';
  const revertBtn = document.createElement('button');
  revertBtn.className = 'btn btn-secondary';
  revertBtn.style.cssText = 'font-size:0.8rem;padding:4px 12px;color:var(--red);border-color:var(--red);';
  const revertInfo = document.createElement('span');
  revertInfo.className = 'text-secondary';
  revertInfo.style.fontSize = '0.78rem';
  function updateRevertBtn() {
    if (undoStack.length === 0) {
      revertBtn.textContent = '↩ Revert';
      revertBtn.disabled = true;
      revertInfo.textContent = '';
    } else {
      const last = undoStack[undoStack.length - 1];
      revertBtn.textContent = `↩ Revert (${undoStack.length})`;
      revertBtn.disabled = false;
      revertInfo.textContent = `Undo: ${last.label}`;
    }
  }
  updateRevertBtn();
  revertBtn.addEventListener('click', () => {
    if (undoStack.length === 0) return;
    const prev = undoStack.pop();
    const versions = getVersions(audioId);
    const existingEdited = versions.find(v => v.type === 'edited');
    if (existingEdited) {
      updateVersion(audioId, existingEdited.id, { text: prev.text, createdAt: new Date().toISOString() });
    }
    const s = getState();
    renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
  });
  revertRow.appendChild(revertBtn);
  revertRow.appendChild(revertInfo);
  cleanSection.appendChild(revertRow);

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
      renderWordView(audioId, cleaning, fullAlignment, container, pageContainer, playerEl, activeVersionRef, getCurrentText, getManualText, splitState);
      renderIterationHistory(audioId, container, pageContainer, playerEl);
    });
  } else if (alignment) {
    renderWordView(audioId, cleaning, alignment, container, pageContainer, playerEl, activeVersionRef, getCurrentText, getManualText, splitState);
    renderIterationHistory(audioId, container, pageContainer, playerEl);
  } else {
    // No alignment yet — show plain text editor for editing before alignment
    const preAlignEditor = document.createElement('div');
    preAlignEditor.className = 'text-editor-view';
    preAlignEditor.contentEditable = 'true';
    preAlignEditor.dir = 'rtl';
    preAlignEditor.spellcheck = false;
    preAlignEditor.style.marginTop = '8px';

    // Load text into editor
    getCurrentText().then(text => {
      preAlignEditor.textContent = text || 'Click "Start Editing" above to load the transcript text, then edit here.';
    });

    // View toggle — Edited (editable) vs Manual (readonly original)
    let _preEditedCache = null;
    const preToggle = buildViewToggle(
      async () => {
        preAlignEditor.contentEditable = 'true';
        preAlignEditor.style.opacity = '';
        if (_preEditedCache != null) {
          preAlignEditor.textContent = _preEditedCache;
          _preEditedCache = null;
        } else {
          const text = await getCurrentText();
          preAlignEditor.textContent = text || '';
        }
      },
      async () => {
        _preEditedCache = preAlignEditor.innerText;
        preAlignEditor.contentEditable = 'false';
        preAlignEditor.style.opacity = '0.85';
        preAlignEditor.textContent = 'Loading original...';
        const text = await getManualText();
        preAlignEditor.textContent = text || '(No original transcript available)';
      }
    );
    container.appendChild(preToggle.bar);

    // Auto-save — ensure we always save to an 'edited' version (not manual)
    const preSaveStatus = document.createElement('span');
    preSaveStatus.className = 'text-secondary';
    preSaveStatus.style.fontSize = '0.8rem';
    let _preTimer = null;
    let _ensuredEdited = false;
    preAlignEditor.addEventListener('input', () => {
      if (preToggle.getMode() !== 'edited') return;
      preSaveStatus.textContent = 'Unsaved...';
      clearTimeout(_preTimer);
      _preTimer = setTimeout(() => {
        const text = preAlignEditor.innerText.trim();
        if (!text) return;
        // If current version is manual, auto-create an edited version on first edit
        const versions = getVersions(audioId);
        let editedVersion = versions.find(v => v.type === 'edited');
        if (!editedVersion && !_ensuredEdited) {
          _ensuredEdited = true;
          const mapping = getState().mappings[audioId];
          addVersion(audioId, { type: 'edited', sourceTranscriptId: mapping?.transcriptId, text, createdBy: getCurrentUser() });
          editedVersion = getVersions(audioId).find(v => v.type === 'edited');
          if (activeVersionRef && editedVersion) activeVersionRef.id = editedVersion.id;
        }
        const versionId = editedVersion?.id || activeVersionRef?.id;
        if (versionId) {
          updateVersion(audioId, versionId, { text, updatedAt: new Date().toISOString() });
          const now = new Date();
          preSaveStatus.textContent = `Saved ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
        }
      }, 800);
    });

    container.appendChild(preSaveStatus);
    container.appendChild(preAlignEditor);

    const hint = document.createElement('div');
    hint.className = 'text-secondary';
    hint.style.cssText = 'font-size:0.8rem;margin-top:6px;';
    hint.textContent = 'Edit the text above, then click Re-Align to generate word timestamps and confidence scores.';
    container.appendChild(hint);
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
  const audioEntry = getState().audio.find(a => a.id === audioId);
  if (audioEntry?.isBenchmark) {
    const note = document.createElement('div');
    note.className = 'seg-approve-bar text-secondary';
    note.style.fontSize = '0.85rem';
    note.textContent = 'Benchmark file — approval disabled (never enters the training set).';
    container.appendChild(note);
    return;
  }
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

function renderWordView(audioId, cleaning, alignment, container, pageContainer, playerEl, activeVersionRef, getCurrentText, getManualText, splitState = { anchor: null, refresh: () => {} }) {
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

  // ── Two-column layout: Text Editor (main) + Karaoke Sidebar (right) ──

  // Sidebar + chip placement use the RAW aligner output (no reconciliation
  // placeholders) so the user sees exactly what the aligner timestamped.
  // `words` stays reconciled — split-from-here, review-panel confidence lookup
  // and DB sync still expect a 1:1 mapping with the edited text.
  const rawWords = Array.isArray(alignment?.rawWords) ? alignment.rawWords : words;

  const GAP_THRESHOLD = 1.0;
  const segmentize = (arr) => {
    if (!arr.length) return [];
    const segs = [];
    let cur = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if ((arr[i].start - arr[i - 1].end) > GAP_THRESHOLD) { segs.push(cur); cur = [arr[i]]; }
      else cur.push(arr[i]);
    }
    segs.push(cur);
    return segs;
  };
  const segments = segmentize(words);
  const rawSegments = segmentize(rawWords);

  function fmtSec(s) {
    if (s == null || isNaN(s)) return '?';
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }


  // ── Layout: Text Editor (main) + Karaoke Sidebar (right) ──
  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex;gap:16px;';

  const leftPanel = document.createElement('div');
  leftPanel.style.cssText = 'flex:1;min-width:0;';

  const sidebar = document.createElement('div');
  sidebar.className = 'karaoke-sidebar';
  sidebar.style.cssText = 'width:260px;flex-shrink:0;max-height:600px;overflow-y:auto;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);';

  // ── Play/pause button ──
  let playPauseBtn = null;
  if (playerEl) {
    playPauseBtn = document.createElement('button');
    playPauseBtn.className = 'btn btn-secondary';
    playPauseBtn.style.cssText = 'font-size:1.2rem;min-width:44px;padding:4px 12px;';
    const updatePlayBtn = () => {
      playPauseBtn.textContent = playerEl.paused ? '▶' : '⏸';
    };
    updatePlayBtn();
    playPauseBtn.addEventListener('click', () => { if (playerEl.paused) playerEl.play().catch(() => {}); else playerEl.pause(); });
    playerEl.addEventListener('play', updatePlayBtn);
    playerEl.addEventListener('pause', updatePlayBtn);
  }

  // ── Toolbar ──
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;';
  if (playPauseBtn) toolbar.appendChild(playPauseBtn);

  // View toggle — Edited (editable, with timestamps) vs Manual (readonly original)
  let _viewMode = 'edited';
  const editedToggleBtn = document.createElement('button');
  const manualToggleBtn = document.createElement('button');
  editedToggleBtn.textContent = 'Edited';
  manualToggleBtn.textContent = 'Manual (original)';
  function refreshToggle() {
    editedToggleBtn.className = _viewMode === 'edited' ? 'action-btn action-btn-primary' : 'action-btn';
    manualToggleBtn.className = _viewMode === 'manual' ? 'action-btn action-btn-primary' : 'action-btn';
  }
  refreshToggle();
  editedToggleBtn.addEventListener('click', () => {
    if (_viewMode === 'edited') return;
    _viewMode = 'edited';
    refreshToggle();
    editorDiv.contentEditable = 'true';
    editorDiv.style.opacity = '';
    buildEditorContent();
  });
  manualToggleBtn.addEventListener('click', async () => {
    if (_viewMode === 'manual') return;
    _viewMode = 'manual';
    refreshToggle();
    editorDiv.contentEditable = 'false';
    editorDiv.style.opacity = '0.85';
    editorDiv.innerHTML = '';
    editorDiv.textContent = 'Loading original...';
    const text = await getManualText();
    editorDiv.innerHTML = '';
    const manualText = text || '(No original transcript available)';
    const manualLines = manualText
      .split(/\n+/)
      .flatMap(line => {
        const parts = line.split(/(?<=\.)\s+/).map(p => p.trim()).filter(Boolean);
        return parts.length > 0 ? parts : [line];
      });
    manualLines.forEach((line, idx) => {
      if (line) editorDiv.appendChild(document.createTextNode(line));
      if (idx < manualLines.length - 1) editorDiv.appendChild(document.createElement('br'));
    });
  });
  toolbar.appendChild(editedToggleBtn);
  toolbar.appendChild(manualToggleBtn);

  // Font size control — persists in localStorage
  const FONT_SIZE_KEY = 'editor-font-size';
  const FONT_MIN = 12;
  const FONT_MAX = 36;
  let _editorFontSize = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
  if (!Number.isFinite(_editorFontSize)) _editorFontSize = 16;
  _editorFontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, _editorFontSize));
  function applyEditorFontSize() {
    editorDiv.style.fontSize = _editorFontSize + 'px';
    localStorage.setItem(FONT_SIZE_KEY, String(_editorFontSize));
    fontSizeLabel.textContent = _editorFontSize + 'px';
  }
  const fontDecBtn = document.createElement('button');
  fontDecBtn.type = 'button';
  fontDecBtn.className = 'action-btn';
  fontDecBtn.textContent = 'A−';
  fontDecBtn.title = 'Decrease editor font size';
  fontDecBtn.addEventListener('click', () => {
    _editorFontSize = Math.max(FONT_MIN, _editorFontSize - 2);
    applyEditorFontSize();
  });
  const fontIncBtn = document.createElement('button');
  fontIncBtn.type = 'button';
  fontIncBtn.className = 'action-btn';
  fontIncBtn.textContent = 'A+';
  fontIncBtn.title = 'Increase editor font size';
  fontIncBtn.addEventListener('click', () => {
    _editorFontSize = Math.min(FONT_MAX, _editorFontSize + 2);
    applyEditorFontSize();
  });
  const fontSizeLabel = document.createElement('span');
  fontSizeLabel.className = 'text-secondary';
  fontSizeLabel.style.cssText = 'font-size:0.75rem;min-width:36px;text-align:center;';
  toolbar.appendChild(fontDecBtn);
  toolbar.appendChild(fontSizeLabel);
  toolbar.appendChild(fontIncBtn);

  const editorWordCountEl = document.createElement('span');
  editorWordCountEl.className = 'text-secondary';
  editorWordCountEl.style.cssText = 'font-size:0.8rem;margin-left:auto;';
  toolbar.appendChild(editorWordCountEl);

  const saveStatus = document.createElement('span');
  saveStatus.className = 'text-secondary';
  saveStatus.style.cssText = 'font-size:0.8rem;';
  toolbar.appendChild(saveStatus);
  leftPanel.appendChild(toolbar);

  const countWords = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;
  function refreshEditorWordCount(textMaybe) {
    const t = textMaybe != null ? textMaybe : (getEditorPlainText ? getEditorPlainText() : '');
    editorWordCountEl.textContent = `Editor: ${countWords(t)} words`;
  }

  // ── Text Editor: contenteditable div ──
  const editorDiv = document.createElement('div');
  editorDiv.className = 'text-editor-view';
  editorDiv.contentEditable = 'true';
  editorDiv.dir = 'rtl';
  editorDiv.spellcheck = false;

  // Editor renders the user's edited text (what was sent to the aligner),
  // unchanged by reconciliation. Plain text only — no inline chips.
  // Each sentence (period-terminated) renders on its own line for readability.
  function buildEditorContent() {
    editorDiv.innerHTML = '';
    const editedVersion = getVersions(audioId).find(v => v.type === 'edited');
    const alignmentJoined = segments.flat().map(w => w.word || w.text || '').join(' ');
    const editedText = (editedVersion?.text || alignmentJoined || '').trim();
    const lines = editedText
      .split(/\n+/)
      .flatMap(line => {
        const parts = line.split(/(?<=\.)\s+/).map(p => p.trim()).filter(Boolean);
        return parts.length > 0 ? parts : [line];
      });
    lines.forEach((line, idx) => {
      if (line) editorDiv.appendChild(document.createTextNode(line));
      if (idx < lines.length - 1) editorDiv.appendChild(document.createElement('br'));
    });
    refreshEditorWordCount(editedText);
  }
  buildEditorContent();
  applyEditorFontSize();

  // ── Auto-save: debounced 800ms ──
  let _editorSaveTimer = null;
  function getEditorPlainText() {
    return editorDiv.innerText.replace(/\n{3,}/g, '\n\n').trim();
  }

  let _ensuredEditedPost = false;
  function flushEditorSave() {
    if (_viewMode !== 'edited') return;
    const text = getEditorPlainText();
    if (!text) return;
    const versions = getVersions(audioId);
    let editedVersion = versions.find(v => v.type === 'edited');
    if (!editedVersion && !_ensuredEditedPost) {
      _ensuredEditedPost = true;
      const mapping = getState().mappings[audioId];
      addVersion(audioId, { type: 'edited', sourceTranscriptId: mapping?.transcriptId, text, createdBy: getCurrentUser() });
      editedVersion = getVersions(audioId).find(v => v.type === 'edited');
      if (activeVersionRef && editedVersion) activeVersionRef.id = editedVersion.id;
    }
    const versionId = editedVersion?.id || activeVersionRef?.id;
    if (versionId && text) {
      const syncPromise = updateVersion(audioId, versionId, { text, updatedAt: new Date().toISOString() });
      const now = new Date();
      const hhmm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
      saveStatus.textContent = `Saved ${hhmm}`;
      if (syncPromise && typeof syncPromise.then === 'function') {
        syncPromise.then(
          () => { saveStatus.textContent = `Saved ${hhmm} ✓`; },
          () => { saveStatus.textContent = `Saved locally (offline)`; },
        );
      }
    }
  }
  editorDiv.addEventListener('input', () => {
    if (_viewMode !== 'edited') return;
    saveStatus.textContent = 'Unsaved...';
    refreshEditorWordCount();
    clearTimeout(_editorSaveTimer);
    _editorSaveTimer = setTimeout(() => {
      _editorSaveTimer = null;
      flushEditorSave();
    }, 800);
  });
  // Flush pending save when the editor loses focus (e.g. user clicks Re-Align)
  // so a sub-800ms edit-then-click doesn't lose the latest text.
  editorDiv.addEventListener('blur', () => {
    if (!_editorSaveTimer) return;
    clearTimeout(_editorSaveTimer);
    _editorSaveTimer = null;
    flushEditorSave();
  });

  leftPanel.appendChild(editorDiv);

  // ── Karaoke Sidebar: read-only word chips with confidence ──
  function renderKaraokeSidebar() {
    sidebar.innerHTML = '';
    const sidebarLabel = document.createElement('div');
    sidebarLabel.style.cssText = 'font-size:0.75rem;color:var(--text-secondary);margin-bottom:6px;font-weight:600;';
    const problemCount = rawSegments.filter((seg) => {
      let run = 0;
      for (const w of seg) { if ((w.confidence || 0) < 0.4) { run++; if (run >= 3) return true; } else run = 0; }
      return false;
    }).length;
    const unalignedList = words.filter(w => w.unaligned);
    const unalignedCount = unalignedList.length;
    sidebarLabel.textContent = `Aligned • ${rawWords.length} words • ${problemCount} problems`;
    sidebar.appendChild(sidebarLabel);

    // Dropped-words panel — every input word that the aligner couldn't place.
    // Reconciliation in alignment.js flags these with unaligned=true. Click to
    // expand a chip grid so the user can see exactly which words got lost.
    if (unalignedCount > 0) {
      const droppedBar = document.createElement('div');
      droppedBar.style.cssText = 'margin-bottom:8px;';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.style.cssText = 'font-size:0.72rem;padding:2px 8px;border:1px solid var(--orange,#d97706);color:var(--orange,#d97706);background:transparent;border-radius:10px;cursor:pointer;';
      toggle.textContent = `⚠ ${unalignedCount} dropped — click to show`;
      droppedBar.appendChild(toggle);
      const listEl = document.createElement('div');
      listEl.style.cssText = 'display:none;flex-wrap:wrap;gap:2px;direction:rtl;margin-top:4px;padding:4px;border:1px dashed var(--orange,#d97706);border-radius:4px;background:rgba(217,119,6,0.05);';
      unalignedList.forEach(w => {
        const chip = document.createElement('span');
        chip.style.cssText = 'font-size:0.72rem;padding:1px 4px;background:#fff;border:1px dashed var(--orange,#d97706);border-radius:3px;color:var(--text);';
        chip.textContent = w.word || '';
        chip.title = `Dropped by aligner — no timestamp. Approx near ${fmtSec(w.start)}`;
        listEl.appendChild(chip);
      });
      droppedBar.appendChild(listEl);
      toggle.addEventListener('click', () => {
        const shown = listEl.style.display !== 'none';
        listEl.style.display = shown ? 'none' : 'flex';
        toggle.textContent = shown
          ? `⚠ ${unalignedCount} dropped — click to show`
          : `⚠ ${unalignedCount} dropped — click to hide`;
      });
      sidebar.appendChild(droppedBar);
    }

    // Shift-click-to-split expects an index into the reconciled `words` array
    // (createSplitFromAudio assumes 1:1 mapping with edited text). Raw words
    // appear in reconciled in order, skipping placeholders — so mapping the
    // n-th raw word to the n-th non-unaligned reconciled word is exact.
    const rawIdxToReconciledIdx = [];
    for (let j = 0; j < words.length; j++) {
      if (!words[j].unaligned) rawIdxToReconciledIdx.push(j);
    }

    let cumulativeRawIdx = 0;

    rawSegments.forEach((seg, segIdx) => {
      // Segment header
      const segHeader = document.createElement('div');
      segHeader.dataset.segIdx = String(segIdx);
      segHeader.style.cssText = 'font-size:0.7rem;color:var(--text-secondary);margin:8px 0 3px;border-top:1px solid var(--border);padding-top:4px;cursor:pointer;';
      segHeader.textContent = `${segIdx + 1}. ${fmtSec(seg[0]?.start)}–${fmtSec(seg[seg.length - 1]?.end)}`;
      segHeader.addEventListener('click', () => {
        // Scroll editor to this segment's anchor
        const anchor = editorDiv.querySelector(`[data-seg-idx="${segIdx}"]`);
        if (anchor) anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (playerEl) { playerEl.currentTime = seg[0]?.start || 0; playerEl.play().catch(() => {}); }
      });
      sidebar.appendChild(segHeader);

      // Word chips
      const chipRow = document.createElement('div');
      chipRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px;direction:rtl;';
      seg.forEach(w => {
        const myRawIdx = cumulativeRawIdx++;
        const reconciledIdx = rawIdxToReconciledIdx[myRawIdx] ?? myRawIdx;
        const conf = typeof w.confidence === 'number' ? w.confidence : 1;
        const chip = document.createElement('span');
        chip.className = `word-chip confidence-${getConfidenceLevel(conf)}`;
        chip.style.cssText = 'font-size:0.75rem;padding:1px 4px;cursor:pointer;';
        chip.textContent = w.word || w.text || '';
        chip.title = `${(conf * 100).toFixed(0)}% | ${fmtSec(w.start)}\nClick: seek • Shift+click: set split point`;
        chip.dataset.start = String(w.start);
        chip.dataset.end = String(w.end);
        chip.dataset.wordIdx = String(reconciledIdx);
        if (splitState.anchor && splitState.anchor.wordIndex === reconciledIdx) chip.classList.add('split-anchor');
        chip.addEventListener('click', (e) => {
          if (e.shiftKey) {
            sidebar.querySelectorAll('.word-chip.split-anchor').forEach(c => c.classList.remove('split-anchor'));
            chip.classList.add('split-anchor');
            splitState.anchor = {
              wordIndex: reconciledIdx,
              word: w.word || w.text || '',
              time: w.start,
              tailLen: words.length - reconciledIdx,
            };
            splitState.refresh();
            return;
          }
          if (playerEl) { playerEl.currentTime = w.start; playerEl.play().catch(() => {}); }
        });
        chipRow.appendChild(chip);
      });
      sidebar.appendChild(chipRow);
    });
  }
  renderKaraokeSidebar();

  // ── Karaoke highlighting — keep sidebar + editor in sync ──
  if (playerEl) {
    let prevActiveChip = null;
    const onTimeUpdate = () => {
      const t = playerEl.currentTime;

      // Highlight active word chip in sidebar
      if (prevActiveChip) { prevActiveChip.classList.remove('active'); prevActiveChip = null; }
      const chips = sidebar.querySelectorAll('.word-chip');
      for (const chip of chips) {
        const start = parseFloat(chip.dataset.start);
        const end = parseFloat(chip.dataset.end);
        if (!isNaN(start) && t >= start && t < (isNaN(end) ? start + 0.5 : end)) {
          chip.classList.add('active');
          const rect = sidebar.getBoundingClientRect();
          if (rect.top < window.innerHeight && rect.bottom > 0) {
            chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          prevActiveChip = chip;
          break;
        }
      }

    };
    if (playerEl._wordViewTimeUpdate) playerEl.removeEventListener('timeupdate', playerEl._wordViewTimeUpdate);
    playerEl._wordViewTimeUpdate = onTimeUpdate;
    playerEl.addEventListener('timeupdate', onTimeUpdate);
  }

  // ── Approve bar ──
  renderApproveBar(audioId, viewer, pageContainer);

  layout.appendChild(leftPanel);
  layout.appendChild(sidebar);
  viewer.appendChild(layout);

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

