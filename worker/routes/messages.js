// worker/routes/messages.js

import { json, err, newId } from '../lib/response.js';

export async function handleMessages(path, method, request, env, user) {
  // /messages/:id/reactions
  const reactionMatch = path.match(/^\/messages\/([^/]+)\/reactions$/);
  if (reactionMatch) {
    const msgId = reactionMatch[1];
    if (method === 'POST')   return addReaction(msgId, request, env, user);
    if (method === 'DELETE') return removeReaction(msgId, env, user);
  }
  return err('Not found', 404);
}

async function addReaction(msgId, request, env, user) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const type = body.type;
  if (!['up','down'].includes(type)) return err('Type must be up or down');

  const msg = await env.DB.prepare(
    `SELECT m.id FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     WHERE m.id = ? AND c.user_id = ?`
  ).bind(msgId, user.id).first();
  if (!msg) return err('Message not found', 404);

  const id  = newId('r');
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO reactions (id, message_id, user_id, type, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(message_id, user_id) DO UPDATE SET type = excluded.type`
  ).bind(id, msgId, user.id, type, now).run();

  return json({ ok: true });
}

async function removeReaction(msgId, env, user) {
  await env.DB.prepare(
    'DELETE FROM reactions WHERE message_id = ? AND user_id = ?'
  ).bind(msgId, user.id).run();
  return json({ ok: true });
}
