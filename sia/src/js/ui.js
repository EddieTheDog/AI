/**
 * SIA - UI Helpers Module
 * Toast notifications, modal system, scroll utilities,
 * textarea auto-expand, and general DOM helpers.
 */

// ─── Toast Notifications ───────────────────────────────────────────────────

let _toastContainer = null;

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 * @param {number} duration - ms before auto-dismiss (0 = permanent)
 */
export function showToast(message, type = 'info', duration = 4000) {
  _ensureToastContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'polite');

  const icon = _toastIcon(type);
  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-message">${_escHtml(message)}</span>
    <button class="toast-close" aria-label="Dismiss">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  toast.querySelector('.toast-close').addEventListener('click', () => _dismissToast(toast));

  _toastContainer.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  if (duration > 0) {
    setTimeout(() => _dismissToast(toast), duration);
  }

  return toast;
}

function _dismissToast(toast) {
  toast.classList.remove('toast-visible');
  toast.classList.add('toast-hiding');
  toast.addEventListener('transitionend', () => toast.remove(), { once: true });
}

function _ensureToastContainer() {
  if (_toastContainer) return;
  _toastContainer = document.createElement('div');
  _toastContainer.id = 'toast-container';
  _toastContainer.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(_toastContainer);
}

function _toastIcon(type) {
  const icons = {
    info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };
  return icons[type] ?? icons.info;
}

// ─── Modal System ─────────────────────────────────────────────────────────

const _openModals = [];

/**
 * Create and open a modal dialog.
 * @param {object} options
 * @param {string} options.title
 * @param {string|HTMLElement} options.content
 * @param {Array<{label: string, action: function, primary?: boolean, danger?: boolean}>} options.actions
 * @returns {{ close: () => void, el: HTMLElement }}
 */
export function openModal({ title, content, actions = [] }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);

  const modal = document.createElement('div');
  modal.className = 'modal';

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.innerHTML = `
    <h2 class="modal-title">${_escHtml(title)}</h2>
    <button class="modal-close" aria-label="Close">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof content === 'string') {
    body.innerHTML = content;
  } else {
    body.appendChild(content);
  }

  modal.appendChild(header);
  modal.appendChild(body);

  if (actions.length > 0) {
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.className = 'btn' + (action.primary ? ' btn-primary' : action.danger ? ' btn-danger' : ' btn-secondary');
      btn.addEventListener('click', () => action.action(api));
      footer.appendChild(btn);
    }
    modal.appendChild(footer);
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  _openModals.push(overlay);

  // Animate in
  requestAnimationFrame(() => overlay.classList.add('modal-visible'));

  const close = () => {
    overlay.classList.remove('modal-visible');
    overlay.addEventListener('transitionend', () => {
      overlay.remove();
      const idx = _openModals.indexOf(overlay);
      if (idx !== -1) _openModals.splice(idx, 1);
    }, { once: true });
  };

  header.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
  });

  return { close, el: modal };
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────

/**
 * Promisified confirm dialog.
 * @param {string} message
 * @param {string} confirmLabel
 * @returns {Promise<boolean>}
 */
export function confirm(message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title: 'Confirm',
      content: `<p>${_escHtml(message)}</p>`,
      actions: [
        {
          label: 'Cancel',
          action: () => { close(); resolve(false); },
        },
        {
          label: confirmLabel,
          primary: !danger,
          danger,
          action: () => { close(); resolve(true); },
        },
      ],
    });
  });
}

// ─── Scroll ───────────────────────────────────────────────────────────────

let _userScrolled = false;
let _scrollContainer = null;

/**
 * Attach scroll tracking to the messages container.
 * Stops auto-scroll when user scrolls up manually.
 */
export function initScrollTracking(container) {
  _scrollContainer = container;
  container.addEventListener('scroll', () => {
    const threshold = 80;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    _userScrolled = !atBottom;
  });
}

/**
 * Scroll to bottom of container.
 * @param {HTMLElement} container
 * @param {'smooth'|'instant'} behavior
 * @param {boolean} force - ignore user scroll position
 */
export function scrollToBottom(container = _scrollContainer, behavior = 'smooth', force = false) {
  if (!container) return;
  if (_userScrolled && !force) return;
  container.scrollTo({ top: container.scrollHeight, behavior });
}

/**
 * Reset scroll tracking (call when loading new conversation).
 */
export function resetScrollTracking() {
  _userScrolled = false;
}

// ─── Auto-Expand Textarea ─────────────────────────────────────────────────

/**
 * Make a textarea auto-expand as content grows.
 * @param {HTMLTextAreaElement} textarea
 * @param {number} maxLines - max rows before scrolling
 */
export function initAutoExpand(textarea, maxLines = 8) {
  const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
  const maxHeight = lineHeight * maxLines;

  const resize = () => {
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  textarea.addEventListener('input', resize);
  textarea.addEventListener('change', resize);

  // Initial
  resize();

  return resize;
}

// ─── Copy to Clipboard ────────────────────────────────────────────────────

/**
 * Copy text to clipboard, show feedback on button.
 */
export async function copyToClipboard(text, btn = null) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.innerHTML;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
      }, 1500);
    }
    return true;
  } catch {
    showToast('Could not copy to clipboard.', 'error');
    return false;
  }
}

// ─── Relative Time ────────────────────────────────────────────────────────

const _rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * Format a timestamp as relative time ("2 minutes ago").
 */
export function relativeTime(dateStr) {
  const date = new Date(dateStr);
  const diffMs = date - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);

  if (Math.abs(diffSec) < 45) return 'just now';
  if (Math.abs(diffMin) < 60) return _rtf.format(diffMin, 'minute');
  if (Math.abs(diffHr) < 24) return _rtf.format(diffHr, 'hour');
  return _rtf.format(diffDay, 'day');
}

/**
 * Format timestamp as readable clock time (e.g. "3:42 PM").
 */
export function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ─── Dropdown ────────────────────────────────────────────────────────────

/**
 * Create and position a dropdown menu near a trigger element.
 * @param {HTMLElement} trigger
 * @param {Array<{label: string, action: function, danger?: boolean}>} items
 */
export function openDropdown(trigger, items) {
  // Close any existing
  document.querySelector('.dropdown-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';

  for (const item of items) {
    if (item === 'divider') {
      const div = document.createElement('hr');
      div.className = 'dropdown-divider';
      menu.appendChild(div);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'dropdown-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Position relative to trigger
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;

  // Flip if off-screen
  if (left + 160 > window.innerWidth) left = rect.right - 160;
  if (top + menuRect.height > window.innerHeight) top = rect.top - menuRect.height - 4;

  menu.style.top = `${top + window.scrollY}px`;
  menu.style.left = `${left}px`;

  // Close on outside click
  const close = (e) => {
    if (!menu.contains(e.target) && e.target !== trigger) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

// ─── Loading State ────────────────────────────────────────────────────────

/**
 * Show full-page loading overlay.
 * @returns {{ hide: () => void }}
 */
export function showPageLoader() {
  const el = document.createElement('div');
  el.className = 'page-loader';
  el.innerHTML = `
    <div class="page-loader-inner">
      <div class="loader-dots">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  return { hide: () => { el.classList.remove('visible'); el.addEventListener('transitionend', () => el.remove(), { once: true }); } };
}

// ─── DOM Helpers ──────────────────────────────────────────────────────────

export function qs(selector, parent = document) {
  return parent.querySelector(selector);
}

export function qsa(selector, parent = document) {
  return [...parent.querySelectorAll(selector)];
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function _escHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
