// Shared ASR provider configuration panel.
// Used by both app.js (global toolbar modal) and detail.js (per-file section).

import { getState, updateState } from './state.js';

function buildProviderBlock(title, fields) {
  const providers = getState().transcribeProviders || {};
  const block = document.createElement('div');
  block.className = 'asr-provider-block';

  const titleEl = document.createElement('div');
  titleEl.className = 'asr-provider-title';
  titleEl.textContent = title;
  block.appendChild(titleEl);

  for (const { stateKey, field, label, placeholder, type } of fields) {
    const row = document.createElement('label');
    row.className = type === 'textarea' ? 'asr-config-row asr-config-row-tall' : 'asr-config-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'asr-config-label';
    labelEl.textContent = label;

    let input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'asr-config-input asr-config-textarea';
      input.placeholder = placeholder;
      input.rows = 4;
      input.value = providers[stateKey]?.[field] || '';
    } else {
      input = document.createElement('input');
      input.type = type || 'text';
      input.className = 'asr-config-input';
      input.placeholder = placeholder;
      input.value = providers[stateKey]?.[field] || '';
    }

    input.addEventListener('change', () => {
      const s = getState();
      if (!s.transcribeProviders) s.transcribeProviders = {};
      if (!s.transcribeProviders[stateKey]) s.transcribeProviders[stateKey] = {};
      s.transcribeProviders[stateKey][field] = input.value.trim();
      updateState('transcribeProviders', null, s.transcribeProviders);
    });

    row.appendChild(labelEl);
    row.appendChild(input);
    block.appendChild(row);
  }

  return block;
}

/**
 * Renders the full ASR provider config panel into `container`.
 * Reads current values from state and saves changes back on input change.
 */
function secretsNote(text) {
  const note = document.createElement('div');
  note.className = 'asr-provider-note asr-provider-note-secrets';
  note.textContent = text;
  return note;
}

export function buildAsrConfigPanel(container) {
  // ── Gemini ──
  const geminiBlock = document.createElement('div');
  geminiBlock.className = 'asr-provider-block';
  const geminiTitle = document.createElement('div');
  geminiTitle.className = 'asr-provider-title';
  geminiTitle.textContent = 'Gemini (fine-tuned via Vertex AI)';
  {
    const providers = getState().transcribeProviders || {};
    const g = providers.gemini || {};
    const isConfigured = !!(g.projectId && g.endpointId);
    const statusSpan = document.createElement('span');
    statusSpan.textContent = isConfigured ? ' ✓ Configured' : ' ○ Not configured';
    statusSpan.style.cssText = `font-size: 0.75rem; color: ${isConfigured ? 'var(--green)' : 'var(--text-secondary)'}; margin-left: 8px;`;
    geminiTitle.appendChild(statusSpan);
  }
  geminiBlock.appendChild(geminiTitle);
  geminiBlock.appendChild(secretsNote('🔒 SA JSON stored as Cloudflare Worker secret GEMINI_SA_JSON — set via CLI, not here.'));
  container.appendChild(geminiBlock);

  // Non-secret Gemini config
  container.appendChild(buildProviderBlock('Gemini — endpoint config', [
    { stateKey: 'gemini', field: 'projectId',  label: 'GCP Project ID', placeholder: 'fink-partnership',    type: 'text' },
    { stateKey: 'gemini', field: 'region',     label: 'Region',         placeholder: 'us-central1',         type: 'text' },
    { stateKey: 'gemini', field: 'endpointId', label: 'Endpoint ID',    placeholder: '5718022314876993536', type: 'text' },
  ]));

  // ── Whisper ──
  const whisperBlock = document.createElement('div');
  whisperBlock.className = 'asr-provider-block';
  const whisperTitle = document.createElement('div');
  whisperTitle.className = 'asr-provider-title';
  whisperTitle.textContent = 'Whisper (RunPod)';
  {
    const statusSpan = document.createElement('span');
    statusSpan.textContent = ' ✓ Ready';
    statusSpan.style.cssText = 'font-size: 0.75rem; color: var(--green); margin-left: 8px;';
    whisperTitle.appendChild(statusSpan);
  }
  whisperBlock.appendChild(whisperTitle);
  whisperBlock.appendChild(secretsNote('No credentials needed — uses the existing align.kohnai.ai endpoint.'));
  container.appendChild(whisperBlock);

  // ── Yiddish Labs ──
  const ylBlock = document.createElement('div');
  ylBlock.className = 'asr-provider-block';
  const ylTitle = document.createElement('div');
  ylTitle.className = 'asr-provider-title';
  ylTitle.textContent = 'Yiddish Labs';
  {
    const providers = getState().transcribeProviders || {};
    const yl = providers.yiddishLabs || {};
    const isConfigured = !!(yl.endpoint);
    const statusSpan = document.createElement('span');
    statusSpan.textContent = isConfigured ? ' ✓ Configured' : ' ○ Not configured';
    statusSpan.style.cssText = `font-size: 0.75rem; color: ${isConfigured ? 'var(--green)' : 'var(--text-secondary)'}; margin-left: 8px;`;
    ylTitle.appendChild(statusSpan);
  }
  ylBlock.appendChild(ylTitle);
  ylBlock.appendChild(secretsNote('🔒 API key stored as Cloudflare Worker secret YL_API_KEY — set via CLI, not here.'));
  container.appendChild(ylBlock);

  // Optional custom endpoint (not a secret)
  container.appendChild(buildProviderBlock('Yiddish Labs — endpoint config', [
    { stateKey: 'yiddishLabs', field: 'endpoint', label: 'Endpoint (optional)', placeholder: 'https://app.yiddishlabs.com/api/v1/transcriptions/sync', type: 'text' },
  ]));
}
