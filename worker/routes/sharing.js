// worker/routes/sharing.js

import { json, err } from '../lib/response.js';

export async function handleSharing(path, method, request, env, user) {
  const match = path.match(/^\/shared\/([^/]+)$/);
  if (match && method === 'GET') return getShared(match[1], env);
  return err('Not found', 404);
}

async function getShared(token, env) {
  const now = new Date().toISOString();

  const row = await env.DB.prepare(
    `SELECT st.conversation_id, st.expires_at, c.title, c.user_id
     FROM share_tokens st
     JOIN conversations c ON st.conversation_id = c.id
     WHERE st.token = ?`
  ).bind(token).first();

  if (!row) return err('Shared conversation not found', 404);
  if (row.expires_at && row.expires_at < now) return err('This share link has expired', 410);

  const msgs = await env.DB.prepare(
    `SELECT m.id, m.role, m.content, m.created_at, im.url as image_url
     FROM messages m
     LEFT JOIN image_meta im ON m.image_meta_id = im.id
     WHERE m.conversation_id = ? AND m.status = 'done'
     ORDER BY m.created_at ASC`
  ).bind(row.conversation_id).all();

  return json({
    conversation: { id: row.conversation_id, title: row.title },
    messages: msgs.results ?? [],
  });
}
