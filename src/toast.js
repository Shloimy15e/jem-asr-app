// Tiny toast notification system. Usage:
//   import { toast } from './toast.js';
//   toast.success('Saved', { duration: 2500 });
//   toast.error('Failed to save: ' + err.message);
//   toast.info('Vertex prompt updated');
//   toast.show({ title: 'Approved', detail: 'tv_abc123', variant: 'success' });
//
// Renders into a single, lazy-mounted container in the top-right.

import { icons } from './icons.js';

let _container = null;
const ICON_BY = {
  success: icons.check,
  error: icons.x,
  warning: icons.alertTriangle || icons.alertCircle,
  info: icons.info,
};

function ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.className = 'toast-stack';
  _container.setAttribute('role', 'status');
  _container.setAttribute('aria-live', 'polite');
  _container.setAttribute('aria-atomic', 'false');
  document.body.appendChild(_container);
  return _container;
}

export function show(opts) {
  const {
    title = '',
    detail = '',
    variant = 'info',
    duration = 3200,
    action = null, // { label, onClick }
  } = opts || {};

  ensureContainer();
  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;
  el.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  // Icon
  const ic = document.createElement('span');
  ic.className = 'toast__icon';
  const drawIcon = ICON_BY[variant] || icons.info;
  if (drawIcon) ic.innerHTML = drawIcon();
  el.appendChild(ic);

  // Body
  const body = document.createElement('div');
  body.className = 'toast__body';
  if (title) {
    const t = document.createElement('div');
    t.className = 'toast__title';
    t.textContent = title;
    body.appendChild(t);
  }
  if (detail) {
    const d = document.createElement('div');
    d.className = 'toast__detail';
    d.textContent = detail;
    body.appendChild(d);
  }
  el.appendChild(body);

  // Action button
  if (action && action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      try { action.onClick && action.onClick(); } catch (_) {}
      dismiss(el);
    });
    el.appendChild(btn);
  }

  // Close
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = icons.x ? icons.x() : '×';
  close.addEventListener('click', () => dismiss(el));
  el.appendChild(close);

  _container.appendChild(el);

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => dismiss(el), duration);
  }
  return el;
}

function dismiss(el) {
  if (!el || !el.isConnected) return;
  el.classList.add('toast--leaving');
  setTimeout(() => el.remove(), 220);
}

export const toast = {
  show,
  success: (title, opts) => show({ title, variant: 'success', ...opts }),
  error:   (title, opts) => show({ title, variant: 'error', duration: 5000, ...opts }),
  warning: (title, opts) => show({ title, variant: 'warning', ...opts }),
  info:    (title, opts) => show({ title, variant: 'info', ...opts }),
};

if (typeof window !== 'undefined') window.__jemToast = toast;
