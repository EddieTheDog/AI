// worker/routes/auth.js

import { json, err, sessionCookie, generateCsrf, parseCookies,
         hashPassword, verifyPassword, newId } from '../lib/response.js';

const SESSION_DURATION = 60 * 60 * 24 * 30; // 30 days

export async function handleAuth(path, method, request, env) {
  if (path === 'login'    && method === 'POST') return login(request, env);
  if (path === 'register' && method === 'POST') return register(request, env);
  if (path === 'logout'   && method === 'POST') return logout(request, env);
  if (path === 'me'       && method === 'GET')  return me(request, env);
  return err('Not found', 404);
}

// ── Login ──────────────────────────────────────────────────────────────────

async function login(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return err('Email and password required');

  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE email = ?'
  ).bind(email.toLowerCase().trim()).first();

  if (!user) return err('Invalid email or password', 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return err('Invalid email or password', 401);

  return createUserSession(user, request, env);
}

// ── Register ───────────────────────────────────────────────────────────────

async function register(request, env) {
  // Check if registration is enabled
  const setting = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'registration_enabled'"
  ).first();
  if (setting?.value === 'false') return err('Registration is currently disabled', 403);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { email, password, display_name } = body;

  if (!email || !password)      return err('Email and password required');
  if (password.length < 8)      return err('Password must be at least 8 characters');
  if (!display_name?.trim())    return err('Display name required');
  if (!isValidEmail(email))     return err('Invalid email address');

  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email.toLowerCase().trim()).first();

  if (existing) return err('An account with this email already exists', 409);

  const id   = newId('u');
  const hash = await hashPassword(password);
  const now  = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, email.toLowerCase().trim(), display_name.trim(), hash, now, now).run();

  const user = { id, email: email.toLowerCase().trim(), display_name: display_name.trim() };
  return createUserSession(user, request, env);
}

// ── Logout ─────────────────────────────────────────────────────────────────

async function logout(request, env) {
  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies['sid'];

  if (sessionId) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', sessionCookie('sid',  '', -1));
  headers.append('Set-Cookie', sessionCookie('csrf', '', -1));

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// ── Me ─────────────────────────────────────────────────────────────────────

async function me(request, env) {
  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies['sid'];
  if (!sessionId) return json({ user: null });

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.created_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.role = 'user' AND s.expires_at > ?`
  ).bind(sessionId, now).first();

  return json({ user: row ?? null });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function createUserSession(user, request, env) {
  const sessionId = newId('s');
  const csrf      = generateCsrf();
  const expiresAt = new Date(Date.now() + SESSION_DURATION * 1000).toISOString();
  const now       = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, role, expires_at, created_at, user_agent, ip_address) VALUES (?,?,?,?,?,?,?)'
  ).bind(
    sessionId, user.id, 'user', expiresAt, now,
    request.headers.get('User-Agent') || '',
    request.headers.get('CF-Connecting-IP') || ''
  ).run();

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', sessionCookie('sid',  sessionId, SESSION_DURATION));
  headers.append('Set-Cookie', `csrf=${csrf}; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION}; Secure`);

  return new Response(JSON.stringify({
    user: { id: user.id, email: user.email, display_name: user.display_name }
  }), { status: 200, headers });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
