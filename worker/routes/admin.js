// worker/routes/admin.js

import { json, err, newId, hashPassword, verifyPassword,
         sessionCookie, generateCsrf, parseCookies } from '../lib/response.js';

const ADMIN_SESSION_DURATION = 60 * 60 * 12; // 12 hours

export async function handleAdmin(path, method, request, env, admin) {
  // Admin auth (no admin session required for login)
  if (path === '/login'    && method === 'POST') return adminLogin(request, env);
  if (path === '/register' && method === 'POST') return adminRegister(request, env);
  if (path === '/logout'   && method === 'POST') return adminLogout(request, env);
  if (path === '/me'       && method === 'GET')  return adminMe(request, env);

  // All below require valid admin session (passed in via admin param)
  if (!admin) return err('Unauthorized', 401);

  // Dashboard
  if (path === '/dashboard'         && method === 'GET') return getDashboard(env, admin);
  if (path === '/users'             && method === 'GET') return getUsers(env);
  if (path === '/conversations'     && method === 'GET') return getConversations(env, request);
  if (path === '/expiring'          && method === 'GET') return getExpiringChats(env);

  // Conversation detail
  const convMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
  if (convMatch && method === 'GET') return getConvMessages(convMatch[1], env);

  // Send / stream response as admin
  const replyMatch = path.match(/^\/conversations\/([^/]+)\/reply$/);
  if (replyMatch && method === 'POST') return adminReply(replyMatch[1], request, env, admin);

  // Stream chunk (admin types incrementally)
  const chunkMatch = path.match(/^\/conversations\/([^/]+)\/chunk$/);
  if (chunkMatch && method === 'POST') return adminChunk(chunkMatch[1], request, env, admin);

  // Finish streaming
  const finishMatch = path.match(/^\/conversations\/([^/]+)\/finish$/);
  if (finishMatch && method === 'POST') return adminFinish(finishMatch[1], request, env, admin);

  // Edit assistant message
  const editMatch = path.match(/^\/messages\/([^/]+)\/edit$/);
  if (editMatch && method === 'PATCH') return adminEditMessage(editMatch[1], request, env, admin);

  // Assignment
  if (path === '/assign' && method === 'POST')   return assignConversation(request, env, admin);
  if (path === '/unassign' && method === 'POST') return unassignConversation(request, env, admin);

  // Notes
  if (path === '/notes' && method === 'POST') return addNote(request, env, admin);
  const notesMatch = path.match(/^\/notes\/([^/]+)$/);
  if (notesMatch && method === 'GET')    return getNotes(notesMatch[1], request, env);
  if (notesMatch && method === 'DELETE') return deleteNote(notesMatch[1], env, admin);

  // Reactions
  if (path === '/reactions' && method === 'GET') return getReactions(env, request);

  // Preserve chat
  const preserveMatch = path.match(/^\/conversations\/([^/]+)\/preserve$/);
  if (preserveMatch && method === 'POST') return preserveChat(preserveMatch[1], env);

  // Analytics
  if (path === '/analytics' && method === 'GET') return getAnalytics(env);

  // Settings
  if (path === '/settings' && method === 'GET')   return getSettings(env);
  if (path === '/settings' && method === 'PATCH') return updateSettings(request, env);

  return err('Not found', 404);
}

// ── Admin Auth ─────────────────────────────────────────────────────────────

async function adminLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return err('Email and password required');

  const admin = await env.DB.prepare(
    'SELECT * FROM admins WHERE email = ?'
  ).bind(email.toLowerCase().trim()).first();

  if (!admin) return err('Invalid credentials', 401);

  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) return err('Invalid credentials', 401);

  return createAdminSession(admin, request, env);
}

async function adminRegister(request, env) {
  // Only allow if no admins exist yet (first-run bootstrap) OR via secret key
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { email, password, display_name, setup_key } = body;

  const count = await env.DB.prepare('SELECT COUNT(*) as n FROM admins').first();
  const isFirstAdmin = (count?.n ?? 0) === 0;

  if (!isFirstAdmin) {
    // Require setup key for subsequent admins
    const expectedKey = env.ADMIN_SETUP_KEY;
    if (!expectedKey || setup_key !== expectedKey) {
      return err('Invalid setup key', 403);
    }
  }

  if (!email || !password || !display_name) return err('All fields required');
  if (password.length < 12) return err('Admin password must be at least 12 characters');

  const existing = await env.DB.prepare(
    'SELECT id FROM admins WHERE email = ?'
  ).bind(email.toLowerCase().trim()).first();
  if (existing) return err('Email already in use', 409);

  const id   = newId('a');
  const hash = await hashPassword(password);
  const now  = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO admins (id, email, display_name, password_hash, created_at) VALUES (?,?,?,?,?)'
  ).bind(id, email.toLowerCase().trim(), display_name.trim(), hash, now).run();

  const admin = { id, email: email.toLowerCase().trim(), display_name: display_name.trim() };
  return createAdminSession(admin, request, env);
}

async function adminLogout(request, env) {
  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies['asid'];
  if (sessionId) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', sessionCookie('asid', '', -1));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function adminMe(request, env) {
  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies['asid'];
  if (!sessionId) return json({ admin: null });

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT a.id, a.email, a.display_name FROM sessions s
     JOIN admins a ON s.admin_id = a.id
     WHERE s.id = ? AND s.role = 'admin' AND s.expires_at > ?`
  ).bind(sessionId, now).first();

  return json({ admin: row ?? null });
}

async function createAdminSession(admin, request, env) {
  const sessionId = newId('as');
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_DURATION * 1000).toISOString();
  const now       = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (id, admin_id, role, expires_at, created_at, user_agent, ip_address) VALUES (?,?,?,?,?,?,?)'
  ).bind(
    sessionId, admin.id, 'admin', expiresAt, now,
    request.headers.get('User-Agent') || '',
    request.headers.get('CF-Connecting-IP') || ''
  ).run();

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', sessionCookie('asid', sessionId, ADMIN_SESSION_DURATION));

  return new Response(JSON.stringify({
    admin: { id: admin.id, email: admin.email, display_name: admin.display_name }
  }), { status: 200, headers });
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function getDashboard(env, admin) {
  const now     = new Date().toISOString();
  const fiveMin = new Date(Date.now() - 5 * 60000).toISOString();

  const [activeUsers, pendingMsgs, totalConvs, recentReactions] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) as n FROM presence WHERE last_seen > ? AND state != 'offline'"
    ).bind(fiveMin).first(),

    env.DB.prepare(
      "SELECT COUNT(*) as n FROM messages WHERE status = 'pending'"
    ).first(),

    env.DB.prepare(
      'SELECT COUNT(*) as n FROM conversations WHERE expiry_state != ?'
    ).bind('expired').first(),

    env.DB.prepare(
      `SELECT r.type, COUNT(*) as n FROM reactions r
       WHERE r.created_at > datetime('now', '-24 hours')
       GROUP BY r.type`
    ).all(),
  ]);

  // Live presence with conversation info
  const liveUsers = await env.DB.prepare(
    `SELECT p.user_id, p.state, p.is_typing, p.conversation_id, p.last_seen,
            u.email, u.display_name,
            c.title as conv_title,
            a.admin_id as assigned_admin_id
     FROM presence p
     JOIN users u ON p.user_id = u.id
     LEFT JOIN conversations c ON p.conversation_id = c.id
     LEFT JOIN assignments a ON c.id = a.conversation_id
     WHERE p.last_seen > ?
     ORDER BY p.last_seen DESC`
  ).bind(fiveMin).all();

  // Pending message queue
  const queue = await env.DB.prepare(
    `SELECT m.id, m.conversation_id, m.created_at,
            c.title as conv_title, c.user_id,
            u.email as user_email, u.display_name as user_name,
            a.admin_id as assigned_admin_id
     FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     JOIN users u ON c.user_id = u.id
     LEFT JOIN assignments a ON c.id = a.conversation_id
     WHERE m.status = 'pending'
     ORDER BY m.created_at ASC`
  ).all();

  return json({
    stats: {
      active_users:   activeUsers?.n ?? 0,
      pending_msgs:   pendingMsgs?.n ?? 0,
      total_convs:    totalConvs?.n ?? 0,
      reactions_24h:  reactionSummary(recentReactions.results ?? []),
    },
    live_users: liveUsers.results ?? [],
    queue:      queue.results ?? [],
  });
}

function reactionSummary(rows) {
  return rows.reduce((acc, r) => { acc[r.type] = r.n; return acc; }, { up: 0, down: 0 });
}

// ── Users ──────────────────────────────────────────────────────────────────

async function getUsers(env) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.created_at,
            p.state, p.last_seen, p.conversation_id, p.is_typing
     FROM users u
     LEFT JOIN presence p ON u.id = p.user_id
     ORDER BY u.created_at DESC`
  ).all();
  return json({ users: rows.results ?? [] });
}

// ── Conversations ──────────────────────────────────────────────────────────

async function getConversations(env, request) {
  const url    = new URL(request.url);
  const userId = url.searchParams.get('user_id');

  let query = `
    SELECT c.id, c.title, c.user_id, c.created_at, c.updated_at, c.expiry_state, c.expires_at,
           u.email as user_email, u.display_name as user_name,
           a.admin_id as assigned_admin_id,
           ad.display_name as assigned_admin_name,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.status = 'pending') as pending_count
    FROM conversations c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN assignments a ON c.id = a.conversation_id
    LEFT JOIN admins ad ON a.admin_id = ad.id
    WHERE c.expiry_state != 'expired'
  `;

  const bindings = [];
  if (userId) { query += ' AND c.user_id = ?'; bindings.push(userId); }
  query += ' ORDER BY c.updated_at DESC LIMIT 200';

  const rows = bindings.length
    ? await env.DB.prepare(query).bind(...bindings).all()
    : await env.DB.prepare(query).all();

  return json({ conversations: rows.results ?? [] });
}

async function getConvMessages(convId, env) {
  const msgs = await env.DB.prepare(
    `SELECT m.*, im.url as image_url,
       (SELECT json_group_array(json_object(
         'id',c.id,'position',c.position,'title',c.title,
         'url',c.url,'domain',c.domain,'excerpt',c.excerpt
       )) FROM citations c WHERE c.message_id = m.id) as citations_json,
       (SELECT json_group_array(json_object(
         'type',r.type,'user_id',r.user_id,'email',u.email
       )) FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = m.id) as reactions_json
     FROM messages m
     LEFT JOIN image_meta im ON m.image_meta_id = im.id
     WHERE m.conversation_id = ?
     ORDER BY m.created_at ASC`
  ).bind(convId).all();

  const messages = (msgs.results ?? []).map(m => ({
    ...m,
    citations:     m.citations_json  ? JSON.parse(m.citations_json)  : [],
    reactions:     m.reactions_json  ? JSON.parse(m.reactions_json)  : [],
    citations_json: undefined,
    reactions_json: undefined,
  }));

  return json({ messages });
}

// ── Admin Reply ────────────────────────────────────────────────────────────

async function adminReply(convId, request, env, admin) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const content   = (body.content ?? '').trim();
  const citations = body.citations ?? [];

  if (!content) return err('Content required');

  // Find pending message for this conversation
  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();

  if (!pending) return err('No pending message found for this conversation', 404);

  const now = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE messages SET content = ?, status = 'done', updated_at = ? WHERE id = ?"
  ).bind(content, now, pending.id).run();

  // Insert citations
  if (citations.length > 0) {
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      await env.DB.prepare(
        `INSERT INTO citations (id, message_id, position, title, url, domain, excerpt, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(newId('c'), pending.id, i + 1, c.title ?? '', c.url ?? '', c.domain ?? '', c.excerpt ?? '', now).run();
    }
  }

  // Clean up typing state
  await env.DB.prepare('DELETE FROM typing_state WHERE message_id = ?').bind(pending.id).run();

  // Update conversation timestamp
  await env.DB.prepare(
    'UPDATE conversations SET updated_at = ? WHERE id = ?'
  ).bind(now, convId).run();

  // Log analytics
  await env.DB.prepare(
    `INSERT INTO analytics (id, event_type, conversation_id, message_id, metadata, created_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(
    newId(), 'admin_reply', convId, pending.id,
    JSON.stringify({ admin_id: admin.id }),
    now
  ).run();

  return json({ ok: true, message_id: pending.id });
}

// ── Admin Streaming (chunk by chunk) ──────────────────────────────────────

async function adminChunk(convId, request, env, admin) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const chunk = body.chunk ?? '';

  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();
  if (!pending) return err('No pending message', 404);

  const now = new Date().toISOString();

  // Upsert into typing_state
  await env.DB.prepare(
    `INSERT INTO typing_state (message_id, conversation_id, partial_content, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(message_id) DO UPDATE SET
       partial_content = partial_content || excluded.partial_content,
       updated_at      = excluded.updated_at`
  ).bind(pending.id, convId, chunk, now).run();

  return json({ ok: true });
}

async function adminFinish(convId, request, env, admin) {
  let body = {};
  try { body = await request.json(); } catch {}

  const citations = body.citations ?? [];

  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();
  if (!pending) return err('No pending message', 404);

  // Get accumulated content from typing_state
  const ts = await env.DB.prepare(
    'SELECT partial_content FROM typing_state WHERE message_id = ?'
  ).bind(pending.id).first();

  const content = body.content ?? ts?.partial_content ?? '';
  const now     = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE messages SET content = ?, status = 'done', updated_at = ? WHERE id = ?"
  ).bind(content, now, pending.id).run();

  if (citations.length > 0) {
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      await env.DB.prepare(
        `INSERT INTO citations (id, message_id, position, title, url, domain, excerpt, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(newId('c'), pending.id, i + 1, c.title ?? '', c.url ?? '', c.domain ?? '', c.excerpt ?? '', now).run();
    }
  }

  await env.DB.prepare('DELETE FROM typing_state WHERE message_id = ?').bind(pending.id).run();
  await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, convId).run();

  return json({ ok: true });
}

// ── Admin Edit Message ─────────────────────────────────────────────────────

async function adminEditMessage(msgId, request, env, admin) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const content = (body.content ?? '').trim();
  if (!content) return err('Content required');

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE messages SET content = ?, updated_at = ? WHERE id = ? AND role = 'assistant'"
  ).bind(content, now, msgId).run();

  return json({ ok: true });
}

// ── Assignments ────────────────────────────────────────────────────────────

async function assignConversation(request, env, admin) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { conversation_id } = body;
  if (!conversation_id) return err('conversation_id required');

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO assignments (id, conversation_id, admin_id, assigned_at)
     VALUES (?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET admin_id = excluded.admin_id, assigned_at = excluded.assigned_at`
  ).bind(newId(), conversation_id, admin.id, now).run();

  return json({ ok: true });
}

async function unassignConversation(request, env, admin) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { conversation_id } = body;
  if (!conversation_id) return err('conversation_id required');

  await env.DB.prepare(
    'DELETE FROM assignments WHERE conversation_id = ? AND admin_id = ?'
  ).bind(conversation_id, admin.id).run();

  return json({ ok: true });
}

// ── Notes ──────────────────────────────────────────────────────────────────

async function addNote(request, env, admin) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { target_type, target_id, content, highlight_text, tag } = body;
  if (!target_type || !target_id || !content) return err('target_type, target_id, and content required');
  if (!['user','conversation','message'].includes(target_type)) return err('Invalid target_type');

  const id  = newId('n');
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO internal_notes (id, admin_id, target_type, target_id, content, highlight_text, tag, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, admin.id, target_type, target_id, content.trim(), highlight_text ?? null, tag ?? null, now).run();

  return json({ note: { id, target_type, target_id, content, created_at: now } }, 201);
}

async function getNotes(targetId, request, env) {
  const url        = new URL(request.url);
  const targetType = url.searchParams.get('type') ?? 'conversation';

  const rows = await env.DB.prepare(
    `SELECT n.*, a.display_name as admin_name FROM internal_notes n
     JOIN admins a ON n.admin_id = a.id
     WHERE n.target_id = ? AND n.target_type = ?
     ORDER BY n.created_at DESC`
  ).bind(targetId, targetType).all();

  return json({ notes: rows.results ?? [] });
}

async function deleteNote(noteId, env, admin) {
  await env.DB.prepare(
    'DELETE FROM internal_notes WHERE id = ? AND admin_id = ?'
  ).bind(noteId, admin.id).run();
  return json({ ok: true });
}

// ── Reactions ──────────────────────────────────────────────────────────────

async function getReactions(env, request) {
  const url    = new URL(request.url);
  const convId = url.searchParams.get('conversation_id');

  let query = `
    SELECT r.id, r.type, r.created_at, r.note,
           u.email as user_email, u.display_name as user_name,
           m.content as message_preview, m.conversation_id
    FROM reactions r
    JOIN users u ON r.user_id = u.id
    JOIN messages m ON r.message_id = m.id
  `;

  const rows = convId
    ? await env.DB.prepare(query + ' WHERE m.conversation_id = ? ORDER BY r.created_at DESC').bind(convId).all()
    : await env.DB.prepare(query + ' ORDER BY r.created_at DESC LIMIT 100').all();

  return json({ reactions: rows.results ?? [] });
}

// ── Chat Expiry ────────────────────────────────────────────────────────────

async function getExpiringChats(env) {
  const now     = new Date().toISOString();
  const warnDay = new Date(Date.now() + 3 * 86400000).toISOString();

  const expiring = await env.DB.prepare(
    `SELECT c.id, c.title, c.expires_at, c.user_id, u.email
     FROM conversations c JOIN users u ON c.user_id = u.id
     WHERE c.expires_at < ? AND c.expires_at > ? AND c.preserved = 0
     ORDER BY c.expires_at ASC`
  ).bind(warnDay, now).all();

  const expired = await env.DB.prepare(
    `SELECT c.id, c.title, c.expires_at, c.user_id, u.email
     FROM conversations c JOIN users u ON c.user_id = u.id
     WHERE c.expires_at < ? AND c.expiry_state != 'expired'
     ORDER BY c.expires_at DESC LIMIT 50`
  ).bind(now).all();

  // Mark actually expired ones
  if (expired.results?.length) {
    await env.DB.prepare(
      `UPDATE conversations SET expiry_state = 'expired'
       WHERE expires_at < ? AND expiry_state != 'expired' AND preserved = 0`
    ).bind(now).run();
  }

  return json({
    expiring: expiring.results ?? [],
    recently_expired: expired.results ?? [],
  });
}

async function preserveChat(convId, env) {
  await env.DB.prepare(
    "UPDATE conversations SET preserved = 1, expiry_state = 'active', expires_at = NULL WHERE id = ?"
  ).bind(convId).run();
  return json({ ok: true });
}

// ── Analytics ──────────────────────────────────────────────────────────────

async function getAnalytics(env) {
  const [msgStats, sessionStats, reactionStats, deviceStats] = await Promise.all([
    env.DB.prepare(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM messages WHERE role = 'user'
       AND created_at > datetime('now', '-30 days')
       GROUP BY DATE(created_at) ORDER BY date ASC`
    ).all(),

    env.DB.prepare(
      `SELECT COUNT(*) as total,
              AVG((julianday(expires_at) - julianday(created_at)) * 24 * 60) as avg_duration_min
       FROM sessions WHERE role = 'user'`
    ).first(),

    env.DB.prepare(
      `SELECT type, COUNT(*) as count FROM reactions
       GROUP BY type`
    ).all(),

    env.DB.prepare(
      `SELECT user_agent, COUNT(*) as count FROM sessions
       WHERE role = 'user' GROUP BY user_agent ORDER BY count DESC LIMIT 20`
    ).all(),
  ]);

  return json({
    messages_per_day: msgStats.results ?? [],
    sessions:         sessionStats,
    reactions:        reactionStats.results ?? [],
    devices:          deviceStats.results ?? [],
  });
}

// ── Settings ───────────────────────────────────────────────────────────────

async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries((rows.results ?? []).map(r => [r.key, r.value]));
  return json({ settings });
}

async function updateSettings(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind(key, String(value), now).run();
  }

  return json({ ok: true });
}
