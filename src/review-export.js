// Review a Stage-1 export (audio.mp3 + transcript.aligned.json + optional
// metadata.json) with a karaoke-style view to spot-check alignment before
// committing to the training pipeline. Standalone — no auth, no Supabase.

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const viewer = document.getElementById('viewer');
const exportInfo = document.getElementById('export-info');
const player = document.getElementById('player');
const speedBar = document.getElementById('speed-bar');
const wordGrid = document.getElementById('word-grid');
const btnReset = document.getElementById('btn-reset');
const btnJumpFirst = document.getElementById('btn-jump-first');
const btnToggleSlices = document.getElementById('btn-toggle-slices');
const btnOnlyProblems = document.getElementById('btn-only-problems');

let aligned = null;
let metadata = null;
let allWords = [];
let showSlices = true;
let onlyProblems = false;
let currentAudioFileName = null;

// ── Approval manifest (localStorage) ─────────────────────────────────────
const MANIFEST_KEY = 'jem-asr-export-approvals';

function loadManifest() {
  try {
    const raw = localStorage.getItem(MANIFEST_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveManifest(m) {
  localStorage.setItem(MANIFEST_KEY, JSON.stringify(m));
}

function manifestKeyFor(audioId, libraryId) {
  return `${libraryId || 'unknown'}:${audioId || currentAudioFileName || 'anon'}`;
}

function updateManifestBar() {
  const m = loadManifest();
  const count = Object.keys(m).length;
  document.getElementById('manifest-count').textContent = count;
}

const btnApprove = document.getElementById('btn-approve');
const btnReject = document.getElementById('btn-reject');
const approvalNotes = document.getElementById('approval-notes');
const approvalStatus = document.getElementById('approval-status');
const btnManifestDownload = document.getElementById('btn-manifest-download');
const btnManifestImport = document.getElementById('btn-manifest-import');
const btnManifestClear = document.getElementById('btn-manifest-clear');
const manifestInput = document.getElementById('manifest-input');

btnApprove.addEventListener('click', () => {
  if (!aligned) return;
  const audioId = metadata?.source_entry_id || null;
  const libraryId = metadata?.source_type || null;
  const key = manifestKeyFor(audioId, libraryId);

  const lastSeg = aligned.segments[aligned.segments.length - 1];
  const totalDur = lastSeg ? lastSeg.end : 0;
  const probs = allWords.map(w => w.probability ?? w.confidence ?? 0);
  const avgConf = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;

  const entry = {
    audio_id: audioId,
    library_id: libraryId,
    file_name: metadata?.jem?.name || currentAudioFileName,
    transcript_name: metadata?.jem?.transcript_name || null,
    approved_at: new Date().toISOString(),
    notes: approvalNotes.value.trim().slice(0, 2000) || null,
    stats: {
      segments: aligned.segments.length,
      words: allWords.length,
      slices_30s: Math.ceil(totalDur / 30),
      duration_sec: Math.round(totalDur * 100) / 100,
      avg_confidence: Math.round(avgConf * 1000) / 1000,
    },
  };

  const m = loadManifest();
  m[key] = entry;
  saveManifest(m);
  refreshApprovalUI(key);
  updateManifestBar();
});

btnReject.addEventListener('click', () => {
  if (!aligned) return;
  const audioId = metadata?.source_entry_id || null;
  const libraryId = metadata?.source_type || null;
  const key = manifestKeyFor(audioId, libraryId);

  const m = loadManifest();
  if (m[key]) {
    delete m[key];
    saveManifest(m);
    refreshApprovalUI(key);
    updateManifestBar();
  }
});

btnManifestDownload.addEventListener('click', () => {
  const m = loadManifest();
  const entries = Object.values(m);
  if (entries.length === 0) {
    alert('No approvals yet.');
    return;
  }
  const doc = {
    version: 1,
    created_at: new Date().toISOString(),
    count: entries.length,
    approvals: entries.sort((a, b) => (a.audio_id || '').localeCompare(b.audio_id || '')),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const fname = `export-approvals-${new Date().toISOString().slice(0, 10)}.json`;
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
});

btnManifestImport.addEventListener('click', () => manifestInput.click());
manifestInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const doc = JSON.parse(await file.text());
    if (!Array.isArray(doc.approvals)) {
      alert('Not a valid manifest (missing "approvals" array).');
      return;
    }
    const existing = loadManifest();
    let added = 0, updated = 0;
    for (const entry of doc.approvals) {
      const key = manifestKeyFor(entry.audio_id, entry.library_id);
      if (existing[key]) updated++;
      else added++;
      existing[key] = entry;
    }
    saveManifest(existing);
    updateManifestBar();
    if (aligned) {
      const audioId = metadata?.source_entry_id || null;
      const libraryId = metadata?.source_type || null;
      refreshApprovalUI(manifestKeyFor(audioId, libraryId));
    }
    alert(`Imported. Added ${added}, updated ${updated}. Total now: ${Object.keys(existing).length}.`);
  } catch (err) {
    alert('Failed to import: ' + err.message);
  }
  manifestInput.value = '';
});

btnManifestClear.addEventListener('click', () => {
  const m = loadManifest();
  const count = Object.keys(m).length;
  if (count === 0) return;
  if (!confirm(`Delete all ${count} approvals from this browser? (You can re-import from a saved manifest.)`)) return;
  localStorage.removeItem(MANIFEST_KEY);
  updateManifestBar();
  if (aligned) {
    const audioId = metadata?.source_entry_id || null;
    const libraryId = metadata?.source_type || null;
    refreshApprovalUI(manifestKeyFor(audioId, libraryId));
  }
});

function refreshApprovalUI(key) {
  const m = loadManifest();
  const entry = m[key];
  if (entry) {
    btnApprove.classList.add('approved');
    btnApprove.textContent = '✓ Approved';
    approvalStatus.textContent = `Approved ${new Date(entry.approved_at).toLocaleString()}`;
    approvalNotes.value = entry.notes || '';
  } else {
    btnApprove.classList.remove('approved');
    btnApprove.textContent = '✓ Approve for training';
    approvalStatus.textContent = 'Not yet approved';
    approvalNotes.value = '';
  }
}

updateManifestBar();

// ── Speed bar ────────────────────────────────────────────────────────────
const SPEEDS = [0.5, 1, 1.25, 1.5, 2, 2.5, 3];
SPEEDS.forEach((s) => {
  const btn = document.createElement('button');
  btn.className = 'speed-btn' + (s === 1 ? ' active' : '');
  btn.textContent = `${s}x`;
  btn.addEventListener('click', () => {
    player.playbackRate = s;
    [...speedBar.children].forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
  speedBar.appendChild(btn);
});

// ── Drag-drop wiring ─────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

btnReset.addEventListener('click', () => {
  player.pause();
  URL.revokeObjectURL(player.src);
  player.src = '';
  aligned = null; metadata = null; allWords = [];
  viewer.style.display = 'none';
  btnReset.style.display = 'none';
  dropZone.style.display = 'block';
  fileInput.value = '';
});

btnJumpFirst.addEventListener('click', () => {
  if (allWords.length > 0) {
    player.currentTime = allWords[0].start;
    player.play();
  }
});

btnToggleSlices.addEventListener('click', () => {
  showSlices = !showSlices;
  btnToggleSlices.textContent = showSlices ? 'Hide 30s slice boundaries' : 'Show 30s slice boundaries';
  renderWordGrid();
});

btnOnlyProblems.addEventListener('click', () => {
  onlyProblems = !onlyProblems;
  btnOnlyProblems.textContent = onlyProblems ? 'Show all words' : 'Only low-confidence';
  renderWordGrid();
});

async function handleFiles(fileList) {
  const files = [...fileList];
  let audioFile = null, alignedFile = null, metaFile = null;

  for (const f of files) {
    const name = f.name.toLowerCase();
    if (name.endsWith('.mp3') || f.type === 'audio/mpeg') audioFile = f;
    else if (name === 'transcript.aligned.json') alignedFile = f;
    else if (name === 'metadata.json') metaFile = f;
    else if (name.endsWith('.json') && !alignedFile) alignedFile = f; // fallback: pick the first .json as aligned
  }

  if (!audioFile) { alert('Missing audio.mp3 file.'); return; }
  if (!alignedFile) { alert('Missing transcript.aligned.json file.'); return; }

  try {
    aligned = JSON.parse(await alignedFile.text());
    if (!aligned.segments || !Array.isArray(aligned.segments)) {
      alert('transcript.aligned.json is missing a "segments" array.');
      return;
    }
    allWords = aligned.segments.flatMap((s) => s.words || []);
  } catch (err) {
    alert('Could not parse transcript JSON: ' + err.message);
    return;
  }

  metadata = null;
  if (metaFile) {
    try { metadata = JSON.parse(await metaFile.text()); }
    catch (err) { console.warn('metadata.json parse failed:', err); }
  }

  // Load audio
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(audioFile);
  currentAudioFileName = audioFile.name;

  renderExportInfo(audioFile);
  renderWordGrid();

  // Show existing approval status (if this file is already in the manifest)
  const audioId = metadata?.source_entry_id || null;
  const libraryId = metadata?.source_type || null;
  refreshApprovalUI(manifestKeyFor(audioId, libraryId));

  dropZone.style.display = 'none';
  viewer.style.display = 'block';
  btnReset.style.display = 'inline-block';
}

function renderExportInfo(audioFile) {
  const lastSeg = aligned.segments[aligned.segments.length - 1];
  const totalDur = lastSeg ? lastSeg.end : 0;
  const nonEmpty = allWords.filter((w) => (w.word || '').trim().length > 0);
  const probs = nonEmpty.map((w) => w.probability ?? w.confidence ?? 0);
  const avgConf = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
  const lowConf = probs.filter((p) => p < 0.4).length;
  const slices = Math.ceil(totalDur / 30);

  const name = metadata?.jem?.name || audioFile.name;
  const transcriptName = metadata?.jem?.transcript_name;
  const entryId = metadata?.source_entry_id;
  const language = metadata?.document_language || aligned.language || '?';

  exportInfo.innerHTML = `
    <div class="file-name">${escapeHtml(name)}</div>
    ${transcriptName ? `<div class="stats" style="margin-bottom:4px">Transcript: ${escapeHtml(transcriptName)}</div>` : ''}
    <div class="stats">
      <span><b>${aligned.segments.length}</b> segments</span>
      <span><b>${nonEmpty.length}</b> words</span>
      <span><b>${slices}</b> 30s slices</span>
      <span>${formatTime(totalDur)} total</span>
      <span>avg conf <b>${(avgConf * 100).toFixed(1)}%</b></span>
      <span>low conf <b>${lowConf}</b></span>
      ${entryId ? `<span>ID <code>${escapeHtml(entryId)}</code></span>` : ''}
      <span>lang <code>${escapeHtml(language)}</code></span>
    </div>
  `;
}

function renderWordGrid() {
  wordGrid.innerHTML = '';
  if (!aligned) return;

  let nextSliceBoundary = 30;
  let wordIdx = 0;

  for (let si = 0; si < aligned.segments.length; si++) {
    const seg = aligned.segments[si];

    // Insert slice divider if configured and this segment starts past a 30s boundary
    if (showSlices) {
      while (seg.start >= nextSliceBoundary) {
        const div = document.createElement('div');
        div.className = 'slice-divider';
        div.textContent = `— 30s slice boundary at ${formatTime(nextSliceBoundary)} —`;
        wordGrid.appendChild(div);
        nextSliceBoundary += 30;
      }
    }

    // Filter by low-confidence if toggled
    const segWords = seg.words || [];
    const hasLow = segWords.some((w) => (w.probability ?? w.confidence ?? 1) < 0.4);
    if (onlyProblems && !hasLow) { wordIdx += segWords.length; continue; }

    const segEl = document.createElement('div');
    segEl.className = 'segment';
    segEl.innerHTML = `<div class="seg-meta">seg ${si} · ${formatTime(seg.start)}–${formatTime(seg.end)} · ${(seg.probability ?? 0).toFixed(2)}</div>`;

    for (const w of segWords) {
      const chip = document.createElement('span');
      const p = w.probability ?? w.confidence ?? 0;
      chip.className = 'word-chip ' + confidenceClass(p);
      chip.textContent = w.word || '·';
      chip.dataset.start = w.start;
      chip.dataset.end = w.end;
      chip.dataset.idx = String(wordIdx++);
      chip.title = `start ${w.start.toFixed(2)}s · conf ${(p * 100).toFixed(1)}%`;
      chip.addEventListener('click', () => {
        player.currentTime = w.start;
        player.play();
      });
      segEl.appendChild(chip);
    }
    wordGrid.appendChild(segEl);
  }
}

function confidenceClass(p) {
  if (p == null) return 'confidence-mid';
  if (p >= 0.8) return 'confidence-high';
  if (p >= 0.4) return 'confidence-mid';
  return 'confidence-low';
}

function formatTime(s) {
  if (typeof s !== 'number' || !isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ── Active-word highlight during playback ─────────────────────────────────
let lastActiveIdx = -1;
player.addEventListener('timeupdate', () => {
  if (!allWords.length) return;
  const t = player.currentTime;

  // Binary search — word arrays can be thousands of entries
  let lo = 0, hi = allWords.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = allWords[mid];
    if (t < w.start) hi = mid - 1;
    else if (t >= w.end) lo = mid + 1;
    else { found = mid; break; }
  }
  // If not inside any word, find the most recent one that started before t
  if (found === -1) {
    lo = 0; hi = allWords.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (allWords[mid].start <= t) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
  }
  if (found === lastActiveIdx) return;

  if (lastActiveIdx !== -1) {
    const prev = wordGrid.querySelector(`.word-chip[data-idx="${lastActiveIdx}"]`);
    prev?.classList.remove('active');
  }
  const cur = wordGrid.querySelector(`.word-chip[data-idx="${found}"]`);
  if (cur) {
    cur.classList.add('active');
    const rect = cur.getBoundingClientRect();
    const viewportH = window.innerHeight;
    if (rect.top < 120 || rect.bottom > viewportH - 40) {
      cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  lastActiveIdx = found;
});

// Seek ±5s with arrow keys when audio is focused (matches the main app's shortcut)
document.addEventListener('keydown', (e) => {
  if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); player.paused ? player.play() : player.pause(); }
  else if (e.key === 'ArrowLeft') player.currentTime = Math.max(0, player.currentTime - 5);
  else if (e.key === 'ArrowRight') player.currentTime = Math.min(player.duration || 0, player.currentTime + 5);
});
