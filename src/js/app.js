// src/js/app.js

import { initAuth, isAuthenticated, currentUser, onAuthChange, logout } from './auth.js';
import {
  loadConversation,
  loadConversationList,
  sendMessage,
  cancelPending,
  onUserTyping,
  getActiveConversationId,
  isPending,
} from './chat.js';
import { initRenderer } from './renderer.js';
import {
  showToast,
  initAutoExpand,
  initScrollTracking,
  resetScrollTracking,
  openDropdown,
  copyToClipboard,
} from './ui.js';
import { memory as memoryAPI, sharing, uploadImage } from './api.js';

// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  initRenderer();

  const user = await initAuth();

  if (!user) {
    window.location.href = '/login';
    return;
  }

  initUI(user);
  initRouting();
}

// ─── UI Init ───────────────────────────────────────────────────────────────

function initUI(user) {
  // Set user info in sidebar
  const nameEl = document.getElementById('user-display-name');
  const initialsEl = document.getElementById('user-avatar-initials');
  if (nameEl) nameEl.textContent = user.display_name || user.email;
  if (initialsEl) initialsEl.textContent = _initials(user.display_name || user.email);

  // Sidebar new chat
  document.getElementById('new-chat-btn')?.addEventListener('click', () => {
    history.pushState({}, '', '/new');
    _handleRoute();
  });

  // Mobile sidebar
  document.getElementById('menu-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-close-btn').style.display = 'flex';
  });

  document.getElementById('sidebar-close-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-close-btn').style.display = 'none';
  });

  // User chip menu
  document.getElementById('user-chip')?.addEventListener('click', (e) => {
    openDropdown(e.currentTarget, [
      { label: 'Account settings', action: () => showToast('Coming soon.', 'info') },
      'divider',
      { label: 'Sign out', danger: true, action: () => logout() },
    ]);
  });

  // Input + send
  initInputArea();

  // Memory panel
  initMemoryPanel();

  // Share button
  document.getElementById('share-btn')?.addEventListener('click', handleShare);

  // Starter cards
  document.querySelectorAll('.starter-card').forEach(card => {
    card.addEventListener('click', () => {
      const prompt = card.dataset.prompt;
      if (prompt) {
        const input = document.getElementById('message-input');
        if (input) {
          input.value = prompt;
          input.dispatchEvent(new Event('input'));
          _updateSendBtn();
          input.focus();
        }
      }
    });
  });

  // Conversation search
  document.getElementById('conv-search')?.addEventListener('input', (e) => {
    _filterConversations(e.target.value);
  });

  // Back/forward navigation
  window.addEventListener('popstate', _handleRoute);

  // Input lock state
  document.addEventListener('sia:input-lock', (e) => {
    const { locked } = e.detail;
    const box = document.getElementById('input-box');
    box?.classList.toggle('locked', locked);
  });

  // Load conversation list
  loadConversationList();
}

// ─── Routing ───────────────────────────────────────────────────────────────

function initRouting() {
  _handleRoute();
}

async function _handleRoute() {
  const path = window.location.pathname;
  resetScrollTracking();

  if (path === '/' || path === '/new' || path === '') {
    _showEmptyState();
    document.title = 'SIA';
    document.getElementById('share-btn').style.display = 'none';
    document.getElementById('topbar-title').textContent = 'SIA';
    return;
  }

  const match = path.match(/^\/c\/([a-zA-Z0-9_-]+)$/);
  if (match) {
    const convId = match[1];
    _hideEmptyState();
    document.getElementById('share-btn').style.display = 'flex';
    await loadConversation(convId);
    return;
  }

  // Unknown route — go home
  history.replaceState({}, '', '/new');
  _showEmptyState();
}

function _showEmptyState() {
  const container = document.getElementById('messages-container');
  const empty = document.getElementById('empty-state');
  if (container && empty) {
    container.innerHTML = '';
    container.appendChild(empty);
    empty.style.display = 'flex';
  }
}

function _hideEmptyState() {
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = 'none';
}

// ─── Input Area ────────────────────────────────────────────────────────────

let _imageMetaId = null;
let _imageFile = null;

function initInputArea() {
  const textarea = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const imageUploadBtn = document.getElementById('image-upload-btn');
  const imageFileInput = document.getElementById('image-file-input');
  const imgPreviewRemove = document.getElementById('img-preview-remove');
  const messagesContainer = document.getElementById('messages-container');

  if (!textarea || !sendBtn) return;

  // Init auto-expand
  initAutoExpand(textarea);

  // Init scroll tracking
  initScrollTracking(messagesContainer);

  // Update send button state on input
  textarea.addEventListener('input', () => {
    _updateSendBtn();
    onUserTyping();
  });

  // Enter = newline (no send on enter)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Allow default newline behavior
      // Send only via button
    }
    // Ctrl/Cmd+Enter = send
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      _doSend(textarea, sendBtn);
    }
  });

  // Send button
  sendBtn.addEventListener('click', () => _doSend(textarea, sendBtn));

  // Cancel
  cancelBtn?.addEventListener('click', cancelPending);

  // Image upload trigger
  imageUploadBtn?.addEventListener('click', () => {
    if (_imageMetaId) {
      showToast('Remove the current image first.', 'info');
      return;
    }
    imageFileInput?.click();
  });

  // File selected
  imageFileInput?.addEventListener('change', async () => {
    const file = imageFileInput.files[0];
    if (!file) return;

    // Validate
    if (!file.type.startsWith('image/')) {
      showToast('Only image files are supported.', 'error');
      imageFileInput.value = '';
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      showToast('Image must be under 10MB.', 'error');
      imageFileInput.value = '';
      return;
    }

    _imageFile = file;
    _showImagePreview(file);
    await _uploadImageFile(file);
    imageFileInput.value = '';
  });

  // Remove image
  imgPreviewRemove?.addEventListener('click', _clearImage);
}

async function _doSend(textarea, sendBtn) {
  if (sendBtn.disabled) return;
  if (isPending()) return;

  const content = textarea.value;
  if (!content.trim() && !_imageMetaId) return;

  // Ensure we have a conversation
  if (!getActiveConversationId()) {
    try {
      const { conversations: convAPI } = await import('./api.js');
      const data = await convAPI.create();
      history.pushState({}, '', `/c/${data.conversation.id}`);
      _hideEmptyState();
      document.getElementById('share-btn').style.display = 'flex';
    } catch {
      showToast('Could not create conversation.', 'error');
      return;
    }
  }

  // Clear input
  textarea.value = '';
  textarea.style.height = 'auto';
  _updateSendBtn();

  const imageMeta = _imageMetaId;
  _clearImage();

  await sendMessage(content, imageMeta);
}

async function _uploadImageFile(file) {
  const progressBar = document.getElementById('upload-progress');
  progressBar.classList.add('visible');
  progressBar.style.width = '0%';

  try {
    const result = await uploadImage(file, {
      onProgress(pct) {
        progressBar.style.width = `${pct}%`;
      },
    });
    _imageMetaId = result.id;
    progressBar.style.width = '100%';
    setTimeout(() => progressBar.classList.remove('visible'), 600);
    _updateSendBtn();
  } catch (err) {
    showToast(err.message || 'Upload failed.', 'error');
    _clearImage();
    progressBar.classList.remove('visible');
  }
}

function _showImagePreview(file) {
  const strip = document.getElementById('image-preview-strip');
  const thumb = document.getElementById('img-preview-thumb');
  const img = document.getElementById('img-preview-img');

  if (!strip || !thumb || !img) return;

  const url = URL.createObjectURL(file);
  img.src = url;
  img.onload = () => URL.revokeObjectURL(url);
  thumb.style.display = 'block';
  strip.classList.add('has-image');
}

function _clearImage() {
  _imageMetaId = null;
  _imageFile = null;

  const strip = document.getElementById('image-preview-strip');
  const thumb = document.getElementById('img-preview-thumb');
  const img = document.getElementById('img-preview-img');

  if (strip) strip.classList.remove('has-image');
  if (thumb) thumb.style.display = 'none';
  if (img) img.src = '';

  _updateSendBtn();
}

function _updateSendBtn() {
  const textarea = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  if (!textarea || !sendBtn) return;
  const hasContent = textarea.value.trim().length > 0 || _imageMetaId !== null;
  sendBtn.disabled = !hasContent || isPending();
}

// ─── Memory Panel ──────────────────────────────────────────────────────────

let _memories = [];

function initMemoryPanel() {
  const memBtn = document.getElementById('memory-btn');
  const panel = document.getElementById('memory-panel');
  const closeBtn = document.getElementById('memory-close-btn');
  const searchInput = document.getElementById('memory-search-input');
  const addInput = document.getElementById('memory-add-input');
  const addBtn = document.getElementById('memory-add-btn');

  memBtn?.addEventListener('click', async () => {
    panel?.classList.add('open');
    panel?.setAttribute('aria-hidden', 'false');
    await _loadMemories();
  });

  closeBtn?.addEventListener('click', () => {
    panel?.classList.remove('open');
    panel?.setAttribute('aria-hidden', 'true');
  });

  searchInput?.addEventListener('input', () => {
    _renderMemories(_memories.filter(m =>
      m.content.toLowerCase().includes(searchInput.value.toLowerCase())
    ));
  });

  addInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBtn?.click();
  });

  addBtn?.addEventListener('click', async () => {
    const content = addInput?.value.trim();
    if (!content) return;

    addBtn.disabled = true;
    try {
      const result = await memoryAPI.add(content);
      _memories.unshift(result.memory);
      _renderMemories(_memories);
      if (addInput) addInput.value = '';
      showToast('Memory saved.', 'success');
    } catch {
      showToast('Could not save memory.', 'error');
    } finally {
      addBtn.disabled = false;
    }
  });
}

async function _loadMemories() {
  const list = document.getElementById('memory-list');
  if (!list) return;
  list.innerHTML = '<p class="sidebar-empty" style="padding:20px">Loading...</p>';

  try {
    const data = await memoryAPI.list();
    _memories = data.memories ?? [];
    _renderMemories(_memories);
  } catch {
    list.innerHTML = '<p class="sidebar-empty" style="padding:20px">Failed to load memories.</p>';
  }
}

function _renderMemories(list) {
  const container = document.getElementById('memory-list');
  if (!container) return;

  if (!list.length) {
    container.innerHTML = '<p class="sidebar-empty" style="padding:20px">No memories yet.</p>';
    return;
  }

  container.innerHTML = '';
  for (const mem of list) {
    const item = document.createElement('div');
    item.className = 'memory-item';
    item.innerHTML = `
      <span class="memory-text">${_escHtml(mem.content)}</span>
      <button class="memory-delete" aria-label="Delete memory" data-id="${mem.id}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    `;
    item.querySelector('.memory-delete').addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      try {
        await memoryAPI.delete(id);
        _memories = _memories.filter(m => m.id !== id);
        _renderMemories(_memories);
        showToast('Memory deleted.', 'success');
      } catch {
        showToast('Could not delete memory.', 'error');
      }
    });
    container.appendChild(item);
  }
}

// ─── Share ─────────────────────────────────────────────────────────────────

async function handleShare() {
  const convId = getActiveConversationId();
  if (!convId) return;

  try {
    const data = await sharing.createShare(convId);
    const shareUrl = `${window.location.origin}/shared/${data.token}`;
    await copyToClipboard(shareUrl);
    showToast('Share link copied to clipboard.', 'success');
  } catch {
    showToast('Could not create share link.', 'error');
  }
}

// ─── Conversation Filter ───────────────────────────────────────────────────

function _filterConversations(query) {
  const items = document.querySelectorAll('.sidebar-item');
  const q = query.toLowerCase().trim();
  items.forEach(item => {
    const title = item.querySelector('.conv-title')?.textContent.toLowerCase() ?? '';
    item.style.display = !q || title.includes(q) ? '' : 'none';
  });

  // Show/hide group labels
  document.querySelectorAll('.sidebar-group').forEach(group => {
    const visible = [...group.querySelectorAll('.sidebar-item')]
      .some(item => item.style.display !== 'none');
    group.style.display = visible ? '' : 'none';
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Start ─────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('[SIA] boot error', err);
});
