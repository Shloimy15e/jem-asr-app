// Curated Vertex endpoint registry — pulled from /api/vertex-endpoints.
//
// Globally shared, read-only list of fine-tuned Gemini endpoints maintained
// by the operator. Cached in module scope for the session; merge with the
// user's own additions stored in state.transcribeProviders.gemini.endpoints.
//
// Each row from the API:
//   { id, display_name, project_id, region, endpoint_id, base_model,
//     tuning_version, checkpoint, is_default, notes }
//
// We surface them to the rest of the app reshaped to match the local-endpoint
// schema (so the existing picker code works unchanged):
//   { id, name, projectId, region, endpointId, _global: true, _registry: row }

import { getAccessToken } from './auth.js';

let _cache = null;
let _inflight = null;

function reshape(row) {
  return {
    id: `global_${row.id}`,
    name: row.display_name,
    projectId: row.project_id,
    region: row.region,
    endpointId: row.endpoint_id,
    _global: true,
    _registry: row,
  };
}

// Fetches the global registry once per session. Returns [] on failure rather
// than throwing — a transient registry outage shouldn't break the workbench.
export async function loadGlobalVertexEndpoints({ force = false } = {}) {
  if (_cache && !force) return _cache;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const token = await getAccessToken();
      if (!token) return [];
      const resp = await fetch('/api/vertex-endpoints', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        console.warn('[vertex-registry] failed to load:', resp.status);
        return [];
      }
      const data = await resp.json();
      _cache = (data.endpoints || []).map(reshape);
      return _cache;
    } catch (err) {
      console.warn('[vertex-registry] load error:', err);
      return [];
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// Merge global + local endpoints into a single picker-ready list.
// Globals come first; the global default is sorted to the very top.
// `localEndpoints` is the user's own list from state.transcribeProviders.gemini.endpoints.
export function mergeEndpoints(globalEndpoints, localEndpoints) {
  const globals = (globalEndpoints || []).slice().sort((a, b) => {
    const ad = a._registry?.is_default ? 0 : 1;
    const bd = b._registry?.is_default ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return (a.name || '').localeCompare(b.name || '');
  });
  const locals = Array.isArray(localEndpoints) ? localEndpoints.filter(e => e && !e._global) : [];
  return [...globals, ...locals];
}

// Pick the best initial selection when the user hasn't picked one yet.
// Preference order: their saved selectedId → registry default → first available.
export function resolveDefaultSelection(merged, savedSelectedId) {
  if (savedSelectedId) {
    const found = merged.find(e => e.id === savedSelectedId);
    if (found) return found;
  }
  const registryDefault = merged.find(e => e._global && e._registry?.is_default);
  if (registryDefault) return registryDefault;
  return merged[0] || null;
}

// Convenience for callers that don't want to deal with the merge plumbing.
// Returns: { merged, selected, globals, locals }
export async function getMergedVertexEndpoints(state) {
  const globals = await loadGlobalVertexEndpoints();
  const providers = state.transcribeProviders || {};
  const g = providers.gemini || { endpoints: [], selectedId: null };
  const locals = Array.isArray(g.endpoints) ? g.endpoints.filter(e => !e._global) : [];
  const merged = mergeEndpoints(globals, locals);
  const selected = resolveDefaultSelection(merged, g.selectedId);
  return { merged, selected, globals, locals };
}
