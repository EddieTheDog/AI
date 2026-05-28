/**
 * SIA - Auth Module
 * Manages client-side authentication state.
 * Keeps a single source of truth for the current user session.
 */

import { auth as authAPI } from './api.js';

// ─── State ─────────────────────────────────────────────────────────────────

let _currentUser = null;
let _initialized = false;
let _initPromise = null;

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
  // Already initialized
  if (_initialized) {
    return _currentUser;
  }

  // Existing in-flight request
  if (_initPromise) {
    return _initPromise;
  }

  _initPromise = (async () => {
    try {
      const data = await authAPI.me();
      _setUser(data?.user ?? null);
    } catch {
      _setUser(null);
    } finally {
      _initialized = true;
    }

    return _currentUser;
  })();

  return _initPromise;
}

/**
 * Log in with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<User>}
 */
export async function login(email, password) {
  const data = await authAPI.login(email, password);

  _initialized = true;
  _setUser(data.user);

  return data.user;
}

/**
 * Register a new user account.
 * @param {string} email
 * @param {string} password
 * @param {string} displayName
 * @returns {Promise<User>}
 */
export async function register(email, password, displayName) {
  const data = await authAPI.register(email, password, displayName);

  _initialized = true;
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

    // Reset auth boot state
    _initialized = true;
    _initPromise = null;

    window.location.href = '/';
  }
}

// ─── Accessors ─────────────────────────────────────────────────────────────

/**
 * Get current user.
 * @returns {User|null}
 */
export function currentUser() {
  return _currentUser;
}

/**
 * Whether auth has completed initialization.
 * @returns {boolean}
 */
export function isAuthReady() {
  return _initialized;
}

/**
 * Whether a user is authenticated.
 * @returns {boolean}
 */
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

  // Immediately invoke if auth already initialized
  if (_initialized) {
    try {
      fn(_currentUser);
    } catch (err) {
      console.error('Auth listener failed:', err);
    }
  }

  return () => {
    _listeners.delete(fn);
  };
}

// ─── Guards ────────────────────────────────────────────────────────────────

/**
 * Redirects to login page if user is not authenticated.
 * Use at the top of protected page init functions.
 */
export async function requireAuth(redirectTo = '/') {
  await initAuth();

  if (!_currentUser) {
    const next =
      window.location.pathname +
      window.location.search +
      window.location.hash;

    window.location.href =
      `${redirectTo}?next=${encodeURIComponent(next)}`;

    return false;
  }

  return true;
}

/**
 * Redirects authenticated users away
 * (e.g. from login page).
 */
export async function requireGuest(redirectTo = '/c/new') {
  await initAuth();

  if (_currentUser) {
    window.location.href = redirectTo;
    return false;
  }

  return true;
}

// ─── Session Expiry Handler ────────────────────────────────────────────────

window.addEventListener('sia:unauthorized', () => {
  _setUser(null);

  // Preserve current location for redirect-back flow
  const next =
    window.location.pathname +
    window.location.search +
    window.location.hash;

  // Avoid redirect loop
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href =
      `/?next=${encodeURIComponent(next)}`;
  }
});

// ─── Internal ──────────────────────────────────────────────────────────────

/**
 * Internal user setter.
 * Updates state + notifies listeners.
 * @param {User|null} user
 */
function _setUser(user) {
  _currentUser = user
    ? Object.freeze({ ...user })
    : null;

  _listeners.forEach(fn => {
    try {
      fn(_currentUser);
    } catch (err) {
      console.error('Auth listener failed:', err);
    }
  });
}
