/**
 * SIA - API Client Module
 * Handles all communication with the Cloudflare Worker backend.
 * Supports standard JSON requests and SSE streaming responses.
 */

const API_BASE = '/api';

// ─── Core Fetch Wrapper ────────────────────────────────────────────────────

/**
 * Base fetch with auth headers, CSRF token, and error normalization.
 * @param {string} path - API path (e.g. '/messages')
 * @param {object} options - fetch options override
 * @returns {Promise<any>} parsed JSON response
 */
async function apiFetch(path, options = {}) {
  const csrfToken = getCsrfToken();

  const defaults = {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {}),
    },
  };

  const config = { ...defaults, ...options, headers: defaults.headers };

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, config);
  } catch (err) {
    throw new APIError('Network error — please check your connection.', 0);
  }

  if (response.status === 401) {
    // Session expired — redirect to login
    window.dispatchEvent(new CustomEvent('sia:unauthorized'));
    throw new APIError('Session expired. Please log in again.', 401);
  }

  if (response.status === 403) {
    throw new APIError('Access denied.', 403);
  }

  if (response.status === 429) {
    throw new APIError('Too many requests. Please slow down.', 429);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch (_) {}
    throw new APIError(message, response.status);
  }

  // 204 No Content
  if (response.status === 204) return null;

  return response.json();
}

// ─── CSRF ──────────────────────────────────────────────────────────────────

function getCsrfToken() {
  return document.cookie
    .split('; ')
    .find(r => r.startsWith('csrf='))
    ?.split('=')[1] ?? null;
}

// ─── Error Class ───────────────────────────────────────────────────────────

export class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}

// ─── Streaming SSE ─────────────────────────────────────────────────────────

/**
 * Opens a streaming connection for a pending assistant message.
 * Calls onChunk(text) for each delta, onDone() when complete, onError(err) on failure.
 *
 * @param {string} conversationId
 * @param {string} pendingMessageId - the placeholder message ID to stream into
 * @param {object} callbacks - { onChunk, onDone, onError }
 * @returns {{ abort: () => void }} - call abort() to cancel
 */
export function streamResponse(conversationId, pendingMessageId, { onChunk, onDone, onError }) {
  const controller = new AbortController();
  const { signal } = controller;

  (async () => {
    let response;
    try {
      response = await fetch(
        `${API_BASE}/conversations/${conversationId}/stream/${pendingMessageId}`,
        {
          credentials: 'include',
          headers: { Accept: 'text/event-stream' },
          signal,
        }
      );
    } catch (err) {
      if (err.name === 'AbortError') return;
      onError?.(new APIError('Stream connection failed.', 0));
      return;
    }

    if (!response.ok) {
      onError?.(new APIError(`Stream error (${response.status})`, response.status));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            onDone?.();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.delta) onChunk?.(parsed.delta);
            if (parsed.error) throw new APIError(parsed.error, 500);
          } catch (parseErr) {
            if (parseErr instanceof APIError) throw parseErr;
            // ignore malformed lines
          }
        }
      }
      onDone?.();
    } catch (err) {
      if (err.name === 'AbortError') return;
      onError?.(err);
    }
  })();

  return { abort: () => controller.abort() };
}

// ─── Auth Endpoints ────────────────────────────────────────────────────────

export const auth = {
  login: (email, password) =>
    apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email, password, displayName) =>
    apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, display_name: displayName }),
    }),

  logout: () =>
    apiFetch('/auth/logout', { method: 'POST' }),

  me: () =>
    apiFetch('/auth/me'),
};

// ─── Conversation Endpoints ────────────────────────────────────────────────

export const conversations = {
  list: () =>
    apiFetch('/conversations'),

  get: (id) =>
    apiFetch(`/conversations/${id}`),

  create: () =>
    apiFetch('/conversations', { method: 'POST' }),

  rename: (id, title) =>
    apiFetch(`/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  delete: (id) =>
    apiFetch(`/conversations/${id}`, { method: 'DELETE' }),

  messages: (id) =>
    apiFetch(`/conversations/${id}/messages`),

  sendMessage: (id, content, imageMetaId = null) =>
    apiFetch(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, image_meta_id: imageMetaId }),
    }),

  cancelPending: (id, messageId) =>
    apiFetch(`/conversations/${id}/messages/${messageId}/cancel`, {
      method: 'POST',
    }),

  editMessage: (id, messageId, content) =>
    apiFetch(`/conversations/${id}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
};

// ─── Reaction Endpoints ────────────────────────────────────────────────────

export const reactions = {
  add: (messageId, type) =>
    apiFetch(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ type }), // 'up' | 'down'
    }),

  remove: (messageId) =>
    apiFetch(`/messages/${messageId}/reactions`, { method: 'DELETE' }),
};

// ─── Memory Endpoints ─────────────────────────────────────────────────────

export const memory = {
  list: () =>
    apiFetch('/memory'),

  add: (content) =>
    apiFetch('/memory', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  delete: (id) =>
    apiFetch(`/memory/${id}`, { method: 'DELETE' }),

  search: (query) =>
    apiFetch(`/memory/search?q=${encodeURIComponent(query)}`),
};

// ─── Image Upload ──────────────────────────────────────────────────────────

/**
 * Uploads an image file, returns metadata ID stored in D1.
 * Progress reported via onProgress(percent).
 */
export function uploadImage(file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/images/upload`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', getCsrfToken() ?? '');

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new APIError('Invalid upload response', xhr.status));
        }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText)?.error ?? msg; } catch (_) {}
        reject(new APIError(msg, xhr.status));
      }
    });

    xhr.addEventListener('error', () =>
      reject(new APIError('Upload network error', 0))
    );

    xhr.addEventListener('abort', () =>
      reject(new APIError('Upload cancelled', 0))
    );

    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

// ─── Presence ─────────────────────────────────────────────────────────────

export const presence = {
  ping: (conversationId, state) =>
    apiFetch('/presence/ping', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: conversationId, state }),
    }),

  typing: (conversationId, isTyping) =>
    apiFetch('/presence/typing', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: conversationId, is_typing: isTyping }),
    }),
};

// ─── Share Endpoints ──────────────────────────────────────────────────────

export const sharing = {
  createShare: (conversationId, expiresIn = null) =>
    apiFetch(`/conversations/${conversationId}/share`, {
      method: 'POST',
      body: JSON.stringify({ expires_in: expiresIn }),
    }),

  revokeShare: (conversationId) =>
    apiFetch(`/conversations/${conversationId}/share`, { method: 'DELETE' }),

  getShared: (token) =>
    apiFetch(`/shared/${token}`),
};
