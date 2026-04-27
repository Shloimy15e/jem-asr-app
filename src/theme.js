// Theme manager — toggles between light and dark.
// Honors localStorage choice; falls back to system prefers-color-scheme.
// Exposes window.__jemTheme so the command palette + rail can use it.

const KEY = 'jem-asr-theme-v1';

function systemPref() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  } catch { return 'light'; }
}

function getStoredTheme() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(KEY, next); } catch {}
  // Notify any listeners (e.g. rail icon update)
  try {
    window.dispatchEvent(new CustomEvent('jem:theme-change', { detail: { theme: next } }));
  } catch {}
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
  // Apply ASAP to avoid a flash of light theme on dark-preference systems.
  const stored = getStoredTheme();
  const initial = stored || systemPref();
  document.documentElement.setAttribute('data-theme', initial);
  // Track system changes only if the user hasn't made an explicit choice.
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', (e) => {
        if (!getStoredTheme()) {
          setTheme(e.matches ? 'dark' : 'light');
          // setTheme persists; clear so we keep tracking system.
          try { localStorage.removeItem(KEY); } catch {}
        }
      });
    }
  } catch {}
}

if (typeof window !== 'undefined') {
  window.__jemTheme = { get: getTheme, set: setTheme, toggle: toggleTheme };
}

// Auto-init on import so the theme is set before first paint.
initTheme();
