import axios from 'axios';

/**
 * The single axios instance every API module uses.
 *
 * NO TOKEN IS STORED IN JAVASCRIPT.
 *
 * This used to keep a JWT in localStorage and attach it as a bearer header. It
 * no longer does. The session is two httpOnly cookies the browser sends
 * automatically and this code cannot read — so an XSS on any page of the app
 * can no longer walk off with a credential that stays valid for a week.
 *
 * What replaces the request interceptor is `withCredentials: true`, and what
 * replaces "clear the token on a 401" is a single transparent refresh attempt.
 */

const client = axios.create({
  // Falls back to a relative path, which the Vite dev server proxies to the
  // backend. Set VITE_API_URL when the API is on another origin.
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
  // Send the auth cookies. Without this axios omits credentials on any
  // cross-origin request, and the API sees an anonymous caller.
  withCredentials: true,
});

/**
 * CSRF: read the token the server planted and echo it back in a header.
 *
 * This is the client half of the double-submit check in
 * backend/src/middleware/csrf.js. The cookie is deliberately readable from
 * JavaScript (unlike the session cookies) because this code has to read it —
 * and that is safe, because on its own the value grants nothing. It only proves
 * the request was made by code running on our own origin, which an attacker's
 * page cannot do: it can make the browser *send* our cookies but the same-origin
 * policy stops it *reading* them.
 */
const CSRF_COOKIE = 'simplecrm_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Attach the token to every state-changing request.
 *
 * Read fresh on each request rather than cached at startup: the server rotates
 * the token if it goes missing mid-session, and a cached copy would then be
 * stale and every write would 403.
 */
function attachCsrfToken(config) {
  const method = (config.method || 'get').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return config;

  const token = readCookie(CSRF_COOKIE);
  if (token) config.headers[CSRF_HEADER] = token;

  return config;
}

/**
 * A bare axios call for the refresh endpoint.
 *
 * Deliberately NOT `client`: the interceptor below would catch a failing
 * refresh, try to refresh again, and recurse until the stack blew up. Using a
 * separate instance makes that impossible rather than merely unlikely.
 */
const refreshClient = axios.create({
  baseURL: client.defaults.baseURL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// Both instances need the CSRF header — /auth/refresh is a POST like any other.
client.interceptors.request.use(attachCsrfToken);
refreshClient.interceptors.request.use(attachCsrfToken);

/**
 * One in-flight refresh, shared.
 *
 * A dashboard fires several requests at once. When the access token has just
 * expired they all 401 together, and without this every one of them would call
 * /auth/refresh. Because refresh *rotates* the token, the first call would
 * invalidate the token the others are using — the server would read that as
 * token reuse and revoke the whole session. So the first 401 starts a refresh
 * and every other request waits on the same promise.
 */
let refreshPromise = null;

function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = refreshClient
      .post('/auth/refresh')
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

/** Callbacks fired when the session is definitively gone, so React can react. */
const sessionExpiredHandlers = new Set();

export function onSessionExpired(handler) {
  sessionExpiredHandlers.add(handler);
  return () => sessionExpiredHandlers.delete(handler);
}

function notifySessionExpired() {
  sessionExpiredHandlers.forEach((handler) => handler());
}

/** Requests that must never trigger a refresh attempt — they ARE the auth flow. */
const AUTH_PATHS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

function isAuthPath(url = '') {
  return AUTH_PATHS.some((path) => url.startsWith(path));
}

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const original = error.config;

    // Only a 401 is worth retrying, only once, and never for the auth
    // endpoints themselves — a failed login is not an expired session.
    if (status !== 401 || !original || original._retried || isAuthPath(original.url)) {
      if (status === 401 && !isAuthPath(original?.url || '')) notifySessionExpired();
      return Promise.reject(error);
    }

    original._retried = true;

    try {
      await refreshSession();
      // The refresh set new cookies; replaying the original request now works.
      return client(original);
    } catch {
      // The refresh token is gone or was revoked. The session is over.
      // The refresh error itself is not bound: the caller needs the ORIGINAL
      // failure, not the failure of our attempt to rescue it.
      notifySessionExpired();
      return Promise.reject(error);
    }
  }
);

/**
 * Pull a readable message out of an axios error.
 *
 * The backend always answers with `{ success: false, message, details? }`, so
 * this reaches for that first and only falls back to a generic string when the
 * request never got a response at all (network down, server not running).
 */
export function errorMessage(error, fallback = 'Something went wrong') {
  const data = error?.response?.data;

  if (data?.details) {
    // Validation errors arrive as { field: 'message' } — show them all.
    const parts = Object.values(data.details);
    if (parts.length) return parts.join(' ');
  }

  return data?.message || error?.message || fallback;
}

export default client;
