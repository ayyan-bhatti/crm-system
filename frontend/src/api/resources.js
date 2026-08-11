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
  me: () => client.get('/auth/me').then((r) => r.data.data.user),
};

// --- customers --------------------------------------------------------------
export const customersApi = {
  list: (params) => client.get('/customers', { params }).then((r) => r.data),
  get: (id) => client.get(`/customers/${id}`).then((r) => r.data.data),
  create: (payload) => client.post('/customers', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/customers/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/customers/${id}`).then((r) => r.data),
};

// --- products ---------------------------------------------------------------
export const productsApi = {
  list: (params) => client.get('/products', { params }).then((r) => r.data),
  categories: () => client.get('/products/categories').then((r) => r.data.data),
  get: (id) => client.get(`/products/${id}`).then((r) => r.data.data),
  create: (payload) => client.post('/products', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/products/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/products/${id}`).then((r) => r.data),
};

// --- orders -----------------------------------------------------------------
export const ordersApi = {
  list: (params) => client.get('/orders', { params }).then((r) => r.data),
  get: (id) => client.get(`/orders/${id}`).then((r) => r.data.data),
  create: (payload) => client.post('/orders', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/orders/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/orders/${id}`).then((r) => r.data),
};

// --- users ------------------------------------------------------------------
export const usersApi = {
  // Available to every authenticated user — used to fill "assign to" dropdowns.
  assignable: () => client.get('/users/assignable').then((r) => r.data.data),
  // Admin only.
  list: (params) => client.get('/users', { params }).then((r) => r.data),
  create: (payload) => client.post('/users', payload).then((r) => r.data.data),
  update: (id, payload) => client.patch(`/users/${id}`, payload).then((r) => r.data.data),
  remove: (id) => client.delete(`/users/${id}`).then((r) => r.data),
};

// --- dashboard + AI search --------------------------------------------------
export const dashboardApi = {
  summary: () => client.get('/dashboard/summary').then((r) => r.data.data),
};

export const aiSearchApi = {
  search: (query, entity) => client.post('/ai-search', { query, entity }).then((r) => r.data),
};
