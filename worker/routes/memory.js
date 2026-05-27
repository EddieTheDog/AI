// worker/routes/memory.js

import { json, err, newId } from '../lib/response.js';

export async function handleMemory(path, method, request, env, user) {
  if (path === '/memory' && method === 'GET')  return listMemory(env, user);
  if (path === '/memory' && method === 'POST') return addMemory(request, env, user);

  const searchMatch = path.match(/^\/memory\/search$/);
  if (searchMatch && method === 'GET') return searchMemory(request, env, user);

  const idMatch = path.match(/^\/memory\/([^/]+)$/);
  if (idMatch && method === 'DELETE') return deleteMemory(idMatch[1], env, user);

  return err('Not found', 404);
}

async function listMemory(env, user) {
  const rows = await env.DB.prepare(
    'SELECT id, content, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 200'
  ).bind(user.id).all();
  return json({ memories: rows.results ?? [] });
}

async function addMemory(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const content = (body.content ?? '').trim().slice(0, 1000);
  if (!content) return err('Content required');

  const id  = newId('mem');
  const now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO memories (id, user_id, content, created_at) VALUES (?,?,?,?)'
  ).bind(id, user.id, content, now).run();

  return json({ memory: { id, content, created_at: now } }, 201);
}

async function deleteMemory(id, env, user) {
  const mem = await env.DB.prepare(
    'SELECT id FROM memories WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!mem) return err('Memory not found', 404);

  await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function searchMemory(request, env, user) {
  const url   = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return json({ memories: [] });

  const rows = await env.DB.prepare(
    `SELECT id, content, created_at FROM memories
     WHERE user_id = ? AND content LIKE ?
     ORDER BY created_at DESC LIMIT 50`
  ).bind(user.id, `%${query}%`).all();

  return json({ memories: rows.results ?? [] });
}
