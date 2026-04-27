// Linear/Raycast-style command palette. Cmd/Ctrl+K opens; ? opens
// keyboard cheatsheet (a curated subset rendered as a list).
//
// Pages register additional sources via:
//   import { registerSource } from './command-palette.js';
//   registerSource(() => audioRows.map(a => ({
//     id: a.id, label: a.name, group: 'Audio',
//     onRun: () => { location.href = `/detail.html?id=${a.id}` }
//   })));
//
// A source is a function that returns an array of items (so it can be
// re-evaluated each open with the latest data).

import { icons } from './icons.js';

const _sources = [];
let _overlay = null;
let _input = null;
let _list = null;
let _selectedIndex = 0;
let _filteredItems = [];
let _isOpen = false;

const STATIC_ACTIONS = [
  { id: 'nav.audio',      label: 'Audio',           detail: 'Open audio table',     group: 'Navigate', icon: 'audio',    onRun: () => (location.href = '/index.html') },
  { id: 'nav.transcribe', label: 'Transcribe',      detail: 'Run new ASR job',       group: 'Navigate', icon: 'mic',      onRun: () => (location.href = '/transcribe.html') },
  { id: 'nav.dashboard',  label: 'Dashboard',       detail: 'Library overview',      group: 'Navigate', icon: 'sliders',  onRun: () => (location.href = '/dashboard.html') },
  { id: 'nav.admin',      label: 'Admin',           detail: 'Users, libraries',      group: 'Navigate', icon: 'shield',   onRun: () => (location.href = '/admin.html') },
  { id: 'nav.review',     label: 'Review export',   detail: 'Approved CSV export',   group: 'Navigate', icon: 'fileText', onRun: () => (location.href = '/review-export.html') },

  { id: 'act.export-csv', label: 'Export approved as CSV',          group: 'Actions', icon: 'download', onRun: () => document.getElementById('btn-export-csv')?.click() },
  { id: 'act.search',     label: 'Search transcripts',              group: 'Actions', icon: 'search',   onRun: () => document.getElementById('btn-search-transcripts')?.click() },
  { id: 'act.settings',   label: 'ASR settings',                    group: 'Actions', icon: 'settings', onRun: () => document.getElementById('btn-asr-settings')?.click() },
  { id: 'act.signout',    label: 'Sign out',                        group: 'Actions', icon: 'logOut',   onRun: () => document.getElementById('btn-logout')?.click() },

  { id: 'help.shortcuts', label: 'Keyboard shortcuts',              group: 'Help',    icon: 'keyboard', onRun: () => openCheatsheet() },
];

export function registerSource(fn) {
  if (typeof fn !== 'function') return;
  _sources.push(fn);
}

function ensureOverlay() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'cmdk-overlay';
  _overlay.innerHTML = `
    <div class="cmdk-modal" role="dialog" aria-label="Command palette">
      <div class="cmdk-input-wrap">
        <span class="cmdk-leading">${icons.search()}</span>
        <input class="cmdk-input" type="text" placeholder="Type a command, audio name, or page…" autocomplete="off" spellcheck="false" />
        <kbd class="cmdk-esc">Esc</kbd>
      </div>
      <div class="cmdk-list" role="listbox"></div>
      <div class="cmdk-footer">
        <span><kbd>↑↓</kbd> navigate</span>
        <span><kbd>↵</kbd> select</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>`;
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) close();
  });
  document.body.appendChild(_overlay);
  _input = _overlay.querySelector('.cmdk-input');
  _list = _overlay.querySelector('.cmdk-list');

  _input.addEventListener('input', render);
  _input.addEventListener('keydown', onKey);
}

function gatherAll() {
  let items = [...STATIC_ACTIONS];
  for (const src of _sources) {
    try {
      const got = src() || [];
      for (const it of got) items.push(it);
    } catch (_) {}
  }
  return items;
}

function fuzzyScore(needle, hay) {
  if (!needle) return 0;
  const n = needle.toLowerCase(), h = hay.toLowerCase();
  if (h.includes(n)) return n.length * 10 + (h.startsWith(n) ? 50 : 0) - h.indexOf(n);
  // Subsequence match
  let i = 0, j = 0, score = 0, last = -1;
  while (i < n.length && j < h.length) {
    if (n[i] === h[j]) {
      score += 1;
      if (last >= 0 && j === last + 1) score += 2; // contiguous bonus
      last = j;
      i++;
    }
    j++;
  }
  return i === n.length ? score : -1;
}

function render() {
  if (!_overlay) return;
  const q = (_input.value || '').trim();
  const all = gatherAll();
  let filtered;
  if (!q) {
    filtered = all;
  } else {
    filtered = all
      .map(it => ({ it, s: fuzzyScore(q, `${it.label} ${it.detail || ''} ${it.group || ''}`) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(x => x.it);
  }
  _filteredItems = filtered.slice(0, 80);
  _selectedIndex = 0;

  _list.innerHTML = '';
  if (_filteredItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cmdk-empty';
    empty.textContent = q ? `No results for "${q}"` : 'No commands available';
    _list.appendChild(empty);
    return;
  }

  let lastGroup = null;
  _filteredItems.forEach((item, idx) => {
    const group = item.group || '';
    if (group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'cmdk-group';
      h.textContent = group;
      _list.appendChild(h);
      lastGroup = group;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmdk-row';
    row.dataset.idx = idx;
    if (idx === _selectedIndex) row.classList.add('is-selected');

    const ic = document.createElement('span');
    ic.className = 'cmdk-row__icon';
    if (item.icon && icons[item.icon]) ic.innerHTML = icons[item.icon]();
    row.appendChild(ic);

    const lab = document.createElement('span');
    lab.className = 'cmdk-row__label';
    lab.textContent = item.label;
    row.appendChild(lab);

    if (item.detail) {
      const d = document.createElement('span');
      d.className = 'cmdk-row__detail';
      d.textContent = item.detail;
      row.appendChild(d);
    }

    if (item.shortcut) {
      const s = document.createElement('span');
      s.className = 'cmdk-row__shortcut';
      s.textContent = item.shortcut;
      row.appendChild(s);
    }

    row.addEventListener('click', () => runItem(item));
    row.addEventListener('mousemove', () => {
      _selectedIndex = idx;
      updateSelection();
    });
    _list.appendChild(row);
  });
}

function updateSelection() {
  const rows = _list.querySelectorAll('.cmdk-row');
  rows.forEach((r) => r.classList.toggle('is-selected', Number(r.dataset.idx) === _selectedIndex));
  const active = rows[_selectedIndex];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _selectedIndex = Math.min(_selectedIndex + 1, _filteredItems.length - 1);
    updateSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _selectedIndex = Math.max(_selectedIndex - 1, 0);
    updateSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const item = _filteredItems[_selectedIndex];
    if (item) runItem(item);
  }
}

function runItem(item) {
  close();
  try { item.onRun && item.onRun(); } catch (e) { console.warn('cmdk runItem failed', e); }
}

export function open() {
  ensureOverlay();
  _overlay.classList.add('is-open');
  _isOpen = true;
  _input.value = '';
  render();
  setTimeout(() => _input.focus(), 0);
}

export function close() {
  if (!_overlay) return;
  _overlay.classList.remove('is-open');
  _isOpen = false;
}

// Global keyboard shortcuts
function bindGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const isTyping =
      target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    // Cmd/Ctrl+K → palette
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      _isOpen ? close() : open();
      return;
    }
    // ? → cheatsheet (when not typing)
    if (!isTyping && e.key === '?' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      openCheatsheet();
    }
    // g then a/t/d/r → quick nav (Linear-style)
    if (!isTyping && e.key === 'g') {
      _gMode = true;
      setTimeout(() => (_gMode = false), 1200);
      return;
    }
    if (_gMode && !isTyping) {
      const map = {
        a: '/index.html', t: '/transcribe.html', d: '/dashboard.html',
        r: '/review-export.html', m: '/admin.html',
      };
      const dest = map[e.key.toLowerCase()];
      if (dest) {
        e.preventDefault();
        location.href = dest;
        _gMode = false;
      }
    }
  });
}

let _gMode = false;

// ────────── Cheatsheet (the ? help modal) ──────────

const CHEATS = [
  { keys: ['⌘', 'K'],            label: 'Open command palette' },
  { keys: ['?'],                 label: 'Show this cheatsheet' },
  { keys: ['G', 'A'],            label: 'Go to Audio table' },
  { keys: ['G', 'T'],            label: 'Go to Transcribe' },
  { keys: ['G', 'D'],            label: 'Go to Dashboard' },
  { keys: ['G', 'R'],            label: 'Go to Review export' },
  { keys: ['G', 'M'],            label: 'Go to Admin' },
  { keys: ['Esc'],               label: 'Close any overlay / modal' },
  { keys: ['↑', '↓'],            label: 'Navigate palette' },
  { keys: ['↵'],                 label: 'Select / confirm' },
  { keys: ['⌘', 'S'],            label: 'Force-save (detail editor)' },
  { keys: ['Space'],             label: 'Play / pause audio (detail page)' },
];

let _sheet = null;
function ensureCheatsheet() {
  if (_sheet) return;
  _sheet = document.createElement('div');
  _sheet.className = 'cheatsheet-overlay';
  const rows = CHEATS.map(c =>
    `<li><span class="cheat__label">${c.label}</span><span class="cheat__keys">${
      c.keys.map(k => `<kbd>${k}</kbd>`).join('<span class="cheat__plus">+</span>')
    }</span></li>`
  ).join('');
  _sheet.innerHTML = `
    <div class="cheatsheet-modal" role="dialog" aria-label="Keyboard shortcuts">
      <div class="cheatsheet-head">
        <h3>Keyboard shortcuts</h3>
        <button class="cheatsheet-close" aria-label="Close">${icons.x()}</button>
      </div>
      <ul class="cheatsheet-list">${rows}</ul>
    </div>`;
  _sheet.addEventListener('click', (e) => { if (e.target === _sheet) closeCheatsheet(); });
  _sheet.querySelector('.cheatsheet-close').addEventListener('click', closeCheatsheet);
  document.body.appendChild(_sheet);
}

export function openCheatsheet() {
  ensureCheatsheet();
  _sheet.classList.add('is-open');
  document.addEventListener('keydown', escClose, { once: true });
}
export function closeCheatsheet() {
  if (!_sheet) return;
  _sheet.classList.remove('is-open');
}
function escClose(e) {
  if (e.key === 'Escape') closeCheatsheet();
  else document.addEventListener('keydown', escClose, { once: true });
}

// Auto-bind on import
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindGlobalKeys);
  } else {
    bindGlobalKeys();
  }
}

if (typeof window !== 'undefined') {
  window.__jemCmdK = { open, close, openCheatsheet, registerSource };
}
