// functions/api/[[path]].js
// Cloudflare Pages Function — handles all /api/* requests
// This runs the worker logic directly inside Pages Functions runtime

import { handleAuth }          from '../../worker/routes/auth.js';
import { handleConversations } from '../../worker/routes/conversations.js';
import { handleMessages }      from '../../worker/routes/messages.js';
import { handlePresence }      from '../../worker/routes/presence.js';
import { handleMemory }        from '../../worker/routes/memory.js';
import { handleImages }        from '../../worker/routes/images.js';
import { handleSharing }       from '../../worker/routes/sharing.js';
import { handleAdmin }         from '../../worker/routes/admin.js';
import { authMiddleware }      from '../../worker/middleware/auth.js';
import { rateLimiter }         from '../../worker/middleware/ratelimit.js';
import { cors, err }           from '../../worker/lib/response.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }

  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  try {
    const rl = await rateLimiter(request, env);
    if (rl) return cors(rl);

    // Strip /api prefix
    const apiPath = path.replace(/^\/api/, '');

    // Public routes
    if (apiPath.startsWith('/auth/')) {
      return cors(await handleAuth(apiPath.slice(5), method, request, env));
    }

    if (apiPath.startsWith('/shared/')) {
      return cors(await handleSharing(apiPath, method, request, env, null));
    }

    // Admin routes
    if (apiPath.startsWith('/admin/')) {
      const adminPath = apiPath.slice(6);
      const publicRoutes = ['login', 'register', 'me', 'logout'];
      const isPublic = publicRoutes.some(r => adminPath === `/${r}`);
      const admin = isPublic ? null : await authMiddleware(request, env, 'admin');
      if (!isPublic && !admin) return cors(err('Unauthorized', 401));
      return cors(await handleAdmin(adminPath, method, request, env, admin));
    }

    // User-auth routes
    const user = await authMiddleware(request, env, 'user');
    if (!user) return cors(err('Unauthorized', 401));

    if (apiPath.startsWith('/conversations'))  return cors(await handleConversations(apiPath, method, request, env, user));
    if (apiPath.startsWith('/messages/'))      return cors(await handleMessages(apiPath, method, request, env, user));
    if (apiPath.startsWith('/presence/'))      return cors(await handlePresence(apiPath, method, request, env, user));
    if (apiPath.startsWith('/memory'))         return cors(await handleMemory(apiPath, method, request, env, user));
    if (apiPath.startsWith('/images/'))        return cors(await handleImages(apiPath, method, request, env, user));
    if (apiPath.startsWith('/sharing/'))       return cors(await handleSharing(apiPath, method, request, env, user));

    return cors(err('Not found', 404));

  } catch (e) {
    console.error('[pages-fn]', e);
    return cors(err('Internal server error', 500));
  }
}
