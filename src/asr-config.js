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
export function buildAsrConfigPanel(container) {
  container.appendChild(buildProviderBlock('Gemini (fine-tuned via Vertex AI)', [
    { stateKey: 'gemini', field: 'saJson',     label: 'Service Account JSON', placeholder: 'Paste the contents of your .json key file', type: 'textarea' },
    { stateKey: 'gemini', field: 'projectId',  label: 'GCP Project ID',       placeholder: 'fink-partnership',    type: 'text' },
    { stateKey: 'gemini', field: 'region',     label: 'Region',               placeholder: 'us-central1',         type: 'text' },
    { stateKey: 'gemini', field: 'endpointId', label: 'Endpoint ID',          placeholder: '5718022314876993536', type: 'text' },
    { stateKey: 'gemini', field: 'apiKey',     label: 'API Key (alt)',         placeholder: 'AIza… — only if not using service account', type: 'password' },
    { stateKey: 'gemini', field: 'modelId',    label: 'Model ID (alt)',        placeholder: 'gemini-2.5-flash or numeric tuned model ID', type: 'text' },
  ]));

  const whisperBlock = document.createElement('div');
  whisperBlock.className = 'asr-provider-block';
  const whisperTitle = document.createElement('div');
  whisperTitle.className = 'asr-provider-title';
  whisperTitle.textContent = 'Whisper (RunPod)';
  const whisperNote = document.createElement('div');
  whisperNote.className = 'asr-provider-note';
  whisperNote.textContent = 'Uses the existing alignment endpoint (align.kohnai.ai) — no additional configuration needed.';
  whisperBlock.appendChild(whisperTitle);
  whisperBlock.appendChild(whisperNote);
  container.appendChild(whisperBlock);

  container.appendChild(buildProviderBlock('Yiddish Labs', [
    { stateKey: 'yiddishLabs', field: 'apiKey',   label: 'API Key',             placeholder: 'yl_live_...',                                           type: 'password' },
    { stateKey: 'yiddishLabs', field: 'endpoint', label: 'Endpoint (optional)', placeholder: 'https://app.yiddishlabs.com/api/v1/transcriptions/sync', type: 'text' },
  ]));
}
