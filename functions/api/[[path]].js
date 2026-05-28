// functions/api/[[path]].js
// SIA — Cloudflare Pages Function (self-contained, no external imports)

const SESSION_DURATION       = 60 * 60 * 24 * 30; // 30 days
const ADMIN_SESSION_DURATION = 60 * 60 * 12;       // 12 hours

// ── Entry point ────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return corsResponse(new Response(null, { status: 204 }));
  }

  const url    = new URL(request.url);
  const path   = url.pathname.replace(/^\/api/, ''); // strip /api prefix
  const method = request.method;

  try {
    // ── Public auth routes ─────────────────────────────────────────────
    if (path === '/auth/login'    && method === 'POST') return corsResponse(await userLogin(request, env));
    if (path === '/auth/register' && method === 'POST') return corsResponse(await userRegister(request, env));
    if (path === '/auth/logout'   && method === 'POST') return corsResponse(await userLogout(request, env));
    if (path === '/auth/me'       && method === 'GET')  return corsResponse(await userMe(request, env));

    // ── Public shared route ────────────────────────────────────────────
    const sharedMatch = path.match(/^\/shared\/([^/]+)$/);
    if (sharedMatch && method === 'GET') return corsResponse(await getShared(sharedMatch[1], env));

    // ── Admin auth routes (no session needed) ─────────────────────────
    if (path === '/admin/login'    && method === 'POST') return corsResponse(await adminLogin(request, env));
    if (path === '/admin/register' && method === 'POST') return corsResponse(await adminRegister(request, env));
    if (path === '/admin/logout'   && method === 'POST') return corsResponse(await adminLogout(request, env));
    if (path === '/admin/me'       && method === 'GET')  return corsResponse(await adminMe(request, env));

    // ── Protected admin routes ─────────────────────────────────────────
    if (path.startsWith('/admin/')) {
      const admin = await getAdminSession(request, env);
      if (!admin) return corsResponse(jsonErr('Unauthorized', 401));
      return corsResponse(await handleAdminRoute(path, method, request, env, admin));
    }

    // ── Protected user routes ──────────────────────────────────────────
    const user = await getUserSession(request, env);
    if (!user) return corsResponse(jsonErr('Unauthorized', 401));
    return corsResponse(await handleUserRoute(path, method, request, env, user));

  } catch (e) {
    console.error('[sia-fn]', e?.message ?? e);
    return corsResponse(jsonErr('Internal server error', 500));
  }
}

// ── User route dispatcher ──────────────────────────────────────────────────

async function handleUserRoute(path, method, request, env, user) {
  // Conversations list + create
  if (path === '/conversations' && method === 'GET')  return listConversations(env, user);
  if (path === '/conversations' && method === 'POST') return createConversation(env, user);

  // Conversation CRUD
  const convMatch = path.match(/^\/conversations\/([^/]+)$/);
  if (convMatch) {
    const id = convMatch[1];
    if (method === 'GET')    return getConversation(id, env, user);
    if (method === 'PATCH')  return renameConversation(id, request, env, user);
    if (method === 'DELETE') return deleteConversation(id, env, user);
  }

  // Messages
  const msgsMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
  if (msgsMatch) {
    const id = msgsMatch[1];
    if (method === 'GET')  return listMessages(id, env, user);
    if (method === 'POST') return sendMessage(id, request, env, user);
  }

  // Cancel message
  const cancelMatch = path.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') return cancelMessage(cancelMatch[1], cancelMatch[2], env, user);

  // Edit message
  const editMatch = path.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)$/);
  if (editMatch && method === 'PATCH') return editUserMessage(editMatch[1], editMatch[2], request, env, user);

  // Stream
  const streamMatch = path.match(/^\/conversations\/([^/]+)\/stream\/([^/]+)$/);
  if (streamMatch && method === 'GET') return streamMessage(streamMatch[1], streamMatch[2], env, user);

  // Reactions
  const reactionMatch = path.match(/^\/messages\/([^/]+)\/reactions$/);
  if (reactionMatch) {
    const msgId = reactionMatch[1];
    if (method === 'POST')   return addReaction(msgId, request, env, user);
    if (method === 'DELETE') return removeReaction(msgId, env, user);
  }

  // Memory
  if (path === '/memory' && method === 'GET')  return listMemory(env, user);
  if (path === '/memory' && method === 'POST') return addMemory(request, env, user);
  const memMatch = path.match(/^\/memory\/([^/]+)$/);
  if (memMatch && method === 'DELETE') return deleteMemory(memMatch[1], env, user);

  // Presence
  if (path === '/presence/ping'   && method === 'POST') return presencePing(request, env, user);
  if (path === '/presence/typing' && method === 'POST') return presenceTyping(request, env, user);

  // Images
  if (path === '/images/upload' && method === 'POST') return uploadImage(request, env, user);

  // Share
  const shareMatch = path.match(/^\/conversations\/([^/]+)\/share$/);
  if (shareMatch) {
    if (method === 'POST')   return createShare(shareMatch[1], request, env, user);
    if (method === 'DELETE') return revokeShare(shareMatch[1], env, user);
  }

  return jsonErr('Not found', 404);
}

// ── Admin route dispatcher ─────────────────────────────────────────────────

async function handleAdminRoute(path, method, request, env, admin) {
  if (path === '/admin/dashboard'     && method === 'GET') return adminDashboard(env, admin);
  if (path === '/admin/users'         && method === 'GET') return adminUsers(env);
  if (path === '/admin/conversations' && method === 'GET') return adminConversations(env, request);
  if (path === '/admin/expiring'      && method === 'GET') return adminExpiring(env);
  if (path === '/admin/analytics'     && method === 'GET') return adminAnalytics(env);
  if (path === '/admin/settings'      && method === 'GET')   return adminGetSettings(env);
  if (path === '/admin/settings'      && method === 'PATCH') return adminSaveSettings(request, env);
  if (path === '/admin/assign'        && method === 'POST')  return adminAssign(request, env, admin);
  if (path === '/admin/unassign'      && method === 'POST')  return adminUnassign(request, env, admin);
  if (path === '/admin/notes'         && method === 'POST')  return adminAddNote(request, env, admin);

  const convMsgsMatch = path.match(/^\/admin\/conversations\/([^/]+)\/messages$/);
  if (convMsgsMatch && method === 'GET') return adminConvMessages(convMsgsMatch[1], env);

  const replyMatch = path.match(/^\/admin\/conversations\/([^/]+)\/reply$/);
  if (replyMatch && method === 'POST') return adminReply(replyMatch[1], request, env, admin);

  const chunkMatch = path.match(/^\/admin\/conversations\/([^/]+)\/chunk$/);
  if (chunkMatch && method === 'POST') return adminChunk(chunkMatch[1], request, env, admin);

  const finishMatch = path.match(/^\/admin\/conversations\/([^/]+)\/finish$/);
  if (finishMatch && method === 'POST') return adminFinish(finishMatch[1], request, env, admin);

  const editMsgMatch = path.match(/^\/admin\/messages\/([^/]+)\/edit$/);
  if (editMsgMatch && method === 'PATCH') return adminEditMsg(editMsgMatch[1], request, env);

  const notesMatch = path.match(/^\/admin\/notes\/([^/]+)$/);
  if (notesMatch && method === 'GET')    return adminGetNotes(notesMatch[1], request, env);
  if (notesMatch && method === 'DELETE') return adminDeleteNote(notesMatch[1], env, admin);

  const preserveMatch = path.match(/^\/admin\/conversations\/([^/]+)\/preserve$/);
  if (preserveMatch && method === 'POST') return adminPreserve(preserveMatch[1], env);

  return jsonErr('Not found', 404);
}

// ── User Auth ──────────────────────────────────────────────────────────────

async function userLogin(request, env) {
  const body = await parseJSON(request);
  if (!body) return jsonErr('Invalid JSON');
  const { email, password } = body;
  if (!email || !password) return jsonErr('Email and password required');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();
  if (!user) return jsonErr('Invalid email or password', 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return jsonErr('Invalid email or password', 401);

  return createUserSession({ id: user.id, email: user.email, display_name: user.display_name }, request, env);
}

async function userRegister(request, env) {
  const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'registration_enabled'").first();
  if (setting?.value === 'false') return jsonErr('Registration is currently disabled', 403);

  const body = await parseJSON(request);
  if (!body) return jsonErr('Invalid JSON');
  const { email, password, display_name } = body;

  if (!email || !password)   return jsonErr('Email and password required');
  if (password.length < 8)   return jsonErr('Password must be at least 8 characters');
  if (!display_name?.trim()) return jsonErr('Display name required');
  if (!validEmail(email))    return jsonErr('Invalid email address');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();
  if (existing) return jsonErr('An account with this email already exists', 409);

  const id   = newId('u');
  const hash = await hashPassword(password);
  const now  = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, email.toLowerCase().trim(), display_name.trim(), hash, now, now).run();

  return createUserSession({ id, email: email.toLowerCase().trim(), display_name: display_name.trim() }, request, env);
}

async function userLogout(request, env) {
  const sid = parseCookies(request)['sid'];
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  const h = new Headers({ 'Content-Type': 'application/json' });
  h.append('Set-Cookie', clearCookie('sid'));
  h.append('Set-Cookie', clearCookie('csrf'));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}

async function userMe(request, env) {
  const sid = parseCookies(request)['sid'];
  if (!sid) return jsonOk({ user: null });
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.role = 'user' AND s.expires_at > ?`
  ).bind(sid, now).first();
  return jsonOk({ user: row ?? null });
}

async function createUserSession(user, request, env) {
  const sid  = newId('s');
  const csrf = newId('csrf');
  const exp  = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();
  const now  = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, role, expires_at, created_at, user_agent, ip_address) VALUES (?,?,?,?,?,?,?)'
  ).bind(sid, user.id, 'user', exp, now,
    request.headers.get('User-Agent') || '',
    request.headers.get('CF-Connecting-IP') || ''
  ).run();
  const h = new Headers({ 'Content-Type': 'application/json' });
  h.append('Set-Cookie', makeCookie('sid',  sid,  SESSION_DURATION));
  h.append('Set-Cookie', makeCookie('csrf', csrf, SESSION_DURATION, false));
  return new Response(JSON.stringify({ user }), { status: 200, headers: h });
}

async function getUserSession(request, env) {
  const sid = parseCookies(request)['sid'];
  if (!sid) return null;
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.role = 'user' AND s.expires_at > ?`
  ).bind(sid, now).first();
  return row ?? null;
}

// ── Admin Auth ─────────────────────────────────────────────────────────────

async function adminLogin(request, env) {
  const body = await parseJSON(request);
  if (!body) return jsonErr('Invalid JSON');
  const { email, password } = body;
  if (!email || !password) return jsonErr('Email and password required');

  const admin = await env.DB.prepare('SELECT * FROM admins WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();
  if (!admin) return jsonErr('Invalid credentials', 401);

  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) return jsonErr('Invalid credentials', 401);

  return createAdminSession({ id: admin.id, email: admin.email, display_name: admin.display_name }, request, env);
}

async function adminRegister(request, env) {
  const body = await parseJSON(request);
  if (!body) return jsonErr('Invalid JSON');
  const { email, password, display_name, setup_key } = body;

  const count = await env.DB.prepare('SELECT COUNT(*) as n FROM admins').first();
  const isFirst = (count?.n ?? 0) === 0;

  if (!isFirst) {
    if (!env.ADMIN_SETUP_KEY || setup_key !== env.ADMIN_SETUP_KEY)
      return jsonErr('Invalid setup key', 403);
  }

  if (!email || !password || !display_name) return jsonErr('All fields required');
  if (password.length < 12) return jsonErr('Password must be at least 12 characters');

  const existing = await env.DB.prepare('SELECT id FROM admins WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();
  if (existing) return jsonErr('Email already in use', 409);

  const id   = newId('a');
  const hash = await hashPassword(password);
  const now  = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO admins (id, email, display_name, password_hash, created_at) VALUES (?,?,?,?,?)'
  ).bind(id, email.toLowerCase().trim(), display_name.trim(), hash, now).run();

  return createAdminSession({ id, email: email.toLowerCase().trim(), display_name: display_name.trim() }, request, env);
}

async function adminLogout(request, env) {
  const sid = parseCookies(request)['asid'];
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  const h = new Headers({ 'Content-Type': 'application/json' });
  h.append('Set-Cookie', clearCookie('asid'));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}

async function adminMe(request, env) {
  const sid = parseCookies(request)['asid'];
  if (!sid) return jsonOk({ admin: null });
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT a.id, a.email, a.display_name FROM sessions s
     JOIN admins a ON s.admin_id = a.id
     WHERE s.id = ? AND s.role = 'admin' AND s.expires_at > ?`
  ).bind(sid, now).first();
  return jsonOk({ admin: row ?? null });
}

async function createAdminSession(admin, request, env) {
  const sid = newId('as');
  const exp = new Date(Date.now() + ADMIN_SESSION_DURATION * 1000).toISOString();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (id, admin_id, role, expires_at, created_at, user_agent, ip_address) VALUES (?,?,?,?,?,?,?)'
  ).bind(sid, admin.id, 'admin', exp, now,
    request.headers.get('User-Agent') || '',
    request.headers.get('CF-Connecting-IP') || ''
  ).run();
  const h = new Headers({ 'Content-Type': 'application/json' });
  h.append('Set-Cookie', makeCookie('asid', sid, ADMIN_SESSION_DURATION));
  return new Response(JSON.stringify({ admin }), { status: 200, headers: h });
}

async function getAdminSession(request, env) {
  const sid = parseCookies(request)['asid'];
  if (!sid) return null;
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT a.id, a.email, a.display_name FROM sessions s
     JOIN admins a ON s.admin_id = a.id
     WHERE s.id = ? AND s.role = 'admin' AND s.expires_at > ?`
  ).bind(sid, now).first();
  if (row) await env.DB.prepare('UPDATE admins SET last_active = ? WHERE id = ?').bind(now, row.id).run();
  return row ?? null;
}

// ── Conversations ──────────────────────────────────────────────────────────

async function listConversations(env, user) {
  const rows = await env.DB.prepare(
    `SELECT id, title, created_at, updated_at, expiry_state
     FROM conversations WHERE user_id = ? AND expiry_state != 'expired'
     ORDER BY updated_at DESC LIMIT 100`
  ).bind(user.id).all();
  return jsonOk({ conversations: rows.results ?? [] });
}

async function createConversation(env, user) {
  const id  = newConvId();
  const now = new Date().toISOString();
  const s   = await env.DB.prepare("SELECT value FROM settings WHERE key = 'chat_expiry_days'").first();
  const exp = new Date(Date.now() + parseInt(s?.value ?? '30') * 86400000).toISOString();
  await env.DB.prepare(
    'INSERT INTO conversations (id, user_id, title, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, user.id, 'New conversation', now, now, exp).run();
  return jsonOk({ conversation: { id, title: 'New conversation', created_at: now } }, 201);
}

async function getConversation(id, env, user) {
  const row = await env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (!row) return jsonErr('Not found', 404);
  return jsonOk({ conversation: row });
}

async function renameConversation(id, request, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (!conv) return jsonErr('Not found', 404);
  const body = await parseJSON(request);
  const title = (body?.title ?? '').trim().slice(0, 200);
  if (!title) return jsonErr('Title required');
  await env.DB.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .bind(title, new Date().toISOString(), id).run();
  return jsonOk({ ok: true });
}

async function deleteConversation(id, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (!conv) return jsonErr('Not found', 404);
  await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id).run();
  return jsonOk({ ok: true });
}

// ── Messages ───────────────────────────────────────────────────────────────

async function listMessages(convId, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(convId, user.id).first();
  if (!conv) return jsonErr('Not found', 404);

  const rows = await env.DB.prepare(
    `SELECT m.*, im.url as image_url,
       (SELECT json_group_array(json_object('id',c.id,'position',c.position,'title',c.title,'url',c.url,'domain',c.domain,'excerpt',c.excerpt))
        FROM citations c WHERE c.message_id = m.id) as citations_json,
       (SELECT type FROM reactions r WHERE r.message_id = m.id AND r.user_id = ?) as user_reaction
     FROM messages m
     LEFT JOIN image_meta im ON m.image_meta_id = im.id
     WHERE m.conversation_id = ? ORDER BY m.created_at ASC`
  ).bind(user.id, convId).all();

  const messages = (rows.results ?? []).map(m => ({
    ...m,
    citations: m.citations_json ? tryParse(m.citations_json) : [],
    citations_json: undefined,
  }));
  return jsonOk({ messages });
}

async function sendMessage(convId, request, env, user) {
  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .bind(convId, user.id).first();
  if (!conv) return jsonErr('Not found', 404);

  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();
  if (pending) return jsonErr('A response is already pending', 409);

  const body        = await parseJSON(request);
  const content     = (body?.content ?? '').trim();
  const imageMetaId = body?.image_meta_id ?? null;
  if (!content && !imageMetaId) return jsonErr('Content required');

  if (imageMetaId) {
    const img = await env.DB.prepare('SELECT id FROM image_meta WHERE id = ? AND user_id = ?')
      .bind(imageMetaId, user.id).first();
    if (!img) return jsonErr('Image not found', 404);
  }

  const now      = new Date().toISOString();
  const userMsgId = newId('m');
  const asstMsgId = newId('m');

  await env.DB.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, status, image_meta_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(userMsgId, convId, 'user', content, 'done', imageMetaId, now, now).run();

  await env.DB.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(asstMsgId, convId, 'assistant', '', 'pending', now, now).run();

  const s   = await env.DB.prepare("SELECT value FROM settings WHERE key = 'chat_expiry_days'").first();
  const exp = new Date(Date.now() + parseInt(s?.value ?? '30') * 86400000).toISOString();

  let newTitle = conv.title;
  if (conv.title === 'New conversation' && content) {
    newTitle = content.slice(0, 60).trim();
  }
  await env.DB.prepare(
    "UPDATE conversations SET updated_at = ?, expires_at = ?, expiry_state = 'active', title = ? WHERE id = ?"
  ).bind(now, exp, newTitle, convId).run();

  return jsonOk({
    user_message: { id: userMsgId, conversation_id: convId, role: 'user', content, status: 'done', image_meta_id: imageMetaId, created_at: now },
    assistant_message: { id: asstMsgId, conversation_id: convId, role: 'assistant', content: '', status: 'pending', created_at: now },
  }, 201);
}

async function cancelMessage(convId, msgId, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(convId, user.id).first();
  if (!conv) return jsonErr('Not found', 404);
  await env.DB.prepare("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE id = ? AND conversation_id = ?")
    .bind(new Date().toISOString(), msgId, convId).run();
  await env.DB.prepare('DELETE FROM typing_state WHERE message_id = ?').bind(msgId).run();
  return jsonOk({ ok: true });
}

async function editUserMessage(convId, msgId, request, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(convId, user.id).first();
  if (!conv) return jsonErr('Not found', 404);
  const body    = await parseJSON(request);
  const content = (body?.content ?? '').trim();
  if (!content) return jsonErr('Content required');
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE messages SET content = ?, updated_at = ? WHERE id = ? AND conversation_id = ? AND role = 'user'")
    .bind(content, now, msgId, convId).run();
  return jsonOk({ ok: true });
}

async function streamMessage(convId, msgId, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(convId, user.id).first();
  if (!conv) return jsonErr('Not found', 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc    = new TextEncoder();

  let lastLen = 0;
  let polls   = 0;

  const poll = async () => {
    const msg = await env.DB.prepare('SELECT content, status FROM messages WHERE id = ? AND conversation_id = ?')
      .bind(msgId, convId).first();
    if (!msg) { await writer.write(enc.encode('data: {"error":"Not found"}\n\n')); await writer.close(); return; }

    const ts      = await env.DB.prepare('SELECT partial_content FROM typing_state WHERE message_id = ?').bind(msgId).first();
    const current = ts?.partial_content || msg.content || '';

    if (current.length > lastLen) {
      const delta = current.slice(lastLen);
      lastLen = current.length;
      await writer.write(enc.encode(`data: ${JSON.stringify({ delta })}\n\n`));
    }

    if (msg.status === 'done' || msg.status === 'cancelled') {
      if (msg.content.length > lastLen) {
        await writer.write(enc.encode(`data: ${JSON.stringify({ delta: msg.content.slice(lastLen) })}\n\n`));
      }
      await writer.write(enc.encode('data: [DONE]\n\n'));
      await writer.close();
      return;
    }

    if (++polls >= 240) { await writer.write(enc.encode('data: [DONE]\n\n')); await writer.close(); return; }
    await new Promise(r => setTimeout(r, 1000));
    return poll();
  };

  poll().catch(() => writer.close().catch(() => {}));

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

// ── Reactions ──────────────────────────────────────────────────────────────

async function addReaction(msgId, request, env, user) {
  const body = await parseJSON(request);
  const type = body?.type;
  if (!['up','down'].includes(type)) return jsonErr('Type must be up or down');
  const msg = await env.DB.prepare(
    `SELECT m.id FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE m.id = ? AND c.user_id = ?`
  ).bind(msgId, user.id).first();
  if (!msg) return jsonErr('Not found', 404);
  await env.DB.prepare(
    `INSERT INTO reactions (id, message_id, user_id, type, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(message_id, user_id) DO UPDATE SET type = excluded.type`
  ).bind(newId('r'), msgId, user.id, type, new Date().toISOString()).run();
  return jsonOk({ ok: true });
}

async function removeReaction(msgId, env, user) {
  await env.DB.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').bind(msgId, user.id).run();
  return jsonOk({ ok: true });
}

// ── Memory ─────────────────────────────────────────────────────────────────

async function listMemory(env, user) {
  const rows = await env.DB.prepare(
    'SELECT id, content, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 200'
  ).bind(user.id).all();
  return jsonOk({ memories: rows.results ?? [] });
}

async function addMemory(request, env, user) {
  const body    = await parseJSON(request);
  const content = (body?.content ?? '').trim().slice(0, 1000);
  if (!content) return jsonErr('Content required');
  const id  = newId('mem');
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO memories (id, user_id, content, created_at) VALUES (?,?,?,?)')
    .bind(id, user.id, content, now).run();
  return jsonOk({ memory: { id, content, created_at: now } }, 201);
}

async function deleteMemory(id, env, user) {
  await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return jsonOk({ ok: true });
}

// ── Presence ───────────────────────────────────────────────────────────────

async function presencePing(request, env, user) {
  const body  = await parseJSON(request);
  const state = ['active','away','offline'].includes(body?.state) ? body.state : 'active';
  const now   = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO presence (user_id, conversation_id, state, last_seen, user_agent) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET conversation_id=excluded.conversation_id, state=excluded.state, last_seen=excluded.last_seen`
  ).bind(user.id, body?.conversation_id ?? null, state, now, request.headers.get('User-Agent') || '').run();
  return jsonOk({ ok: true });
}

async function presenceTyping(request, env, user) {
  const body     = await parseJSON(request);
  const isTyping = body?.is_typing ? 1 : 0;
  const now      = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO presence (user_id, conversation_id, is_typing, last_seen) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET is_typing=excluded.is_typing, conversation_id=excluded.conversation_id, last_seen=excluded.last_seen`
  ).bind(user.id, body?.conversation_id ?? null, isTyping, now).run();
  return jsonOk({ ok: true });
}

// ── Images ─────────────────────────────────────────────────────────────────

async function uploadImage(request, env, user) {
  let formData;
  try { formData = await request.formData(); } catch { return jsonErr('Invalid form data'); }
  const file = formData.get('file');
  if (!file || typeof file === 'string') return jsonErr('No file provided');
  const allowed = ['image/jpeg','image/png','image/webp','image/gif'];
  if (!allowed.includes(file.type)) return jsonErr('Invalid file type');
  if (file.size > 10 * 1024 * 1024)  return jsonErr('File too large');

  const id  = newId('img');
  const ext = file.type.split('/')[1].replace('jpeg','jpg');
  const key = `images/${user.id}/${id}.${ext}`;
  const now = new Date().toISOString();

  const buf = await file.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  const url = `data:${file.type};base64,${b64}`;

  await env.DB.prepare(
    'INSERT INTO image_meta (id, user_id, filename, mime_type, size_bytes, storage_key, url, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, user.id, file.name, file.type, file.size, key, url, now).run();

  return jsonOk({ id, url, filename: file.name }, 201);
}

// ── Sharing ────────────────────────────────────────────────────────────────

async function createShare(convId, request, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(convId, user.id).first();
  if (!conv) return jsonErr('Not found', 404);
  const body  = await parseJSON(request).catch(() => ({}));
  const token = newId('sh');
  const now   = new Date().toISOString();
  const exp   = body?.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;
  await env.DB.prepare(
    'INSERT OR REPLACE INTO share_tokens (id, conversation_id, token, expires_at, created_at) VALUES (?,?,?,?,?)'
  ).bind(newId(), convId, token, exp, now).run();
  return jsonOk({ token, expires_at: exp });
}

async function revokeShare(convId, env, user) {
  const conv = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .bind(convId, user.id).first();
  if (!conv) return jsonErr('Not found', 404);
  await env.DB.prepare('DELETE FROM share_tokens WHERE conversation_id = ?').bind(convId).run();
  return jsonOk({ ok: true });
}

async function getShared(token, env) {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT st.conversation_id, st.expires_at, c.title FROM share_tokens st
     JOIN conversations c ON st.conversation_id = c.id WHERE st.token = ?`
  ).bind(token).first();
  if (!row) return jsonErr('Not found', 404);
  if (row.expires_at && row.expires_at < now) return jsonErr('Share link expired', 410);
  const msgs = await env.DB.prepare(
    `SELECT m.id, m.role, m.content, m.created_at, im.url as image_url
     FROM messages m LEFT JOIN image_meta im ON m.image_meta_id = im.id
     WHERE m.conversation_id = ? AND m.status = 'done' ORDER BY m.created_at ASC`
  ).bind(row.conversation_id).all();
  return jsonOk({ conversation: { id: row.conversation_id, title: row.title }, messages: msgs.results ?? [] });
}

// ── Admin routes ───────────────────────────────────────────────────────────

async function adminDashboard(env, admin) {
  const fiveMin = new Date(Date.now() - 5 * 60000).toISOString();
  const [active, pending, total] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM presence WHERE last_seen > ? AND state != 'offline'").bind(fiveMin).first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM messages WHERE status = 'pending'").first(),
    env.DB.prepare("SELECT COUNT(*) as n FROM conversations WHERE expiry_state != 'expired'").first(),
  ]);
  const reactions = await env.DB.prepare(
    "SELECT type, COUNT(*) as n FROM reactions WHERE created_at > datetime('now', '-24 hours') GROUP BY type"
  ).all();
  const liveUsers = await env.DB.prepare(
    `SELECT p.user_id, p.state, p.is_typing, p.conversation_id, p.last_seen,
            u.email, u.display_name, c.title as conv_title
     FROM presence p JOIN users u ON p.user_id = u.id
     LEFT JOIN conversations c ON p.conversation_id = c.id
     WHERE p.last_seen > ? ORDER BY p.last_seen DESC`
  ).bind(fiveMin).all();
  const queue = await env.DB.prepare(
    `SELECT m.id, m.conversation_id, m.created_at, c.title as conv_title,
            u.email as user_email, u.display_name as user_name
     FROM messages m JOIN conversations c ON m.conversation_id = c.id
     JOIN users u ON c.user_id = u.id
     WHERE m.status = 'pending' ORDER BY m.created_at ASC`
  ).all();
  const rxMap = (reactions.results ?? []).reduce((a, r) => { a[r.type] = r.n; return a; }, { up: 0, down: 0 });
  return jsonOk({
    stats: { active_users: active?.n ?? 0, pending_msgs: pending?.n ?? 0, total_convs: total?.n ?? 0, reactions_24h: rxMap },
    live_users: liveUsers.results ?? [],
    queue: queue.results ?? [],
  });
}

async function adminUsers(env) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.created_at, p.state, p.last_seen, p.is_typing
     FROM users u LEFT JOIN presence p ON u.id = p.user_id ORDER BY u.created_at DESC`
  ).all();
  return jsonOk({ users: rows.results ?? [] });
}

async function adminConversations(env, request) {
  const url    = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  let q = `SELECT c.id, c.title, c.user_id, c.created_at, c.updated_at, c.expiry_state, c.expires_at,
            u.email as user_email, u.display_name as user_name,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.status = 'pending') as pending_count
           FROM conversations c JOIN users u ON c.user_id = u.id
           WHERE c.expiry_state != 'expired'`;
  const rows = userId
    ? await env.DB.prepare(q + ' AND c.user_id = ? ORDER BY c.updated_at DESC LIMIT 200').bind(userId).all()
    : await env.DB.prepare(q + ' ORDER BY c.updated_at DESC LIMIT 200').all();
  return jsonOk({ conversations: rows.results ?? [] });
}

async function adminConvMessages(convId, env) {
  const msgs = await env.DB.prepare(
    `SELECT m.*, im.url as image_url,
       (SELECT json_group_array(json_object('type',r.type,'user_id',r.user_id,'email',u.email))
        FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = m.id) as reactions_json
     FROM messages m LEFT JOIN image_meta im ON m.image_meta_id = im.id
     WHERE m.conversation_id = ? ORDER BY m.created_at ASC`
  ).bind(convId).all();
  const messages = (msgs.results ?? []).map(m => ({
    ...m,
    reactions: m.reactions_json ? tryParse(m.reactions_json) : [],
    reactions_json: undefined,
  }));
  return jsonOk({ messages });
}

async function adminReply(convId, request, env, admin) {
  const body    = await parseJSON(request);
  const content = (body?.content ?? '').trim();
  if (!content) return jsonErr('Content required');
  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();
  if (!pending) return jsonErr('No pending message', 404);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE messages SET content = ?, status = 'done', updated_at = ? WHERE id = ?")
    .bind(content, now, pending.id).run();
  const citations = body?.citations ?? [];
  for (let i = 0; i < citations.length; i++) {
    const c = citations[i];
    await env.DB.prepare(
      'INSERT INTO citations (id, message_id, position, title, url, domain, excerpt, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(newId('c'), pending.id, i + 1, c.title ?? '', c.url ?? '', c.domain ?? '', c.excerpt ?? '', now).run();
  }
  await env.DB.prepare('DELETE FROM typing_state WHERE message_id = ?').bind(pending.id).run();
  await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, convId).run();
  return jsonOk({ ok: true, message_id: pending.id });
}

async function adminChunk(convId, request, env, admin) {
  const body    = await parseJSON(request);
  const chunk   = body?.chunk ?? '';
  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();
  if (!pending) return jsonErr('No pending message', 404);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO typing_state (message_id, conversation_id, partial_content, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(message_id) DO UPDATE SET partial_content = partial_content || excluded.partial_content, updated_at = excluded.updated_at`
  ).bind(pending.id, convId, chunk, now).run();
  return jsonOk({ ok: true });
}

async function adminFinish(convId, request, env, admin) {
  const body    = await parseJSON(request).catch(() => ({}));
  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();
  if (!pending) return jsonErr('No pending message', 404);
  const ts      = await env.DB.prepare('SELECT partial_content FROM typing_state WHERE message_id = ?').bind(pending.id).first();
  const content = body?.content ?? ts?.partial_content ?? '';
  const now     = new Date().toISOString();
  await env.DB.prepare("UPDATE messages SET content = ?, status = 'done', updated_at = ? WHERE id = ?")
    .bind(content, now, pending.id).run();
  await env.DB.prepare('DELETE FROM typing_state WHERE message_id = ?').bind(pending.id).run();
  await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, convId).run();
  return jsonOk({ ok: true });
}

async function adminEditMsg(msgId, request, env) {
  const body    = await parseJSON(request);
  const content = (body?.content ?? '').trim();
  if (!content) return jsonErr('Content required');
  await env.DB.prepare("UPDATE messages SET content = ?, updated_at = ? WHERE id = ? AND role = 'assistant'")
    .bind(content, new Date().toISOString(), msgId).run();
  return jsonOk({ ok: true });
}

async function adminAssign(request, env, admin) {
  const body = await parseJSON(request);
  if (!body?.conversation_id) return jsonErr('conversation_id required');
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO assignments (id, conversation_id, admin_id, assigned_at) VALUES (?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET admin_id=excluded.admin_id, assigned_at=excluded.assigned_at`
  ).bind(newId(), body.conversation_id, admin.id, now).run();
  return jsonOk({ ok: true });
}

async function adminUnassign(request, env, admin) {
  const body = await parseJSON(request);
  if (!body?.conversation_id) return jsonErr('conversation_id required');
  await env.DB.prepare('DELETE FROM assignments WHERE conversation_id = ? AND admin_id = ?')
    .bind(body.conversation_id, admin.id).run();
  return jsonOk({ ok: true });
}

async function adminAddNote(request, env, admin) {
  const body = await parseJSON(request);
  const { target_type, target_id, content, highlight_text, tag } = body ?? {};
  if (!target_type || !target_id || !content) return jsonErr('target_type, target_id, content required');
  if (!['user','conversation','message'].includes(target_type)) return jsonErr('Invalid target_type');
  const id  = newId('n');
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO internal_notes (id, admin_id, target_type, target_id, content, highlight_text, tag, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, admin.id, target_type, target_id, content.trim(), highlight_text ?? null, tag ?? null, now).run();
  return jsonOk({ note: { id, target_type, target_id, content, created_at: now } }, 201);
}

async function adminGetNotes(targetId, request, env) {
  const url        = new URL(request.url);
  const targetType = url.searchParams.get('type') ?? 'conversation';
  const rows = await env.DB.prepare(
    `SELECT n.*, a.display_name as admin_name FROM internal_notes n
     JOIN admins a ON n.admin_id = a.id WHERE n.target_id = ? AND n.target_type = ? ORDER BY n.created_at DESC`
  ).bind(targetId, targetType).all();
  return jsonOk({ notes: rows.results ?? [] });
}

async function adminDeleteNote(noteId, env, admin) {
  await env.DB.prepare('DELETE FROM internal_notes WHERE id = ? AND admin_id = ?').bind(noteId, admin.id).run();
  return jsonOk({ ok: true });
}

async function adminExpiring(env) {
  const now     = new Date().toISOString();
  const warnDay = new Date(Date.now() + 3 * 86400000).toISOString();
  const expiring = await env.DB.prepare(
    `SELECT c.id, c.title, c.expires_at, u.email FROM conversations c JOIN users u ON c.user_id = u.id
     WHERE c.expires_at < ? AND c.expires_at > ? AND c.preserved = 0 ORDER BY c.expires_at ASC`
  ).bind(warnDay, now).all();
  const expired = await env.DB.prepare(
    `SELECT c.id, c.title, c.expires_at, u.email FROM conversations c JOIN users u ON c.user_id = u.id
     WHERE c.expires_at < ? AND c.expiry_state != 'expired' ORDER BY c.expires_at DESC LIMIT 50`
  ).bind(now).all();
  return jsonOk({ expiring: expiring.results ?? [], recently_expired: expired.results ?? [] });
}

async function adminPreserve(convId, env) {
  await env.DB.prepare("UPDATE conversations SET preserved = 1, expiry_state = 'active', expires_at = NULL WHERE id = ?")
    .bind(convId).run();
  return jsonOk({ ok: true });
}

async function adminAnalytics(env) {
  const [msgs, sessions, reactions] = await Promise.all([
    env.DB.prepare(
      `SELECT DATE(created_at) as date, COUNT(*) as count FROM messages WHERE role = 'user'
       AND created_at > datetime('now', '-30 days') GROUP BY DATE(created_at) ORDER BY date ASC`
    ).all(),
    env.DB.prepare("SELECT COUNT(*) as total FROM sessions WHERE role = 'user'").first(),
    env.DB.prepare("SELECT type, COUNT(*) as count FROM reactions GROUP BY type").all(),
  ]);
  return jsonOk({ messages_per_day: msgs.results ?? [], sessions, reactions: reactions.results ?? [] });
}

async function adminGetSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  return jsonOk({ settings: Object.fromEntries((rows.results ?? []).map(r => [r.key, r.value])) });
}

async function adminSaveSettings(request, env) {
  const body = await parseJSON(request);
  if (!body) return jsonErr('Invalid JSON');
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
    ).bind(key, String(value), now).run();
  }
  return jsonOk({ ok: true });
}

// ── Crypto helpers ─────────────────────────────────────────────────────────

async function hashPassword(password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hash    = hex(new Uint8Array(bits));
  const saltHex = hex(salt);
  return `pbkdf2:${saltHex}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, hash] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return hex(new Uint8Array(bits)) === hash;
}

function hex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Misc helpers ───────────────────────────────────────────────────────────

function newId(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id    = Array.from(bytes).map(b => b.toString(36)).join('');
  return prefix ? `${prefix}_${id}` : id;
}

function newConvId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(20))).map(b => chars[b % chars.length]).join('');
}

function parseCookies(request) {
  const str = request.headers.get('Cookie') || '';
  return Object.fromEntries(str.split(';').map(p => p.trim().split('=').map(s => decodeURIComponent(s.trim()))).filter(p => p.length === 2));
}

function makeCookie(name, value, maxAge, httpOnly = true) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}; Secure`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`;
}

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

function corsResponse(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
  r.headers.set('Access-Control-Allow-Credentials', 'true');
  return r;
}

async function parseJSON(request) {
  try { return await request.json(); } catch { return null; }
}

function tryParse(str) {
  try { return JSON.parse(str); } catch { return []; }
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
