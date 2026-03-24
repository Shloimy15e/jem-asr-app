import { getState, updateState } from './state.js';
import { calculateWER, normalizeYiddish, levenshtein } from './utils.js';

// ── ASR Config Modal ────────────────────────────────────────────────

export function renderAsrConfig(container, state) {
  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'asr-config-panel';

  const title = document.createElement('h2');
  title.textContent = 'ASR Model Configuration';
  wrapper.appendChild(title);

  const models = state.asrModels || [];

  models.forEach((model, idx) => {
    wrapper.appendChild(buildModelForm(model, idx, container));
  });

  // Add new model button
  const addBtn = document.createElement('button');
  addBtn.className = 'bulk-btn';
  addBtn.textContent = '+ Add Model';
  addBtn.addEventListener('click', () => {
    const s = getState();
    s.asrModels = s.asrModels || [];
    s.asrModels.push({ name: '', endpoint: '', apiKey: '', requestTemplate: {} });
    updateState('asrModels', null, s.asrModels);
    renderAsrConfig(container, getState());
  });
  wrapper.appendChild(addBtn);

  container.appendChild(wrapper);
}

function buildModelForm(model, idx, rootContainer) {
  const form = document.createElement('div');
  form.className = 'asr-model-form';

  const fields = [
    { key: 'name', label: 'Model Name', type: 'text', placeholder: 'e.g. Whisper Large v3' },
    { key: 'endpoint', label: 'API Endpoint', type: 'url', placeholder: 'https://api.example.com/transcribe' },
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
    { key: 'requestTemplate', label: 'Request Template (JSON)', type: 'textarea', placeholder: '{"model": "whisper-1", "language": "yi"}' },
  ];

  fields.forEach(f => {
    const label = document.createElement('label');
    label.className = 'asr-form-label';
    label.textContent = f.label;

    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'asr-form-input asr-form-textarea';
      input.rows = 3;
      input.value = typeof model[f.key] === 'object' ? JSON.stringify(model[f.key], null, 2) : (model[f.key] || '');
    } else {
      input = document.createElement('input');
      input.type = f.type;
      input.className = 'asr-form-input';
      input.value = model[f.key] || '';
    }
    input.placeholder = f.placeholder;

    input.addEventListener('change', () => {
      const s = getState();
      if (f.key === 'requestTemplate') {
        try {
          s.asrModels[idx][f.key] = JSON.parse(input.value);
        } catch {
          s.asrModels[idx][f.key] = {};
        }
      } else {
        s.asrModels[idx][f.key] = input.value;
      }
      updateState('asrModels', null, s.asrModels);
    });

    label.appendChild(input);
    form.appendChild(label);
  });

  const btnRow = document.createElement('div');
  btnRow.className = 'asr-form-buttons';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'bulk-btn asr-delete-btn';
  deleteBtn.textContent = 'Delete Model';
  deleteBtn.addEventListener('click', () => {
    const s = getState();
    s.asrModels.splice(idx, 1);
    updateState('asrModels', null, s.asrModels);
    renderAsrConfig(rootContainer, getState());
  });

  btnRow.appendChild(deleteBtn);
  form.appendChild(btnRow);

  return form;
}

// ── Run Benchmark ───────────────────────────────────────────────────

export async function runBenchmark(benchmarkAudioIds, state, onProgress) {
  const models = state.asrModels || [];
  if (models.length === 0) {
    throw new Error('No ASR models configured. Add models in the benchmark config panel.');
  }

  const benchmarkAudios = state.audio.filter(a => benchmarkAudioIds.includes(a.id));
  const total = benchmarkAudios.length * models.length;
  let completed = 0;

  for (const audio of benchmarkAudios) {
    const mapping = state.mappings[audio.id];
    const transcript = mapping
      ? state.transcripts.find(t => t.id === mapping.transcriptId)
      : null;
    const cleaningData = state.cleaning?.[audio.id];
    const goldTranscript = cleaningData?.cleanedText
      || transcript?.text
      || transcript?.cleanedText
      || transcript?.firstLine
      || '';

    if (!state.benchmarks[audio.id]) {
      state.benchmarks[audio.id] = { results: [] };
    }

    let audioUrl = audio.r2Link || audio.driveLink;
    if (audioUrl && audioUrl.includes('audio.kohnai.ai')) {
      audioUrl = '/api/audio?url=' + encodeURIComponent(audioUrl);
    }
    let audioBlob;
    try {
      const resp = await fetch(audioUrl);
      audioBlob = await resp.blob();
    } catch (err) {
      console.error(`Failed to fetch audio for ${audio.name}:`, err);
      completed += models.length;
      if (onProgress) onProgress(completed, total);
      continue;
    }

    for (const model of models) {
      try {
        const asrTranscript = await sendToAsrModel(audioBlob, model);
        const werResult = calculateWER(goldTranscript, asrTranscript);

        // Custom WER: (I + D + critical_S) / N
        // Known limitation: critical_S distinction is not yet implemented, so
        // all substitutions count as critical — making customWer equal to wer.
        // Column kept as a placeholder for future functionality.
        const customWer = werResult.total > 0
          ? (werResult.insertions + werResult.deletions + werResult.substitutions) / werResult.total
          : 0;

        const result = {
          model: model.name,
          transcript: asrTranscript,
          wer: werResult.wer,
          cer: werResult.cer,
          customWer,
          substitutions: werResult.substitutions,
          insertions: werResult.insertions,
          deletions: werResult.deletions,
          total: werResult.total,
          ranAt: new Date().toISOString(),
        };

        state.benchmarks[audio.id].results.push(result);
        updateState('benchmarks', audio.id, state.benchmarks[audio.id]);
      } catch (err) {
        console.error(`Benchmark failed for ${audio.name} with ${model.name}:`, err);
      }

      completed++;
      if (onProgress) onProgress(completed, total);
    }
  }
}

async function sendToAsrModel(audioBlob, model) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.mp3');

  const template = model.requestTemplate || {};
  for (const [key, value] of Object.entries(template)) {
    formData.append(key, value);
  }

  const headers = {};
  if (model.apiKey) {
    headers['Authorization'] = `Bearer ${model.apiKey}`;
  }

  const resp = await fetch(model.endpoint, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!resp.ok) {
    throw new Error(`ASR API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  return data.text || data.transcript || data.full_text || JSON.stringify(data);
}

// ── Benchmark Comparison Table ──────────────────────────────────────

export function renderBenchmarkTable(container, state) {
  container.innerHTML = '';

  const benchmarkAudios = (state.audio || []).filter(a => a.isBenchmark);
  const benchmarks = state.benchmarks || {};

  if (benchmarkAudios.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'empty-message';
    msg.textContent = 'No benchmark audio files found.';
    container.appendChild(msg);
    return;
  }

  const hasResults = benchmarkAudios.some(a => benchmarks[a.id]?.results?.length > 0);
  if (!hasResults) {
    const msg = document.createElement('p');
    msg.className = 'empty-message';
    msg.textContent = 'No benchmark results yet. Configure ASR models and run benchmark.';
    container.appendChild(msg);
    return;
  }

  // Build flat rows: one row per (file, model) with latest result
  const flatRows = [];
  for (const audio of benchmarkAudios) {
    const results = benchmarks[audio.id]?.results || [];
    // Group by model, take latest
    const byModel = {};
    results.forEach(r => { byModel[r.model] = r; });
    for (const [modelName, r] of Object.entries(byModel)) {
      const allRuns = results.filter(x => x.model === modelName);
      const prev = allRuns.length >= 2 ? allRuns[allRuns.length - 2] : null;
      flatRows.push({ audio, model: modelName, result: r, prevResult: prev, audioId: audio.id });
    }
  }

  // Find best (lowest) WER per file for green highlighting
  const bestWerByFile = {};
  for (const row of flatRows) {
    const id = row.audioId;
    if (bestWerByFile[id] === undefined || row.result.wer < bestWerByFile[id]) {
      bestWerByFile[id] = row.result.wer;
    }
  }

  // Sort state
  let sortCol = null;
  let sortDir = 'asc';

  const columns = [
    { key: 'model', label: 'Model', value: r => r.model },
    { key: 'file', label: 'File', value: r => r.audio.name },
    { key: 'wer', label: 'WER', value: r => r.result.wer },
    { key: 'cer', label: 'CER', value: r => r.result.cer },
    { key: 'customWer', label: 'Custom WER', value: r => r.result.customWer },
  ];

  function renderTable() {
    container.innerHTML = '';

    let sorted = [...flatRows];
    if (sortCol) {
      const colDef = columns.find(c => c.key === sortCol);
      if (colDef) {
        const dir = sortDir === 'desc' ? -1 : 1;
        sorted.sort((a, b) => {
          const va = colDef.value(a);
          const vb = colDef.value(b);
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
          const sa = String(va || '');
          const sb = String(vb || '');
          return sa.localeCompare(sb) * dir;
        });
      }
    }

    const table = document.createElement('table');
    table.className = 'data-table benchmark-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    columns.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.className = 'sortable-header';
      if (sortCol === col.key) {
        th.textContent += sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
      }
      th.addEventListener('click', () => {
        if (sortCol === col.key) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col.key;
          sortDir = 'asc';
        }
        renderTable();
      });
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    sorted.forEach(row => {
      const tr = document.createElement('tr');

      // Model
      const modelTd = document.createElement('td');
      modelTd.textContent = row.model;
      tr.appendChild(modelTd);

      // File with Benchmark badge
      const fileTd = document.createElement('td');
      fileTd.textContent = row.audio.name;
      const badge = document.createElement('span');
      badge.className = 'status-badge status-benchmark';
      badge.textContent = 'Benchmark';
      fileTd.appendChild(document.createTextNode(' '));
      fileTd.appendChild(badge);
      tr.appendChild(fileTd);

      // WER
      const werTd = document.createElement('td');
      werTd.textContent = (row.result.wer * 100).toFixed(1) + '%';
      if (row.result.wer === bestWerByFile[row.audioId]) {
        werTd.classList.add('best-score');
      }
      // Delta arrow
      if (row.prevResult) {
        const delta = row.result.wer - row.prevResult.wer;
        if (delta !== 0) {
          const arrow = document.createElement('span');
          arrow.className = delta < 0 ? 'delta-improved' : 'delta-worse';
          arrow.textContent = delta < 0 ? ' \u2193' : ' \u2191';
          werTd.appendChild(arrow);
        }
      }
      tr.appendChild(werTd);

      // CER
      const cerTd = document.createElement('td');
      cerTd.textContent = (row.result.cer * 100).toFixed(1) + '%';
      tr.appendChild(cerTd);

      // Custom WER
      const cwTd = document.createElement('td');
      cwTd.textContent = row.result.customWer != null
        ? (row.result.customWer * 100).toFixed(1) + '%'
        : '--';
      tr.appendChild(cwTd);

      // Click row to expand word errors
      tr.classList.add('expandable-row');
      tr.addEventListener('click', () => {
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('word-error-row')) {
          next.remove();
          return;
        }
        const detailRow = document.createElement('tr');
        detailRow.className = 'word-error-row';
        const detailTd = document.createElement('td');
        detailTd.colSpan = columns.length;
        renderWordErrors(row.result, detailTd);
        detailRow.appendChild(detailTd);
        tr.parentNode.insertBefore(detailRow, tr.nextSibling);
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  renderTable();
}

// ── Word Error View ─────────────────────────────────────────────────

export function renderWordErrors(result, container) {
  container.innerHTML = '';

  if (!result || !result.transcript) {
    container.textContent = 'No transcript data available.';
    return;
  }

  // Find gold transcript for this result
  const state = getState();
  const benchmarkAudios = (state.audio || []).filter(a => a.isBenchmark);
  let goldText = '';
  for (const audio of benchmarkAudios) {
    const runs = state.benchmarks[audio.id]?.results || [];
    if (runs.some(r => r.model === result.model && r.ranAt === result.ranAt)) {
      const mapping = state.mappings[audio.id];
      const transcript = mapping ? state.transcripts.find(t => t.id === mapping.transcriptId) : null;
      const cleaningData = state.cleaning?.[audio.id];
      goldText = cleaningData?.cleanedText
        || transcript?.text
        || transcript?.cleanedText
        || transcript?.firstLine
        || '';
      break;
    }
  }

  const refNorm = normalizeYiddish(goldText);
  const hypNorm = normalizeYiddish(result.transcript);
  const refWords = refNorm.split(/\s+/).filter(Boolean);
  const hypWords = hypNorm.split(/\s+/).filter(Boolean);

  const { operations: ops } = levenshtein(refWords, hypWords);

  const wrapper = document.createElement('div');
  wrapper.className = 'word-errors-view';
  wrapper.dir = 'rtl';

  const legend = document.createElement('div');
  legend.className = 'word-error-legend';
  const legendItems = [
    { cls: 'word-correct', text: 'Correct' },
    { cls: 'word-sub', text: 'Substitution' },
    { cls: 'word-ins', text: 'Insertion' },
    { cls: 'word-del', text: 'Deletion' },
  ];
  legendItems.forEach(item => {
    const span = document.createElement('span');
    span.className = item.cls;
    span.textContent = item.text;
    legend.appendChild(span);
    legend.appendChild(document.createTextNode(' '));
  });
  wrapper.appendChild(legend);

  const wordGrid = document.createElement('div');
  wordGrid.className = 'word-error-grid';

  ops.forEach(op => {
    const chip = document.createElement('span');
    chip.className = 'word-error-chip';

    switch (op.type) {
      case 'C':
        chip.classList.add('word-correct');
        chip.textContent = op.ref;
        break;
      case 'S':
        chip.classList.add('word-sub');
        chip.textContent = op.hyp;
        chip.title = `Expected: ${op.ref}`;
        break;
      case 'I':
        chip.classList.add('word-ins');
        chip.textContent = op.hyp;
        chip.title = 'Inserted (extra word)';
        break;
      case 'D':
        chip.classList.add('word-del');
        chip.textContent = op.ref;
        chip.title = 'Deleted (missing word)';
        break;
    }

    wordGrid.appendChild(chip);
  });

  wrapper.appendChild(wordGrid);
  container.appendChild(wrapper);
}
