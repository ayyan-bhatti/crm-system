const Customer = require('../src/models/Customer');
const Order = require('../src/models/Order');
const ChangeRequest = require('../src/models/ChangeRequest');
const changeRequestService = require('../src/services/changeRequestService');
const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
  createBuyer,
} = require('./helpers');

/**
 * A manager proposes, an administrator decides.
 *
 * THE PROPERTY THAT MATTERS MOST.
 *
 * Nothing is written when the change is proposed. Not written-and-hidden, not
 * written-and-reverted-on-rejection — not written. The alternative is simpler
 * and wrong: between the write and the rejection the record is LIVE, and a live
 * order can be completed and move stock, a live customer address is the one a
 * delivery goes to. Most of these tests are checking that absence.
 */

describe('proposing a change', () => {
  let admin;
  let manager;

  beforeEach(async () => {
    admin = await createAdmin();
    manager = await createManager();
  });

  const CUSTOMER = {
    name: 'Proposed Traders',
    email: 'proposed@example.com',
    phone: '+92 300 1112222',
    address: '5 Ledger Road, Karachi',
    city: 'Karachi',
  };

  describe('a manager creating a customer', () => {
    it('is accepted as a request rather than refused', async () => {
      const res = await api().post('/api/customers').set(manager.headers).send(CUSTOMER);

      expect(res.status).toBe(202);
      expect(res.body.message).toMatch(/approval/i);
    });

    /** The whole design in one assertion. */
    it('creates no customer', async () => {
      await api().post('/api/customers').set(manager.headers).send(CUSTOMER);

      expect(await Customer.findOne({ email: CUSTOMER.email })).toBeNull();
    });

    it('records what was asked for, so it can be applied later', async () => {
      await api().post('/api/customers').set(manager.headers).send(CUSTOMER);

      const request = await ChangeRequest.findOne({ entity: 'customer' });

      expect(request.action).toBe('create');
      expect(request.status).toBe('pending');
      expect(request.payload.name).toBe('Proposed Traders');
      expect(request.payload.address).toBe('5 Ledger Road, Karachi');
      expect(String(request.requestedBy)).toBe(String(manager.user._id));
    });
  });

  describe('an admin creating a customer', () => {
    /**
     * Requiring an admin to approve themselves would be theatre, and a queue
     * that fills with your own requests is a queue you stop reading.
     */
    it('applies immediately, with no request in between', async () => {
      const res = await api().post('/api/customers').set(admin.headers).send(CUSTOMER);

      expect(res.status).toBe(201);
      expect(await Customer.findOne({ email: CUSTOMER.email })).not.toBeNull();
      expect(await ChangeRequest.countDocuments({})).toBe(0);
    });
  });

  describe('a manager editing a customer', () => {
    it('leaves the record untouched until approved', async () => {
      const customer = await createCustomer(admin, { name: 'Original Name' });

      const res = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ name: 'Renamed By A Manager' });

      expect(res.status).toBe(202);
      expect((await Customer.findById(customer._id)).name).toBe('Original Name');
    });

    /**
     * Only the fields that were sent. Approving later then changes exactly what
     * was proposed, and nothing that has moved on in the meantime.
     */
    it('records only the fields that were actually sent', async () => {
      const customer = await createCustomer(admin, { name: 'Original Name' });

      await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ city: 'Lahore' });

      const request = await ChangeRequest.findOne({ entity: 'customer' });

      expect(Object.keys(request.payload)).toEqual(['city']);
    });
  });

  describe('a manager deleting a customer', () => {
    it('leaves the customer in place', async () => {
      const customer = await createCustomer(admin);

      const res = await api()
        .delete(`/api/customers/${customer._id}`)
        .set(manager.headers);

      expect(res.status).toBe(202);
      expect(await Customer.findById(customer._id)).not.toBeNull();
    });
  });

  /**
   * PLACING AN ORDER IS NOT A CHANGE REQUEST, AND USED TO BE.
   *
   * It queued for an admin, and that was the wrong call: it put the approver in
   * the critical path of SELLING, so nothing a manager agreed became real — and
   * no rep could start work — until somebody else acted.
   *
   * What still waits is changing or destroying a record that already exists.
   * The full lifecycle lives in orderWorkflow.test.js; these two pin the
   * boundary from this side, so the day somebody re-queues order creation, the
   * test that fails says why it should not be.
   */
  describe('a manager placing an order', () => {
    it('places it directly, with nothing queued', async () => {
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 10 });

      const res = await api()
        .post('/api/orders')
        .set(manager.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 2 }] });

      expect(res.status).toBe(201);
      expect(await Order.countDocuments({})).toBe(1);
      expect(await ChangeRequest.countDocuments({})).toBe(0);
    });

    /** Editing one afterwards is a different act, and does wait. */
    it('queues a later edit to the same order', async () => {
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 10 });

      const created = await api()
        .post('/api/orders')
        .set(manager.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 2 }] });

      const res = await api()
        .patch(`/api/orders/${created.body.data._id}`)
        .set(manager.headers)
        .send({ items: [{ product: product._id, quantity: 5 }] });

      expect(res.status).toBe(202);
      expect(await ChangeRequest.countDocuments({ entity: 'order' })).toBe(1);
    });
  });

  /**
   * Two managers queueing conflicting edits to one record, both approved, means
   * the second silently overwrites the first — having been written against a
   * version that no longer exists. Refusing the second submission puts that
   * conflict in front of the person making it.
   */
  describe('two requests against the same record', () => {
    it('refuses the second while the first is outstanding', async () => {
      const customer = await createCustomer(admin);

      const first = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ city: 'Lahore' });
      const second = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ city: 'Islamabad' });

      expect(first.status).toBe(202);
      expect(second.status).toBe(409);
      expect(await ChangeRequest.countDocuments({})).toBe(1);
    });

    /** Creations have no record to conflict over, so they queue freely. */
    it('allows two creations, which cannot conflict', async () => {
      await api().post('/api/customers').set(manager.headers).send(CUSTOMER);
      await api()
        .post('/api/customers')
        .set(manager.headers)
        .send({ ...CUSTOMER, email: 'second@example.com' });

      expect(await ChangeRequest.countDocuments({})).toBe(2);
    });
  });
});

describe('deciding on a change', () => {
  let admin;
  let manager;

  beforeEach(async () => {
    admin = await createAdmin();
    manager = await createManager();
  });

  /** Propose a customer creation and return the request. */
  const proposeCreate = async (overrides = {}) => {
    await api()
      .post('/api/customers')
      .set(manager.headers)
      .send({
        name: 'Proposed Traders',
        email: 'proposed@example.com',
        city: 'Karachi',
        ...overrides,
      });

    return ChangeRequest.findOne({ entity: 'customer' });
  };

  const queue = (actor = admin) => api().get('/api/change-requests').set(actor.headers);

  describe('the queue', () => {
    it('lists what is waiting, with who asked', async () => {
      await proposeCreate();

      const res = await queue();

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].requestedBy.name).toBe(manager.user.name);
      expect(res.body.data[0].label).toBe('Proposed Traders');
    });

    /** A queue is worked from the front. */
    it('lists the longest wait first', async () => {
      await proposeCreate({ name: 'First', email: 'first@example.com' });
      await proposeCreate({ name: 'Second', email: 'second@example.com' });

      const res = await queue();

      expect(res.body.data.map((r) => r.label)).toEqual(['First', 'Second']);
    });

    /**
     * A sales rep never sees this queue at all — nothing in their role
     * submits to it or decides from it.
     */
    it('is refused to a sales rep', async () => {
      const rep = await createRep();
      expect((await queue(rep)).status).toBe(403);
    });

    /*
     * A manager may now open the queue — the storefront brief asks for a
     * buyer's cancel/edit request to be visible to any manager, not admin
     * alone. What a manager sees is filtered, though: their OWN
     * staff-initiated request (an approver who can approve their own request
     * is not an approver, the reason this queue was admin-only to begin
     * with) is hidden from them exactly as it always was, even though the
     * route itself now answers 200 rather than 403.
     */
    it('answers a manager, but hides staff-initiated requests from them', async () => {
      await proposeCreate();

      const res = await queue(manager);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('is refused to an anonymous caller', async () => {
      expect((await api().get('/api/change-requests')).status).toBe(401);
    });
  });

  describe('approving', () => {
    const approve = (id, actor = admin) =>
      api().patch(`/api/change-requests/${id}/approve`).set(actor.headers).send();

    it('makes the change that was proposed', async () => {
      const request = await proposeCreate();

      const res = await approve(request._id);

      expect(res.status).toBe(200);
      const customer = await Customer.findOne({ email: 'proposed@example.com' });
      expect(customer).not.toBeNull();
      expect(customer.name).toBe('Proposed Traders');
    });

    it('marks the request approved and records who decided', async () => {
      const request = await proposeCreate();

      await approve(request._id);

      const after = await ChangeRequest.findById(request._id);
      expect(after.status).toBe('approved');
      expect(String(after.reviewedBy)).toBe(String(admin.user._id));
      expect(after.reviewedAt).toBeInstanceOf(Date);
    });

    it('applies an edit to the right record', async () => {
      const customer = await createCustomer(admin, { name: 'Before' });
      await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ name: 'After' });

      const request = await ChangeRequest.findOne({ action: 'update' });
      await approve(request._id);

      expect((await Customer.findById(customer._id)).name).toBe('After');
    });

    it('applies a deletion', async () => {
      const customer = await createCustomer(admin);
      await api().delete(`/api/customers/${customer._id}`).set(manager.headers);

      const request = await ChangeRequest.findOne({ action: 'delete' });
      await approve(request._id);

      expect(await Customer.findById(customer._id)).toBeNull();
    });

    /**
     * An approved EDIT to an order has to be priced exactly as a direct one is.
     *
     * The payload holds `{ product, quantity }` and an order line needs
     * `priceAtOrder` with a total recomputed from the lines — assigning the raw
     * payload produced a 400 from the schema. Priced at APPROVAL time rather
     * than when it was asked for, so a request that sits in the queue over a
     * price rise applies the new price rather than the stale one.
     */
    it('prices an approved edit to an order', async () => {
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 10, price: 250 });

      const created = await api()
        .post('/api/orders')
        .set(manager.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      await api()
        .patch(`/api/orders/${created.body.data._id}`)
        .set(manager.headers)
        .send({ items: [{ product: product._id, quantity: 3 }] });

      const request = await ChangeRequest.findOne({ entity: 'order', action: 'update' });
      const res = await approve(request._id);

      expect(res.status).toBe(200);

      const order = await Order.findById(created.body.data._id);
      expect(order.total).toBe(750);
      expect(order.items[0].priceAtOrder).toBe(250);
    });

    it('refuses to approve the same request twice', async () => {
      const request = await proposeCreate();

      await approve(request._id);
      const second = await approve(request._id);

      expect(second.status).toBe(400);
      expect(await Customer.countDocuments({ email: 'proposed@example.com' })).toBe(1);
    });

    /**
     * A request overtaken by events. Not an error in the request, and it must
     * not be reported as one — saying so plainly is the only honest answer.
     */
    it('reports a conflict when the record has since been deleted', async () => {
      const customer = await createCustomer(admin, { name: 'Doomed' });
      await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ name: 'Renamed' });

      await Customer.findByIdAndDelete(customer._id);

      const request = await ChangeRequest.findOne({ action: 'update' });
      const res = await approve(request._id);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/no longer exists/i);
    });

    it('is refused to a manager for a staff-initiated request', async () => {
      const request = await proposeCreate();

      expect((await approve(request._id, manager)).status).toBe(403);
      expect(await Customer.countDocuments({ email: 'proposed@example.com' })).toBe(0);
    });

    /*
     * The other half of the split: a manager MAY decide a request nobody on
     * staff submitted. There is no self-approval conflict for a buyer's own
     * cancellation, which is the entire reason the queue was reopened to
     * managers at all.
     */
    it('is allowed for a manager deciding a buyer-initiated request', async () => {
      const order = await Order.create({
        customer: (await createCustomer(admin))._id,
        items: [
          { product: (await createProduct({ price: 5 }))._id, quantity: 1, priceAtOrder: 5 },
        ],
        total: 5,
        createdBy: admin.user._id,
      });
      const buyer = await createBuyer();

      const request = await changeRequestService.submit(
        { entity: 'order', entityId: order._id, action: 'cancel', label: 'Buyer order' },
        buyer
      );

      const res = await approve(request._id, manager);

      expect(res.status).toBe(200);
      expect((await Order.findById(order._id)).status).toBe('cancelled');
    });

    it('404s for a request that does not exist', async () => {
      expect((await approve('650000000000000000000099')).status).toBe(404);
    });
  });

  describe('rejecting', () => {
    const reject = (id, note, actor = admin) =>
      api()
        .patch(`/api/change-requests/${id}/reject`)
        .set(actor.headers)
        .send(note ? { note } : {});

    it('is refused to a manager for a staff-initiated request, allowed for a buyer one', async () => {
      const staffRequest = await proposeCreate();
      expect((await reject(staffRequest._id, undefined, manager)).status).toBe(403);

      const order = await Order.create({
        customer: (await createCustomer(admin))._id,
        items: [
          { product: (await createProduct({ price: 5 }))._id, quantity: 1, priceAtOrder: 5 },
        ],
        total: 5,
        createdBy: admin.user._id,
      });
      const buyerRequest = await changeRequestService.submit(
        { entity: 'order', entityId: order._id, action: 'cancel', label: 'Buyer order' },
        await createBuyer()
      );

      const res = await reject(buyerRequest._id, undefined, manager);
      expect(res.status).toBe(200);
      expect((await Order.findById(order._id)).status).toBe('pending');
    });

    /** Nothing to undo, because nothing was ever applied. */
    it('changes nothing', async () => {
      const request = await proposeCreate();

      const res = await reject(request._id);

      expect(res.status).toBe(200);
      expect(await Customer.findOne({ email: 'proposed@example.com' })).toBeNull();
    });

    it('records the decision and the reason', async () => {
      const request = await proposeCreate();

      await reject(request._id, 'We already have this account under another name.');

      const after = await ChangeRequest.findById(request._id);
      expect(after.status).toBe('rejected');
      expect(after.reviewNote).toMatch(/another name/);
      expect(String(after.reviewedBy)).toBe(String(admin.user._id));
    });

    it('takes the request out of the queue', async () => {
      const request = await proposeCreate();
      await reject(request._id);

      expect((await queue()).body.data).toHaveLength(0);
    });

    /** A rejected record is free to be proposed against again. */
    it('lets the record be proposed against again afterwards', async () => {
      const customer = await createCustomer(admin);
      await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ city: 'Lahore' });

      const request = await ChangeRequest.findOne({ action: 'update' });
      await reject(request._id);

      const again = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(manager.headers)
        .send({ city: 'Islamabad' });

      expect(again.status).toBe(202);
    });

    it('refuses to reject something already decided', async () => {
      const request = await proposeCreate();

      await reject(request._id);

      expect((await reject(request._id)).status).toBe(400);
    });
  });

  describe('notifying a buyer of the outcome', () => {
    const mailer = require('../src/services/mailer');
    const realSendMail = mailer.sendMail;
    let sent;

    beforeEach(() => {
      sent = [];
      mailer.sendMail = async (message) => {
        sent.push(message);
        return { delivered: true, transport: 'test' };
      };
    });

    afterEach(() => {
      mailer.sendMail = realSendMail;
    });

    async function buyerCancelRequest() {
      const order = await Order.create({
        customer: (await createCustomer(admin))._id,
        items: [
          { product: (await createProduct({ price: 5 }))._id, quantity: 1, priceAtOrder: 5 },
        ],
        total: 5,
        createdBy: admin.user._id,
      });
      const buyer = await createBuyer({ email: 'notify-me@example.com' });

      const request = await changeRequestService.submit(
        { entity: 'order', entityId: order._id, action: 'cancel', label: 'Buyer order' },
        buyer
      );

      return request;
    }

    it('emails the buyer when their request is approved', async () => {
      const request = await buyerCancelRequest();

      await api().patch(`/api/change-requests/${request._id}/approve`).set(admin.headers).send();

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('notify-me@example.com');
      expect(sent[0].text).toMatch(/approved/i);
    });

    it('emails the buyer when their request is rejected, with the reason', async () => {
      const request = await buyerCancelRequest();

      await api()
        .patch(`/api/change-requests/${request._id}/reject`)
        .set(admin.headers)
        .send({ note: 'Order already left the warehouse.' });

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toMatch(/not approved/i);
      expect(sent[0].text).toMatch(/already left the warehouse/i);
    });

    /** A staff-initiated request generates no buyer email — there is no buyer. */
    it('sends no email for a staff-initiated request', async () => {
      const request = await proposeCreate();

      await api().patch(`/api/change-requests/${request._id}/approve`).set(admin.headers).send();

      expect(sent).toHaveLength(0);
    });
  });

  /**
   * The trail has to answer "what happened to this customer", so an approved
   * change belongs in that record's history rather than in a parallel history of
   * approvals nobody thinks to open.
   */
  describe('the audit trail', () => {
    it('records an approval against the entity, naming who asked', async () => {
      const request = await proposeCreate();
      await api().patch(`/api/change-requests/${request._id}/approve`).set(admin.headers).send();

      const audit = await api()
        .get('/api/audit-logs')
        .query({ entity: 'customer' })
        .set(admin.headers);

      const entry = audit.body.data.find((row) => row.note?.includes('approved'));
      expect(entry).toBeDefined();
      expect(entry.note).toContain(manager.user.name);
    });

    /** "What did we decide not to do" is a question an audit gets asked. */
    it('records a rejection too', async () => {
      const request = await proposeCreate();
      await api()
        .patch(`/api/change-requests/${request._id}/reject`)
        .set(admin.headers)
        .send({ note: 'duplicate' });

      const audit = await api()
        .get('/api/audit-logs')
        .query({ entity: 'customer' })
        .set(admin.headers);

      expect(audit.body.data.some((row) => row.note?.includes('rejected'))).toBe(true);
    });
  });
});
