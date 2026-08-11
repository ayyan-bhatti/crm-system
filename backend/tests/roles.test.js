const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');

/**
 * Role-based access control.
 *
 * The rules being verified:
 *
 *   admin      everything, including user management
 *   manager    full CRUD on customers / products / orders; no user management
 *   sales_rep  customers and orders they created or are assigned to;
 *              products are read-only
 *
 * These tests are mostly about the denials — the 403s are the part that has to
 * keep working, because a silently missing check looks exactly like a working
 * app until someone notices they can read a colleague's accounts.
 */
describe('Role-based access control', () => {
  describe('Products — sales reps are read-only', () => {
    it('lets a sales rep list products', async () => {
      const rep = await createRep();
      await createProduct();

      const res = await api().get('/api/products').set(rep.headers);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
    });

    it('lets a sales rep read a single product', async () => {
      const rep = await createRep();
      const product = await createProduct();

      const res = await api().get(`/api/products/${product._id}`).set(rep.headers);

      expect(res.status).toBe(200);
    });

    it('blocks a sales rep from creating a product', async () => {
      const rep = await createRep();

      const res = await api()
        .post('/api/products')
        .set(rep.headers)
        .send({ name: 'Nope', sku: 'NOPE-1', price: 5, stockQty: 5 });

      expect(res.status).toBe(403);
    });

    it('blocks a sales rep from updating a product', async () => {
      const rep = await createRep();
      const product = await createProduct();

      const res = await api()
        .patch(`/api/products/${product._id}`)
        .set(rep.headers)
        .send({ price: 1 });

      expect(res.status).toBe(403);
    });

    it('blocks a sales rep from deleting a product', async () => {
      const rep = await createRep();
      const product = await createProduct();

      const res = await api().delete(`/api/products/${product._id}`).set(rep.headers);

      expect(res.status).toBe(403);
    });

    it('allows a manager to create a product', async () => {
      const manager = await createManager();

      const res = await api()
        .post('/api/products')
        .set(manager.headers)
        .send({ name: 'Widget', sku: 'W-1', price: 5, stockQty: 5 });

      expect(res.status).toBe(201);
    });
  });

  describe('User management — admins only', () => {
    it('allows an admin to list users', async () => {
      const admin = await createAdmin();

      const res = await api().get('/api/users').set(admin.headers);

      expect(res.status).toBe(200);
    });

    it('blocks a manager from listing users', async () => {
      const manager = await createManager();

      const res = await api().get('/api/users').set(manager.headers);

      expect(res.status).toBe(403);
    });

    it('blocks a sales rep from listing users', async () => {
      const rep = await createRep();

      const res = await api().get('/api/users').set(rep.headers);

      expect(res.status).toBe(403);
    });

    it('blocks a manager from creating a user', async () => {
      const manager = await createManager();

      const res = await api()
        .post('/api/users')
        .set(manager.headers)
        .send({ name: 'X', email: 'x@test.com', password: 'password123', role: 'admin' });

      expect(res.status).toBe(403);
    });

    it('blocks a sales rep from changing a role', async () => {
      const rep = await createRep();
      const victim = await createRep();

      const res = await api()
        .patch(`/api/users/${victim.user._id}`)
        .set(rep.headers)
        .send({ role: 'admin' });

      expect(res.status).toBe(403);
    });

    it('lets any authenticated user read the assignable-users list', async () => {
      const rep = await createRep();

      const res = await api().get('/api/users/assignable').set(rep.headers);

      expect(res.status).toBe(200);
    });

    it('stops an admin deleting their own account', async () => {
      const admin = await createAdmin();

      const res = await api().delete(`/api/users/${admin.user._id}`).set(admin.headers);

      expect(res.status).toBe(400);
    });
  });

  describe('Customers — sales reps are limited to their own records', () => {
    it("blocks a rep from reading another rep's customer", async () => {
      const owner = await createRep();
      const other = await createRep();
      const customer = await createCustomer(owner);

      const res = await api().get(`/api/customers/${customer._id}`).set(other.headers);

      expect(res.status).toBe(403);
    });

    it("blocks a rep from editing another rep's customer", async () => {
      const owner = await createRep();
      const other = await createRep();
      const customer = await createCustomer(owner);

      const res = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(other.headers)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(403);
    });

    it("blocks a rep from deleting another rep's customer", async () => {
      const owner = await createRep();
      const other = await createRep();
      const customer = await createCustomer(owner);

      const res = await api().delete(`/api/customers/${customer._id}`).set(other.headers);

      expect(res.status).toBe(403);
    });

    it("keeps another rep's customers out of the list entirely", async () => {
      const owner = await createRep();
      const other = await createRep();
      await createCustomer(owner);
      await createCustomer(other);

      const res = await api().get('/api/customers').set(other.headers);

      expect(res.body.total).toBe(1);
    });

    it('lets a manager read any customer', async () => {
      const owner = await createRep();
      const manager = await createManager();
      const customer = await createCustomer(owner);

      const res = await api().get(`/api/customers/${customer._id}`).set(manager.headers);

      expect(res.status).toBe(200);
    });

    it('lets a rep read a customer assigned to them but created by someone else', async () => {
      const manager = await createManager();
      const rep = await createRep();
      const customer = await createCustomer(manager, { assignedTo: rep.user._id });

      const res = await api().get(`/api/customers/${customer._id}`).set(rep.headers);

      expect(res.status).toBe(200);
    });

    it('blocks a rep from reassigning a customer', async () => {
      const rep = await createRep();
      const other = await createRep();
      const customer = await createCustomer(rep);

      const res = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(rep.headers)
        .send({ assignedTo: other.user._id });

      expect(res.status).toBe(403);
    });

    it('lets a manager reassign a customer', async () => {
      const manager = await createManager();
      const rep = await createRep();
      const customer = await createCustomer(manager);

      const res = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ assignedTo: rep.user._id });

      expect(res.status).toBe(200);
      expect(String(res.body.data.assignedTo._id)).toBe(String(rep.user._id));
    });
  });

  describe('Orders — sales reps are limited to their own records', () => {
    it("blocks a rep from ordering for another rep's customer", async () => {
      const owner = await createRep();
      const other = await createRep();
      const customer = await createCustomer(owner);
      const product = await createProduct();

      const res = await api()
        .post('/api/orders')
        .set(other.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      expect(res.status).toBe(403);
    });

    it("blocks a rep from reading another rep's order", async () => {
      const owner = await createRep();
      const other = await createRep();
      const customer = await createCustomer(owner);
      const product = await createProduct();

      const created = await api()
        .post('/api/orders')
        .set(owner.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api().get(`/api/orders/${created.body.data._id}`).set(other.headers);

      expect(res.status).toBe(403);
    });

    it("keeps another rep's orders out of the list", async () => {
      const owner = await createRep();
      const other = await createRep();
      const customer = await createCustomer(owner);
      const product = await createProduct();

      await api()
        .post('/api/orders')
        .set(owner.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api().get('/api/orders').set(other.headers);

      expect(res.body.total).toBe(0);
    });

    it('lets an admin read any order', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(rep);
      const product = await createProduct();

      const created = await api()
        .post('/api/orders')
        .set(rep.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api().get(`/api/orders/${created.body.data._id}`).set(admin.headers);

      expect(res.status).toBe(200);
    });

    /**
     * A rep who did not place the order can still work it if the customer is
     * theirs — this is the "assigned to" half of the ownership rule, and the
     * easy one to break when refactoring.
     */
    it("lets a rep update an order on their customer that a manager created", async () => {
      const manager = await createManager();
      const rep = await createRep();
      const customer = await createCustomer(manager, { assignedTo: rep.user._id });
      const product = await createProduct({ stockQty: 10 });

      const created = await api()
        .post('/api/orders')
        .set(manager.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api()
        .patch(`/api/orders/${created.body.data._id}`)
        .set(rep.headers)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
    });
  });

  describe('Unauthenticated access', () => {
    it.each([
      ['get', '/api/customers'],
      ['get', '/api/products'],
      ['get', '/api/orders'],
      ['get', '/api/dashboard/summary'],
      ['post', '/api/ai-search'],
      ['get', '/api/users'],
    ])('rejects %s %s with 401', async (method, path) => {
      const res = await api()[method](path);
      expect(res.status).toBe(401);
    });
  });
});
