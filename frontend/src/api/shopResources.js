import shopClient from './shopClient';

/** Same reasoning as ordersApi.create's key — see api/resources.js. */
function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export const shopAuthApi = {
  register: (payload) => shopClient.post('/shop/auth/register', payload).then((r) => r.data.data),
  login: (payload) => shopClient.post('/shop/auth/login', payload).then((r) => r.data.data),
  logout: () => shopClient.post('/shop/auth/logout').then((r) => r.data),
  me: () => shopClient.get('/shop/auth/me').then((r) => r.data.data.buyer),

  // The saved-address book — always the signed-in buyer's own, so no id in
  // any of these URLs. Each resolves to the full, updated address array.
  addAddress: (payload) =>
    shopClient.post('/shop/auth/addresses', payload).then((r) => r.data.data.addresses),
  updateAddress: (addressId, payload) =>
    shopClient
      .patch(`/shop/auth/addresses/${addressId}`, payload)
      .then((r) => r.data.data.addresses),
  deleteAddress: (addressId) =>
    shopClient.delete(`/shop/auth/addresses/${addressId}`).then((r) => r.data.data.addresses),
};

export const shopProductsApi = {
  list: (params) => shopClient.get('/shop/products', { params }).then((r) => r.data),
  get: (id) => shopClient.get(`/shop/products/${id}`).then((r) => r.data.data),
  search: (q) => shopClient.get('/shop/products/search', { params: { q } }).then((r) => r.data),
  recommendations: (id) =>
    shopClient.get(`/shop/products/${id}/recommendations`).then((r) => r.data),

  /*
   * The PUBLIC category list. The storefront used to call `productsApi.categories()`
   * — the internal, staff-only one — which answered 401 for every shopper who
   * did not also have a CRM session open, and the failure was swallowed by a
   * `.catch(() => {})`. A category filter that renders nothing looks exactly
   * like a category filter that was never built.
   */
  categories: () => shopClient.get('/shop/products/categories').then((r) => r.data.data),
  colours: () => shopClient.get('/shop/products/colours').then((r) => r.data.data),
};

export const shopNewsletterApi = {
  subscribe: (email) => shopClient.post('/shop/newsletter', { email }).then((r) => r.data),
};

export const shopCartApi = {
  get: () => shopClient.get('/shop/cart').then((r) => r.data.data),
  addItem: (product, quantity, variantId) =>
    shopClient
      .post('/shop/cart/items', { product, quantity, variantId })
      .then((r) => r.data.data),
  /*
   * The variant travels in the body / query string rather than the path.
   *
   * A line is identified by product AND variant, so `/items/:productId` alone
   * is ambiguous the moment a cart holds two colours of one shirt. Putting the
   * variant in a second path segment was the alternative and would have broken
   * every existing URL for products that have no variants; this way those URLs
   * are unchanged and simply carry no variant.
   */
  updateItem: (product, quantity, variantId = null) =>
    shopClient
      .patch(`/shop/cart/items/${product}`, { quantity, variantId })
      .then((r) => r.data.data),
  removeItem: (product, variantId = null) =>
    shopClient
      .delete(`/shop/cart/items/${product}`, { params: variantId ? { variantId } : {} })
      .then((r) => r.data.data),
  merge: (items) => shopClient.post('/shop/cart/merge', { items }).then((r) => r.data.data),
};

export const shopCheckoutApi = {
  /**
   * Start a checkout. Returns the whole response body, not `data`, because the
   * two payment paths return genuinely different things and the caller has to
   * tell them apart:
   *
   *   { mode: 'stripe', data: { checkoutUrl } }  go and pay; no order exists yet
   *   { mode: 'direct', data: <order> }          the order was created
   *
   * Unwrapping to `data` here would erase `mode` and leave the caller guessing
   * from the shape of what it got, which is precisely the kind of inference
   * that breaks the first time a field is added.
   */
  checkout: (items, addressId, paymentMethod) =>
    shopClient
      .post(
        '/shop/checkout',
        { items, addressId, paymentMethod },
        { headers: { 'Idempotency-Key': idempotencyKey() } }
      )
      .then((r) => r.data),

  /** What the confirmation page polls: cheap, and reports only what we know. */
  session: (sessionId) =>
    shopClient.get(`/shop/checkout/session/${sessionId}`).then((r) => r.data.data),

  /**
   * Ask Stripe directly, for when the redirect beat the webhook. Costs an
   * outbound API call, so the page uses it once rather than in a loop.
   */
  reconcile: (sessionId) =>
    shopClient.post(`/shop/checkout/session/${sessionId}/reconcile`).then((r) => r.data.data),
};

export const shopOrdersApi = {
  list: (params) => shopClient.get('/shop/orders', { params }).then((r) => r.data),
  get: (id) => shopClient.get(`/shop/orders/${id}`).then((r) => r.data.data),
  requestCancel: (id) =>
    shopClient.post(`/shop/orders/${id}/request-cancel`).then((r) => r.data),
  requestEdit: (id, items) =>
    shopClient.post(`/shop/orders/${id}/request-edit`, { items }).then((r) => r.data),
  ask: (question) => shopClient.post('/shop/orders/ask', { question }).then((r) => r.data.data),
};
