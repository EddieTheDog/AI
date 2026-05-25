/**
 * SIA - Chat Module
 * Manages conversation state, message sending, streaming,
 * and real-time polling for admin responses.
 */

import { conversations as api, streamResponse, presence } from './api.js';
import { currentUser } from './auth.js';
import { renderMessage, appendMessage, updateStreamingMessage, finalizeMessage, showTypingIndicator, hideTypingIndicator } from './renderer.js';
import { showToast, scrollToBottom } from './ui.js';

// ─── State ─────────────────────────────────────────────────────────────────

let _activeConversationId = null;
let _messages = [];
let _pendingMessageId = null;     // ID of the assistant placeholder awaiting response
let _streamAbort = null;          // AbortController handle for active stream
let _pollInterval = null;         // polling fallback timer
let _presencePingInterval = null;
let _typingDebounce = null;
let _isTyping = false;
let _conversationList = [];

const POLL_INTERVAL_MS = 1500;
const PRESENCE_PING_MS = 15000;
const TYPING_DEBOUNCE_MS = 1500;

// ─── Init / Load ───────────────────────────────────────────────────────────

/**
 * Load a conversation by ID, render all messages, start presence.
 * @param {string} conversationId
 */
export async function loadConversation(conversationId) {
  _reset();
  _activeConversationId = conversationId;

  try {
    const [convData, msgData] = await Promise.all([
      api.get(conversationId),
      api.messages(conversationId),
    ]);

    _messages = msgData.messages ?? [];

    // Render messages
    const container = document.getElementById('messages-container');
    if (container) {
      container.innerHTML = '';
      for (const msg of _messages) {
        appendMessage(msg, container);
      }
      scrollToBottom(container, 'instant');
    }

    // Update sidebar active state
    _highlightSidebarItem(conversationId);

    // Update page title
    document.title = `${convData.conversation?.title ?? 'Chat'} — SIA`;

    // Check if there's a pending message awaiting a response
    const pending = _messages.find(m => m.role === 'assistant' && m.status === 'pending');
    if (pending) {
      _pendingMessageId = pending.id;
      _startStream(conversationId, pending.id);
    }

    // Start presence
    _startPresence(conversationId);

  } catch (err) {
    showToast('Failed to load conversation.', 'error');
    console.error('[chat] loadConversation error', err);
  }
}

/**
 * Load the sidebar conversation list.
 */
export async function loadConversationList() {
  try {
    const data = await api.list();
    _conversationList = data.conversations ?? [];
    _renderSidebar(_conversationList);
  } catch (err) {
    console.error('[chat] loadConversationList error', err);
  }
}

// ─── Send Message ──────────────────────────────────────────────────────────

/**
 * Send a new user message.
 * Locks the input until a response arrives or is cancelled.
 * @param {string} content - plain text content
 * @param {string|null} imageMetaId - optional uploaded image ID
 */
export async function sendMessage(content, imageMetaId = null) {
  if (!_activeConversationId) {
    // Create conversation first
    try {
      const data = await api.create();
      _activeConversationId = data.conversation.id;
      history.pushState({}, '', `/c/${_activeConversationId}`);
      await loadConversationList();
    } catch (err) {
      showToast('Could not start conversation.', 'error');
      return;
    }
  }

  if (_pendingMessageId) {
    showToast('Please wait for the current response.', 'info');
    return;
  }

  const trimmed = content.trim();
  if (!trimmed && !imageMetaId) return;

  // Lock input
  _setInputLocked(true);

  // Optimistically render user message
  const optimisticUser = _buildOptimisticMessage('user', trimmed, imageMetaId);
  _messages.push(optimisticUser);
  const container = document.getElementById('messages-container');
  appendMessage(optimisticUser, container);

  // Show typing indicator immediately
  showTypingIndicator(container);
  scrollToBottom(container);

  try {
    const data = await api.sendMessage(_activeConversationId, trimmed, imageMetaId);
    const { user_message, assistant_message } = data;

    // Replace optimistic with confirmed user message
    _replaceOptimisticMessage(optimisticUser.id, user_message, container);
    _messages.push(user_message);

    // Add assistant placeholder
    _pendingMessageId = assistant_message.id;
    _messages.push(assistant_message);

    // Swap typing indicator for placeholder
    hideTypingIndicator(container);
    appendMessage(assistant_message, container);
    scrollToBottom(container);

    // Begin streaming
    _startStream(_activeConversationId, assistant_message.id);

    // Auto-generate title if this is the first message
    if (_messages.filter(m => m.role === 'user').length === 1) {
      _requestTitleGeneration(_activeConversationId, trimmed);
    }

  } catch (err) {
    hideTypingIndicator(container);
    _removeOptimisticMessage(optimisticUser.id, container);
    _messages = _messages.filter(m => m.id !== optimisticUser.id);
    _setInputLocked(false);
    showToast(err.message ?? 'Failed to send message.', 'error');
  }
}

/**
 * Cancel a pending assistant response.
 */
export async function cancelPending() {
  if (!_pendingMessageId) return;

  _streamAbort?.abort();
  _clearPoll();

  try {
    await api.cancelPending(_activeConversationId, _pendingMessageId);
  } catch (_) {}

  const container = document.getElementById('messages-container');
  finalizeMessage(_pendingMessageId, '', 'cancelled', container);

  _pendingMessageId = null;
  _setInputLocked(false);
}

// ─── Edit Message ──────────────────────────────────────────────────────────

export async function editMessage(messageId, newContent) {
  try {
    const data = await api.editMessage(_activeConversationId, messageId, newContent);
    const idx = _messages.findIndex(m => m.id === messageId);
    if (idx !== -1) _messages[idx] = data.message;
    return data.message;
  } catch (err) {
    showToast('Could not edit message.', 'error');
    throw err;
  }
}

// ─── Conversation Management ───────────────────────────────────────────────

export async function createNewConversation() {
  window.location.href = '/new';
}

export async function renameConversation(id, title) {
  try {
    await api.rename(id, title);
    // Update sidebar
    const item = document.querySelector(`[data-conversation-id="${id}"] .conv-title`);
    if (item) item.textContent = title;
    // Update page title if active
    if (id === _activeConversationId) {
      document.title = `${title} — SIA`;
    }
  } catch {
    showToast('Could not rename conversation.', 'error');
  }
}

export async function deleteConversation(id) {
  try {
    await api.delete(id);
    _conversationList = _conversationList.filter(c => c.id !== id);
    _renderSidebar(_conversationList);
    if (id === _activeConversationId) {
      window.location.href = '/new';
    }
  } catch {
    showToast('Could not delete conversation.', 'error');
  }
}

// ─── Streaming ─────────────────────────────────────────────────────────────

function _startStream(conversationId, messageId) {
  let accum = '';

  _streamAbort = streamResponse(conversationId, messageId, {
    onChunk(delta) {
      accum += delta;
      const container = document.getElementById('messages-container');
      updateStreamingMessage(messageId, accum, container);
      scrollToBottom(container);
    },
    onDone() {
      _onResponseComplete(messageId, accum, 'done');
    },
    onError(err) {
      // Fall back to polling if stream not available
      console.warn('[chat] stream error, falling back to poll', err);
      _startPolling(conversationId, messageId, accum);
    },
  });
}

/**
 * Polling fallback — used when SSE isn't available or stream errors.
 * Checks message status every POLL_INTERVAL_MS ms.
 */
function _startPolling(conversationId, messageId, existingContent = '') {
  _clearPoll();
  _pollInterval = setInterval(async () => {
    try {
      const data = await api.messages(conversationId);
      const msg = (data.messages ?? []).find(m => m.id === messageId);
      if (!msg) return;

      const container = document.getElementById('messages-container');

      if (msg.status === 'done' || msg.status === 'cancelled') {
        _clearPoll();
        _onResponseComplete(messageId, msg.content, msg.status);
      } else if (msg.content && msg.content !== existingContent) {
        existingContent = msg.content;
        updateStreamingMessage(messageId, existingContent, container);
        scrollToBottom(container);
      }
    } catch (err) {
      console.error('[chat] poll error', err);
    }
  }, POLL_INTERVAL_MS);
}

function _clearPoll() {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

function _onResponseComplete(messageId, content, status) {
  _streamAbort = null;
  _pendingMessageId = null;
  _clearPoll();

  const container = document.getElementById('messages-container');
  finalizeMessage(messageId, content, status, container);
  scrollToBottom(container);
  _setInputLocked(false);

  // Update local state
  const idx = _messages.findIndex(m => m.id === messageId);
  if (idx !== -1) {
    _messages[idx] = { ..._messages[idx], content, status };
  }
}

// ─── Presence ─────────────────────────────────────────────────────────────

function _startPresence(conversationId) {
  _stopPresence();

  // Initial ping
  presence.ping(conversationId, 'active').catch(() => {});

  _presencePingInterval = setInterval(() => {
    const state = document.hidden ? 'away' : 'active';
    presence.ping(conversationId, state).catch(() => {});
  }, PRESENCE_PING_MS);

  document.addEventListener('visibilitychange', _onVisibilityChange);
}

function _stopPresence() {
  if (_presencePingInterval) {
    clearInterval(_presencePingInterval);
    _presencePingInterval = null;
  }
  document.removeEventListener('visibilitychange', _onVisibilityChange);
}

function _onVisibilityChange() {
  if (!_activeConversationId) return;
  const state = document.hidden ? 'away' : 'active';
  presence.ping(_activeConversationId, state).catch(() => {});
}

// ─── Typing Presence ──────────────────────────────────────────────────────

/**
 * Call this on every textarea keystroke.
 */
export function onUserTyping() {
  if (!_activeConversationId) return;

  if (!_isTyping) {
    _isTyping = true;
    presence.typing(_activeConversationId, true).catch(() => {});
  }

  clearTimeout(_typingDebounce);
  _typingDebounce = setTimeout(() => {
    _isTyping = false;
    presence.typing(_activeConversationId, false).catch(() => {});
  }, TYPING_DEBOUNCE_MS);
}

// ─── Title Generation ─────────────────────────────────────────────────────

async function _requestTitleGeneration(conversationId, firstMessage) {
  // Backend generates title; we just poll for an update after a short delay
  setTimeout(async () => {
    try {
      const data = await api.get(conversationId);
      const title = data.conversation?.title;
      if (title) {
        const item = document.querySelector(
          `[data-conversation-id="${conversationId}"] .conv-title`
        );
        if (item) item.textContent = title;
        document.title = `${title} — SIA`;
      }
    } catch (_) {}
  }, 3000);
}

// ─── Sidebar Render ───────────────────────────────────────────────────────

function _renderSidebar(list) {
  const sidebar = document.getElementById('conversation-list');
  if (!sidebar) return;

  if (list.length === 0) {
    sidebar.innerHTML = '<p class="sidebar-empty">No conversations yet.</p>';
    return;
  }

  sidebar.innerHTML = '';

  // Group by date
  const groups = _groupByDate(list);

  for (const [label, items] of Object.entries(groups)) {
    const group = document.createElement('div');
    group.className = 'sidebar-group';

    const groupLabel = document.createElement('span');
    groupLabel.className = 'sidebar-group-label';
    groupLabel.textContent = label;
    group.appendChild(groupLabel);

    for (const conv of items) {
      group.appendChild(_buildSidebarItem(conv));
    }

    sidebar.appendChild(group);
  }
}

function _buildSidebarItem(conv) {
  const item = document.createElement('a');
  item.className = 'sidebar-item';
  item.href = `/c/${conv.id}`;
  item.dataset.conversationId = conv.id;
  if (conv.id === _activeConversationId) item.classList.add('active');

  item.innerHTML = `
    <span class="conv-title" title="${_escHtml(conv.title ?? 'Untitled')}">${_escHtml(conv.title ?? 'Untitled')}</span>
    <span class="conv-actions">
      <button class="conv-btn conv-rename" title="Rename" aria-label="Rename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="conv-btn conv-delete" title="Delete" aria-label="Delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </span>
  `;

  // Rename
  item.querySelector('.conv-rename').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const current = conv.title ?? 'Untitled';
    const newTitle = prompt('Rename conversation:', current);
    if (newTitle && newTitle.trim() && newTitle.trim() !== current) {
      await renameConversation(conv.id, newTitle.trim());
      conv.title = newTitle.trim();
    }
  });

  // Delete
  item.querySelector('.conv-delete').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm('Delete this conversation? This cannot be undone.')) {
      await deleteConversation(conv.id);
    }
  });

  // Navigate (SPA)
  item.addEventListener('click', (e) => {
    if (e.target.closest('.conv-btn')) return;
    e.preventDefault();
    history.pushState({}, '', `/c/${conv.id}`);
    loadConversation(conv.id);
    // Mobile: close sidebar
    document.querySelector('.sidebar')?.classList.remove('open');
  });

  return item;
}

function _highlightSidebarItem(conversationId) {
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.conversationId === conversationId);
  });
}

// ─── Input Lock ───────────────────────────────────────────────────────────

function _setInputLocked(locked) {
  const textarea = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');

  if (textarea) textarea.disabled = locked;
  if (sendBtn) sendBtn.disabled = locked;
  if (cancelBtn) {
    cancelBtn.style.display = locked ? 'flex' : 'none';
  }

  document.dispatchEvent(new CustomEvent('sia:input-lock', { detail: { locked } }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _reset() {
  _streamAbort?.abort();
  _streamAbort = null;
  _clearPoll();
  _stopPresence();
  _pendingMessageId = null;
  _messages = [];
  _activeConversationId = null;
  _setInputLocked(false);
}

function _buildOptimisticMessage(role, content, imageMetaId) {
  return {
    id: `opt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role,
    content,
    image_meta_id: imageMetaId,
    status: 'done',
    created_at: new Date().toISOString(),
    _optimistic: true,
  };
}

function _replaceOptimisticMessage(optimisticId, confirmed, container) {
  const el = container?.querySelector(`[data-message-id="${optimisticId}"]`);
  if (el) {
    el.dataset.messageId = confirmed.id;
  }
  const idx = _messages.findIndex(m => m.id === optimisticId);
  if (idx !== -1) _messages[idx] = confirmed;
}

function _removeOptimisticMessage(optimisticId, container) {
  const el = container?.querySelector(`[data-message-id="${optimisticId}"]`);
  el?.remove();
}

function _groupByDate(conversations) {
  const now = new Date();
  const groups = { Today: [], Yesterday: [], 'This Week': [], Older: [] };

  for (const conv of conversations) {
    const d = new Date(conv.updated_at ?? conv.created_at);
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) groups['Today'].push(conv);
    else if (diffDays === 1) groups['Yesterday'].push(conv);
    else if (diffDays <= 7) groups['This Week'].push(conv);
    else groups['Older'].push(conv);
  }

  // Remove empty groups
  return Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0));
}

function _escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Exports ──────────────────────────────────────────────────────────────

export function getActiveConversationId() {
  return _activeConversationId;
}

export function getMessages() {
  return [..._messages];
}

export function isPending() {
  return _pendingMessageId !== null;
}
