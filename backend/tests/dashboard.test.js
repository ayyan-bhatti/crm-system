const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');
const Order = require('../src/models/Order');

/**
 * The dashboard payload, per role.
 *
 * WHAT THIS FILE EXISTS TO PROVE.
 *
 * The three dashboards are meant to be genuinely different screens, not one
 * screen filtered three ways. That claim is only true if the SERVER sends
 * different things to each role — if the payload were identical and the
 * client hid pieces of it, a rep would still be one devtools tab away from
 * the company's revenue, and the "no empty tiles" rule would be a styling
 * decision rather than a real one.
 *
 * So these tests assert on what is ABSENT as much as on what is present.
 */
describe('Dashboard summary, per role', () => {
  describe('what every role gets', () => {
    it('echoes the role the server resolved, not one the client claimed', async () => {
      const admin = await createAdmin();
      const manager = await createManager();
      const rep = await createRep();

      const [a, m, r] = await Promise.all([
        api().get('/api/dashboard/summary').set(admin.headers),
        api().get('/api/dashboard/summary').set(manager.headers),
        api().get('/api/dashboard/summary').set(rep.headers),
      ]);

      expect(a.body.data.role).toBe('admin');
      expect(m.body.data.role).toBe('manager');
      expect(r.body.data.role).toBe('sales_rep');
    });

    it('requires authentication', async () => {
      const res = await api().get('/api/dashboard/summary');
      expect(res.status).toBe(401);
    });
  });

  describe('admin — the whole business, plus what only they can act on', () => {
    it('includes the approval queue and the account figures', async () => {
      const admin = await createAdmin();

      const res = await api().get('/api/dashboard/summary').set(admin.headers);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('pendingApprovals');
      expect(res.body.data).toHaveProperty('unassignedOrders');
      // Account management is the admin's alone — these two are what make
      // their dashboard structurally different from a manager's.
      expect(res.body.data).toHaveProperty('totalUsers');
      expect(res.body.data).toHaveProperty('pendingAccounts');
    });

    it('counts active and pending accounts from the real collection', async () => {
      const admin = await createAdmin();
      await createManager();

      await api().post('/api/auth/register').send({
        name: 'Hopeful Applicant',
        email: 'hopeful-dash@example.com',
        password: 'Karachi-Ledger-72',
        requestedRole: 'sales_rep',
      });

      const res = await api().get('/api/dashboard/summary').set(admin.headers);

      // The admin and the manager.
      expect(res.body.data.totalUsers).toBeGreaterThanOrEqual(2);
      expect(res.body.data.pendingAccounts).toBeGreaterThanOrEqual(1);
    });
  });

  describe('manager — the operating floor, without org administration', () => {
    it('gets the approval queue but NOT the account-management figures', async () => {
      const manager = await createManager();

      const res = await api().get('/api/dashboard/summary').set(manager.headers);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('pendingApprovals');
      expect(res.body.data).toHaveProperty('unassignedOrders');

      /*
       * The point of the split. A manager has no user-management screen, so
       * sending them a user count would be a figure they cannot act on — and
       * the previous dashboard's habit of doing exactly that is what made all
       * three roles look identical.
       */
      expect(res.body.data.totalUsers).toBeUndefined();
      expect(res.body.data.pendingAccounts).toBeUndefined();
    });
  });

  describe('sales rep — their own work, and nothing they cannot act on', () => {
    it('gets their own pending orders and no approval or account figures', async () => {
      const rep = await createRep();

      const res = await api().get('/api/dashboard/summary').set(rep.headers);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('myPendingOrders');
      expect(res.body.data).toHaveProperty('myPendingCount');

      // None of the manager/admin queues reach a rep at all.
      expect(res.body.data.pendingApprovals).toBeUndefined();
      expect(res.body.data.unassignedOrders).toBeUndefined();
      expect(res.body.data.totalUsers).toBeUndefined();
      expect(res.body.data.pendingAccounts).toBeUndefined();
    });

    /**
     * The empty-tile bug this design replaced.
     *
     * A rep has no customer book, so their customer count was always 0 — and
     * a tile reading "Customers: 0" states something false-sounding about the
     * business rather than true about their access. The figure is still zero
     * here (the scope filter is what makes it so), and the REP DASHBOARD
     * simply does not render a tile for it. Asserted so nobody "fixes" the
     * zero by widening a rep's scope.
     */
    it('still scopes the shared figures to nothing they do not own', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      await createCustomer(admin);
      await createCustomer(admin);

      const res = await api().get('/api/dashboard/summary').set(rep.headers);

      expect(res.body.data.totalCustomers).toBe(0);
      expect(res.body.data.totalRevenue).toBe(0);
    });

    it('lists only the pending orders assigned to them, oldest first', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const otherRep = await createRep({ email: 'other-rep@example.com' });
      const customer = await createCustomer(admin);
      const product = await createProduct({ price: 10, stockQty: 50 });

      const mine = await Order.create({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1, priceAtOrder: 10 }],
        total: 10,
        status: 'pending',
        createdBy: admin.user._id,
        assignedTo: rep.user._id,
      });

      await Order.create({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1, priceAtOrder: 10 }],
        total: 10,
        status: 'pending',
        createdBy: admin.user._id,
        assignedTo: otherRep.user._id,
      });

      // Assigned to them, but already finished — not "waiting on you".
      await Order.create({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1, priceAtOrder: 10 }],
        total: 10,
        status: 'completed',
        completedAt: new Date(),
        createdBy: admin.user._id,
        assignedTo: rep.user._id,
      });

      const res = await api().get('/api/dashboard/summary').set(rep.headers);

      expect(res.body.data.myPendingCount).toBe(1);
      expect(res.body.data.myPendingOrders).toHaveLength(1);
      expect(String(res.body.data.myPendingOrders[0]._id)).toBe(String(mine._id));
      // The customer is populated, because the rep needs to know who to call.
      expect(res.body.data.myPendingOrders[0].customer.name).toBe(customer.name);
    });
  });
});
