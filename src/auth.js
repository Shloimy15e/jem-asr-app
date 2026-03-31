import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

let _currentUser = null;
let _userLibraries = null;

// Redirects to /login.html if no active session. Returns the session if valid.
export async function checkAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return null;
  }
  _currentUser = session.user;
  return session;
}

// Returns the email of the currently authenticated user, or 'user' as fallback.
export function getCurrentUser() {
  return _currentUser?.email || _currentUser?.id || 'user';
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/login.html';
}

// ── Library context ──────────────────────────────────────────────────

// Returns all libraries the current user has access to.
// Result is [{id, name, r2Domain, transcriptPathPrefix, audioPathPrefix, role}].
// Cached for the session lifetime.
export async function getUserLibraries() {
  if (_userLibraries) return _userLibraries;
  const userId = _currentUser?.id;
  if (!userId) return [];
  // Two separate queries to avoid depending on PostgREST FK schema cache
  const { data: memberData, error: memberError } = await supabase
    .from('library_members')
    .select('library_id, role')
    .eq('user_id', userId);
  if (memberError) {
    console.warn('[Auth] getUserLibraries (members):', memberError.message);
  }
  const libraryIds = (memberData || []).map(m => m.library_id);
  // Fallback: if query failed or user not yet in library_members, default to jemedia admin
  if (libraryIds.length === 0) {
    _userLibraries = [{ id: 'jemedia', name: 'JEM Media', r2Domain: 'audio.kohnai.ai', transcriptPathPrefix: 'transcripts-txt/', audioPathPrefix: '', role: 'admin' }];
    return _userLibraries;
  }

  const { data: libData, error: libError } = await supabase
    .from('libraries')
    .select('id, name, r2_domain, transcript_path_prefix, audio_path_prefix')
    .in('id', libraryIds);
  if (libError) {
    console.warn('[Auth] getUserLibraries (libraries):', libError.message);
    return [];
  }
  const libMap = Object.fromEntries((libData || []).map(l => [l.id, l]));
  _userLibraries = (memberData || []).map(m => {
    const lib = libMap[m.library_id] || {};
    return {
      id: m.library_id,
      name: lib.name || m.library_id,
      r2Domain: lib.r2_domain || 'audio.kohnai.ai',
      transcriptPathPrefix: lib.transcript_path_prefix || 'transcripts-txt/',
      audioPathPrefix: lib.audio_path_prefix || '',
      role: m.role,
    };
  });
  return _userLibraries;
}

// Returns the ID of the currently active library.
// Validates the stored value against the user's memberships; falls back to first.
export function getActiveLibrary() {
  const stored = localStorage.getItem('active-library');
  if (stored) {
    // If we have cached libraries, validate; otherwise trust the stored value
    if (_userLibraries) {
      const valid = _userLibraries.some(l => l.id === stored);
      if (valid) return stored;
      // Stored value not in memberships — fall through to first
    } else {
      return stored;
    }
  }
  // Fall back to first library in the user's membership list
  if (_userLibraries && _userLibraries.length > 0) {
    const first = _userLibraries[0].id;
    localStorage.setItem('active-library', first);
    return first;
  }
  return null;
}

// Sets the active library and persists to localStorage.
export function setActiveLibrary(id) {
  localStorage.setItem('active-library', id);
}

// Returns the full config object for the active library, or a default fallback.
export function getActiveLibraryConfig() {
  const id = getActiveLibrary();
  if (_userLibraries && id) {
    return _userLibraries.find(l => l.id === id) || null;
  }
  // Fallback for early calls before getUserLibraries() resolves
  return { id: id || 'jemedia', name: 'ASR Workbench', r2Domain: 'audio.kohnai.ai', transcriptPathPrefix: 'transcripts-txt/', audioPathPrefix: '' };
}

// Returns true when the given URL points to the active library's R2 bucket.
export function isLibraryR2Url(url) {
  try {
    const config = getActiveLibraryConfig();
    return new URL(url).hostname === config?.r2Domain;
  } catch {
    return false;
  }
}
