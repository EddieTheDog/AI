// worker/middleware/auth.js

import { parseCookies } from '../lib/response.js';

const SESSION_COOKIE_USER  = 'sid';
const SESSION_COOKIE_ADMIN = 'asid';

/**
 * Validates session cookie and returns the authenticated entity or null.
 * @param {Request} request
 * @param {object} env - Cloudflare Worker env (env.DB = D1)
 * @param {'user'|'admin'} role
 * @returns {object|null}
 */
export async function authMiddleware(request, env, role = 'user') {
  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const cookieName = role === 'admin' ? SESSION_COOKIE_ADMIN : SESSION_COOKIE_USER;
  const sessionId  = cookies[cookieName];

  if (!sessionId) return null;

  const now = new Date().toISOString();

  const row = await env.DB.prepare(
    `SELECT s.*, 
      CASE WHEN s.role = 'user'  THEN u.id  ELSE NULL END AS uid,
      CASE WHEN s.role = 'user'  THEN u.email ELSE NULL END AS uemail,
      CASE WHEN s.role = 'user'  THEN u.display_name ELSE NULL END AS uname,
      CASE WHEN s.role = 'admin' THEN a.id  ELSE NULL END AS aid,
      CASE WHEN s.role = 'admin' THEN a.email ELSE NULL END AS aemail,
      CASE WHEN s.role = 'admin' THEN a.display_name ELSE NULL END AS aname
     FROM sessions s
     LEFT JOIN users  u ON s.user_id  = u.id AND s.role = 'user'
     LEFT JOIN admins a ON s.admin_id = a.id AND s.role = 'admin'
     WHERE s.id = ? AND s.role = ? AND s.expires_at > ?`
  ).bind(sessionId, role, now).first();

  if (!row) return null;

  if (role === 'user') {
    return { id: row.uid, email: row.uemail, display_name: row.uname, session_id: row.id };
  } else {
    // Update admin last_active
    await env.DB.prepare(`UPDATE admins SET last_active = ? WHERE id = ?`)
      .bind(now, row.aid).run();
    return { id: row.aid, email: row.aemail, display_name: row.aname, session_id: row.id };
  }
}
