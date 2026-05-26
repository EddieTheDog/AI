// worker/index.js

import { handleAuth }          from './routes/auth.js';
import { handleConversations } from './routes/conversations.js';
import { handleMessages }      from './routes/messages.js';
import { handlePresence }      from './routes/presence.js';
import { handleMemory }        from './routes/memory.js';
import { handleImages }        from './routes/images.js';
import { handleSharing }       from './routes/sharing.js';
import { handleAdmin }         from './routes/admin.js';
import { authMiddleware }      from './middleware/auth.js';
import { rateLimiter }         from './middleware/ratelimit.js';
import { cors, json, err }     from './lib/response.js';

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      // ── Rate limiting ──────────────────────────────────────────────
      const rl = await rateLimiter(request, env);
      if (rl) return cors(rl);

      // ── Static file passthrough (Cloudflare Pages handles these) ──
      // Worker only handles /api/* and /op routes

      // ── API routes ────────────────────────────────────────────────
      if (path.startsWith('/api/')) {
        return cors(await handleAPI(path.slice(4), method, request, env, ctx));
      }

      // ── 404 ───────────────────────────────────────────────────────
      return cors(err('Not found', 404));

    } catch (e) {
      console.error('[worker]', e);
      return cors(err('Internal server error', 500));
    }
  },
};

// ── API Router ─────────────────────────────────────────────────────────────

async function handleAPI(path, method, request, env, ctx) {

  // Public routes (no auth required)
  if (path.startsWith('/auth/')) {
    return handleAuth(path.slice(5), method, request, env);
  }

  if (path.startsWith('/shared/')) {
    return handleSharing(path, method, request, env, null);
  }

  // Admin routes — separate auth
  if (path.startsWith('/admin/')) {
    const admin = await authMiddleware(request, env, 'admin');
    if (!admin) return err('Unauthorized', 401);
    return handleAdmin(path.slice(6), method, request, env, admin);
  }

  // All other routes require user auth
  const user = await authMiddleware(request, env, 'user');
  if (!user) return err('Unauthorized', 401);

  if (path.startsWith('/conversations'))  return handleConversations(path, method, request, env, user);
  if (path.startsWith('/messages/'))      return handleMessages(path, method, request, env, user);
  if (path.startsWith('/presence/'))      return handlePresence(path, method, request, env, user);
  if (path.startsWith('/memory'))         return handleMemory(path, method, request, env, user);
  if (path.startsWith('/images/'))        return handleImages(path, method, request, env, user);
  if (path.startsWith('/sharing/'))       return handleSharing(path, method, request, env, user);

  return err('Not found', 404);
}
