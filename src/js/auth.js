/**
 * SIA - Auth Module
 * Manages client-side authentication state.
 * Keeps a single source of truth for the current user session.
 */

import { auth as authAPI } from './api.js';

// ─── State ─────────────────────────────────────────────────────────────────

let _currentUser = null;
let _initialized = false;
const _listeners = new Set();

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} email
 * @property {string} display_name
 * @property {string} created_at
 */

// ─── Core ──────────────────────────────────────────────────────────────────

/**
 * Initialize auth — fetch current session from backend.
 * Safe to call multiple times; only fetches once.
 * @returns {Promise<User|null>}
 */
export async function initAuth() {
  if (_initialized) return _currentUser;
  _initialized = true;

  try {
    const data = await authAPI.me();
    _setUser(data?.user ?? null);
  } catch {
    _setUser(null);
  }

  return _currentUser;
}

/**
 * Log in with email + password.
 * @returns {Promise<User>}
 */
export async function login(email, password) {
  const data = await authAPI.login(email, password);
  _setUser(data.user);
  return data.user;
}

/**
 * Register a new user account.
 * @returns {Promise<User>}
 */
export async function register(email, password, displayName) {
  const data = await authAPI.register(email, password, displayName);
  _setUser(data.user);
  return data.user;
}

/**
 * Log out current user.
 */
export async function logout() {
  try {
    await authAPI.logout();
  } finally {
    _setUser(null);
    window.location.href = '/';
  }
}

// ─── Accessors ─────────────────────────────────────────────────────────────

/** @returns {User|null} */
export function currentUser() {
  return _currentUser;
}

/** @returns {boolean} */
export function isAuthenticated() {
  return _currentUser !== null;
}

// ─── Listeners ─────────────────────────────────────────────────────────────

/**
 * Subscribe to auth state changes.
 * @param {(user: User|null) => void} fn
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(fn) {
  _listeners.add(fn);
  // Immediately invoke if already initialized
  if (_initialized) fn(_currentUser);
  return () => _listeners.delete(fn);
}

// ─── Guards ────────────────────────────────────────────────────────────────

/**
 * Redirects to login page if user is not authenticated.
 * Use at the top of protected page init functions.
 */
export function requireAuth(redirectTo = '/') {
  if (_initialized && !_currentUser) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}

/**
 * Redirects authenticated users away (e.g. from login page).
 */
export function requireGuest(redirectTo = '/c/new') {
  if (_initialized && _currentUser) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}

// ─── Session expiry handler ────────────────────────────────────────────────

window.addEventListener('sia:unauthorized', () => {
  _setUser(null);
  // Soft redirect — don't stomp current URL if already on login
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = `/?next=${encodeURIComponent(window.location.pathname)}`;
  }
});

// ─── Internal ──────────────────────────────────────────────────────────────

function _setUser(user) {
  _currentUser = user;
  _listeners.forEach(fn => fn(user));
}
