import './app-shell.js';
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
  backBtn.style.textDecoration = 'none';
  backBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;vertical-align:-3px"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg><span>Back to file</span>';

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
  // Inline mic SVG (matches icons.js mic glyph). Sized to fit the 40x40 chip.
  iconEl.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

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
  // ── Prompt editor (Gemini only) ─────────────────────────────────
  // Polished editor with preset chips, char counter, persistence,
  // expand-to-overlay. Whisper/Mendel ignore this; we show that hint
  // when they're highlighted.
  let promptInput = null;
  const PROMPT_LS_KEY = 'jem-asr-last-gemini-prompt';
  const PROMPT_PRESETS = [
    { label: 'Default',           text: '' },
    { label: 'Verbatim + punctuation', text: 'Transcribe this Yiddish audio verbatim with full punctuation. Preserve hesitations (uh, um) and false starts.' },
    { label: 'Clean reading',     text: 'Transcribe this Yiddish audio. Remove filler words and false starts. Keep punctuation and sentence breaks.' },
    { label: 'Word-for-word',     text: 'Transcribe word-for-word in Yiddish, exactly as spoken. Do not paraphrase. Mark unintelligible words with [?].' },
    { label: 'With speaker tags', text: 'Transcribe this Yiddish audio. Identify each speaker and prefix lines with the speaker label (Speaker 1: / Speaker 2:). Use full punctuation.' },
  ];
  {
    const wrap = document.createElement('div');
    wrap.className = 'prompt-editor';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:10px 0 14px;padding:14px 14px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-lg);';

    // Header row: label + expand button
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const headLabel = document.createElement('div');
    headLabel.style.cssText = 'font-size:0.75rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted);';
    headLabel.textContent = 'Gemini Prompt';
    const headHint = document.createElement('div');
    headHint.style.cssText = 'font-size:0.74rem;color:var(--text-muted);';
    headHint.textContent = '· Whisper / Mendel ignore this';
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'action-btn';
    expandBtn.style.cssText = 'margin-left:auto;font-size:0.75rem;height:26px;padding:0 10px;';
    expandBtn.title = 'Expand prompt editor';
    expandBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    head.appendChild(headLabel);
    head.appendChild(headHint);
    head.appendChild(expandBtn);
    wrap.appendChild(head);

    // Preset chips
    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    PROMPT_PRESETS.forEach(p => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'prompt-preset-chip';
      chip.textContent = p.label;
      chip.title = p.text || 'Use the default Worker prompt';
      chip.style.cssText = 'height:26px;padding:0 10px;font-size:0.74rem;font-weight:600;border:1px solid var(--border);background:var(--surface);color:var(--text-secondary);border-radius:999px;cursor:pointer;transition:all 150ms;';
      chip.addEventListener('click', () => {
        promptInput.value = p.text;
        updateCharCount();
        promptInput.focus();
        // Visual select
        chips.querySelectorAll('.prompt-preset-chip').forEach(c => {
          c.style.background = 'var(--surface)';
          c.style.color = 'var(--text-secondary)';
          c.style.borderColor = 'var(--border)';
        });
        chip.style.background = 'var(--accent-dim)';
        chip.style.color = 'var(--accent)';
        chip.style.borderColor = 'var(--accent)';
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);

    // Textarea
    promptInput = document.createElement('textarea');
    promptInput.className = 'gemini-prompt-input';
    promptInput.rows = 4;
    promptInput.placeholder = 'Leave blank to use the worker default prompt, or write your own. Tip: be specific about Yiddish, punctuation, and how to handle uncertain words.';
    promptInput.style.cssText = 'width:100%;min-height:88px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:0.88rem;line-height:1.5;font-family:inherit;background:var(--surface);color:var(--text);resize:vertical;outline:none;transition:border-color 150ms, box-shadow 150ms;';
    promptInput.addEventListener('focus', () => {
      promptInput.style.borderColor = 'var(--accent)';
      promptInput.style.boxShadow = '0 0 0 3px var(--accent-dim)';
    });
    promptInput.addEventListener('blur', () => {
      promptInput.style.borderColor = 'var(--border)';
      promptInput.style.boxShadow = 'none';
    });
    // Restore last prompt
    try {
      const saved = localStorage.getItem(PROMPT_LS_KEY);
      if (saved) promptInput.value = saved;
    } catch {}
    wrap.appendChild(promptInput);

    // Footer: char count + clear + persist
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const charCount = document.createElement('span');
    charCount.style.cssText = 'font-size:0.72rem;color:var(--text-muted);font-variant-numeric:tabular-nums;';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'action-btn action-btn-danger';
    clearBtn.style.cssText = 'font-size:0.72rem;height:24px;padding:0 8px;';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => { promptInput.value = ''; updateCharCount(); promptInput.focus(); });
    foot.appendChild(charCount);
    foot.appendChild(clearBtn);
    wrap.appendChild(foot);

    function updateCharCount() {
      const n = (promptInput.value || '').length;
      charCount.textContent = n === 0 ? 'Using worker default prompt' : `${n} character${n === 1 ? '' : 's'}`;
      try { localStorage.setItem(PROMPT_LS_KEY, promptInput.value); } catch {}
    }
    promptInput.addEventListener('input', updateCharCount);
    updateCharCount();

    // Expand-to-fullscreen overlay
    expandBtn.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px;';
      const dlg = document.createElement('div');
      dlg.style.cssText = 'background:var(--surface);border-radius:var(--radius-2xl);box-shadow:var(--shadow-lg);width:min(900px, 92vw);max-height:88vh;display:flex;flex-direction:column;padding:22px;';
      const dlgHead = document.createElement('div');
      dlgHead.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
      const dlgTitle = document.createElement('h3');
      dlgTitle.textContent = 'Edit Gemini prompt';
      dlgTitle.style.cssText = 'margin:0;font-size:1rem;font-weight:700;letter-spacing:-0.01em;';
      const dlgClose = document.createElement('button');
      dlgClose.type = 'button';
      dlgClose.className = 'action-btn';
      dlgClose.textContent = 'Done';
      dlgHead.appendChild(dlgTitle);
      dlgHead.appendChild(dlgClose);
      dlg.appendChild(dlgHead);
      const dlgArea = document.createElement('textarea');
      dlgArea.value = promptInput.value;
      dlgArea.style.cssText = 'flex:1;width:100%;min-height:50vh;padding:14px 16px;border:1px solid var(--border);border-radius:var(--radius);font-size:0.95rem;line-height:1.6;font-family:inherit;resize:vertical;outline:none;';
      dlgArea.addEventListener('focus', () => { dlgArea.style.borderColor = 'var(--accent)'; dlgArea.style.boxShadow = '0 0 0 3px var(--accent-dim)'; });
      dlgArea.addEventListener('blur',  () => { dlgArea.style.borderColor = 'var(--border)'; dlgArea.style.boxShadow = 'none'; });
      dlg.appendChild(dlgArea);
      overlay.appendChild(dlg);
      document.body.appendChild(overlay);
      dlgArea.focus();
      const close = () => {
        promptInput.value = dlgArea.value;
        updateCharCount();
        document.body.removeChild(overlay);
      };
      dlgClose.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onEsc);
          close();
        }
      });
    });

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
