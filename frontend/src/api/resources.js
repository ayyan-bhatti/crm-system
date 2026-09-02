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

  /*
   * Email verification. `checkEmailVerification` is read-only — it never
   * redeems the token, so a mail client prefetching the link cannot burn it
   * before a human clicks. `verifyEmail` is the POST that actually does.
   */
  checkEmailVerification: (token) =>
    client.get(`/auth/verify-email/${token}`).then((r) => r.data.data),
  verifyEmail: (token) => client.post('/auth/verify-email', { token }).then((r) => r.data),
  resendVerification: () => client.post('/auth/resend-verification').then((r) => r.data),
};

// --- customers --------------------------------------------------------------
export const customersApi = {
  list: (params) => client.get('/customers', { params }).then((r) => r.data),
  get: (id) => client.get(`/customers/${id}`).then((r) => r.data.data),
  create: (payload) => client.post('/customers', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/customers/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/customers/${id}`).then((r) => r.data),

  /**
   * Bulk-create customers from an uploaded .xlsx. Admin only.
   *
   * `FormData`, not JSON — axios detects it and lets the browser set the
   * `Content-Type: multipart/form-data; boundary=...` header itself, which is
   * NOT the same as this client's default `application/json` and cannot be
   * set by hand (the boundary is generated per-request).
   *
   * Resolves even on a partial success: `data.failed`/`data.skipped` can be
   * non-empty on a 200, because most rows succeeding while a few did not is
   * the ordinary outcome of importing a real spreadsheet, not an error.
   */
  importFile: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return client.post('/customers/import', formData).then((r) => r.data.data);
  },
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
   * The delivery board: everything still in flight, ranked by urgency.
   *
   * Returns the whole envelope rather than `data`, because the server also
   * sends the per-band counts it just computed. Re-deriving those on the client
   * is how the headline number and the list quietly start disagreeing.
   */
  deliveries: () => client.get('/orders/deliveries').then((r) => r.data),

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

  /**
   * Move an order along the delivery sequence.
   *
   * A separate endpoint from `update` for the same reason `assign` is one: it
   * is a different kind of change, with a different audience and a different
   * permission. `update` decides whether a sale counts and whether stock moves;
   * this decides what the customer is told about a parcel — and unlike `assign`
   * it is open to the rep holding the order, who is usually the person who
   * actually knows it went out.
   */
  updateFulfilment: (id, fulfilment, estimatedDeliveryAt, courier, trackingNumber) =>
    client
      .patch(`/orders/${id}/fulfilment`, {
        fulfilment,
        estimatedDeliveryAt,
        courier,
        trackingNumber,
      })
      .then((r) => r.data.data),

  /**
   * The tracking-page link plus, only for a `dhl` shipment with a live key
   * configured server-side, a real status pulled from DHL. `live: false` with
   * a `reason` is an ordinary, expected answer — not an error — for every
   * other courier and for DHL with no key set.
   */
  trackingStatus: (id) => client.get(`/orders/${id}/tracking`).then((r) => r.data.data),

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

// --- marketing contacts -----------------------------------------------------
/**
 * A CONTACT IS ADDRESSED BY EMAIL, not by an id, and every path here encodes
 * it. A merged contact is not a document — it is up to two records, a
 * `Customer` and a `Buyer`, joined on the address — so there is no `_id` to
 * use, and inventing a synthetic one would give the screen a key that changes
 * whenever the merge does. `encodeURIComponent` matters rather than being
 * defensive: a perfectly ordinary `first+tag@example.com` breaks the route
 * without it.
 */
export const contactsApi = {
  /**
   * Returns `{ data, count, options }` rather than just the rows, because the
   * filter dropdowns come from the server. Same reasoning as the storefront
   * config: a client that hard-codes the segment list disagrees with the
   * server the day one is added.
   */
  list: (params) => client.get('/contacts', { params }).then((r) => r.data),

  get: (email) => client.get(`/contacts/${encodeURIComponent(email)}`).then((r) => r.data.data),

  /** Record a consent the customer gave a member of staff directly. */
  setConsent: (email, changes) =>
    client
      .patch(`/contacts/${encodeURIComponent(email)}/consent`, changes)
      .then((r) => r.data),

  /** Replaces the hand-assigned tags. Computed segments are not settable. */
  setTags: (email, tags) =>
    client.put(`/contacts/${encodeURIComponent(email)}/tags`, { tags }).then((r) => r.data.data),

  /**
   * Send one message to one contact.
   *
   * Resolves even when the message was NOT sent — a contact who has not opted
   * in comes back as `{ status: 'skipped_no_consent' }` with a 200, because
   * that is an answer rather than an error. The caller has to read `status`;
   * treating any resolved promise as success would report a blocked send as
   * a delivered one.
   */
  message: (email, payload) =>
    client.post(`/contacts/${encodeURIComponent(email)}/message`, payload).then((r) => r.data.data),

  /**
   * Download the current view as a spreadsheet. Admin only.
   *
   * `responseType: 'blob'` is essential and easy to omit: without it axios
   * parses the binary xlsx as text, and the file that reaches the user is a
   * corrupted archive Excel refuses to open. Takes the SAME params the list
   * does, so the file matches what is on screen.
   */
  exportUrl: (params) =>
    client
      .get('/contacts/export', { params, responseType: 'blob' })
      .then((r) => r.data),
};

// --- campaigns (admin and manager) ------------------------------------------
export const campaignsApi = {
  list: (params) => client.get('/campaigns', { params }).then((r) => r.data),

  /** `{ campaign, recipients }` — the rows, not just the counts. */
  get: (id) => client.get(`/campaigns/${id}`).then((r) => r.data.data),

  /**
   * How many this audience matches and how many can actually be reached.
   *
   * The second number is the point: an audience of 400 is not 400 messages,
   * and finding that out only after sending makes the consent skips look like
   * a bug in the sender.
   */
  preview: (audience) => client.post('/campaigns/preview', { audience }).then((r) => r.data.data),

  /** AI copy for all four forms at once. Creates nothing. */
  draft: (payload) => client.post('/campaigns/draft', payload).then((r) => r.data.data),

  create: (payload) => client.post('/campaigns', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/campaigns/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/campaigns/${id}`).then((r) => r.data),

  /**
   * Send it — or queue it for an admin. The response's `queued` flag says
   * which, and the caller must not assume the first.
   */
  send: (id) => client.post(`/campaigns/${id}/send`).then((r) => r.data),
};

// --- post-sale automation ---------------------------------------------------
export const automationApi = {
  /**
   * The log, plus each job's last-run date and the current settings.
   *
   * The last-run dates are the reason this screen exists: a scheduled job that
   * stops firing produces no error anywhere, and the only visible symptom is a
   * date that stopped moving.
   */
  log: (params) => client.get('/automation/log', { params }).then((r) => r.data),

  settings: () => client.get('/automation/settings').then((r) => r.data.data),

  /** Admin only. */
  updateSettings: (payload) =>
    client.patch('/automation/settings', payload).then((r) => r.data.data),

  /** Admin only. Safe to press twice — the jobs claim each order before sending. */
  run: () => client.post('/automation/run').then((r) => r.data.data),
};

// --- unsubscribe (public, no session) ---------------------------------------
/**
 * The landing page for the link in a marketing email.
 *
 * PUBLIC BY NECESSITY. Requiring a login to stop receiving marketing is a dark
 * pattern, and for a contact who has no account it is impossible. The signed
 * token in the link is the authorisation.
 */
export const unsubscribeApi = {
  /**
   * What this token WOULD do, without doing it. Safe for a mail client to
   * prefetch, which is exactly why the change itself is a POST — several mail
   * clients and security scanners fetch every link before a human sees it.
   */
  check: (token) => client.get(`/unsubscribe/${encodeURIComponent(token)}`).then((r) => r.data.data),

  /** Does it. Idempotent — a second click changes nothing and still succeeds. */
  confirm: (token) => client.post('/unsubscribe', { token }).then((r) => r.data),
};
