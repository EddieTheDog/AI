/**
 * SIA - Renderer Module
 * Renders chat messages with markdown, code blocks, syntax highlighting,
 * streaming updates, typing indicators, and reaction buttons.
 *
 * Uses marked.js (CDN) for markdown and highlight.js (CDN) for code.
 * Both must be loaded in the HTML before this module runs.
 */

import { reactions } from './api.js';
import { copyToClipboard, formatTime, relativeTime, showToast } from './ui.js';

// ─── Markdown Config ──────────────────────────────────────────────────────

function configureMarked() {
  if (!window.marked) return;

  const renderer = new window.marked.Renderer();

  // Code blocks with copy button and language label
  renderer.code = (code, language) => {
    const lang = (language || 'text').toLowerCase();
    const highlighted = _highlight(code, lang);
    const escapedCode = _escHtml(code);
    return `
      <div class="code-block" data-lang="${_escHtml(lang)}">
        <div class="code-header">
          <span class="code-lang">${_escHtml(lang)}</span>
          <button class="code-copy-btn" data-code="${escapedCode}" aria-label="Copy code">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy
          </button>
        </div>
        <pre class="code-pre"><code class="hljs language-${_escHtml(lang)}">${highlighted}</code></pre>
      </div>
    `;
  };

  // Inline code
  renderer.codespan = (code) =>
    `<code class="inline-code">${_escHtml(code)}</code>`;

  // Blockquotes
  renderer.blockquote = (quote) =>
    `<blockquote class="message-blockquote">${quote}</blockquote>`;

  // Tables
  renderer.table = (header, body) =>
    `<div class="table-wrapper"><table class="message-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;

  // Links — open in new tab, no referrer
  renderer.link = (href, title, text) =>
    `<a href="${_escHtml(href)}" target="_blank" rel="noopener noreferrer" title="${_escHtml(title ?? '')}">${text}</a>`;

  window.marked.setOptions({
    renderer,
    gfm: true,
    breaks: true,
    pedantic: false,
  });
}

// ─── Highlight ────────────────────────────────────────────────────────────

function _highlight(code, lang) {
  if (!window.hljs) return _escHtml(code);
  try {
    if (lang && window.hljs.getLanguage(lang)) {
      return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return window.hljs.highlightAuto(code).value;
  } catch {
    return _escHtml(code);
  }
}

// ─── Citation Parsing ─────────────────────────────────────────────────────

/**
 * Convert [1], [2] citation markers to interactive chips.
 * Citations data should be on the message object.
 */
function _renderCitations(html, citations = []) {
  if (!citations.length) return html;

  return html.replace(/\[(\d+)\]/g, (match, num) => {
    const idx = parseInt(num) - 1;
    const cite = citations[idx];
    if (!cite) return match;

    return `<button class="citation-chip" data-citation-idx="${idx}" aria-label="Source ${num}">${num}</button>`;
  });
}

// ─── Render Message ───────────────────────────────────────────────────────

/**
 * Render a full message element.
 * @param {object} msg - message object from API
 * @returns {HTMLElement}
 */
export function renderMessage(msg) {
  const wrap = document.createElement('div');
  wrap.className = `message message-${msg.role}`;
  wrap.dataset.messageId = msg.id;
  if (msg._optimistic) wrap.classList.add('message-optimistic');
  if (msg.status === 'pending') wrap.classList.add('message-pending');

  const inner = document.createElement('div');
  inner.className = 'message-inner';

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.innerHTML = msg.role === 'user' ? _userAvatarSvg() : _assistantAvatarSvg();

  // Body
  const body = document.createElement('div');
  body.className = 'message-body';

  // Content
  const content = document.createElement('div');
  content.className = 'message-content';

  if (msg.role === 'assistant') {
    content.innerHTML = _renderAssistantContent(msg);
  } else {
    content.innerHTML = _renderUserContent(msg);
  }

  body.appendChild(content);

  // Image attachment
  if (msg.image_meta_id && msg.image_url) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'message-image-wrap';
    const img = document.createElement('img');
    img.src = msg.image_url;
    img.alt = 'Attached image';
    img.className = 'message-image';
    img.loading = 'lazy';
    imgWrap.appendChild(img);
    body.insertBefore(imgWrap, content);
  }

  // Meta row (time + actions)
  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const timestamp = document.createElement('span');
  timestamp.className = 'message-timestamp';
  timestamp.textContent = formatTime(msg.created_at);
  timestamp.title = new Date(msg.created_at).toLocaleString();
  meta.appendChild(timestamp);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  if (msg.role === 'assistant' && msg.status !== 'pending') {
    // Reaction buttons
    actions.appendChild(_buildReactionBtn(msg, 'up'));
    actions.appendChild(_buildReactionBtn(msg, 'down'));
    // Copy button
    actions.appendChild(_buildCopyBtn(msg.content));
  }

  if (msg.role === 'user') {
    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn edit-btn';
    editBtn.setAttribute('aria-label', 'Edit message');
    editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    editBtn.addEventListener('click', () => _startEditMessage(msg, wrap));
    actions.appendChild(editBtn);
  }

  meta.appendChild(actions);
  body.appendChild(meta);

  inner.appendChild(avatar);
  inner.appendChild(body);
  wrap.appendChild(inner);

  // Wire up code copy buttons
  _bindCodeCopyButtons(wrap);

  // Wire up citation chips
  if (msg.citations?.length) {
    _bindCitationChips(wrap, msg.citations);
  }

  return wrap;
}

// ─── Append / Update / Finalize ───────────────────────────────────────────

export function appendMessage(msg, container) {
  if (!container) return;
  const el = renderMessage(msg);
  container.appendChild(el);
}

/**
 * Update a streaming assistant message in place (partial content).
 */
export function updateStreamingMessage(messageId, partialContent, container) {
  const el = container?.querySelector(`[data-message-id="${messageId}"] .message-content`);
  if (!el) return;

  el.innerHTML = _renderAssistantContent({ content: partialContent, status: 'streaming' });
  _bindCodeCopyButtons(el.closest('[data-message-id]'));
}

/**
 * Finalize an assistant message after streaming completes.
 */
export function finalizeMessage(messageId, content, status, container) {
  const wrap = container?.querySelector(`[data-message-id="${messageId}"]`);
  if (!wrap) return;

  wrap.classList.remove('message-pending');
  if (status === 'cancelled') wrap.classList.add('message-cancelled');

  const contentEl = wrap.querySelector('.message-content');
  if (contentEl && content) {
    contentEl.innerHTML = _renderAssistantContent({ content, status });
  }

  // Add reactions + copy after finalize
  const actions = wrap.querySelector('.message-actions');
  if (actions && status === 'done') {
    if (!actions.querySelector('.reaction-btn')) {
      const msg = { id: messageId, content };
      actions.prepend(_buildCopyBtn(content));
      actions.prepend(_buildReactionBtn(msg, 'down'));
      actions.prepend(_buildReactionBtn(msg, 'up'));
    }
  }

  _bindCodeCopyButtons(wrap);
}

// ─── Typing Indicator ─────────────────────────────────────────────────────

export function showTypingIndicator(container) {
  if (!container || container.querySelector('.typing-indicator')) return;

  const el = document.createElement('div');
  el.className = 'message message-assistant typing-indicator-wrap';
  el.innerHTML = `
    <div class="message-inner">
      <div class="message-avatar">${_assistantAvatarSvg()}</div>
      <div class="message-body">
        <div class="message-content">
          <div class="typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(el);
}

export function hideTypingIndicator(container) {
  container?.querySelector('.typing-indicator-wrap')?.remove();
}

// ─── Edit Message ─────────────────────────────────────────────────────────

function _startEditMessage(msg, wrap) {
  const contentEl = wrap.querySelector('.message-content');
  if (!contentEl) return;

  const original = msg.content;

  const textarea = document.createElement('textarea');
  textarea.className = 'edit-textarea';
  textarea.value = original;

  const editActions = document.createElement('div');
  editActions.className = 'edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary btn-sm';
  cancelBtn.textContent = 'Cancel';

  editActions.appendChild(cancelBtn);
  editActions.appendChild(saveBtn);

  contentEl.innerHTML = '';
  contentEl.appendChild(textarea);
  contentEl.appendChild(editActions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  cancelBtn.addEventListener('click', () => {
    contentEl.innerHTML = _renderUserContent(msg);
  });

  saveBtn.addEventListener('click', async () => {
    const newContent = textarea.value.trim();
    if (!newContent || newContent === original) {
      contentEl.innerHTML = _renderUserContent(msg);
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      // Import lazily to avoid circular dep
      const { editMessage } = await import('./chat.js');
      const updated = await editMessage(msg.id, newContent);
      msg.content = updated.content;
      contentEl.innerHTML = _renderUserContent(msg);
    } catch {
      showToast('Could not save edit.', 'error');
      contentEl.innerHTML = _renderUserContent(msg);
    }
  });
}

// ─── Reaction Buttons ─────────────────────────────────────────────────────

function _buildReactionBtn(msg, type) {
  const btn = document.createElement('button');
  btn.className = `action-btn reaction-btn reaction-${type}`;
  btn.dataset.type = type;
  btn.setAttribute('aria-label', type === 'up' ? 'Helpful' : 'Not helpful');
  btn.setAttribute('aria-pressed', msg.user_reaction === type ? 'true' : 'false');

  btn.innerHTML = type === 'up'
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="${msg.user_reaction === 'up' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="${msg.user_reaction === 'down' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>`;

  btn.addEventListener('click', async () => {
    const current = btn.getAttribute('aria-pressed') === 'true';
    try {
      if (current) {
        await reactions.remove(msg.id);
        btn.setAttribute('aria-pressed', 'false');
        msg.user_reaction = null;
        _updateReactionFill(btn, type, false);
      } else {
        // Remove opposite reaction first
        const opposite = btn.closest('.message-actions')?.querySelector(`.reaction-${type === 'up' ? 'down' : 'up'}`);
        if (opposite?.getAttribute('aria-pressed') === 'true') {
          opposite.setAttribute('aria-pressed', 'false');
          _updateReactionFill(opposite, type === 'up' ? 'down' : 'up', false);
        }
        await reactions.add(msg.id, type);
        btn.setAttribute('aria-pressed', 'true');
        msg.user_reaction = type;
        _updateReactionFill(btn, type, true);
      }
    } catch {
      showToast('Could not save reaction.', 'error');
    }
  });

  return btn;
}

function _updateReactionFill(btn, type, filled) {
  const path = btn.querySelector('path');
  if (path) path.setAttribute('fill', filled ? 'currentColor' : 'none');
}

// ─── Copy Button ──────────────────────────────────────────────────────────

function _buildCopyBtn(text) {
  const btn = document.createElement('button');
  btn.className = 'action-btn copy-btn';
  btn.setAttribute('aria-label', 'Copy response');
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  btn.addEventListener('click', () => copyToClipboard(text, btn));
  return btn;
}

// ─── Code Copy Binding ────────────────────────────────────────────────────

function _bindCodeCopyButtons(container) {
  container?.querySelectorAll('.code-copy-btn').forEach(btn => {
    // Avoid double-binding
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', () => {
      const code = btn.dataset.code ?? '';
      copyToClipboard(code, btn);
    });
  });
}

// ─── Citation Chips ───────────────────────────────────────────────────────

function _bindCitationChips(container, citations) {
  container?.querySelectorAll('.citation-chip').forEach(chip => {
    const idx = parseInt(chip.dataset.citationIdx ?? '0');
    const cite = citations[idx];
    if (!cite) return;

    chip.addEventListener('mouseenter', (e) => _showCitationPreview(chip, cite));
    chip.addEventListener('mouseleave', () => _hideCitationPreview());
    chip.addEventListener('click', () => _showCitationCard(cite));
  });
}

let _citationPreview = null;

function _showCitationPreview(chip, cite) {
  _hideCitationPreview();
  _citationPreview = document.createElement('div');
  _citationPreview.className = 'citation-preview';
  _citationPreview.innerHTML = `
    <div class="citation-source">${_escHtml(cite.domain ?? cite.url ?? '')}</div>
    <div class="citation-title">${_escHtml(cite.title ?? '')}</div>
    ${cite.excerpt ? `<div class="citation-excerpt">${_escHtml(cite.excerpt)}</div>` : ''}
  `;
  document.body.appendChild(_citationPreview);

  const rect = chip.getBoundingClientRect();
  _citationPreview.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  _citationPreview.style.left = `${rect.left}px`;
  requestAnimationFrame(() => _citationPreview?.classList.add('visible'));
}

function _hideCitationPreview() {
  _citationPreview?.remove();
  _citationPreview = null;
}

function _showCitationCard(cite) {
  // Import lazily
  import('./ui.js').then(({ openModal }) => {
    openModal({
      title: cite.title ?? 'Source',
      content: `
        <p class="cite-url"><a href="${_escHtml(cite.url)}" target="_blank" rel="noopener noreferrer">${_escHtml(cite.url)}</a></p>
        ${cite.excerpt ? `<p class="cite-excerpt">${_escHtml(cite.excerpt)}</p>` : ''}
      `,
      actions: [
        {
          label: 'Open Source',
          primary: true,
          action: () => window.open(cite.url, '_blank', 'noopener,noreferrer'),
        },
      ],
    });
  });
}

// ─── Content Renderers ────────────────────────────────────────────────────

function _renderAssistantContent(msg) {
  if (!msg.content) {
    return msg.status === 'pending' || msg.status === 'streaming'
      ? '<span class="cursor-blink"></span>'
      : '';
  }

  let html = window.marked
    ? window.marked.parse(msg.content)
    : _escHtml(msg.content).replace(/\n/g, '<br>');

  if (msg.citations?.length) {
    html = _renderCitations(html, msg.citations);
  }

  return html + (msg.status === 'streaming' ? '<span class="cursor-blink"></span>' : '');
}

function _renderUserContent(msg) {
  // User messages: escape HTML, preserve line breaks, basic formatting
  const escaped = _escHtml(msg.content ?? '');
  return escaped.replace(/\n/g, '<br>');
}

// ─── Avatars ──────────────────────────────────────────────────────────────

function _assistantAvatarSvg() {
  return `
    <svg class="avatar-sia" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="var(--accent)"/>
      <path d="M10 20 Q16 10 22 20" stroke="white" stroke-width="2" fill="none" stroke-linecap="round"/>
      <circle cx="16" cy="14" r="2.5" fill="white"/>
    </svg>
  `;
}

function _userAvatarSvg() {
  return `
    <svg class="avatar-user" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="var(--surface-2)"/>
      <circle cx="16" cy="13" r="5" fill="var(--text-muted)"/>
      <path d="M6 26c0-5 4.5-8 10-8s10 3 10 8" fill="var(--text-muted)"/>
    </svg>
  `;
}

// ─── Init ─────────────────────────────────────────────────────────────────

export function initRenderer() {
  configureMarked();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _escHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
