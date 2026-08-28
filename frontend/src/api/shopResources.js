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
};

export const shopCartApi = {
  get: () => shopClient.get('/shop/cart').then((r) => r.data.data),
  addItem: (product, quantity) =>
    shopClient.post('/shop/cart/items', { product, quantity }).then((r) => r.data.data),
  updateItem: (product, quantity) =>
    shopClient.patch(`/shop/cart/items/${product}`, { quantity }).then((r) => r.data.data),
  removeItem: (product) =>
    shopClient.delete(`/shop/cart/items/${product}`).then((r) => r.data.data),
  merge: (items) => shopClient.post('/shop/cart/merge', { items }).then((r) => r.data.data),
};

export const shopCheckoutApi = {
  /** `guestDetails` is omitted for a signed-in buyer, who checks out from their account. */
  checkout: (items, guestDetails, addressId) =>
    shopClient
      .post(
        '/shop/checkout',
        { items, ...guestDetails, ...(addressId ? { addressId } : {}) },
        { headers: { 'Idempotency-Key': idempotencyKey() } }
      )
      .then((r) => r.data.data),
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
