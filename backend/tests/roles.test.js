const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');
const Customer = require('../src/models/Customer');

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
        .send({
          name: 'Widget',
          sku: 'W-1',
          price: 5,
          stockQty: 5,
          imageUrl: 'https://picsum.photos/seed/w-1/480',
        });

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
        .send({ name: 'X', email: 'x@test.com', password: 'Karachi-Ledger-72', role: 'admin' });

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

  /**
   * THE CUSTOMER BOOK, WHICH A SALES REP CANNOT SEE AT ALL.
   *
   * This block used to test that a rep was limited to their OWN customers.
   * That rule is gone, replaced by a flat refusal: the customer list is the
   * most commercially sensitive collection in the system, and "only my
   * customers" is still a slice of it — a slice is enough to walk out with.
   *
   * Reading and writing are now separate questions, which is the other half of
   * the change. A manager sees the whole book and may change none of it.
   */
  describe('Customers — no access for a sales rep', () => {
    it('refuses a rep the customer list outright', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      await createCustomer(admin);

      const res = await api().get('/api/customers').set(rep.headers);

      expect(res.status).toBe(403);
    });

    /**
     * Not an empty list — a refusal. An empty list would tell a rep the
     * feature exists and they have no records, which invites them to go
     * looking for the ones they think they should have.
     */
    it('refuses rather than returning an empty list', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      await createCustomer(admin);

      const res = await api().get('/api/customers').set(rep.headers);

      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
    });

    it('refuses a rep a single customer by id, even one assigned to them', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin, { assignedTo: rep.user._id });

      const res = await api().get(`/api/customers/${customer._id}`).set(rep.headers);

      expect(res.status).toBe(403);
    });

    it('refuses a rep the customer picker used by forms', async () => {
      const rep = await createRep();

      expect((await api().get('/api/customers/options').set(rep.headers)).status).toBe(403);
    });

    it('refuses a rep the creation of a customer', async () => {
      const rep = await createRep();

      const res = await api()
        .post('/api/customers')
        .set(rep.headers)
        .send({ name: 'Back Door Ltd', email: 'back@door.com' });

      expect(res.status).toBe(403);
    });
  });

  /**
   * A manager runs the business and does not own the record.
   *
   * The split is the point: full sight of the customer book, no ability to
   * change it. What they can do instead is propose a change for an admin to
   * approve — covered in changeRequests.test.js.
   */
  describe('Customers — a manager may read, and may only propose a write', () => {
    it('lets a manager list every customer', async () => {
      const admin = await createAdmin();
      const manager = await createManager();
      await createCustomer(admin);
      await createCustomer(admin);

      const res = await api().get('/api/customers').set(manager.headers);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    });

    it('lets a manager read one customer', async () => {
      const admin = await createAdmin();
      const manager = await createManager();
      const customer = await createCustomer(admin);

      expect(
        (await api().get(`/api/customers/${customer._id}`).set(manager.headers)).status
      ).toBe(200);
    });

    /**
     * A manager is NOT refused — their write becomes a proposal.
     *
     * 202, not 403, and the distinction is the feature rather than a detail:
     * refusing would mean a manager cannot get a customer added at all, which
     * is not what "an admin owns the record" should cost them. The record is
     * untouched until an admin approves; see changeRequests.test.js for the
     * approval itself.
     */
    it('turns a manager’s creation into a request, writing nothing', async () => {
      const manager = await createManager();

      const res = await api()
        .post('/api/customers')
        .set(manager.headers)
        .send({ name: 'Manager Made This', email: 'mm@example.com' });

      expect(res.status).toBe(202);
      expect(await Customer.countDocuments({ email: 'mm@example.com' })).toBe(0);
    });

    it('turns a manager’s edit into a request, changing nothing', async () => {
      const admin = await createAdmin();
      const manager = await createManager();
      const customer = await createCustomer(admin, { name: 'Untouched' });

      const res = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ name: 'Renamed by a manager' });

      expect(res.status).toBe(202);
      expect((await Customer.findById(customer._id)).name).toBe('Untouched');
    });

    it('turns a manager’s deletion into a request, deleting nothing', async () => {
      const admin = await createAdmin();
      const manager = await createManager();
      const customer = await createCustomer(admin);

      const res = await api().delete(`/api/customers/${customer._id}`).set(manager.headers);

      expect(res.status).toBe(202);
      expect(await Customer.findById(customer._id)).not.toBeNull();
    });

    /** And the admin can do all three, or the rule above is just an outage. */
    it('lets an admin create, edit and delete', async () => {
      const admin = await createAdmin();

      const created = await api()
        .post('/api/customers')
        .set(admin.headers)
        .send({ name: 'Admin Made This', email: 'am@example.com' });
      expect(created.status).toBe(201);

      const id = created.body.data._id;

      expect(
        (await api().patch(`/api/customers/${id}`).set(admin.headers).send({ city: 'Lahore' }))
          .status
      ).toBe(200);

      expect((await api().delete(`/api/customers/${id}`).set(admin.headers)).status).toBe(200);
    });
  });

  /**
   * ORDERS ARE THE WHOLE OF A SALES REP'S WORLD, AND ONLY BY ASSIGNMENT.
   *
   * This block used to test three overlapping ownership rules: orders a rep
   * created, orders for a customer they owned, orders assigned to them. The
   * first two are now impossible — a rep cannot create an order and has no
   * customers — so assignment is the only route, which makes a rep's access a
   * single fact rather than three that have to agree.
   */
  describe('Orders — a sales rep sees only what is assigned to them', () => {
    /**
     * Build an order and hand it to `assignee`, or to nobody.
     *
     * Placed by an ADMIN: a manager's order is a proposal that waits for
     * approval, so posting as one returns a change request rather than an order
     * and leaves this suite nothing to assign.
     */
    const placeOrder = async (admin, customer, assignee = null) => {
      const product = await createProduct({ stockQty: 50 });

      const created = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      if (assignee) {
        await api()
          .patch(`/api/orders/${created.body.data._id}/assign`)
          .set(admin.headers)
          .send({ assignedTo: assignee.user._id });
      }

      return created.body.data;
    };

    it('refuses a rep the creation of an order', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);
      const product = await createProduct();

      const res = await api()
        .post('/api/orders')
        .set(rep.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      expect(res.status).toBe(403);
    });

    it('shows a rep an order assigned to them', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);

      const order = await placeOrder(admin, customer, rep);

      expect((await api().get(`/api/orders/${order._id}`).set(rep.headers)).status).toBe(200);
      expect((await api().get('/api/orders').set(rep.headers)).body.total).toBe(1);
    });

    it('hides an order assigned to a different rep', async () => {
      const admin = await createAdmin();
      const mine = await createRep({ email: 'mine@example.com' });
      const theirs = await createRep({ email: 'theirs@example.com' });
      const customer = await createCustomer(admin);

      const order = await placeOrder(admin, customer, theirs);

      expect((await api().get(`/api/orders/${order._id}`).set(mine.headers)).status).toBe(403);
      expect((await api().get('/api/orders').set(mine.headers)).body.total).toBe(0);
    });

    /**
     * Unassigned orders belong to nobody in particular, and a rep is nobody in
     * particular until somebody says otherwise. Leaking them would make
     * assignment optional in practice.
     */
    it('hides an order that has not been assigned to anyone', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);

      await placeOrder(admin, customer);

      expect((await api().get('/api/orders').set(rep.headers)).body.total).toBe(0);
    });

    it('lets an admin and a manager read any order', async () => {
      const admin = await createAdmin();
      const manager = await createManager();
      const rep = await createRep();
      const customer = await createCustomer(admin);

      const order = await placeOrder(admin, customer, rep);

      expect((await api().get(`/api/orders/${order._id}`).set(admin.headers)).status).toBe(200);
      expect((await api().get(`/api/orders/${order._id}`).set(manager.headers)).status).toBe(200);
    });

    /**
     * THE ONE WRITE A REP HAS.
     *
     * Completing the order is the step the assignment exists to let them take.
     * Without it a rep can see the work and not do it, which is not a
     * permission model, it is a waiting room.
     */
    it('lets the assigned rep complete their order', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);

      const order = await placeOrder(admin, customer, rep);

      const res = await api()
        .patch(`/api/orders/${order._id}`)
        .set(rep.headers)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
    });

    /**
     * Moving the order is not the same act as rewriting it. Refused explicitly
     * rather than by silently dropping the field — a rep who edited quantities
     * and got a 200 back would find out from the customer.
     */
    it('refuses the assigned rep a change to the items', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);
      const other = await createProduct({ stockQty: 50 });

      const order = await placeOrder(admin, customer, rep);

      const res = await api()
        .patch(`/api/orders/${order._id}`)
        .set(rep.headers)
        .send({ items: [{ product: other._id, quantity: 99 }] });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/not change what is on it/i);
    });

    it('refuses a rep the reassignment of their own order', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const someone = await createRep({ email: 'someone@example.com' });
      const customer = await createCustomer(admin);

      const order = await placeOrder(admin, customer, rep);

      const res = await api()
        .patch(`/api/orders/${order._id}/assign`)
        .set(rep.headers)
        .send({ assignedTo: someone.user._id });

      expect(res.status).toBe(403);
    });

    it('refuses a rep the deletion of their own order', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);

      const order = await placeOrder(admin, customer, rep);

      expect((await api().delete(`/api/orders/${order._id}`).set(rep.headers)).status).toBe(403);
    });

    /**
     * The narrow hole through which a rep sees a customer at all. They have no
     * customer book; they need a phone number and an address to deliver the
     * order they are holding.
     */
    it('gives the assigned rep the delivery details on their order', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin, {
        phone: '+92 300 1234567',
        address: '12 Ledger Road, Karachi',
      });

      const order = await placeOrder(admin, customer, rep);

      const res = await api().get(`/api/orders/${order._id}`).set(rep.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.customer.phone).toBe('+92 300 1234567');
      expect(res.body.data.customer.address).toBe('12 Ledger Road, Karachi');
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

/**
 * The colleague picker.
 *
 * It fills "assign to" controls, so what it returns is what a user can pick —
 * which makes the exclusions the interesting part. Offering a name that the
 * write endpoints then refuse is a picker whose options are partly decorative,
 * and the person choosing has no way to tell which.
 */
describe('GET /api/users/assignable', () => {
  const { api, createAdmin, createManager, createRep } = require('./helpers');

  it('is available to every authenticated role', async () => {
    const rep = await createRep();

    const res = await api().get('/api/users/assignable').set(rep.headers);

    expect(res.status).toBe(200);
  });

  it('is refused to an anonymous caller', async () => {
    expect((await api().get('/api/users/assignable')).status).toBe(401);
  });

  /** Names and roles only — this is reachable by every role in the system. */
  it('exposes no sensitive fields', async () => {
    const rep = await createRep();

    const res = await api().get('/api/users/assignable').set(rep.headers);

    for (const user of res.body.data) {
      expect(user.password).toBeUndefined();
      expect(user.failedLoginAttempts).toBeUndefined();
      expect(user).toHaveProperty('name');
      expect(user).toHaveProperty('role');
    }
  });

  /**
   * A deactivated colleague cannot sign in, so work assigned to them lands in
   * a list nobody opens — which looks exactly like the work being handled.
   */
  it('omits deactivated accounts', async () => {
    const admin = await createAdmin();
    const leaver = await createRep({ name: 'Departed Rep', email: 'gone@example.com' });

    await api()
      .patch(`/api/users/${leaver.user._id}/status`)
      .set(admin.headers)
      .send({ status: 'deactivated' });

    const res = await api().get('/api/users/assignable').set(admin.headers);

    expect(res.body.data.map((u) => u.name)).not.toContain('Departed Rep');
  });

  /** A pending account has not set a password yet, so it cannot work either. */
  it('omits accounts that have not been activated', async () => {
    const admin = await createAdmin();

    await api()
      .post('/api/users/invite')
      .set(admin.headers)
      .send({ name: 'Not Yet Started', email: 'soon@example.com', role: 'sales_rep' });

    const res = await api().get('/api/users/assignable').set(admin.headers);

    expect(res.body.data.map((u) => u.name)).not.toContain('Not Yet Started');
  });

  describe('?search=', () => {
    it('narrows by name', async () => {
      const admin = await createAdmin();
      await createManager({ name: 'Bilal Ahmed', email: 'bilal@example.com' });
      await createRep({ name: 'Sana Iqbal', email: 'sana@example.com' });

      const res = await api()
        .get('/api/users/assignable')
        .query({ search: 'bilal' })
        .set(admin.headers);

      expect(res.body.data.map((u) => u.name)).toEqual(['Bilal Ahmed']);
    });

    it('narrows by email too, since that is what people paste', async () => {
      const admin = await createAdmin();
      await createRep({ name: 'Sana Iqbal', email: 'sana@example.com' });

      const res = await api()
        .get('/api/users/assignable')
        .query({ search: 'sana@example' })
        .set(admin.headers);

      expect(res.body.data.map((u) => u.name)).toEqual(['Sana Iqbal']);
    });

    /** A picker shows a handful; an uncapped list grows with the company. */
    it('caps how many it returns', async () => {
      const admin = await createAdmin();

      const res = await api().get('/api/users/assignable').set(admin.headers);

      expect(res.body.data.length).toBeLessThanOrEqual(25);
    });
  });
});

/**
 * What the colleague picker hands out, and to whom.
 *
 * A sales rep reaches `/users/assignable` legitimately — the transfer-request
 * picker has to list colleagues — so the route cannot simply be closed to them.
 * What they have no use for is anybody's email address, and returning it made
 * this an internal staff directory that any rep could enumerate.
 *
 * Not an escalation. Worth fixing anyway: an endpoint handing out more than its
 * caller can use is how internal details leave the building.
 */
describe('GET /api/users/assignable — what each role is shown', () => {
  it('gives a sales rep names to pick from, and no email addresses', async () => {
    const rep = await createRep();
    await createManager({ name: 'Bilal Ahmed', email: 'bilal@example.com' });

    const res = await api().get('/api/users/assignable').set(rep.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);

    for (const user of res.body.data) {
      expect(user.name).toEqual(expect.any(String));
      expect(user.email).toBeUndefined();
    }
  });

  /** The picker is still usable — a name to show and a role to qualify it. */
  it('still returns enough for a rep to choose somebody', async () => {
    const rep = await createRep();
    await createManager({ name: 'Bilal Ahmed', email: 'bilal@example.com' });

    const res = await api()
      .get('/api/users/assignable')
      .query({ search: 'Bilal' })
      .set(rep.headers);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ name: 'Bilal Ahmed', role: 'manager' });
  });

  /** Anyone who manages people identifies them by address, so they keep it. */
  it.each([['admin'], ['manager']])('gives %s the email address', async (role) => {
    const actor = role === 'admin' ? await createAdmin() : await createManager();
    await createRep({ name: 'Sara Iqbal', email: 'sara@example.com' });

    const res = await api()
      .get('/api/users/assignable')
      .query({ search: 'Sara' })
      .set(actor.headers);

    expect(res.body.data[0].email).toBe('sara@example.com');
  });
});
