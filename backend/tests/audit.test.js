const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');
const AuditLog = require('../src/models/AuditLog');

/**
 * Audit logging.
 *
 * Two things are being tested, and the second is easy to forget:
 *
 *   1. that every write is recorded, with enough detail to be useful
 *   2. that the trail itself is not a hole in the permission model — it holds
 *      a copy of every field of every record, so who can read it matters more
 *      than for any other endpoint
 */

describe('Audit logging', () => {
  let admin;
  let manager;

  beforeEach(async () => {
    admin = await createAdmin();
    manager = await createManager();
  });

  describe('customers', () => {
    it('records a creation with the resulting document', async () => {
      const res = await api()
        .post('/api/customers')
        .set(admin.headers)
        .send({ name: 'Acme Ltd', email: 'acme@example.com', city: 'Karachi' });

      const log = await AuditLog.findOne({ entity: 'customer', action: 'create' });

      expect(log).not.toBeNull();
      expect(String(log.entityId)).toBe(res.body.data._id);
      expect(log.after.name).toBe('Acme Ltd');
      expect(log.before).toBeNull();
    });

    /**
     * The property that makes the trail worth keeping: the value BEFORE the
     * change, which the record itself no longer holds.
     */
    it('records what a field changed from and to', async () => {
      const customer = await createCustomer(manager, { name: 'Old Name', status: 'lead' });

      await api()
        .patch(`/api/customers/${customer._id}`)
        .set(admin.headers)
        .send({ name: 'New Name', status: 'active' });

      const log = await AuditLog.findOne({ entity: 'customer', action: 'update' });

      expect(log.before.name).toBe('Old Name');
      expect(log.after.name).toBe('New Name');

      const byField = Object.fromEntries(log.changes.map((c) => [c.field, c]));
      expect(byField.status).toMatchObject({ from: 'lead', to: 'active' });
    });

    it('lists only the fields that actually changed', async () => {
      const customer = await createCustomer(manager, { name: 'Acme', city: 'Karachi' });

      await api()
        .patch(`/api/customers/${customer._id}`)
        .set(admin.headers)
        .send({ name: 'Acme', city: 'Lahore' }); // name resent unchanged

      const log = await AuditLog.findOne({ entity: 'customer', action: 'update' });

      expect(log.changes.map((c) => c.field)).toEqual(['city']);
    });

    /**
     * A deletion is the case where the trail matters most, and the one where
     * an id alone is useless — nothing can look up what the record was called
     * once it is gone.
     */
    it('records a deletion with the document and a readable label', async () => {
      const customer = await createCustomer(manager, { name: 'Doomed Ltd' });

      await api().delete(`/api/customers/${customer._id}`).set(admin.headers);

      const log = await AuditLog.findOne({ entity: 'customer', action: 'delete' });

      expect(log.entityLabel).toBe('Doomed Ltd');
      expect(log.before.name).toBe('Doomed Ltd');
      expect(log.after).toBeNull();
    });
  });

  describe('products, orders and users', () => {
    it('records product writes', async () => {
      const created = await api()
        .post('/api/products')
        .set(manager.headers)
        .send({ name: 'Blue Widget', sku: 'BW-1', price: 10, stockQty: 5 });

      await api()
        .patch(`/api/products/${created.body.data._id}`)
        .set(manager.headers)
        .send({ stockQty: 3 });

      const logs = await AuditLog.find({ entity: 'product' }).sort({ createdAt: 1 });

      expect(logs.map((l) => l.action)).toEqual(['create', 'update']);
      // A manual stock correction and a mistake look identical in the product
      // document; only the trail can tell them apart.
      expect(logs[1].changes.find((c) => c.field === 'stockQty')).toMatchObject({
        from: 5,
        to: 3,
      });
    });

    it('records order creation', async () => {
      const customer = await createCustomer(manager);
      const product = await createProduct({ stockQty: 10 });

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 2 }] });

      const log = await AuditLog.findOne({ entity: 'order', action: 'create' });

      expect(String(log.entityId)).toBe(res.body.data._id);
    });

    it('records an order status transition', async () => {
      const customer = await createCustomer(manager);
      const product = await createProduct({ stockQty: 10 });

      const created = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 2 }] });

      await api()
        .patch(`/api/orders/${created.body.data._id}`)
        .set(manager.headers)
        .send({ status: 'completed' });

      const log = await AuditLog.findOne({ entity: 'order', action: 'update' });

      expect(log.changes.find((c) => c.field === 'status')).toMatchObject({
        from: 'pending',
        to: 'completed',
      });
    });

    /** The most security-relevant write in the app. */
    it('records a role change', async () => {
      const rep = await createRep();

      await api()
        .patch(`/api/users/${rep.user._id}`)
        .set(admin.headers)
        .send({ role: 'manager' });

      const log = await AuditLog.findOne({ entity: 'user', action: 'update' });

      expect(log.changes.find((c) => c.field === 'role')).toMatchObject({
        from: 'sales_rep',
        to: 'manager',
      });
    });
  });

  describe('what is captured about the actor and the request', () => {
    it('snapshots the actor rather than only referencing them', async () => {
      await api()
        .post('/api/products')
        .set(manager.headers)
        .send({ name: 'Widget', sku: 'AUDIT-1', price: 10, stockQty: 5 });

      const log = await AuditLog.findOne({});

      expect(String(log.actor.user)).toBe(String(manager.user._id));
      expect(log.actor.name).toBe(manager.user.name);
      expect(log.actor.role).toBe('manager');
    });

    /**
     * The reason the snapshot exists: an audit trail whose contents change when
     * someone is deleted is not an audit trail.
     */
    it('keeps the actor readable after their account is deleted', async () => {
      await api()
        .post('/api/products')
        .set(manager.headers)
        .send({ name: 'Widget', sku: 'AUDIT-1', price: 10, stockQty: 5 });

      await api().delete(`/api/users/${manager.user._id}`).set(admin.headers);

      const log = await AuditLog.findOne({ entity: 'product' });

      expect(log.actor.name).toBe(manager.user.name);
      expect(log.actor.role).toBe('manager');
    });

    it('records the request metadata', async () => {
      await api()
        .post('/api/products')
        .set(manager.headers)
        .set('User-Agent', 'jest-test-agent')
        .send({ name: 'Widget', sku: 'AUDIT-1', price: 10, stockQty: 5 });

      const log = await AuditLog.findOne({});

      expect(log.method).toBe('POST');
      expect(log.path).toBe('/api/products');
      expect(log.userAgent).toBe('jest-test-agent');
      expect(log.ip).toBeTruthy();
    });

    /**
     * An audit trail is kept forever and read by administrators, which makes it
     * exactly the wrong place to accumulate credentials.
     */
    it('never stores a password hash', async () => {
      await api()
        .post('/api/users')
        .set(admin.headers)
        .send({ name: 'New Rep', email: 'rep@example.com', password: 'Karachi-Ledger-72' });

      const log = await AuditLog.findOne({ entity: 'user', action: 'create' });

      expect(log.after.password).toBeUndefined();
      expect(JSON.stringify(log.after)).not.toContain('$2b$');
    });
  });

  describe('failed writes', () => {
    /** Nothing happened, so nothing should be recorded as having happened. */
    it('records nothing when the write is rejected', async () => {
      const rep = await createRep();
      const someoneElsesCustomer = await createCustomer(manager);

      const res = await api()
        .patch(`/api/customers/${someoneElsesCustomer._id}`)
        .set(rep.headers)
        .send({ name: 'Hijacked' });

      expect(res.status).toBe(403);
      expect(await AuditLog.countDocuments({})).toBe(0);
    });

    it('records nothing when an order rolls back', async () => {
      const customer = await createCustomer(manager);
      const product = await createProduct({ stockQty: 1 });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({
          customer: customer._id,
          status: 'completed',
          items: [{ product: product._id, quantity: 50 }],
        });

      expect(await AuditLog.countDocuments({ entity: 'order' })).toBe(0);
    });
  });

  describe('GET /api/audit-logs', () => {
    beforeEach(async () => {
      await api()
        .post('/api/customers')
        .set(admin.headers)
        .send({ name: 'Acme', email: 'acme@example.com' });
      await api()
        .post('/api/products')
        .set(manager.headers)
        .send({ name: 'Widget', sku: 'W-1', price: 5, stockQty: 5 });
    });

    it('returns the trail to an admin', async () => {
      const res = await api().get('/api/audit-logs').set(admin.headers);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    });

    /**
     * The trail holds a copy of every field of every record, so a manager who
     * could read it would be reading their own audit — and a sales rep would be
     * reading customers they have no access to. Restricting it to admins is
     * what stops it undoing the rest of the permission model.
     */
    it('refuses a manager', async () => {
      const res = await api().get('/api/audit-logs').set(manager.headers);
      expect(res.status).toBe(403);
    });

    it('refuses a sales rep', async () => {
      const rep = await createRep();
      const res = await api().get('/api/audit-logs').set(rep.headers);
      expect(res.status).toBe(403);
    });

    it('refuses an unauthenticated request', async () => {
      const res = await api().get('/api/audit-logs');
      expect(res.status).toBe(401);
    });

    it('filters by entity', async () => {
      const res = await api().get('/api/audit-logs?entity=product').set(admin.headers);

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].entity).toBe('product');
    });

    /**
     * One entry per actor in the setup above, which makes this a better test
     * than it was: it previously filtered a trail where every entry belonged to
     * the same person, so it would have passed against a filter that did
     * nothing at all.
     */
    it('filters by actor', async () => {
      const byManager = await api()
        .get(`/api/audit-logs?actor=${manager.user._id}`)
        .set(admin.headers);
      const byAdmin = await api()
        .get(`/api/audit-logs?actor=${admin.user._id}`)
        .set(admin.headers);

      expect(byManager.body.total).toBe(1);
      expect(byManager.body.data[0].entity).toBe('product');

      expect(byAdmin.body.total).toBe(1);
      expect(byAdmin.body.data[0].entity).toBe('customer');
    });

    it('returns the newest first', async () => {
      const res = await api().get('/api/audit-logs').set(admin.headers);

      const times = res.body.data.map((log) => new Date(log.createdAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('paginates', async () => {
      const res = await api().get('/api/audit-logs?limit=1').set(admin.headers);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.pages).toBe(2);
    });

    /** An audit trail that can be edited through the API is not evidence. */
    it('offers no way to write to the trail', async () => {
      const existing = await AuditLog.findOne({});

      const created = await api().post('/api/audit-logs').set(admin.headers).send({});
      const deleted = await api()
        .delete(`/api/audit-logs/${existing._id}`)
        .set(admin.headers);

      expect(created.status).toBe(404);
      expect(deleted.status).toBe(404);
      expect(await AuditLog.countDocuments({})).toBe(2);
    });
  });
});
