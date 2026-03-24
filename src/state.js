import { syncStateKey, syncEdited, syncAsr } from './db.js';

const STORAGE_KEY = 'jem-asr-state';

let state = null;

export function initState(data) {
  const saved = loadFromStorage();
  state = {
    audio: data.audio || [],
    transcripts: data.transcripts || [],
    transcriptVersions: saved.transcriptVersions || {},
    // Legacy keys kept for backward compat
    mappings: saved.mappings || {},
    cleaning: saved.cleaning || {},
    alignments: saved.alignments || {},
    reviews: saved.reviews || {},
    benchmarks: saved.benchmarks || {},
    asrModels: saved.asrModels || [],
    transcribeProviders: saved.transcribeProviders || {
      // Secrets (SA JSON, API keys) are Cloudflare Worker secrets — not stored here.
      // Only non-sensitive config lives in state.
      gemini: { projectId: 'fink-partnership', region: 'us-central1', endpointId: '5718022314876993536' },
      whisper: {},
      yiddishLabs: { endpoint: '' },
    },
    trims: saved.trims || {},
    audioNames: saved.audioNames || {},
  };
  // Migrate old format into transcriptVersions
  migrateToVersions();
  return state;
}

function migrateToVersions() {
  for (const [audioId, mapping] of Object.entries(state.mappings)) {
    if (!state.transcriptVersions[audioId]) {
      state.transcriptVersions[audioId] = [];
    }
    const versions = state.transcriptVersions[audioId];
    // Create manual version if none exists
    if (!versions.some(v => v.type === 'manual')) {
      versions.push({
        id: `tv_${audioId}_manual`,
        type: 'manual',
        sourceTranscriptId: mapping.transcriptId,
        text: null, // loaded on demand from R2
        confidence: mapping.confidence,
        matchReason: mapping.matchReason,
        createdAt: mapping.confirmedAt || new Date().toISOString(),
        createdBy: mapping.confirmedBy || 'imported',
      });
    }
    // Migrate cleaning data
    const cleaning = state.cleaning[audioId];
    if (cleaning && !versions.some(v => v.type === 'cleaned')) {
      versions.push({
        id: `tv_${audioId}_cleaned`,
        type: 'cleaned',
        parentVersionId: `tv_${audioId}_manual`,
        sourceTranscriptId: mapping.transcriptId,
        text: cleaning.cleanedText,
        originalText: cleaning.originalText,
        cleanRate: cleaning.cleanRate,
        createdAt: cleaning.cleanedAt || new Date().toISOString(),
        createdBy: 'system',
      });
    }
    // Migrate alignment data
    const alignment = state.alignments[audioId];
    if (alignment) {
      const target = versions.find(v => v.type === 'cleaned') || versions.find(v => v.type === 'manual');
      if (target && !target.alignment) {
        target.alignment = {
          words: alignment.words,
          avgConfidence: alignment.avgConfidence,
          lowConfidenceCount: alignment.lowConfidenceCount,
          alignedAt: alignment.alignedAt,
        };
      }
    }
    // Migrate review data
    const review = state.reviews[audioId];
    if (review) {
      const target = versions[versions.length - 1];
      if (target && !target.review) {
        target.review = {
          status: review.status,
          editedText: review.editedText,
          reviewedAt: review.reviewedAt,
        };
      }
    }
  }
}

export function getState() {
  return state;
}

// Merge work data loaded from Supabase over localStorage cache.
// Called once on startup. Catalog (audio/transcripts) already comes
// from Supabase via initState — this only needs to handle work data.
export function mergeSupabaseData(remote) {
  if (!state || !remote) return;

  // Work data — Supabase is authoritative, replace entirely so deletions propagate
  if (remote.mappings)   state.mappings = remote.mappings;
  if (remote.cleaning)   state.cleaning = remote.cleaning;
  if (remote.alignments) state.alignments = remote.alignments;
  if (remote.reviews)    state.reviews = remote.reviews;
  if (remote.trims)      Object.assign(state.trims, remote.trims);

  // Restore edited versions loaded from Supabase into transcriptVersions
  if (remote.edited) {
    for (const [audioId, editedData] of Object.entries(remote.edited)) {
      const versions = state.transcriptVersions[audioId];
      if (!versions || versions.length === 0) continue;
      const existing = versions.find(v => v.type === 'edited');
      if (existing) {
        existing.text = editedData.text;
      } else {
        const manual = versions.find(v => v.type === 'manual');
        versions.push({
          id: `tv_${audioId}_edited_restored`,
          type: 'edited',
          parentVersionId: manual?.id,
          sourceTranscriptId: manual?.sourceTranscriptId,
          text: editedData.text,
          createdAt: editedData.createdAt,
          createdBy: 'user',
        });
      }
    }
  }

  // Restore asr versions loaded from Supabase into transcriptVersions
  if (remote.asr) {
    for (const [audioId, asrData] of Object.entries(remote.asr)) {
      const versions = state.transcriptVersions[audioId];
      if (!versions || versions.length === 0) continue;
      const existing = versions.find(v => v.type === 'asr');
      if (existing) {
        existing.text = asrData.text;
        existing.model = asrData.model;
      } else {
        versions.push({
          id: `tv_${audioId}_asr_restored`,
          type: 'asr',
          text: asrData.text,
          model: asrData.model,
          createdAt: asrData.createdAt,
        });
      }
    }
  }

  // Re-run migration so transcriptVersions reflects the merged data
  migrateToVersions();
  saveToStorage();
}

export function updateState(key, audioId, value) {
  if (!state) return;
  if (!state[key]) state[key] = {};
  if (audioId === null) {
    state[key] = value;
  } else {
    state[key][audioId] = value;
  }
  // Keep state.audio in sync for direct-field overrides
  if (audioId !== null) {
    const audioEntry = state.audio?.find(a => a.id === audioId);
    if (audioEntry) {
      if (key === 'audioNames') audioEntry.name = value;
      if (key === 'audioComments') audioEntry.comments = value;
    }
  }
  saveToStorage();
  // Sync to Supabase (fire and forget)
  if (audioId !== null) {
    const audioEntry = state.audio?.find(a => a.id === audioId);
    syncStateKey(key, audioId, value, audioEntry);
  }
}

export function getStatus(audioId) {
  if (!state) return 'unmapped';
  const versions = state.transcriptVersions[audioId];
  if (versions && versions.length > 0) {
    if (versions.some(v => v.review?.status === 'approved')) return 'approved';
    if (versions.some(v => v.review?.status === 'rejected')) return 'rejected';
    if (versions.some(v => v.alignment)) return 'aligned';
    if (versions.some(v => v.type === 'cleaned')) return 'cleaned';
    return 'mapped';
  }
  // Fallback to legacy
  if (state.reviews[audioId]?.status === 'approved') return 'approved';
  if (state.reviews[audioId]?.status === 'rejected') return 'rejected';
  if (state.alignments[audioId]) return 'aligned';
  if (state.cleaning[audioId]) return 'cleaned';
  if (state.mappings[audioId]) return 'mapped';
  return 'unmapped';
}

// ── Transcript version helpers ──────────────────────────────────────

export function getVersions(audioId) {
  if (!state || !state.transcriptVersions[audioId]) return [];
  return state.transcriptVersions[audioId];
}

export function getVersionsByType(audioId, type) {
  return getVersions(audioId).filter(v => v.type === type);
}

export function getBestVersion(audioId) {
  const versions = getVersions(audioId);
  if (versions.length === 0) return null;
  // Priority: edited > cleaned > asr > manual
  const priority = ['edited', 'cleaned', 'asr', 'manual'];
  for (const type of priority) {
    const v = versions.filter(v => v.type === type);
    if (v.length > 0) return v[v.length - 1]; // latest of that type
  }
  return versions[versions.length - 1];
}

export function addVersion(audioId, versionData) {
  if (!state) return null;
  if (!state.transcriptVersions[audioId]) {
    state.transcriptVersions[audioId] = [];
  }
  const id = `tv_${audioId}_${versionData.type}_${Date.now()}`;
  const version = { id, ...versionData, createdAt: versionData.createdAt || new Date().toISOString() };
  state.transcriptVersions[audioId].push(version);
  syncLegacyKeys(audioId);
  saveToStorage();
  // Persist edited/asr versions to Supabase so they survive across browsers/sessions
  if (versionData.type === 'edited' && versionData.text != null) {
    const audioEntry = state.audio?.find(a => a.id === audioId);
    syncEdited(audioId, versionData.text, audioEntry).catch(console.warn);
  }
  if (versionData.type === 'asr' && versionData.text != null) {
    const audioEntry = state.audio?.find(a => a.id === audioId);
    syncAsr(audioId, versionData.text, versionData.model, audioEntry).catch(console.warn);
  }
  return version;
}

export function updateVersion(audioId, versionId, updates) {
  if (!state) return;
  const versions = state.transcriptVersions[audioId];
  if (!versions) return;
  const v = versions.find(v => v.id === versionId);
  if (v) {
    Object.assign(v, updates);
    syncLegacyKeys(audioId);
    saveToStorage();
    // Sync text changes for edited/asr versions to Supabase
    if (v.type === 'edited' && updates.text != null) {
      const audioEntry = state.audio?.find(a => a.id === audioId);
      syncEdited(audioId, v.text, audioEntry).catch(console.warn);
    }
    if (v.type === 'asr' && updates.text != null) {
      const audioEntry = state.audio?.find(a => a.id === audioId);
      syncAsr(audioId, v.text, v.model, audioEntry).catch(console.warn);
    }
  }
}

// Store alignment data on a specific version object.
// Also updates the legacy flat key so existing code keeps working.
export function setVersionAlignment(audioId, versionId, alignment) {
  if (!state) return;
  const versions = state.transcriptVersions[audioId];
  if (!versions) return;
  const v = versions.find(v => v.id === versionId);
  if (v) {
    v.alignment = alignment;
    syncLegacyKeys(audioId);
    saveToStorage();
  }
}

// Return all versions that have alignment data attached.
export function getAlignedVersions(audioId) {
  return getVersions(audioId).filter(v => v.alignment && v.alignment.words);
}

function syncLegacyKeys(audioId) {
  const versions = state.transcriptVersions[audioId] || [];
  const manual = versions.find(v => v.type === 'manual');
  if (manual) {
    state.mappings[audioId] = {
      transcriptId: manual.sourceTranscriptId,
      confidence: manual.confidence,
      matchReason: manual.matchReason,
      confirmedBy: manual.createdBy,
      confirmedAt: manual.createdAt,
    };
  }
  const cleaned = versions.find(v => v.type === 'cleaned');
  if (cleaned) {
    state.cleaning[audioId] = {
      originalText: cleaned.originalText,
      cleanedText: cleaned.text,
      cleanRate: cleaned.cleanRate,
      cleanedAt: cleaned.createdAt,
    };
  }
  // Use same priority as getBestVersion (edited > cleaned > asr > manual)
  // so the legacy key always reflects the most-relevant aligned version.
  const withAlignment = ['edited', 'cleaned', 'asr', 'manual']
    .reduce((found, type) => found || versions.find(v => v.type === type && v.alignment), null);
  if (withAlignment) {
    state.alignments[audioId] = withAlignment.alignment;
  }
  const withReview = versions.find(v => v.review);
  if (withReview) {
    state.reviews[audioId] = withReview.review;
  }
}

// Returns all audio IDs that are currently mapped to the given transcriptId.
export function getAudiosByTranscriptId(transcriptId) {
  if (!state) return [];
  return Object.entries(state.mappings)
    .filter(([, m]) => m.transcriptId === transcriptId)
    .map(([audioId]) => audioId);
}

// Push a freshly-created transcript record into the in-memory catalog so the
// UI sees it immediately without a full reload.
export function addTranscript(transcript) {
  if (!state) return;
  state.transcripts.push(transcript);
}

export function getFilteredRows(filter, searchTerm, sortCol, sortDir, yearFilter, monthFilter, typeFilter) {
  if (!state) return [];
  const { audio } = state;
  const fifty = audio.filter(a => a.isSelected50hr);

  let rows;
  switch (filter) {
    case 'fifty':
    case '50hr':
      rows = fifty;
      break;
    case 'fifty-unmapped':
    case '50hr-unmapped':
      rows = fifty.filter(a => getStatus(a.id) === 'unmapped');
      break;
    case 'fifty-mapped':
    case '50hr-mapped':
      rows = fifty.filter(a => getStatus(a.id) === 'mapped');
      break;
    case 'fifty-cleaned':
    case '50hr-cleaned':
      rows = fifty.filter(a => getStatus(a.id) === 'cleaned');
      break;
    case 'fifty-aligned':
    case '50hr-aligned':
      rows = fifty.filter(a => getStatus(a.id) === 'aligned');
      break;
    case 'fifty-approved':
    case '50hr-approved':
      rows = fifty.filter(a => getStatus(a.id) === 'approved');
      break;
    case 'unmapped':
      rows = audio.filter(a => getStatus(a.id) === 'unmapped');
      break;
    case 'mapped':
      rows = audio.filter(a => {
        const s = getStatus(a.id);
        return (s === 'mapped' || s === 'cleaned' || s === 'aligned') && !a.isBenchmark;
      });
      break;
    case 'cleaned':
      rows = audio.filter(a => getStatus(a.id) === 'cleaned');
      break;
    case 'benchmark':
      rows = audio.filter(a => a.isBenchmark);
      break;
    case 'needs-review':
    case 'needsReview':
      rows = audio.filter(a => getStatus(a.id) === 'aligned');
      break;
    case 'approved':
      rows = audio.filter(a => getStatus(a.id) === 'approved');
      break;
    case 'rejected':
      rows = audio.filter(a => getStatus(a.id) === 'rejected');
      break;
    case 'all':
    default:
      rows = audio;
      break;
  }

  // Apply year/month/type filters if provided
  if (yearFilter) rows = rows.filter(a => a.year === yearFilter);
  if (monthFilter) rows = rows.filter(a => a.month === monthFilter);
  if (typeFilter) rows = rows.filter(a => a.type === typeFilter);

  // Apply search term if provided
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    rows = rows.filter(a => {
      const name = (a.name || '').toLowerCase();
      const transcript = getTranscriptNameForAudio(a.id).toLowerCase();
      return name.includes(term) || transcript.includes(term);
    });
  }

  // Apply sort if provided
  if (sortCol) {
    const dir = sortDir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      let va = a[sortCol] || '';
      let vb = b[sortCol] || '';
      if (typeof va === 'string') {
        const na = parseFloat(va);
        const nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  return rows;
}

function getTranscriptNameForAudio(audioId) {
  if (!state || !state.mappings || !state.mappings[audioId]) return '';
  const mapping = state.mappings[audioId];
  const transcript = (state.transcripts || []).find(t => t.id === mapping.transcriptId);
  return transcript ? transcript.name : '';
}

export function getFilterCounts() {
  if (!state) return {};
  const { audio } = state;

  // Cache status per audio file — avoids calling getStatus multiple times
  const statusCounts = { unmapped: 0, mapped: 0, cleaned: 0, aligned: 0, approved: 0, rejected: 0 };
  const fiftyStatusCounts = { unmapped: 0, mapped: 0, cleaned: 0, aligned: 0, approved: 0 };
  let benchmarkCount = 0;
  let fiftyCount = 0;

  audio.forEach(a => {
    const s = getStatus(a.id);
    if (statusCounts[s] !== undefined) statusCounts[s]++;
    if (a.isBenchmark) benchmarkCount++;
    if (a.isSelected50hr) {
      fiftyCount++;
      if (fiftyStatusCounts[s] !== undefined) fiftyStatusCounts[s]++;
    }
  });

  const counts = {
    all: audio.length,
    unmapped: statusCounts.unmapped,
    mapped: statusCounts.mapped,
    benchmark: benchmarkCount,
    'needs-review': statusCounts.aligned,
    cleaned: statusCounts.cleaned || 0,
    approved: statusCounts.approved,
    rejected: statusCounts.rejected,
    'fifty': fiftyCount,
    'fifty-unmapped': fiftyStatusCounts.unmapped,
    'fifty-mapped': fiftyStatusCounts.mapped,
    'fifty-cleaned': fiftyStatusCounts.cleaned,
    'fifty-aligned': fiftyStatusCounts.aligned,
    'fifty-approved': fiftyStatusCounts.approved,
  };

  // Alias '50hr-*' keys to 'fifty-*' values
  counts['50hr'] = counts['fifty'];
  counts['50hr-unmapped'] = counts['fifty-unmapped'];
  counts['50hr-mapped'] = counts['fifty-mapped'];
  counts['50hr-cleaned'] = counts['fifty-cleaned'];
  counts['50hr-aligned'] = counts['fifty-aligned'];
  counts['50hr-approved'] = counts['fifty-approved'];

  return counts;
}

export function exportState() {
  if (!state) return;
  const exportData = {
    transcriptVersions: state.transcriptVersions,
    mappings: state.mappings,
    cleaning: state.cleaning,
    alignments: state.alignments,
    reviews: state.reviews,
    benchmarks: state.benchmarks,
    trims: state.trims,
    asrModels: (state.asrModels || []).map(m => {
      const { apiKey, ...rest } = m;
      return rest;
    }),
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jem-asr-state-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importState(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.transcriptVersions) {
          for (const [audioId, versions] of Object.entries(imported.transcriptVersions)) {
            state.transcriptVersions[audioId] = versions;
          }
        }
        if (imported.mappings) Object.assign(state.mappings, imported.mappings);
        if (imported.cleaning) Object.assign(state.cleaning, imported.cleaning);
        if (imported.alignments) Object.assign(state.alignments, imported.alignments);
        if (imported.reviews) Object.assign(state.reviews, imported.reviews);
        if (imported.benchmarks) Object.assign(state.benchmarks, imported.benchmarks);
        if (imported.trims) Object.assign(state.trims, imported.trims);
        if (imported.asrModels) {
          const existing = state.asrModels || [];
          for (const model of imported.asrModels) {
            const match = existing.find(m => m.name === model.name);
            if (match) {
              Object.assign(match, model);
            } else {
              existing.push(model);
            }
          }
          state.asrModels = existing;
        }
        saveToStorage();
        resolve(state);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function saveToStorage() {
  try {
    const persist = {
      transcriptVersions: state.transcriptVersions,
      mappings: state.mappings,
      cleaning: state.cleaning,
      alignments: state.alignments,
      reviews: state.reviews,
      benchmarks: state.benchmarks,
      asrModels: state.asrModels,
      trims: state.trims,
      audioNames: state.audioNames,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
  } catch (e) {
    console.warn('Failed to save state to localStorage:', e);
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Failed to load state from localStorage:', e);
    return {};
  }
}
