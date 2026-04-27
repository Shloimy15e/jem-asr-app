// Layout shell helpers:
//   • Persistent left RAIL on desktop (>= 1024px), with brand + nav + user
//   • Slide-in DRAWER on mobile/tablet (< 1024px), opened via a hamburger
//   • Both share the same content tree from buildDrawerSections()
//
// Pages call:
//   import { mountDrawerToggle, setDrawerContent } from './layout-shell.js';
//   mountDrawerToggle(headerEl, 'Open menu');
//   setDrawerContent(buildDrawerSections([...]));

import { icons } from './icons.js';

let _drawer = null;
let _backdrop = null;
let _toggleBtn = null;
let _contentSlot = null;
let _rail = null;
let _railContent = null;

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

function ensureRail() {
  if (_rail) return;
  _rail = document.createElement('aside');
  _rail.className = 'app-rail';
  _railContent = document.createElement('div');
  _railContent.style.cssText = 'display:flex;flex-direction:column;height:100%;gap:0;';
  _rail.appendChild(_railContent);
  // Insert as the first body child so the CSS grid puts it in `rail` area
  document.body.insertBefore(_rail, document.body.firstChild);
}

function buildBrandHeader() {
  const wrap = document.createElement('a');
  wrap.className = 'app-rail__brand';
  wrap.href = '/';
  wrap.style.textDecoration = 'none';
  wrap.style.color = 'inherit';
  const mark = document.createElement('span');
  mark.className = 'app-rail__brand-mark';
  mark.innerHTML = `<svg viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'>
    <rect x='3' y='10' width='2.4' height='4' rx='1.2'/>
    <rect x='7' y='7'  width='2.4' height='10' rx='1.2'/>
    <rect x='11' y='4' width='2.4' height='16' rx='1.2'/>
    <rect x='15' y='7' width='2.4' height='10' rx='1.2'/>
    <rect x='19' y='10' width='2.4' height='4' rx='1.2'/>
  </svg>`;
  const text = document.createElement('span');
  text.textContent = 'JEM ASR';
  wrap.append(mark, text);
  return wrap;
}

function getUserDisplay() {
  // Read from auth.js getCurrentUser() (synchronously available after
  // checkAuth resolves). Fall back to a [data-user-email] DOM hint.
  let email = null;
  try {
    // Lazy require to avoid a circular import at module-load time.
    const auth = window.__jemAuthMod || null;
    if (auth && typeof auth.getCurrentUser === 'function') {
      const cu = auth.getCurrentUser();
      if (cu && typeof cu === 'string' && cu !== 'user') email = cu;
    }
  } catch (_) {}
  if (!email) {
    const m = document.querySelector('[data-user-email]');
    if (m) email = m.getAttribute('data-user-email');
  }
  if (!email) email = '';
  const initials = email
    ? email.replace(/@.*/, '').split(/[._-]/).filter(Boolean)
        .slice(0, 2).map(s => s[0].toUpperCase()).join('') || email[0].toUpperCase()
    : 'JE';
  return { email, initials };
}

function buildUserCard() {
  const card = document.createElement('div');
  card.className = 'app-rail__user';
  const { email, initials } = getUserDisplay();
  const av = document.createElement('div');
  av.className = 'app-rail__avatar';
  av.textContent = initials;
  const meta = document.createElement('div');
  meta.className = 'app-rail__user-meta';
  const name = document.createElement('div');
  name.className = 'app-rail__user-name';
  name.textContent = email || 'Signed in';
  const role = document.createElement('div');
  role.className = 'app-rail__user-role';
  role.textContent = 'Workbench user';
  meta.append(name, role);
  card.append(av, meta);
  return card;
}

function renderRailFromSections(sections) {
  ensureRail();
  _railContent.innerHTML = '';
  _railContent.appendChild(buildBrandHeader());
  for (const sec of sections) {
    const block = document.createElement('div');
    block.className = 'app-rail__section';
    if (sec.heading) {
      const h = document.createElement('div');
      h.className = 'app-rail__heading';
      h.textContent = sec.heading;
      block.appendChild(h);
    }
    for (const item of (sec.items || [])) {
      let el;
      if (item.href) {
        el = document.createElement('a');
        el.href = item.href;
      } else {
        el = document.createElement('button');
        el.type = 'button';
      }
      el.className = 'app-rail__link';
      if (item.active) el.classList.add('is-active');
      if (item.title) el.title = item.title;
      if (item.icon && icons[item.icon]) {
        const i = document.createElement('span');
        i.style.display = 'inline-flex';
        i.innerHTML = icons[item.icon]();
        el.appendChild(i);
      }
      const txt = document.createElement('span');
      txt.className = 'app-rail__link-text';
      txt.textContent = item.label;
      el.appendChild(txt);
      if (item.onClick) {
        el.addEventListener('click', (e) => {
          const r = item.onClick(e);
          if (r === false) e.preventDefault();
        });
      }
      block.appendChild(el);
    }
    _railContent.appendChild(block);
  }
  const spacer = document.createElement('div');
  spacer.className = 'app-rail__spacer';
  _railContent.appendChild(spacer);
  _railContent.appendChild(buildUserCard());
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

// New: set the same content tree on BOTH the rail (desktop) and drawer
// (mobile). Pages should prefer this over setDrawerContent.
export function setShellSections(sections) {
  // Drawer
  setDrawerContent(buildDrawerSections(sections));
  // Rail (desktop)
  renderRailFromSections(sections);
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
