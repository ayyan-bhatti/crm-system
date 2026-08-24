const Order = require('../src/models/Order');
const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');

/**
 * Assigning an order to a rep.
 *
 * THE DESIGN CLAIM UNDER TEST.
 *
 * An order's assignment is an OVERRIDE of the customer's, not a second way in.
 * That distinction is the whole feature, and it is the half that is easy to get
 * wrong: making an assignment grant access is obvious, and making it also
 * REMOVE access from the customer's owner is what most implementations forget.
 * Without the second half, handing an order to a specialist adds it to their
 * list and changes nothing for the person who gave it up, so the two of them
 * both think they own it.
 */

describe('order assignment', () => {
  let admin;
  let manager;
  let owner;
  let specialist;
  let customer;
  let product;
  let order;

  beforeEach(async () => {
    admin = await createAdmin();
    manager = await createManager();
    owner = await createRep({ name: 'Owning Rep', email: 'owner@example.com' });
    specialist = await createRep({ name: 'Specialist', email: 'spec@example.com' });

    // A customer belonging to `owner`, so their orders are inherited by them.
    customer = await createCustomer(manager, { assignedTo: owner.user._id });
    product = await createProduct({ price: 100, stockQty: 500 });

    /*
     * Placed by an ADMIN, not by the rep who will end up holding it. A rep
     * cannot place an order any more, and a manager's would queue for approval
     * rather than existing — neither gives this suite an order to reassign.
     */
    const created = await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

    order = created.body.data;
  });

  const assign = (to, actor = manager) =>
    api().patch(`/api/orders/${order._id}/assign`).set(actor.headers).send({ assignedTo: to });

  const listAs = (rep) => api().get('/api/orders').set(rep.headers);

  describe('who may reassign', () => {
    it('allows a manager', async () => {
      expect((await assign(specialist.user._id, manager)).status).toBe(200);
    });

    it('allows an admin', async () => {
      const admin = await createAdmin();
      expect((await assign(specialist.user._id, admin)).status).toBe(200);
    });

    /**
     * A rep handing their own work to someone else is a business decision
     * somebody else should be making, and letting them do it would also let
     * them push a problem account onto a colleague.
     */
    it('refuses a sales rep, even for an order they own', async () => {
      const res = await assign(specialist.user._id, owner);

      expect(res.status).toBe(403);
    });
  });

  describe('what it changes', () => {
    it('records the new assignee on the order', async () => {
      const res = await assign(specialist.user._id);

      expect(res.body.data.assignedTo._id).toBe(String(specialist.user._id));
      expect(res.body.data.assignedTo.name).toBe('Specialist');
    });

    it('puts the order in the new rep’s list', async () => {
      await assign(specialist.user._id);

      const res = await listAs(specialist);
      expect(res.body.data.map((row) => row._id)).toContain(order._id);
    });

    /**
     * MOVING AN ORDER TAKES IT AWAY FROM THE PREVIOUS HOLDER.
     *
     * An assignment that only ever adds access is not an assignment — both reps
     * would believe the order was theirs. This used to be phrased against the
     * inherited rule ("even though they still own the customer"); reps no longer
     * own customers, so the property is simply that a hand-off is a hand-off.
     */
    it('removes it from the previous rep’s list', async () => {
      await assign(owner.user._id);
      const before = await listAs(owner);
      expect(before.body.data.map((row) => row._id)).toContain(order._id);

      await assign(specialist.user._id);

      const after = await listAs(owner);
      expect(after.body.data.map((row) => row._id)).not.toContain(order._id);
    });

    /** The list and the detail endpoint must agree, or a rep sees a row they cannot open. */
    it('refuses the previous rep the order detail as well', async () => {
      await assign(specialist.user._id);

      expect((await api().get(`/api/orders/${order._id}`).set(owner.headers)).status).toBe(403);
      expect((await api().get(`/api/orders/${order._id}`).set(specialist.headers)).status).toBe(
        200
      );
    });

    it('leaves the customer with their original rep', async () => {
      await assign(specialist.user._id);

      const res = await api().get(`/api/customers/${customer._id}`).set(manager.headers);
      expect(String(res.body.data.assignedTo._id)).toBe(String(owner.user._id));
    });
  });

  describe('clearing the assignment', () => {
    /**
     * A real operation, and it returns the order to NOBODY rather than to the
     * customer's rep. Reps have no customers to inherit from any more, so an
     * unassigned order waits for somebody to be given it — which is the honest
     * state for work nobody has picked up.
     */
    it('takes the order out of every rep’s list', async () => {
      await assign(specialist.user._id);
      const res = await assign(null);

      expect(res.status).toBe(200);
      expect(res.body.data.assignedTo).toBeNull();

      expect((await listAs(specialist)).body.data.map((row) => row._id)).not.toContain(order._id);
      expect((await listAs(owner)).body.data.map((row) => row._id)).not.toContain(order._id);
    });

    /** Still visible to the people who run the business, or it is lost. */
    it('leaves it visible to a manager', async () => {
      await assign(specialist.user._id);
      await assign(null);

      const res = await api().get('/api/orders').set(manager.headers);
      expect(res.body.data.map((row) => row._id)).toContain(order._id);
    });
  });

  describe('what it refuses', () => {
    it('rejects a user id that does not exist', async () => {
      const res = await assign('650000000000000000000099');

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not exist/i);
    });

    it('rejects a value that is not an id at all', async () => {
      const res = await assign('not-an-id');

      expect(res.status).toBe(400);
    });

    /**
     * A deactivated account cannot sign in, so work assigned to it lands in a
     * list nobody opens — which looks exactly like the order being handled.
     */
    it('refuses to assign work to a deactivated account', async () => {
      const admin = await createAdmin();
      await api()
        .patch(`/api/users/${specialist.user._id}/status`)
        .set(admin.headers)
        .send({ status: 'deactivated' });

      const res = await assign(specialist.user._id);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not active/i);
    });

    it('404s for an order that does not exist', async () => {
      const res = await api()
        .patch('/api/orders/650000000000000000000099/assign')
        .set(manager.headers)
        .send({ assignedTo: specialist.user._id });

      expect(res.status).toBe(404);
    });
  });

  describe('the audit trail', () => {
    it('records the change with both names, not two ids', async () => {
      const admin = await createAdmin();

      await assign(specialist.user._id);

      const audit = await api()
        .get('/api/audit-logs')
        .query({ entity: 'order' })
        .set(admin.headers);

      const entry = audit.body.data.find((row) => row.note?.includes('assigned'));

      expect(entry).toBeDefined();
      expect(entry.note).toContain('follows customer');
      expect(entry.note).toContain('Specialist');
    });

    it('names both reps when reassigning from one to another', async () => {
      const admin = await createAdmin();

      await assign(specialist.user._id);
      await assign(owner.user._id);

      const audit = await api()
        .get('/api/audit-logs')
        .query({ entity: 'order' })
        .set(admin.headers);

      const entry = audit.body.data.find((row) => row.note?.includes('Specialist →'));

      expect(entry).toBeDefined();
      expect(entry.note).toContain('Owning Rep');
    });
  });

  /**
   * Orders created before this field existed have no `assignedTo` at all. They
   * must keep behaving exactly as they did, or the change is a silent
   * permission migration.
   */
  describe('orders predating the field', () => {
    /**
     * An order written before `assignedTo` existed has the field ABSENT rather
     * than null. MongoDB treats the two the same for equality, so such an order
     * is simply unassigned — waiting to be given to somebody, and meanwhile
     * visible to the people who run the business.
     *
     * It used to be visible to the customer's rep instead. Worth a test either
     * way: "absent" and "null" being equivalent is the kind of assumption that
     * is true until somebody writes a query with `$exists`.
     */
    it('is treated as unassigned rather than disappearing', async () => {
      const legacy = await Order.create({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1, priceAtOrder: 100 }],
        total: 100,
        createdBy: manager.user._id,
      });

      await Order.collection.updateOne({ _id: legacy._id }, { $unset: { assignedTo: '' } });

      // In nobody's rep list...
      expect((await listAs(owner)).body.data.map((row) => row._id)).not.toContain(
        String(legacy._id)
      );

      // ...and not lost: a manager still sees it.
      const asManager = await api().get('/api/orders').set(manager.headers);
      expect(asManager.body.data.map((row) => row._id)).toContain(String(legacy._id));
    });
  });
});
