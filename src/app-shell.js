// Cross-cutting UI shell wiring shared by every page:
//   - Mounts a hamburger toggle in the .app-header
//   - Builds a contextual side drawer with cross-page nav
//   - Decorates known toolbar buttons with Lucide icons
//
// Pages do not need to know about layout-shell or icons directly.
import { icons, iconEl } from './icons.js';
import { mountDrawerToggle, setShellSections } from './layout-shell.js';

const NAV = [
  { label: 'Audio',         icon: 'audio',    href: '/index.html',         match: ['/', '/index.html'] },
  { label: 'Transcribe',    icon: 'mic',      href: '/transcribe.html',    match: ['/transcribe.html'] },
  { label: 'Dashboard',     icon: 'sliders',  href: '/dashboard.html',     match: ['/dashboard.html'] },
];

const ADMIN_NAV = [
  { label: 'Admin',         icon: 'shield',   href: '/admin.html',         match: ['/admin.html'] },
  { label: 'Review export', icon: 'fileText', href: '/review-export.html', match: ['/review-export.html'] },
];

function isAdminVisible() {
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn && adminBtn.style.display !== 'none' && adminBtn.offsetParent !== null) return true;
  // Fallback: try users in localStorage role hints
  return false;
}

function buildContextualNav() {
  const path = location.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const sections = [];

  sections.push({
    heading: 'Navigation',
    items: NAV.map(n => ({
      label: n.label,
      icon: n.icon,
      href: n.href,
      active: n.match.some(m => m === path),
      closeOnClick: false,
    })),
  });

  if (isAdminVisible()) {
    sections.push({
      heading: 'Admin',
      items: ADMIN_NAV.map(n => ({
        label: n.label,
        icon: n.icon,
        href: n.href,
        active: n.match.some(m => m === path),
        closeOnClick: false,
      })),
    });
  }

  // Page-specific quick actions
  const actions = [];
  if (path === '/' || path === '/index.html') {
    if (document.getElementById('btn-search-transcripts')) {
      actions.push({ label: 'Search transcripts', icon: 'search',
        onClick: () => document.getElementById('btn-search-transcripts').click() });
    }
    if (document.getElementById('btn-asr-settings')) {
      actions.push({ label: 'ASR settings', icon: 'settings',
        onClick: () => document.getElementById('btn-asr-settings').click() });
    }
    if (document.getElementById('btn-export-csv')) {
      actions.push({ label: 'Export CSV', icon: 'download',
        onClick: () => document.getElementById('btn-export-csv').click() });
    }
  }
  if (actions.length) sections.push({ heading: 'Quick actions', items: actions });

  // Sign out always last
  if (document.getElementById('btn-logout')) {
    sections.push({
      heading: 'Account',
      items: [{
        label: 'Sign out',
        icon: 'logOut',
        onClick: () => document.getElementById('btn-logout').click(),
      }],
    });
  }

  return sections;
}

// Map of toolbar button id → icon name
const TOOLBAR_ICONS = {
  'btn-admin':              'shield',
  'btn-search-transcripts': 'search',
  'btn-asr-settings':       'settings',
  'btn-export-csv':         'download',
  'btn-logout':             'logOut',
};

function decorateToolbarButtons() {
  for (const [id, iconName] of Object.entries(TOOLBAR_ICONS)) {
    const btn = document.getElementById(id);
    if (!btn || btn.dataset.iconified) continue;
    if (!icons[iconName]) continue;
    // Wrap text content in a span so the icon can sit beside it
    const text = (btn.textContent || '').trim();
    btn.textContent = '';
    const i = document.createElement('span');
    i.innerHTML = icons[iconName]();
    i.style.display = 'inline-flex';
    i.style.alignItems = 'center';
    btn.appendChild(i);
    if (text) {
      const t = document.createElement('span');
      t.textContent = text;
      btn.appendChild(t);
    }
    btn.dataset.iconified = '1';
  }
}

function mountSkipLink() {
  if (document.querySelector('.skip-link')) return;
  // Find a sensible main landmark to jump to
  const main = document.querySelector('main, .app-main, #app, body > div');
  if (!main) return;
  if (!main.id) main.id = 'main-content';
  const link = document.createElement('a');
  link.className = 'skip-link';
  link.href = `#${main.id}`;
  link.textContent = 'Skip to main content';
  document.body.insertBefore(link, document.body.firstChild);
}

function refreshShell() {
  setShellSections(buildContextualNav());
  decorateToolbarButtons();
}

let _initialised = false;
export function initAppShell() {
  if (_initialised) return;
  _initialised = true;
  mountSkipLink();
  const header = document.querySelector('.app-header');
  if (!header) return;
  mountDrawerToggle(header, 'Open navigation');
  refreshShell();

  // If admin button becomes visible later (after auth), refresh nav
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) {
    const obs = new MutationObserver(() => refreshShell());
    obs.observe(adminBtn, { attributes: true, attributeFilter: ['style', 'class'] });
  }
}

// Auto-init when imported on a page that has DOM ready.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAppShell);
  } else {
    queueMicrotask(initAppShell);
  }
}

export { iconEl };
