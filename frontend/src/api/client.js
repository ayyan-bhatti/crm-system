import axios from 'axios';

/**
 * The single axios instance every API module uses.
 *
 * Two interceptors carry the whole auth story:
 *   - request:  attach the stored JWT as a bearer token
 *   - response: on a 401, clear the dead token and bounce to /login
 *
 * Doing it here means no component ever handles a token, and a session that
 * expires mid-use fails in one predictable way instead of a different way on
 * every screen.
 */

export const TOKEN_KEY = 'simplecrm.token';

const client = axios.create({
  // Falls back to a relative path, which the Vite dev server proxies to the
  // backend. Set VITE_API_URL when the API is on another origin.
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
});

client.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;

    if (status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      // Skip the redirect if we are already on the login screen, otherwise a
      // failed login attempt would reload the page and wipe the error message.
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }

    return Promise.reject(error);
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
