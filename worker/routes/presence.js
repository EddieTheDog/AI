// worker/routes/presence.js

import { json, err } from '../lib/response.js';

export async function handlePresence(path, method, request, env, user) {
  if (path === '/presence/ping'   && method === 'POST') return ping(request, env, user);
  if (path === '/presence/typing' && method === 'POST') return typing(request, env, user);
  return err('Not found', 404);
}

async function ping(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const state          = ['active','away','offline'].includes(body.state) ? body.state : 'active';
  const conversationId = body.conversation_id ?? null;
  const now            = new Date().toISOString();
  const tabVisible     = !document; // always 1 from server perspective; client tracks this

  await env.DB.prepare(
    `INSERT INTO presence (user_id, conversation_id, state, last_seen, user_agent)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       state           = excluded.state,
       last_seen       = excluded.last_seen`
  ).bind(user.id, conversationId, state, now, request.headers.get('User-Agent') || '').run();

  return json({ ok: true });
}

async function typing(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const isTyping       = body.is_typing ? 1 : 0;
  const conversationId = body.conversation_id ?? null;

  await env.DB.prepare(
    `INSERT INTO presence (user_id, conversation_id, is_typing, last_seen)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       is_typing       = excluded.is_typing,
       conversation_id = excluded.conversation_id,
       last_seen       = excluded.last_seen`
  ).bind(user.id, conversationId, isTyping, new Date().toISOString()).run();

  return json({ ok: true });
}
