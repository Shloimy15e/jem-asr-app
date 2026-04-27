// Shared ASR provider configuration panel.
// Used by both app.js (global toolbar modal) and detail.js (per-file section).

import { getState, updateState } from './state.js';
import { loadGlobalVertexEndpoints } from './vertex-registry.js';

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

// Gemini endpoints are a list — multiple fine-tuned models in the same GCP
// project sharing one GEMINI_SA_JSON. Rendered in its own block with an
// editable table and an "add endpoint" button.
function renderGeminiEndpointsBlock(container) {
  const block = document.createElement('div');
  block.className = 'asr-provider-block';

  const title = document.createElement('div');
  title.className = 'asr-provider-title';
  title.textContent = 'Gemini (fine-tuned via Vertex AI)';
  const providers = getState().transcribeProviders || {};
  const g = providers.gemini || { endpoints: [], selectedId: null };
  const endpoints = Array.isArray(g.endpoints) ? g.endpoints : [];
  const configured = endpoints.filter(e => e.projectId && e.endpointId).length;
  const statusSpan = document.createElement('span');
  statusSpan.textContent = configured > 0 ? ` ✓ ${configured} custom` : ' Curated registry loaded';
  statusSpan.style.cssText = `font-size: 0.75rem; color: ${configured > 0 ? 'var(--green)' : 'var(--text-secondary)'}; margin-left: 8px;`;
  title.appendChild(statusSpan);
  // Async-update count when registry resolves so users see "10 curated + 2 custom" or similar.
  loadGlobalVertexEndpoints().then(rows => {
    const total = (rows?.length || 0) + configured;
    statusSpan.textContent = total > 0 ? ` ✓ ${rows?.length || 0} curated + ${configured} custom` : ' ○ No endpoints';
    statusSpan.style.color = total > 0 ? 'var(--green)' : 'var(--text-secondary)';
  });
  block.appendChild(title);
  block.appendChild(secretsNote('🔒 SA JSON stored as Cloudflare Worker secret GEMINI_SA_JSON — set via CLI, not here. All endpoints below share this one credential (same GCP project).'));

  // ── Curated registry (read-only, fetched from /api/vertex-endpoints) ───
  const registryList = document.createElement('div');
  registryList.className = 'gemini-registry-list';
  registryList.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:8px 0 4px;';
  block.appendChild(registryList);

  const renderRegistry = (rows) => {
    registryList.innerHTML = '';
    if (!rows.length) return;
    const heading = document.createElement('div');
    heading.textContent = `Curated endpoints (${rows.length})`;
    heading.style.cssText = 'font-size:0.78rem;color:var(--text-secondary);font-weight:600;margin-bottom:2px;';
    registryList.appendChild(heading);
    rows.forEach((ep) => {
      const r = document.createElement('label');
      r.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border,#2a2a3a);border-radius:6px;font-size:0.82rem;cursor:pointer;background:#10101e;';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gemini-selected';
      radio.value = ep.id;
      radio.checked = g.selectedId === ep.id;
      radio.addEventListener('change', () => {
        g.selectedId = ep.id;
        persist();
      });
      const star = document.createElement('span');
      star.textContent = ep._registry?.is_default ? '★' : '·';
      star.style.cssText = `color:${ep._registry?.is_default ? 'var(--accent,#00d4ff)' : 'var(--text-secondary)'};width:1em;text-align:center;`;
      const nameSpan = document.createElement('span');
      nameSpan.textContent = ep.name;
      nameSpan.style.flex = '1';
      const meta = document.createElement('span');
      meta.style.cssText = 'color:var(--text-secondary);font-size:0.75rem;';
      meta.textContent = ep._registry?.tuning_version
        ? `${ep._registry.tuning_version} ckpt ${ep._registry.checkpoint}`
        : ep.endpointId.slice(-8);
      r.appendChild(radio);
      r.appendChild(star);
      r.appendChild(nameSpan);
      r.appendChild(meta);
      registryList.appendChild(r);
    });
  };

  loadGlobalVertexEndpoints().then(renderRegistry);

  // ── User-added endpoints (mutable) ─────────────────────────────────────
  const localHeading = document.createElement('div');
  localHeading.textContent = 'Your custom endpoints';
  localHeading.style.cssText = 'font-size:0.78rem;color:var(--text-secondary);font-weight:600;margin:10px 0 2px;';
  block.appendChild(localHeading);

  const list = document.createElement('div');
  list.className = 'gemini-endpoint-list';
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  block.appendChild(list);

  const persist = () => {
    const s = getState();
    if (!s.transcribeProviders) s.transcribeProviders = {};
    s.transcribeProviders.gemini = { endpoints, selectedId: g.selectedId };
    updateState('transcribeProviders', null, s.transcribeProviders);
  };

  const redraw = () => {
    list.innerHTML = '';
    if (endpoints.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No endpoints yet — click "+ Add endpoint" below.';
      empty.style.cssText = 'color:var(--text-secondary);font-size:0.82rem;padding:8px 0;';
      list.appendChild(empty);
    }
    endpoints.forEach((ep, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:auto 1fr 140px 1fr 28px;gap:6px;align-items:center;padding:6px;border:1px solid var(--border,#ddd);border-radius:6px;background:#fafafa;';
      const mk = (val, placeholder, field) => {
        const i = document.createElement('input');
        i.type = 'text';
        i.className = 'asr-config-input';
        i.placeholder = placeholder;
        i.value = val || '';
        i.style.fontSize = '0.82rem';
        i.addEventListener('change', () => {
          endpoints[idx][field] = i.value.trim();
          persist();
        });
        return i;
      };
      // Radio = which endpoint is the "selected" default
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'gemini-selected';
      radio.checked = g.selectedId === ep.id;
      radio.title = 'Use this endpoint by default';
      radio.addEventListener('change', () => {
        g.selectedId = ep.id;
        persist();
      });
      row.appendChild(radio);
      row.appendChild(mk(ep.name, 'Name (e.g. Yiddish v3 large)', 'name'));
      row.appendChild(mk(ep.region, 'us-central1', 'region'));
      row.appendChild(mk(ep.endpointId, 'numeric endpoint ID', 'endpointId'));
      // Project ID in a tooltip-style smaller field — most users reuse one project
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Delete endpoint';
      del.style.cssText = 'background:transparent;border:0;color:var(--red,#d00);cursor:pointer;font-size:1.1rem;padding:2px 6px;';
      del.addEventListener('click', () => {
        if (!confirm(`Delete endpoint "${ep.name || ep.endpointId || 'untitled'}"?`)) return;
        endpoints.splice(idx, 1);
        if (g.selectedId === ep.id) g.selectedId = endpoints[0]?.id || null;
        persist();
        redraw();
      });
      row.appendChild(del);

      // Project ID in a second row (less-common field)
      const projRow = document.createElement('div');
      projRow.style.cssText = 'grid-column: 1 / -1; display:flex;align-items:center;gap:6px;font-size:0.78rem;';
      const projLabel = document.createElement('span');
      projLabel.textContent = 'GCP project:';
      projLabel.style.color = 'var(--text-secondary)';
      const projInput = mk(ep.projectId, 'jem-chabad', 'projectId');
      projInput.style.flex = '1';
      projRow.appendChild(projLabel);
      projRow.appendChild(projInput);
      row.appendChild(projRow);

      list.appendChild(row);
    });
  };
  redraw();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'action-btn';
  addBtn.textContent = '+ Add endpoint';
  addBtn.style.cssText = 'margin-top:8px;font-size:0.82rem;';
  addBtn.addEventListener('click', () => {
    const id = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const last = endpoints[endpoints.length - 1];
    endpoints.push({
      id,
      name: '',
      projectId: last?.projectId || '',
      region: last?.region || 'us-central1',
      endpointId: '',
    });
    if (!g.selectedId) g.selectedId = id;
    persist();
    redraw();
  });
  block.appendChild(addBtn);

  container.appendChild(block);
}

export function buildAsrConfigPanel(container) {
  // ── Gemini ──
  renderGeminiEndpointsBlock(container);

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

  // ── Mendel ──
  const ylBlock = document.createElement('div');
  ylBlock.className = 'asr-provider-block';
  const ylTitle = document.createElement('div');
  ylTitle.className = 'asr-provider-title';
  ylTitle.textContent = 'Mendel';
  {
    const providers = getState().transcribeProviders || {};
    const yl = providers.mendel || {};
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
  container.appendChild(buildProviderBlock('Mendel — endpoint config', [
    { stateKey: 'mendel', field: 'endpoint', label: 'Endpoint (optional)', placeholder: 'https://app.yiddishlabs.com/api/v1/transcriptions/sync', type: 'text' },
  ]));
}
