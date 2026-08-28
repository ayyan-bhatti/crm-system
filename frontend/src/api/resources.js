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
  /**
   * Sign up. Returns the whole envelope, not just `data`, because the useful
   * part of the answer is the MESSAGE — the account was created and cannot be
   * used yet, which is a sentence rather than a record.
   */
  register: (payload) => client.post('/auth/register', payload).then((r) => r.data),
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

  /** An AI-drafted follow-up email, never sent — text for a rep to review and send by hand. */
  draftMessage: (id, tone) =>
    client.post(`/customers/${id}/draft-message`, { tone }).then((r) => r.data.data),

  /** Manager/admin: churn-risk flagged customers rolled up team-wide, with a narrative. */
  churnRollup: () => client.get('/customers/churn-rollup').then((r) => r.data),
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

  /** Manager/admin: low-stock, actually-selling products with an AI justification each. */
  reorderSuggestions: () => client.get('/products/reorder-suggestions').then((r) => r.data),
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

  /**
   * Reassign an order to a different rep, or pass null to clear it and let the
   * order follow its customer again.
   *
   * Its own endpoint rather than a field on `update`, because it is a different
   * kind of change with different permissions — see the note on the route.
   */
  assign: (id, assignedTo) =>
    client.patch(`/orders/${id}/assign`, { assignedTo }).then((r) => r.data.data),

  /**
   * The assigned rep asking for the order to be handed to a colleague.
   *
   * Its own call rather than `assign` with different permissions: the two make
   * the same write and mean different things, and only one of them takes effect
   * immediately.
   */
  requestTransfer: (id, assignedTo, reason) =>
    client
      .post(`/orders/${id}/transfer-request`, { assignedTo, reason })
      .then((r) => r.data),

  remove: (id) => client.delete(`/orders/${id}`).then((r) => r.data),
};

// --- activity ---------------------------------------------------------------

/**
 * The notes timeline on a customer or an order.
 *
 * There is no `update` and no `remove`, and that is the feature rather than an
 * omission. Notes are append-only — a correction is another note, the way it
 * would be in a paper ledger. The backend refuses the write at the model as
 * well as not routing it, so adding them here would only produce a button that
 * always fails.
 *
 * The URL is nested under the record because the permission is the record's:
 * whoever may open this order may read and write its notes.
 */
export const activityApi = {
  list: (entity, id) => client.get(`/${entity}s/${id}/activity`).then((r) => r.data.data),

  add: (entity, id, body) =>
    client.post(`/${entity}s/${id}/activity`, { body }).then((r) => r.data.data),

  /** One AI-written paragraph over the same note thread `list` returns. */
  summarize: (entity, id) =>
    client.get(`/${entity}s/${id}/activity/summary`).then((r) => r.data),
};

// --- users ------------------------------------------------------------------
export const usersApi = {
  // Available to every authenticated user — used to fill "assign to" dropdowns.
  assignable: (search) =>
    client
      .get('/users/assignable', { params: search ? { search } : undefined })
      .then((r) => r.data.data),
  // Admin only.
  list: (params) => client.get('/users', { params }).then((r) => r.data),

  /** Admin only. Sign-up requests waiting on a decision. */
  pending: () => client.get('/users/pending').then((r) => r.data.data),

  /** Admin only. Pass a role to grant something other than what was requested. */
  approve: (id, role) =>
    client.patch(`/users/${id}/approve`, role ? { role } : {}).then((r) => r.data.data),

  reject: (id) => client.patch(`/users/${id}/reject`).then((r) => r.data.data),

  /** Admin or manager. Creates a pending account and emails an invite link. */
  invite: (payload) => client.post('/users/invite', payload).then((r) => r.data),

  /** Admin only. `status` is 'active' or 'deactivated'. */
  setStatus: (id, status) =>
    client.patch(`/users/${id}/status`, { status }).then((r) => r.data.data),
  create: (payload) => client.post('/users', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/users/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/users/${id}`).then((r) => r.data),

  /** Admin only: who has been active, who is idle, anything that looks off. */
  activityDigest: () => client.get('/users/activity-digest').then((r) => r.data.data),
};

// --- dashboard + AI search --------------------------------------------------
export const dashboardApi = {
  summary: () => client.get('/dashboard/summary').then((r) => r.data.data),

  /** Manager/admin: the weekly team digest — figures plus an AI narrative. */
  digest: () => client.get('/dashboard/digest').then((r) => r.data.data),
};

// --- audit log (admin only) -------------------------------------------------
export const auditApi = {
  list: (params) => client.get('/audit-logs', { params }).then((r) => r.data),
  get: (id) => client.get(`/audit-logs/${id}`).then((r) => r.data.data),

  /**
   * A plain-English summary of the CURRENTLY FILTERED range. Takes the same
   * params as `list` for exactly that reason — see the controller's note on
   * why a digest computed over a different set than the table would be worse
   * than none at all.
   */
  digest: (params) => client.get('/audit-logs/digest', { params }).then((r) => r.data.data),
};

export const aiSearchApi = {
  search: (query, entity) => client.post('/ai-search', { query, entity }).then((r) => r.data),
};

// --- change requests (admin only) -------------------------------------------
export const changeRequestsApi = {
  /** Proposed customer and order changes waiting on a decision. */
  list: () => client.get('/change-requests').then((r) => r.data.data),

  approve: (id) => client.patch(`/change-requests/${id}/approve`).then((r) => r.data),

  /** `note` is optional; offered because "rejected" with no reason gets resubmitted. */
  reject: (id, note) =>
    client.patch(`/change-requests/${id}/reject`, note ? { note } : {}).then((r) => r.data),

  /** A plain-English sentence for one request's field-level diff. */
  summary: (id) => client.get(`/change-requests/${id}/summary`).then((r) => r.data),
};

// --- internals (admin only) -------------------------------------------------
export const internalApi = {
  /**
   * Whether the AI is configured and succeeding.
   *
   * Worth having a UI caller for, because the failure it reports is invisible
   * by design: every AI feature falls back to a working non-AI path, so a
   * missing key produces results that look fine and are not what they claim.
   */
  aiStatus: () => client.get('/internal/ai-status').then((r) => r.data.data),
  metrics: () => client.get('/internal/metrics').then((r) => r.data.data),
  aiUsage: (days) => client.get('/internal/ai-usage', { params: { days } }).then((r) => r.data.data),
};
