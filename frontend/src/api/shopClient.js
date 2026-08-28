import axios from 'axios';

/**
 * The buyer-track equivalent of `api/client.js` — a second axios instance,
 * not a second mode of the same one.
 *
 * Same reasoning as the backend's separate `BuyerRefreshToken` collection: a
 * person can have a staff session and a buyer session open in the same
 * browser at once, and the two must never be able to interfere with each
 * other. Reusing one axios instance for both would mean one shared
 * refresh-retry queue and one shared "session expired" signal for two
 * genuinely independent sessions — a buyer's expired cart session would
 * announce a staff session dying, and vice versa. Two instances, two cookie
 * pairs, two CSRF pairs, two refresh queues: nothing to keep in step.
 */

const shopClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

const SHOP_CSRF_COOKIE = 'shop_csrf';
const SHOP_CSRF_HEADER = 'X-CSRF-Token';

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function attachCsrfToken(config) {
  const method = (config.method || 'get').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return config;

  const token = readCookie(SHOP_CSRF_COOKIE);
  if (token) config.headers[SHOP_CSRF_HEADER] = token;

  return config;
}

const refreshClient = axios.create({
  baseURL: shopClient.defaults.baseURL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

shopClient.interceptors.request.use(attachCsrfToken);
refreshClient.interceptors.request.use(attachCsrfToken);

let refreshPromise = null;

function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = refreshClient.post('/shop/auth/refresh').finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

const sessionExpiredHandlers = new Set();

export function onShopSessionExpired(handler) {
  sessionExpiredHandlers.add(handler);
  return () => sessionExpiredHandlers.delete(handler);
}

function notifySessionExpired() {
  sessionExpiredHandlers.forEach((handler) => handler());
}

const AUTH_PATHS = ['/shop/auth/login', '/shop/auth/register', '/shop/auth/refresh', '/shop/auth/logout'];

function isAuthPath(url = '') {
  return AUTH_PATHS.some((path) => url.startsWith(path));
}

shopClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const original = error.config;

    if (status !== 401 || !original || original._retried || isAuthPath(original.url)) {
      if (status === 401 && !isAuthPath(original?.url || '')) notifySessionExpired();
      return Promise.reject(error);
    }

    original._retried = true;

    try {
      await refreshSession();
      return shopClient(original);
    } catch {
      notifySessionExpired();
      return Promise.reject(error);
    }
  }
);

export default shopClient;
