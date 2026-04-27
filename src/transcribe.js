import { initState, getState, getVersions, addVersion, updateVersion, mergeSupabaseData, updateState } from './state.js';
import { checkAuth, signOut, getCurrentUser, getUserLibraries, getActiveLibrary, getActiveLibraryConfig } from './auth.js';
import { transcribeAudio } from './alignment.js';
import { loadFromSupabase } from './db.js';

document.addEventListener('DOMContentLoaded', async () => {
  const root = document.getElementById('transcribe-root');

  // Auth check — same pattern as detail.js
  const user = await checkAuth();
  if (!user) return; // checkAuth redirects to /login.html

  const params = new URLSearchParams(window.location.search);
  const audioId = params.get('id');
  if (!audioId) {
    root.innerHTML = '<p style="padding:24px;color:var(--red)">No audio ID specified.</p>';
    return;
  }

  // Load library config
  const libraries = await getUserLibraries();
  if (!libraries.length) {
    root.innerHTML = '<p style="padding:24px;color:var(--red)">No library access.</p>';
    return;
  }
  const libraryId = getActiveLibrary() || libraries[0].id;

  root.innerHTML = '<p style="padding:24px;color:var(--text-secondary)">Loading\u2026</p>';

  // Load data
  const remote = await loadFromSupabase(libraryId);
  initState({ audio: remote.audio, transcripts: remote.transcripts });
  mergeSupabaseData(remote);

  const state = getState();
  const audio = state.audio.find(a => a.id === audioId);
  if (!audio) {
    root.innerHTML = '<p style="padding:24px;color:var(--red)">Audio file not found.</p>';
    return;
  }

  renderTranscribePage(audioId, audio, state, root);
});

function renderTranscribePage(audioId, audio, state, root) {
  root.innerHTML = '';

  // ── Header bar ──
  const header = document.createElement('header');
  header.className = 'app-header';
  header.style.marginBottom = '0';

  const backBtn = document.createElement('a');
  backBtn.href = `/detail.html?id=${audioId}`;
  backBtn.className = 'toolbar-btn';
  backBtn.textContent = '\u2190 Back to File';

  const title = document.createElement('span');
  title.className = 'app-title';
  title.textContent = 'Generate Transcript';

  const settingsLink = document.createElement('a');
  settingsLink.href = '/';
  settingsLink.className = 'toolbar-btn';
  settingsLink.textContent = 'ASR Settings';
  settingsLink.title = 'Configure ASR providers on the main page';

  header.appendChild(backBtn);
  header.appendChild(title);
  header.appendChild(settingsLink);
  root.appendChild(header);

  // ── Main content ──
  const page = document.createElement('div');
  page.className = 'detail-page';
  page.style.maxWidth = '680px';
  root.appendChild(page);

  // ── File info card ──
  const infoCard = document.createElement('div');
  infoCard.className = 'detail-section';
  infoCard.style.marginBottom = '16px';

  const fileName = document.createElement('div');
  fileName.className = 'detail-title';
  fileName.textContent = audio.name || audioId;

  const fileMeta = document.createElement('div');
  fileMeta.className = 'text-secondary';
  fileMeta.style.fontSize = '0.82rem';
  fileMeta.style.marginTop = '4px';
  fileMeta.textContent = [
    audio.estMinutes ? `${audio.estMinutes.toFixed(1)} min` : null,
    audio.year ? `Year: ${audio.year}` : null,
  ].filter(Boolean).join(' \u00b7 ');

  infoCard.appendChild(fileName);
  infoCard.appendChild(fileMeta);

  // Audio player
  const audioUrl = audio.r2Link || audio.driveLink || null;
  if (audioUrl) {
    const proxiedUrl = `/api/audio?url=${encodeURIComponent(audioUrl)}`;
    const player = document.createElement('audio');
    player.controls = true;
    player.className = 'audio-player';
    player.style.marginTop = '12px';
    player.src = proxiedUrl;
    infoCard.appendChild(player);
  }

  page.appendChild(infoCard);

  // ── Provider buttons card ──
  const asrCard = document.createElement('div');
  asrCard.className = 'detail-section asr-transcription-card';

  const cardHeader = document.createElement('div');
  cardHeader.className = 'asr-card-header';

  const iconEl = document.createElement('div');
  iconEl.className = 'asr-card-icon';
  iconEl.textContent = '\uD83C\uDF99';

  const headerText = document.createElement('div');
  headerText.className = 'asr-card-header-text';

  const titleEl = document.createElement('div');
  titleEl.className = 'asr-card-title';
  titleEl.textContent = 'Generate Transcript';

  const descEl = document.createElement('div');
  descEl.className = 'asr-card-desc';
  descEl.textContent = 'Run an ASR model to produce a transcript from audio \u2014 no reference text needed';

  headerText.appendChild(titleEl);
  headerText.appendChild(descEl);
  cardHeader.appendChild(iconEl);
  cardHeader.appendChild(headerText);
  asrCard.appendChild(cardHeader);

  const PROVIDERS = [
    { key: 'gemini',      label: 'Gemini (fine-tuned)',  providerArg: 'gemini' },
    { key: 'whisper',     label: 'Whisper (RunPod)',      providerArg: 'whisper' },
    { key: 'mendel',      label: 'Mendel',                 providerArg: 'mendel' },
  ];

  const btnBar = document.createElement('div');
  btnBar.className = 'asr-provider-btns';

  // Result area — shows transcript after generation
  const resultArea = document.createElement('div');
  resultArea.className = 'asr-result-area';
  resultArea.hidden = true;

  // Local slug helper — matches detail.js' geminiSlug so version keys stay in sync.
  const geminiSlug = (ep) => {
    if (!ep) return 'unknown';
    const base = (ep.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (base) return base;
    if (ep.endpointId) return `ep-${String(ep.endpointId).slice(-6)}`;
    return 'unknown';
  };

  // Shared per-call prompt textarea (Gemini only). Whisper/Mendel ignore it.
  // Stored ABOVE the buttons so it's discoverable and reused if user runs
  // several Gemini endpoints back-to-back.
  let promptInput = null;
  {
    const wrap = document.createElement('div');
    wrap.className = 'gemini-prompt-wrap';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:8px 0 12px;';
    const lbl = document.createElement('label');
    lbl.textContent = 'Gemini prompt (optional, ignored by Whisper/Mendel)';
    lbl.style.cssText = 'font-size:0.78rem;color:var(--text-secondary);';
    promptInput = document.createElement('textarea');
    promptInput.className = 'gemini-prompt-input';
    promptInput.rows = 2;
    promptInput.placeholder = 'e.g. Verbatim transcription with full punctuation, mark uncertain words with [?]';
    promptInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:0.85rem;resize:vertical;font-family:inherit;';
    wrap.appendChild(lbl);
    wrap.appendChild(promptInput);
    asrCard.appendChild(wrap);
  }

  for (const { key, label: btnLabel, providerArg } of PROVIDERS) {
    const btn = document.createElement('button');
    btn.className = 'asr-provider-btn';
    btn.textContent = btnLabel;
    btn.setAttribute('aria-label', `Generate transcript using ${btnLabel}`);

    // Gemini endpoint picker — lets the user pick which fine-tuned model to
    // use without leaving the page.
    let geminiPicker = null;
    if (key === 'gemini') {
      const providers = getState().transcribeProviders || {};
      const g = providers.gemini || { endpoints: [], selectedId: null };
      const endpoints = Array.isArray(g.endpoints) ? g.endpoints : [];
      if (endpoints.length > 0) {
        geminiPicker = document.createElement('select');
        geminiPicker.className = 'gemini-endpoint-picker';
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
      btn.textContent = `${btnLabel} \u2014 transcribing\u2026`;
      resultArea.hidden = true;

      try {
        const providers = getState().transcribeProviders || {};
        let providerCfg = providers[key] || {};
        let saveModel = key;
        let prompt = null;
        let promptLabel = null;
        if (key === 'gemini') {
          const g = providers.gemini || {};
          const endpoints = Array.isArray(g.endpoints) ? g.endpoints : [];
          const selected = endpoints.find(e => e.id === g.selectedId) || endpoints[0];
          if (!selected || !selected.projectId || !selected.endpointId) {
            alert('No Gemini endpoint configured. Open ASR Settings to add one.');
            btn.disabled = false;
            btn.textContent = btnLabel;
            return;
          }
          providerCfg = { projectId: selected.projectId, region: selected.region, endpointId: selected.endpointId };
          saveModel = `gemini-${geminiSlug(selected)}`;
          // Pull the per-call prompt; treat empty/whitespace as "use default"
          // and mark the resulting version with promptLabel='default' so the
          // version picker can disambiguate it from prompted runs.
          const raw = (promptInput?.value || '').trim();
          prompt = raw.length > 0 ? raw : null;
          promptLabel = raw.length > 0
            ? (raw.length > 32 ? raw.slice(0, 32) + '\u2026' : raw)
            : 'default';
        }
        const config = { provider: providerArg, ...providerCfg };
        if (prompt) config.prompt = prompt;
        const text = await transcribeAudio(audioId, audioUrl, config);
        if (!text) throw new Error('Empty transcription returned');

        // Save version. For Gemini we ALWAYS append a new version (per-run
        // history mode, with a unique runId) so different prompts and reruns
        // coexist for side-by-side comparison. For Whisper/Mendel we keep
        // the existing dedup-per-model behavior since they have no prompt.
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
          const existingAsr = versions.find(v => v.type === 'asr' && v.model === saveModel);
          if (existingAsr) {
            updateVersion(audioId, existingAsr.id, { text, createdAt: new Date().toISOString() });
          } else {
            addVersion(audioId, { type: 'asr', text, model: saveModel, createdAt: new Date().toISOString() });
          }
        }

        btn.textContent = btnLabel;
        btn.disabled = false;

        // Show result
        resultArea.hidden = false;
        resultArea.innerHTML = '';

        const resultLabel = document.createElement('div');
        resultLabel.className = 'asr-result-label';
        resultLabel.textContent = `\u2713 ${btnLabel} transcript saved`;

        const resultText = document.createElement('div');
        resultText.className = 'asr-result-text';
        resultText.dir = 'rtl';
        resultText.textContent = text;

        const backLink = document.createElement('a');
        backLink.href = `/detail.html?id=${audioId}`;
        backLink.className = 'asr-result-back-btn';
        backLink.textContent = 'Open in Detail Page \u2192';

        resultArea.appendChild(resultLabel);
        resultArea.appendChild(resultText);
        resultArea.appendChild(backLink);

      } catch (err) {
        console.error('[ASR] transcription failed:', err);
        btn.textContent = `${btnLabel} \u2014 failed, retry?`;
        btn.disabled = false;
      }
    });

    btnBar.appendChild(btn);
    if (geminiPicker) btnBar.appendChild(geminiPicker);
  }

  asrCard.appendChild(btnBar);
  asrCard.appendChild(resultArea);
  page.appendChild(asrCard);

  // ── Existing ASR versions ──
  const versions = getVersions(audioId);
  const asrVersions = versions.filter(v => v.type === 'asr');
  if (asrVersions.length) {
    const existingCard = document.createElement('div');
    existingCard.className = 'detail-section';
    existingCard.style.marginTop = '16px';

    const existingTitle = document.createElement('div');
    existingTitle.className = 'section-sublabel';
    existingTitle.textContent = 'Previously generated transcripts';
    existingCard.appendChild(existingTitle);

    for (const v of asrVersions) {
      const row = document.createElement('div');
      row.className = 'asr-existing-row';

      const modelLabel = document.createElement('span');
      modelLabel.className = 'asr-existing-model';
      const baseLabel = v.model || 'asr';
      modelLabel.textContent = v.promptLabel
        ? `${baseLabel} \u2014 ${v.promptLabel}`
        : baseLabel;
      if (v.prompt) modelLabel.title = v.prompt;

      const date = document.createElement('span');
      date.className = 'text-secondary';
      date.style.fontSize = '0.75rem';
      date.textContent = v.createdAt
        ? new Date(v.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        : '';

      const preview = document.createElement('div');
      preview.className = 'asr-existing-preview';
      preview.dir = 'rtl';
      preview.textContent = (v.text || '').slice(0, 200) + ((v.text || '').length > 200 ? '\u2026' : '');

      row.appendChild(modelLabel);
      row.appendChild(date);
      row.appendChild(preview);
      existingCard.appendChild(row);
    }

    const detailLink = document.createElement('a');
    detailLink.href = `/detail.html?id=${audioId}`;
    detailLink.className = 'asr-result-back-btn';
    detailLink.style.marginTop = '12px';
    detailLink.textContent = 'Clean & Align in Detail Page \u2192';
    existingCard.appendChild(detailLink);

    page.appendChild(existingCard);
  }
}
