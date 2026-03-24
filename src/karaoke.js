import { generateSRT, generateVTT } from './utils.js';

export function renderKaraokePlayer(audioId, state) {
  const entry = state.audio.find(a => a.id === audioId);

  // Try transcriptVersions first, fall back to legacy alignments
  let alignment = null;
  const versions = state.transcriptVersions && state.transcriptVersions[audioId];
  if (versions && versions.length > 0) {
    const withAlignment = versions.find(v => v.alignment && v.alignment.words);
    if (withAlignment) alignment = withAlignment.alignment;
  }
  if (!alignment) alignment = state.alignments[audioId];
  if (!entry || !alignment || !alignment.words || alignment.words.length === 0) {
    alert('No word-level alignment data available. Run alignment first.');
    return;
  }

  let audioUrl = entry.r2Link || entry.driveLink;
  if (!audioUrl) return;
  // Proxy R2 audio to avoid CORS issues
  if (audioUrl.includes('audio.kohnai.ai')) {
    audioUrl = `/api/audio?url=${encodeURIComponent(audioUrl)}`;
  }

  const words = alignment.words;

  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay karaoke-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal karaoke-modal';

  // Shared close handler — removes overlay and cleans up the Escape listener
  const onKey = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  function closeModal() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => closeModal());

  // Title
  const title = document.createElement('h3');
  title.className = 'karaoke-title';
  title.textContent = entry.name || audioId;

  // Audio element
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = audioUrl;
  audio.className = 'karaoke-audio';

  // Speed controls
  const speedBar = document.createElement('div');
  speedBar.className = 'karaoke-speed-bar';
  const speeds = [0.5, 1, 1.25, 1.5, 2];
  speeds.forEach(speed => {
    const btn = document.createElement('button');
    btn.className = 'speed-btn' + (speed === 1 ? ' active' : '');
    btn.textContent = speed + 'x';
    btn.addEventListener('click', () => {
      audio.playbackRate = speed;
      speedBar.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    speedBar.appendChild(btn);
  });

  // Export buttons
  const exportBar = document.createElement('div');
  exportBar.className = 'karaoke-export-bar';

  const srtBtn = document.createElement('button');
  srtBtn.className = 'btn btn-secondary';
  srtBtn.textContent = 'Export SRT';
  srtBtn.addEventListener('click', () => {
    const content = generateSRT(words);
    downloadFile(content, (entry.name || audioId).replace(/\.[^.]+$/, '') + '.srt', 'text/plain');
  });

  const vttBtn = document.createElement('button');
  vttBtn.className = 'btn btn-secondary';
  vttBtn.textContent = 'Export VTT';
  vttBtn.addEventListener('click', () => {
    const content = generateVTT(words);
    downloadFile(content, (entry.name || audioId).replace(/\.[^.]+$/, '') + '.vtt', 'text/vtt');
  });

  exportBar.appendChild(srtBtn);
  exportBar.appendChild(vttBtn);

  // Word chip grid
  const wordGrid = document.createElement('div');
  wordGrid.className = 'karaoke-word-grid';
  wordGrid.dir = 'rtl';

  const chipEls = [];
  words.forEach((w, idx) => {
    const span = document.createElement('span');
    const conf = typeof w.confidence === 'number' ? w.confidence : 1;
    const level = conf >= 0.8 ? 'high' : conf >= 0.4 ? 'mid' : 'low';
    span.className = `karaoke-word word-chip confidence-${level}`;
    span.title = `${(conf * 100).toFixed(0)}% confidence`;
    span.textContent = w.word;
    span.dataset.start = w.start;
    span.dataset.end = w.end;
    span.dataset.confidence = w.confidence;
    span.dataset.idx = idx;
    span.addEventListener('click', () => {
      audio.currentTime = w.start;
      if (audio.paused) audio.play();
    });
    wordGrid.appendChild(span);
    chipEls.push(span);
  });

  // Timeupdate: highlight current word
  let prevActive = null;
  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    let activeIdx = -1;
    for (let i = 0; i < words.length; i++) {
      if (t >= words[i].start && t < words[i].end) {
        activeIdx = i;
        break;
      }
    }
    if (prevActive !== null && prevActive !== activeIdx) {
      chipEls[prevActive]?.classList.remove('active');
    }
    if (activeIdx >= 0 && activeIdx !== prevActive) {
      chipEls[activeIdx].classList.add('active');
      chipEls[activeIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    prevActive = activeIdx;
  });

  // Assemble modal
  modal.appendChild(closeBtn);
  modal.appendChild(title);
  modal.appendChild(audio);
  modal.appendChild(speedBar);
  modal.appendChild(exportBar);
  modal.appendChild(wordGrid);
  overlay.appendChild(modal);

  // Escape to close
  document.addEventListener('keydown', onKey);

  // Click backdrop to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.body.appendChild(overlay);
}

// Note: duplicates similar logic in utils.js exportCSV. Kept here because
// karaoke.js needs a generic download helper and consolidation is deferred.
export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
