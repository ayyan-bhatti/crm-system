import client from './client';

/**
 * One thin function per endpoint.
 *
 * These deliberately contain no logic beyond unwrapping the response envelope —
 * every backend response is `{ success, data, ... }`, and components want the
 * useful part. Keeping the URLs in one file also means the endpoint list here
 * matches the route files on the server one for one.
 */

// --- auth -------------------------------------------------------------------
export const authApi = {
  register: (payload) => client.post('/auth/register', payload).then((r) => r.data.data),
  login: (payload) => client.post('/auth/login', payload).then((r) => r.data.data),
  // The session cookies are set by the response itself; nothing is returned
  // that the app needs to keep.
  logout: () => client.post('/auth/logout').then((r) => r.data),
  me: () => client.get('/auth/me').then((r) => r.data.data.user),
  // Requires the current password, and signs out every OTHER device — see the
  // controller for why both of those matter.
  changePassword: (payload) =>
    client.post('/auth/change-password', payload).then((r) => r.data.data),

  /*
   * Always resolves for a well-formed request, whether or not the address has
   * an account — the API answers identically either way so it cannot be used to
   * discover which addresses are registered.
   */
  forgotPassword: (email) =>
    client.post('/auth/forgot-password', { email }).then((r) => r.data),

  resetPassword: (payload) => client.post('/auth/reset-password', payload).then((r) => r.data),

  /*
   * Invitations. `getInvite` is what lets the accept page greet the invitee by
   * name and show the role, rather than asking for a password in an anonymous
   * box reached from an email link — which is indistinguishable from phishing.
   */
  getInvite: (token) => client.get(`/auth/invite/${token}`).then((r) => r.data.data),
  acceptInvite: (payload) => client.post('/auth/accept-invite', payload).then((r) => r.data),
};

// --- customers --------------------------------------------------------------
export const customersApi = {
  list: (params) => client.get('/customers', { params }).then((r) => r.data),
  get: (id) => client.get(`/customers/${id}`).then((r) => r.data.data),
  create: (payload) => client.post('/customers', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/customers/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/customers/${id}`).then((r) => r.data),
  // Figures computed server-side plus an AI narrative about them. Always
  // returns both; `mode` says whether the narrative came from the model.
  summary: (id) => client.get(`/customers/${id}/summary`).then((r) => r.data.data),
  // Minimal id/label rows for the searchable picker — not the full documents
  // the list endpoint returns. See the note on the endpoint itself.
  options: (search) =>
    client.get('/customers/options', { params: { search } }).then((r) => r.data.data),
};

// --- products ---------------------------------------------------------------
export const productsApi = {
  list: (params) => client.get('/products', { params }).then((r) => r.data),
  categories: () => client.get('/products/categories').then((r) => r.data.data),
  options: (search) =>
    client.get('/products/options', { params: { search } }).then((r) => r.data.data),
  get: (id) => client.get(`/products/${id}`).then((r) => r.data.data),
  create: (payload) => client.post('/products', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/products/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/products/${id}`).then((r) => r.data),
};

// --- orders -----------------------------------------------------------------

/**
 * A fresh idempotency key for one order submission.
 *
 * `crypto.randomUUID` is available in every browser this app targets; the
 * fallback covers a non-secure context (plain http on a LAN address), where it
 * is undefined. Two clients colliding would need the same random value AND the
 * same user account, so the fallback's weaker randomness is not a real risk.
 */
function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export const ordersApi = {
  list: (params) => client.get('/orders', { params }).then((r) => r.data),
  get: (id) => client.get(`/orders/${id}`).then((r) => r.data.data),

  /**
   * Create an order.
   *
   * The key is generated HERE rather than inside the axios interceptor on
   * purpose: a retry has to reuse the key of the attempt it is retrying, and an
   * interceptor firing per HTTP request would mint a new one for the retry —
   * defeating the whole mechanism. Generating it once per logical submission is
   * what makes the axios 401-refresh replay (see api/client.js) safe.
   *
   * Callers may pass their own key to retry a submission whose response was
   * lost.
   */
  create: (payload, key = idempotencyKey()) =>
    client
      .post('/orders', payload, { headers: { 'Idempotency-Key': key } })
      .then((r) => r.data.data),
  update: (id, payload) => client.patch(`/orders/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/orders/${id}`).then((r) => r.data),
};

// --- users ------------------------------------------------------------------
export const usersApi = {
  // Available to every authenticated user — used to fill "assign to" dropdowns.
  assignable: () => client.get('/users/assignable').then((r) => r.data.data),
  // Admin only.
  list: (params) => client.get('/users', { params }).then((r) => r.data),

  /** Admin or manager. Creates a pending account and emails an invite link. */
  invite: (payload) => client.post('/users/invite', payload).then((r) => r.data),

  /** Admin only. `status` is 'active' or 'deactivated'. */
  setStatus: (id, status) =>
    client.patch(`/users/${id}/status`, { status }).then((r) => r.data.data),
  create: (payload) => client.post('/users', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/users/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/users/${id}`).then((r) => r.data),
};

// --- dashboard + AI search --------------------------------------------------
export const dashboardApi = {
  summary: () => client.get('/dashboard/summary').then((r) => r.data.data),
};

// --- audit log (admin only) -------------------------------------------------
export const auditApi = {
  list: (params) => client.get('/audit-logs', { params }).then((r) => r.data),
  get: (id) => client.get(`/audit-logs/${id}`).then((r) => r.data.data),
};

export const aiSearchApi = {
  search: (query, entity) => client.post('/ai-search', { query, entity }).then((r) => r.data),
};
