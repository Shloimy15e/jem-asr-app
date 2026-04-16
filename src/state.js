import { syncStateKey, syncEdited, syncAsr } from './db.js';
import { getActiveLibrary } from './auth.js';

// Per-library localStorage key so switching libraries never mingles data.
// Falls back to the legacy key when no library context is set yet.
function getStorageKey() {
  const lib = getActiveLibrary();
  return lib ? `asr-state-${lib}` : 'jem-asr-state';
}

let state = null;

export function initState(data) {
  // One-time migration: move old 'jem-asr-state' key to the library-scoped key
  // when the active library is 'jemedia' and the new key doesn't exist yet.
  const activeLib = getActiveLibrary();
  if (activeLib === 'jemedia') {
    const legacy = localStorage.getItem('jem-asr-state');
    const newKey = 'asr-state-jemedia';
    if (legacy && !localStorage.getItem(newKey)) {
      localStorage.setItem(newKey, legacy);
      localStorage.removeItem('jem-asr-state');
    }
  }
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
    segmentApprovals: {},
    asrModels: saved.asrModels || [],
    transcribeProviders: saved.transcribeProviders || {
      // Secrets (SA JSON, API keys) are Cloudflare Worker secrets — not stored here.
      // Only non-sensitive config lives in state.
      gemini: { projectId: 'fink-partnership', region: 'us-central1', endpointId: '5718022314876993536' },
      whisper: {},
      mendel: { endpoint: '' },
    },
    trims: saved.trims || {},
    audioNames: saved.audioNames || {},
    audioYears: saved.audioYears || {},
    audioMonths: saved.audioMonths || {},
    audioDays: saved.audioDays || {},
    audioTypes: saved.audioTypes || {},
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
    // Assign iteration: 1 to all existing versions that lack the field
    for (const v of versions) {
      if (!v.iteration) v.iteration = 1;
    }

    // Deduplicate: keep only the latest version of each type (except 'asr' which allows multiple models)
    const seen = {};
    for (let i = versions.length - 1; i >= 0; i--) {
      const v = versions[i];
      const key = v.type === 'asr' ? `asr_${v.model || ''}` : v.type;
      if (seen[key]) {
        versions.splice(i, 1); // remove older duplicate
      } else {
        seen[key] = true;
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

  // Restore asr versions loaded from Supabase — one version per model
  if (remote.asr) {
    for (const [audioId, asrArray] of Object.entries(remote.asr)) {
      const versions = state.transcriptVersions[audioId];
      if (!versions || versions.length === 0) continue;
      for (const asrData of asrArray) {
        const existing = versions.find(v => v.type === 'asr' && v.model === asrData.model);
        if (existing) {
          existing.text = asrData.text;
        } else {
          versions.push({
            id: `tv_${audioId}_asr_${asrData.model}_restored`,
            type: 'asr',
            text: asrData.text,
            model: asrData.model,
            createdAt: asrData.createdAt,
          });
        }
      }
    }
  }

  // Reconstruct missing mappings from manual versions BEFORE migration —
  // covers cases where work was done locally but the mapping wasn't synced
  // to Supabase.  Must happen first so migrateToVersions sees all mappings
  // and can deduplicate versions properly.
  for (const [audioId, versions] of Object.entries(state.transcriptVersions)) {
    if (state.mappings[audioId]) continue; // already have a mapping
    const manual = versions.find(v => v.type === 'manual');
    if (manual?.sourceTranscriptId) {
      state.mappings[audioId] = {
        transcriptId: manual.sourceTranscriptId,
        confidence: manual.confidence || 0,
        matchReason: manual.matchReason || 'reconstructed from version',
        confirmedBy: manual.createdBy || 'system',
        confirmedAt: manual.createdAt || new Date().toISOString(),
      };
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
      if (key === 'audioYears') audioEntry.year = value;
      if (key === 'audioMonths') audioEntry.month = value;
      if (key === 'audioDays') audioEntry.day = value;
      if (key === 'audioTypes') audioEntry.type = value;
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

  // A mapping only counts if the transcript it points to actually exists
  const mapping = state.mappings[audioId];
  const hasValidTranscript = mapping
    && (state.transcripts || []).some(t => t.id === mapping.transcriptId);

  // Also check if a manual version exists with a valid sourceTranscriptId —
  // this covers cases where the mapping was lost during Supabase sync but
  // versions (with work done) still exist in localStorage.
  const versions = state.transcriptVersions[audioId];
  const hasVersionMapping = !hasValidTranscript && versions && versions.length > 0
    && versions.some(v => v.type === 'manual' && v.sourceTranscriptId
      && (state.transcripts || []).some(t => t.id === v.sourceTranscriptId));

  if (!hasValidTranscript && !hasVersionMapping) return 'unmapped';

  if (versions && versions.length > 0) {
    if (versions.some(v => v.review?.status === 'approved')) return 'approved';
    if (versions.some(v => v.review?.status === 'rejected')) return 'rejected';
    if (versions.some(v => v.alignment)) return 'aligned';
    if (versions.some(v => v.type === 'cleaned' || v.type === 'edited')) return 'cleaned';
    return 'mapped';
  }
  // Fallback to legacy
  if (state.reviews[audioId]?.status === 'approved') return 'approved';
  if (state.reviews[audioId]?.status === 'rejected') return 'rejected';
  if (state.alignments[audioId]) return 'aligned';
  if (state.cleaning[audioId]) return 'cleaned';
  return 'mapped';
}

// ── Pipeline stages ────────────────────────────────────────────────

export const PIPELINE_STAGES = ['mapped', 'cleaned', 'aligned', 'approved'];

// Returns an object of booleans indicating which pipeline stages are complete.
// Each stage is derived independently so the result is cumulative.
export function getCompletedStages(audioId) {
  const result = { mapped: false, cleaned: false, aligned: false, approved: false, rejected: false };
  if (!state) return result;

  // Check mapping (same logic as getStatus)
  const mapping = state.mappings[audioId];
  const versions = state.transcriptVersions[audioId];
  const hasMapping = (mapping && (state.transcripts || []).some(t => t.id === mapping.transcriptId))
    || (versions && versions.some(v => v.type === 'manual' && v.sourceTranscriptId
        && (state.transcripts || []).some(t => t.id === v.sourceTranscriptId)));
  if (!hasMapping) return result; // unmapped — nothing is done

  result.mapped = true;

  // Check cleaned/edited
  if (versions && versions.length > 0) {
    if (versions.some(v => v.type === 'cleaned' || v.type === 'edited')) result.cleaned = true;
    if (versions.some(v => v.alignment)) result.aligned = true;
    if (versions.some(v => v.review?.status === 'approved')) result.approved = true;
    if (versions.some(v => v.review?.status === 'rejected')) result.rejected = true;
  }
  // Legacy fallback
  if (state.cleaning[audioId]) result.cleaned = true;
  if (state.alignments[audioId]) result.aligned = true;
  if (state.reviews[audioId]?.status === 'approved') result.approved = true;
  if (state.reviews[audioId]?.status === 'rejected') result.rejected = true;

  return result;
}

// Inclusive filter matching — "aligned" includes files that are aligned OR approved,
// since approved implies all prior stages. Unmapped/rejected are exact.
export function matchesStatusFilter(audioId, filter) {
  if (!filter) return true;
  const stages = getCompletedStages(audioId);
  switch (filter) {
    case 'unmapped':  return !stages.mapped;
    case 'mapped':    return stages.mapped;
    case 'cleaned':   return stages.cleaned;
    case 'aligned':   return stages.aligned;
    case 'approved':  return stages.approved;
    case 'rejected':  return stages.rejected;
    default:          return getStatus(audioId) === filter;
  }
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

// Derives the current pipeline step from version data (no stored state needed).
// Steps: 'clean' → 'align' → 'review' → 'approved'
export function getPipelineStep(audioId) {
  const versions = getVersions(audioId);
  if (!versions || versions.length === 0) return 'clean';
  if (versions.some(v => v.review?.status === 'approved')) return 'approved';
  const best = getBestVersion(audioId);
  if (!best) return 'clean';
  if (best.alignment?.avgConfidence != null) return 'review';
  if (best.type === 'cleaned' || best.type === 'edited' || best.type === 'asr') return 'align';
  return 'clean';
}

// Returns the next iteration number for a new version in this audio's pipeline.
// Looks at the max stored iteration field; defaults to 1 if none exist yet.
export function getNextIteration(audioId) {
  const versions = getVersions(audioId);
  let max = 0;
  for (const v of versions) {
    if (v.iteration && v.iteration > max) max = v.iteration;
  }
  return max + 1;
}

// Returns the current (highest) iteration number across all versions.
export function getIterationCount(audioId) {
  const versions = getVersions(audioId);
  let max = 0;
  for (const v of versions) {
    if (v.iteration && v.iteration > max) max = v.iteration;
  }
  // Fall back to counting aligned versions (for data that predates iteration field)
  if (max === 0) return versions.filter(v => v.alignment?.avgConfidence != null).length;
  return max;
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
  const cleaned = versions.find(v => v.type === 'edited') || versions.find(v => v.type === 'cleaned');
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

  // Support compound keys (fifty-unmapped, not-fifty-mapped, etc.)
  let fiftyMode = '';  // '' = all, 'yes' = 50hr only, 'no' = not in 50hr
  let statusFilter = '';
  if (typeof filter === 'string') {
    const f = filter.replace('50hr', 'fifty');
    if (f === 'not-fifty' || f.startsWith('not-fifty-')) {
      fiftyMode = 'no';
      statusFilter = f === 'not-fifty' ? '' : f.replace('not-fifty-', '');
    } else if (f === 'fifty' || f.startsWith('fifty-')) {
      fiftyMode = 'yes';
      statusFilter = f === 'fifty' ? '' : f.replace('fifty-', '');
    } else if (['unmapped', 'mapped', 'cleaned', 'aligned', 'approved', 'rejected', 'benchmark'].includes(f)) {
      statusFilter = f;
    } else if (f === 'needs-review' || f === 'needsReview') {
      statusFilter = 'aligned';
    } else if (f === 'perfect-match') {
      statusFilter = 'perfect-match';
    } else if (f === 'strong-match') {
      statusFilter = 'strong-match';
    }
    // 'all' or default → no status filter
  }

  let rows = audio;

  // 50hr filter
  if (fiftyMode === 'yes') rows = rows.filter(a => a.isSelected50hr);
  if (fiftyMode === 'no') rows = rows.filter(a => !a.isSelected50hr);

  // Status filter
  if (statusFilter === 'benchmark') {
    rows = rows.filter(a => a.isBenchmark);
  } else if (statusFilter === 'perfect-match') {
    rows = rows.filter(a => { const m = state.mappings[a.id]; return m && m.confidence === 1; });
  } else if (statusFilter === 'strong-match') {
    rows = rows.filter(a => { const m = state.mappings[a.id]; return m && m.confidence >= 0.5; });
  } else if (statusFilter) {
    rows = rows.filter(a => matchesStatusFilter(a.id, statusFilter));
  }

  // Year/month/type filters
  if (yearFilter) rows = rows.filter(a => a.year === yearFilter);
  if (monthFilter) rows = rows.filter(a => a.month === monthFilter);
  if (typeFilter) rows = rows.filter(a => a.type === typeFilter);

  // Search
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    rows = rows.filter(a => {
      const name = (a.name || '').toLowerCase();
      const transcript = getTranscriptNameForAudio(a.id).toLowerCase();
      return name.includes(term) || transcript.includes(term);
    });
  }

  // Sort
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

  // Inclusive counting — "aligned" count includes approved files too
  const statusCounts = { unmapped: 0, mapped: 0, cleaned: 0, aligned: 0, approved: 0, rejected: 0 };
  const fiftyStatusCounts = { unmapped: 0, mapped: 0, cleaned: 0, aligned: 0, approved: 0, rejected: 0 };
  let benchmarkCount = 0;
  let fiftyCount = 0;
  let perfectMatchCount = 0;
  let strongMatchCount = 0;

  audio.forEach(a => {
    const stages = getCompletedStages(a.id);
    if (!stages.mapped) { statusCounts.unmapped++; }
    else {
      statusCounts.mapped++;
      if (stages.cleaned)  statusCounts.cleaned++;
      if (stages.aligned)  statusCounts.aligned++;
      if (stages.approved) statusCounts.approved++;
      if (stages.rejected) statusCounts.rejected++;
    }
    if (a.isBenchmark) benchmarkCount++;
    if (a.isSelected50hr) {
      fiftyCount++;
      if (!stages.mapped) { fiftyStatusCounts.unmapped++; }
      else {
        fiftyStatusCounts.mapped++;
        if (stages.cleaned)  fiftyStatusCounts.cleaned++;
        if (stages.aligned)  fiftyStatusCounts.aligned++;
        if (stages.approved) fiftyStatusCounts.approved++;
      }
    }
    const m = state.mappings[a.id];
    if (m && m.confidence === 1) perfectMatchCount++;
    if (m && m.confidence >= 0.5) strongMatchCount++;
  });

  const counts = {
    all: audio.length,
    unmapped: statusCounts.unmapped,
    mapped: statusCounts.mapped,
    benchmark: benchmarkCount,
    'perfect-match': perfectMatchCount,
    'strong-match': strongMatchCount,
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
  const lib = getActiveLibrary() || 'asr';
  a.download = `${lib}-state-${new Date().toISOString().slice(0, 10)}.json`;
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

function buildPersistObject() {
  return {
    transcriptVersions: state.transcriptVersions,
    mappings: state.mappings,
    cleaning: state.cleaning,
    alignments: state.alignments,
    reviews: state.reviews,
    benchmarks: state.benchmarks,
    asrModels: state.asrModels,
    transcribeProviders: state.transcribeProviders,
    trims: state.trims,
    audioNames: state.audioNames,
  };
}

export function saveToStorage() {
  try {
    const persist = buildPersistObject();
    localStorage.setItem(getStorageKey(), JSON.stringify(persist));
  } catch (e) {
    console.warn('Failed to save state to localStorage:', e);
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Failed to load state from localStorage:', e);
    return {};
  }
}

export function setSegmentApprovals(audioId, hashArray) {
  if (!state) return;
  if (!state.segmentApprovals) state.segmentApprovals = {};
  state.segmentApprovals[audioId] = new Set(hashArray);
}

export function getApprovedSegments(audioId) {
  return state?.segmentApprovals?.[audioId] || new Set();
}

export function toggleSegmentApproval(audioId, hash) {
  if (!state) return false;
  if (!state.segmentApprovals) state.segmentApprovals = {};
  if (!state.segmentApprovals[audioId]) state.segmentApprovals[audioId] = new Set();
  const set = state.segmentApprovals[audioId];
  const wasApproved = set.has(hash);
  if (wasApproved) set.delete(hash); else set.add(hash);
  return !wasApproved;
}
