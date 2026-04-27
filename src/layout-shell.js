// Tiny layout shell helpers: a single contextual side drawer + topbar
// drawer-toggle button. Lazy-mounts on first call. Pages call:
//
//   import { mountDrawerToggle, openDrawer, setDrawerContent } from './layout-shell.js';
//   mountDrawerToggle(headerEl, 'Filters');
//   setDrawerContent(buildFiltersPanel());
//
// The drawer body accepts arbitrary DOM nodes — pages own the contents.

import { icons } from './icons.js';

let _drawer = null;
let _backdrop = null;
let _toggleBtn = null;
let _contentSlot = null;

function ensureDrawer() {
  if (_drawer) return;
  // Backdrop
  _backdrop = document.createElement('div');
  _backdrop.className = 'side-drawer-backdrop';
  _backdrop.addEventListener('click', closeDrawer);

  // Drawer
  _drawer = document.createElement('aside');
  _drawer.className = 'side-drawer';
  _drawer.setAttribute('aria-hidden', 'true');

  _contentSlot = document.createElement('div');
  _drawer.appendChild(_contentSlot);

  document.body.appendChild(_backdrop);
  document.body.appendChild(_drawer);

  // Esc to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _drawer.classList.contains('is-open')) closeDrawer();
  });
}

export function setDrawerContent(node) {
  ensureDrawer();
  _contentSlot.innerHTML = '';
  if (typeof node === 'string') {
    _contentSlot.innerHTML = node;
  } else if (node instanceof Node) {
    _contentSlot.appendChild(node);
  }
}

export function openDrawer() {
  ensureDrawer();
  _drawer.classList.add('is-open');
  _backdrop.classList.add('is-open');
  _drawer.setAttribute('aria-hidden', 'false');
  if (_toggleBtn) _toggleBtn.setAttribute('aria-expanded', 'true');
}

export function closeDrawer() {
  if (!_drawer) return;
  _drawer.classList.remove('is-open');
  _backdrop.classList.remove('is-open');
  _drawer.setAttribute('aria-hidden', 'true');
  if (_toggleBtn) _toggleBtn.setAttribute('aria-expanded', 'false');
}

export function toggleDrawer() {
  if (!_drawer) return openDrawer();
  if (_drawer.classList.contains('is-open')) closeDrawer();
  else openDrawer();
}

// Mount a hamburger toggle in a host element (typically the app header,
// inserted as the first child).
export function mountDrawerToggle(host, label = 'Menu') {
  if (!host) return null;
  if (_toggleBtn && host.contains(_toggleBtn)) return _toggleBtn;
  _toggleBtn = document.createElement('button');
  _toggleBtn.type = 'button';
  _toggleBtn.className = 'side-drawer-toggle';
  _toggleBtn.title = label;
  _toggleBtn.setAttribute('aria-label', label);
  _toggleBtn.setAttribute('aria-expanded', 'false');
  _toggleBtn.innerHTML = icons.menu();
  _toggleBtn.addEventListener('click', toggleDrawer);
  host.insertBefore(_toggleBtn, host.firstChild);
  return _toggleBtn;
}

// Convenience: build a drawer content tree from a list of sections,
// each with a heading and an array of items {label, icon, href, onClick, active}.
export function buildDrawerSections(sections) {
  const root = document.createElement('div');
  for (const sec of sections) {
    if (sec.heading) {
      const h = document.createElement('h4');
      h.textContent = sec.heading;
      root.appendChild(h);
    }
    for (const item of (sec.items || [])) {
      let el;
      if (item.href) {
        el = document.createElement('a');
        el.href = item.href;
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'drawer-link';
      }
      if (item.active) el.classList.add('active');
      if (item.icon && icons[item.icon]) {
        const i = document.createElement('span');
        i.innerHTML = icons[item.icon]();
        el.appendChild(i);
      }
      const span = document.createElement('span');
      span.textContent = item.label;
      el.appendChild(span);
      if (item.onClick) {
        el.addEventListener('click', (e) => {
          // Allow default link nav unless onClick returns false explicitly.
          const r = item.onClick(e);
          if (r === false) e.preventDefault();
          if (item.closeOnClick !== false) closeDrawer();
        });
      } else {
        el.addEventListener('click', () => { if (item.closeOnClick !== false) closeDrawer(); });
      }
      root.appendChild(el);
    }
  }
  return root;
}
