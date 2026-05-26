// worker/lib/response.js

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
  r.headers.set('Access-Control-Allow-Credentials', 'true');
  return r;
}

export function stream(readable, status = 200) {
  return new Response(readable, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// worker/lib/id.js (inlined here for simplicity)

export function newId(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex   = Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('');
  return prefix ? `${prefix}_${hex}` : hex;
}

export function newConvId() {
  // Short random alphanumeric like ChatGPT conversation IDs
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// worker/lib/hash.js (inlined)

export async function hashPassword(password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hash}`;
}

export async function verifyPassword(password, stored) {
  const [, saltHex, hash] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const candidate = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return candidate === hash;
}

// worker/lib/csrf.js (inlined)

export function generateCsrf() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
}

export function validateCsrf(request) {
  const cookie = parseCookies(request.headers.get('Cookie') || '')['csrf'];
  const header = request.headers.get('X-CSRF-Token');
  return cookie && header && cookie === header;
}

export function parseCookies(cookieStr) {
  return Object.fromEntries(
    cookieStr.split(';').map(p => p.trim().split('=').map(decodeURIComponent))
  );
}

export function sessionCookie(name, value, maxAge, secure = true) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
