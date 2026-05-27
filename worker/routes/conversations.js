// worker/routes/conversations.js

import { json, err, newId, newConvId } from '../lib/response.js';

export async function handleConversations(path, method, request, env, user) {
  // /conversations
  if (path === '/conversations') {
    if (method === 'GET')  return listConversations(env, user);
    if (method === 'POST') return createConversation(env, user);
  }

  // /conversations/:id
  const match = path.match(/^\/conversations\/([^/]+)$/);
  if (match) {
    const id = match[1];
    if (method === 'GET')    return getConversation(id, env, user);
    if (method === 'PATCH')  return renameConversation(id, request, env, user);
    if (method === 'DELETE') return deleteConversation(id, env, user);
  }

  // /conversations/:id/messages
  const msgMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
  if (msgMatch) {
    const id = msgMatch[1];
    if (method === 'GET')  return listMessages(id, env, user);
    if (method === 'POST') return sendMessage(id, request, env, user);
  }

  // /conversations/:id/messages/:msgId/cancel
  const cancelMatch = path.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)\/cancel$/);
  if (cancelMatch) {
    const [, convId, msgId] = cancelMatch;
    if (method === 'POST') return cancelMessage(convId, msgId, env, user);
  }

  // /conversations/:id/messages/:msgId (PATCH = edit)
  const editMatch = path.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)$/);
  if (editMatch) {
    const [, convId, msgId] = editMatch;
    if (method === 'PATCH') return editMessage(convId, msgId, request, env, user);
  }

  // /conversations/:id/stream/:msgId
  const streamMatch = path.match(/^\/conversations\/([^/]+)\/stream\/([^/]+)$/);
  if (streamMatch) {
    const [, convId, msgId] = streamMatch;
    if (method === 'GET') return streamMessage(convId, msgId, env, user);
  }

  // /conversations/:id/share
  const shareMatch = path.match(/^\/conversations\/([^/]+)\/share$/);
  if (shareMatch) {
    const id = shareMatch[1];
    if (method === 'POST')   return createShare(id, request, env, user);
    if (method === 'DELETE') return revokeShare(id, env, user);
  }

  return err('Not found', 404);
}

// ── List conversations ─────────────────────────────────────────────────────

async function listConversations(env, user) {
  const rows = await env.DB.prepare(
    `SELECT id, title, created_at, updated_at, expiry_state
     FROM conversations
     WHERE user_id = ? AND expiry_state != 'expired'
     ORDER BY updated_at DESC
     LIMIT 100`
  ).bind(user.id).all();

  return json({ conversations: rows.results ?? [] });
}

// ── Get single conversation ────────────────────────────────────────────────

async function getConversation(id, env, user) {
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();

  if (!conv) return err('Conversation not found', 404);
  return json({ conversation: conv });
}

// ── Create conversation ────────────────────────────────────────────────────

async function createConversation(env, user) {
  const id  = newConvId();
  const now = new Date().toISOString();

  // Set expiry based on settings
  const setting = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'chat_expiry_days'"
  ).first();
  const days     = parseInt(setting?.value ?? '30');
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

  await env.DB.prepare(
    `INSERT INTO conversations (id, user_id, title, created_at, updated_at, expires_at)
     VALUES (?,?,?,?,?,?)`
  ).bind(id, user.id, 'New conversation', now, now, expiresAt).run();

  return json({ conversation: { id, title: 'New conversation', created_at: now, updated_at: now } }, 201);
}

// ── Rename conversation ────────────────────────────────────────────────────

async function renameConversation(id, request, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const title = (body.title ?? '').trim().slice(0, 200);
  if (!title) return err('Title required');

  await env.DB.prepare(
    'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?'
  ).bind(title, new Date().toISOString(), id).run();

  return json({ ok: true });
}

// ── Delete conversation ────────────────────────────────────────────────────

async function deleteConversation(id, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ── List messages ──────────────────────────────────────────────────────────

async function listMessages(convId, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(convId, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  const rows = await env.DB.prepare(
    `SELECT m.*, im.url as image_url,
       (SELECT json_group_array(json_object(
         'id', c.id, 'position', c.position, 'title', c.title,
         'url', c.url, 'domain', c.domain, 'excerpt', c.excerpt
       )) FROM citations c WHERE c.message_id = m.id) as citations_json,
       (SELECT type FROM reactions r WHERE r.message_id = m.id AND r.user_id = ?) as user_reaction
     FROM messages m
     LEFT JOIN image_meta im ON m.image_meta_id = im.id
     WHERE m.conversation_id = ?
     ORDER BY m.created_at ASC`
  ).bind(user.id, convId).all();

  const messages = (rows.results ?? []).map(m => ({
    ...m,
    citations: m.citations_json ? JSON.parse(m.citations_json) : [],
    citations_json: undefined,
  }));

  return json({ messages });
}

// ── Send message ───────────────────────────────────────────────────────────

async function sendMessage(convId, request, env, user) {
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(convId, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  // Check no pending message exists
  const pending = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND status = 'pending'"
  ).bind(convId).first();
  if (pending) return err('A response is already pending', 409);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const content     = (body.content ?? '').trim();
  const imageMetaId = body.image_meta_id ?? null;

  if (!content && !imageMetaId) return err('Message content required');

  // Validate image belongs to user if provided
  if (imageMetaId) {
    const img = await env.DB.prepare(
      'SELECT id FROM image_meta WHERE id = ? AND user_id = ?'
    ).bind(imageMetaId, user.id).first();
    if (!img) return err('Image not found', 404);
  }

  const now       = new Date().toISOString();
  const userMsgId = newId('m');
  const asstMsgId = newId('m');

  // Insert user message
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, status, image_meta_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(userMsgId, convId, 'user', content, 'done', imageMetaId, now, now).run();

  // Insert assistant placeholder (pending)
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(asstMsgId, convId, 'assistant', '', 'pending', now, now).run();

  // Reset expiry on activity
  const setting = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'chat_expiry_days'"
  ).first();
  const days      = parseInt(setting?.value ?? '30');
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

  await env.DB.prepare(
    "UPDATE conversations SET updated_at = ?, expires_at = ?, expiry_state = 'active' WHERE id = ?"
  ).bind(now, expiresAt, convId).run();

  // Generate title from first user message if still default
  if (conv.title === 'New conversation' && content) {
    const title = content.slice(0, 60).trim();
    await env.DB.prepare(
      'UPDATE conversations SET title = ? WHERE id = ?'
    ).bind(title, convId).run();
  }

  const userMsg = {
    id: userMsgId, conversation_id: convId, role: 'user',
    content, status: 'done', image_meta_id: imageMetaId, created_at: now,
  };
  const asstMsg = {
    id: asstMsgId, conversation_id: convId, role: 'assistant',
    content: '', status: 'pending', created_at: now,
  };

  return json({ user_message: userMsg, assistant_message: asstMsg }, 201);
}

// ── Cancel message ─────────────────────────────────────────────────────────

async function cancelMessage(convId, msgId, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(convId, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  await env.DB.prepare(
    "UPDATE messages SET status = 'cancelled', updated_at = ? WHERE id = ? AND conversation_id = ?"
  ).bind(new Date().toISOString(), msgId, convId).run();

  // Clean up typing state
  await env.DB.prepare('DELETE FROM typing_state WHERE message_id = ?').bind(msgId).run();

  return json({ ok: true });
}

// ── Edit message ───────────────────────────────────────────────────────────

async function editMessage(convId, msgId, request, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(convId, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  const msg = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'"
  ).bind(msgId, convId).first();
  if (!msg) return err('Message not found', 404);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const content = (body.content ?? '').trim();
  if (!content) return err('Content required');

  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE messages SET content = ?, updated_at = ? WHERE id = ?'
  ).bind(content, now, msgId).run();

  return json({ message: { ...msg, content, updated_at: now } });
}

// ── Stream message (SSE) ───────────────────────────────────────────────────

async function streamMessage(convId, msgId, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(convId, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc    = new TextEncoder();

  // Poll typing_state for partial content then message for completion
  let lastContent = '';
  let attempts    = 0;
  const MAX_POLLS = 240; // 4 minutes at 1s interval

  const poll = async () => {
    const msg = await env.DB.prepare(
      'SELECT content, status FROM messages WHERE id = ? AND conversation_id = ?'
    ).bind(msgId, convId).first();

    if (!msg) {
      await writer.write(enc.encode(`data: {"error":"Message not found"}\n\n`));
      await writer.close();
      return;
    }

    // Check typing_state for partial content
    const ts = await env.DB.prepare(
      'SELECT partial_content FROM typing_state WHERE message_id = ?'
    ).bind(msgId).first();

    const current = ts?.partial_content || msg.content || '';

    if (current.length > lastContent.length) {
      const delta = current.slice(lastContent.length);
      lastContent = current;
      await writer.write(enc.encode(`data: ${JSON.stringify({ delta })}\n\n`));
    }

    if (msg.status === 'done' || msg.status === 'cancelled') {
      // Send any remaining content
      if (msg.content.length > lastContent.length) {
        const delta = msg.content.slice(lastContent.length);
        await writer.write(enc.encode(`data: ${JSON.stringify({ delta })}\n\n`));
      }
      await writer.write(enc.encode('data: [DONE]\n\n'));
      await writer.close();
      return;
    }

    attempts++;
    if (attempts >= MAX_POLLS) {
      await writer.write(enc.encode('data: [DONE]\n\n'));
      await writer.close();
      return;
    }

    // Poll again after 1s
    await new Promise(r => setTimeout(r, 1000));
    await poll();
  };

  poll().catch(async (e) => {
    try {
      await writer.write(enc.encode(`data: {"error":"Stream error"}\n\n`));
      await writer.close();
    } catch (_) {}
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ── Share ──────────────────────────────────────────────────────────────────

async function createShare(convId, request, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(convId, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  let body = {};
  try { body = await request.json(); } catch {}

  const token     = newId('sh');
  const now       = new Date().toISOString();
  const expiresAt = body.expires_in
    ? new Date(Date.now() + body.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO share_tokens (id, conversation_id, token, expires_at, created_at)
     VALUES (?,?,?,?,?)`
  ).bind(newId(), convId, token, expiresAt, now).run();

  return json({ token, expires_at: expiresAt });
}

async function revokeShare(convId, env, user) {
  const conv = await env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
  ).bind(convId, user.id).first();
  if (!conv) return err('Conversation not found', 404);

  await env.DB.prepare(
    'DELETE FROM share_tokens WHERE conversation_id = ?'
  ).bind(convId).run();

  return json({ ok: true });
}
