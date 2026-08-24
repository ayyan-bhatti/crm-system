const Order = require('../src/models/Order');
const ChangeRequest = require('../src/models/ChangeRequest');
const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');

/**
 * The order lifecycle, and who is allowed to do each part of it.
 *
 * THE SHAPE OF THE RULE.
 *
 * Placing an order is SELLING and goes through directly — a manager decides
 * what is sold and who works it, and putting an approver in that path means
 * nothing anyone agrees becomes real until somebody else acts. Changing or
 * destroying an order afterwards is editing the admin's data, and waits.
 *
 * A rep executes. They complete or cancel what they hold, and the one way they
 * can move work is to ASK.
 */

describe('placing an order', () => {
  let admin;
  let manager;
  let rep;
  let customer;
  let product;

  beforeEach(async () => {
    admin = await createAdmin();
    manager = await createManager();
    rep = await createRep({ name: 'Sara Iqbal', email: 'sara@example.com' });
    customer = await createCustomer(admin);
    product = await createProduct({ price: 100, stockQty: 50 });
  });

  const place = (actor, body = {}) =>
    api()
      .post('/api/orders')
      .set(actor.headers)
      .send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1 }],
        ...body,
      });

  /**
   * This used to queue for an admin, and it was the wrong call: it put the
   * approver in the critical path of selling.
   */
  it('lets a manager place one directly, with no approval', async () => {
    const res = await place(manager);

    expect(res.status).toBe(201);
    expect(await Order.countDocuments({})).toBe(1);
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });

  it('lets an admin place one directly', async () => {
    expect((await place(admin)).status).toBe(201);
  });

  it('refuses a sales rep', async () => {
    expect((await place(rep)).status).toBe(403);
    expect(await Order.countDocuments({})).toBe(0);
  });

  describe('naming who will work it', () => {
    it('assigns the order at the moment it is placed', async () => {
      const res = await place(manager, { assignedTo: rep.user._id });

      expect(res.status).toBe(201);
      expect(String(res.body.data.assignedTo)).toBe(String(rep.user._id));
    });

    /** The whole point of asking at creation: one step, not two. */
    it('puts it straight into that rep’s list', async () => {
      await place(manager, { assignedTo: rep.user._id });

      const res = await api().get('/api/orders').set(rep.headers);
      expect(res.body.total).toBe(1);
    });

    /**
     * Optional on purpose. Requiring it would mean a manager taking an order
     * over the phone cannot record it until they have decided who works it — so
     * the order does not get written down, which is worse than it being briefly
     * unowned.
     */
    it('allows the order to be placed with nobody named', async () => {
      const res = await place(manager);

      expect(res.status).toBe(201);
      expect(res.body.data.assignedTo).toBeNull();
      expect((await api().get('/api/orders').set(rep.headers)).body.total).toBe(0);
    });

    /**
     * Not defaulted to the creator: a manager placing an order is not thereby
     * working it, and writing themselves in would mean nothing was ever visibly
     * unassigned.
     */
    it('does not quietly assign it to whoever placed it', async () => {
      const res = await place(manager);

      expect(res.body.data.assignedTo).not.toBe(String(manager.user._id));
    });

    it('refuses a user that does not exist', async () => {
      const res = await place(manager, { assignedTo: '650000000000000000000099' });

      expect(res.status).toBe(400);
      expect(await Order.countDocuments({})).toBe(0);
    });

    /**
     * Work assigned to somebody who cannot sign in lands in a list nobody
     * opens, which looks exactly like the order being handled.
     */
    it('refuses a deactivated account', async () => {
      await api()
        .patch(`/api/users/${rep.user._id}/status`)
        .set(admin.headers)
        .send({ status: 'deactivated' });

      const res = await place(manager, { assignedTo: rep.user._id });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not active/i);
    });

    it('refuses a value that is not an id at all', async () => {
      expect((await place(manager, { assignedTo: 'nonsense' })).status).toBe(400);
    });
  });
});

describe('changing an order after it exists', () => {
  let admin;
  let manager;
  let rep;
  let order;
  let otherProduct;

  beforeEach(async () => {
    admin = await createAdmin();
    manager = await createManager();
    rep = await createRep();
    const customer = await createCustomer(admin);
    const product = await createProduct({ price: 100, stockQty: 50 });
    otherProduct = await createProduct({ price: 250, stockQty: 50, sku: 'OTHER-1' });

    const created = await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1 }],
        assignedTo: rep.user._id,
      });

    order = created.body.data;
  });

  const editItems = (actor) =>
    api()
      .patch(`/api/orders/${order._id}`)
      .set(actor.headers)
      .send({ items: [{ product: otherProduct._id, quantity: 3 }] });

  describe('editing the items', () => {
    it('applies immediately for an admin', async () => {
      const res = await editItems(admin);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(750);
    });

    /**
     * Placing is selling; rewriting is editing a record somebody may already
     * have acted on. The price changes and the stock that will move changes.
     */
    it('waits for approval when a manager does it', async () => {
      const res = await editItems(manager);

      expect(res.status).toBe(202);
      expect((await Order.findById(order._id)).total).toBe(100);
    });

    it('is refused outright for the rep holding it', async () => {
      const res = await editItems(rep);

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/not change what is on it/i);
    });

    /**
     * The transaction must not commit when the edit is going to be queued.
     * Throwing to abort it is how that is guaranteed, and this is the assertion
     * that the abort actually happened.
     */
    it('leaves the order completely untouched while queued', async () => {
      await editItems(manager);

      const after = await Order.findById(order._id);
      expect(after.items).toHaveLength(1);
      expect(after.total).toBe(100);
    });

    it('applies the queued edit once approved', async () => {
      await editItems(manager);
      const request = await ChangeRequest.findOne({ action: 'update', entity: 'order' });

      const res = await api()
        .patch(`/api/change-requests/${request._id}/approve`)
        .set(admin.headers)
        .send();

      expect(res.status).toBe(200);
      expect((await Order.findById(order._id)).total).toBe(750);
    });
  });

  describe('deleting', () => {
    const remove = (actor) => api().delete(`/api/orders/${order._id}`).set(actor.headers);

    /**
     * The most destructive act available, and the least reversible: on a
     * completed order it restores stock, so the inventory ledger is rewritten
     * along with the record.
     */
    it('is done directly by an admin', async () => {
      expect((await remove(admin)).status).toBe(200);
      expect(await Order.findById(order._id)).toBeNull();
    });

    it('becomes a request when a manager asks', async () => {
      const res = await remove(manager);

      expect(res.status).toBe(202);
      expect(await Order.findById(order._id)).not.toBeNull();
    });

    it('is refused to the rep holding it', async () => {
      expect((await remove(rep)).status).toBe(403);
      expect(await Order.findById(order._id)).not.toBeNull();
    });

    it('deletes once approved', async () => {
      await remove(manager);
      const request = await ChangeRequest.findOne({ action: 'delete', entity: 'order' });

      await api()
        .patch(`/api/change-requests/${request._id}/approve`)
        .set(admin.headers)
        .send();

      expect(await Order.findById(order._id)).toBeNull();
    });
  });

  /** Moving the order forward is the rep's job and needs nobody's permission. */
  describe('completing', () => {
    it.each([['admin'], ['manager'], ['rep']])('is direct for the %s', async (who) => {
      const actor = { admin, manager, rep }[who];

      const res = await api()
        .patch(`/api/orders/${order._id}`)
        .set(actor.headers)
        .send({ status: 'completed' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
    });
  });
});

describe('a rep asking for a transfer', () => {
  let admin;
  let manager;
  let holder;
  let colleague;
  let order;

  beforeEach(async () => {
    admin = await createAdmin();
    manager = await createManager();
    holder = await createRep({ name: 'Sara Iqbal', email: 'sara@example.com' });
    colleague = await createRep({ name: 'Omar Farooq', email: 'omar@example.com' });

    const customer = await createCustomer(admin);
    const product = await createProduct({ price: 100, stockQty: 50 });

    const created = await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1 }],
        assignedTo: holder.user._id,
      });

    order = created.body.data;
  });

  const request = (actor, body) =>
    api().post(`/api/orders/${order._id}/transfer-request`).set(actor.headers).send(body);

  it('records the request without moving the order', async () => {
    const res = await request(holder, {
      assignedTo: colleague.user._id,
      reason: 'On leave next week',
    });

    expect(res.status).toBe(202);
    expect(String((await Order.findById(order._id)).assignedTo)).toBe(
      String(holder.user._id)
    );
  });

  it('says who it asked for, so the rep knows it was heard', async () => {
    const res = await request(holder, { assignedTo: colleague.user._id });

    expect(res.body.message).toContain('Omar Farooq');
  });

  it('keeps the reason, which is the useful part for the approver', async () => {
    await request(holder, { assignedTo: colleague.user._id, reason: 'On leave next week' });

    const saved = await ChangeRequest.findOne({ action: 'transfer' });
    expect(saved.payload.reason).toBe('On leave next week');
    expect(String(saved.payload.assignedTo)).toBe(String(colleague.user._id));
  });

  /** The order stays with the requester until somebody agrees. */
  it('leaves the order in the requester’s list meanwhile', async () => {
    await request(holder, { assignedTo: colleague.user._id });

    expect((await api().get('/api/orders').set(holder.headers)).body.total).toBe(1);
    expect((await api().get('/api/orders').set(colleague.headers)).body.total).toBe(0);
  });

  it('moves the order when approved', async () => {
    await request(holder, { assignedTo: colleague.user._id });
    const saved = await ChangeRequest.findOne({ action: 'transfer' });

    const res = await api()
      .patch(`/api/change-requests/${saved._id}/approve`)
      .set(admin.headers)
      .send();

    expect(res.status).toBe(200);
    expect((await api().get('/api/orders').set(colleague.headers)).body.total).toBe(1);
    expect((await api().get('/api/orders').set(holder.headers)).body.total).toBe(0);
  });

  it('leaves it where it was when rejected', async () => {
    await request(holder, { assignedTo: colleague.user._id });
    const saved = await ChangeRequest.findOne({ action: 'transfer' });

    await api()
      .patch(`/api/change-requests/${saved._id}/reject`)
      .set(admin.headers)
      .send({ note: 'Cover it yourself this once' });

    expect(String((await Order.findById(order._id)).assignedTo)).toBe(
      String(holder.user._id)
    );
  });

  describe('what it refuses', () => {
    /**
     * Asking about somebody else's work. A manager or admin does not need this
     * endpoint — they can reassign directly — so the only caller it has to
     * serve is the holder.
     */
    it('refuses a rep who does not hold the order', async () => {
      const res = await request(colleague, { assignedTo: colleague.user._id });

      expect(res.status).toBe(403);
    });

    it('refuses a request with nobody named', async () => {
      const res = await request(holder, { reason: 'please help' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/name the colleague/i);
    });

    it('refuses a transfer to yourself', async () => {
      const res = await request(holder, { assignedTo: holder.user._id });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already assigned to you/i);
    });

    it('refuses a deactivated colleague', async () => {
      await api()
        .patch(`/api/users/${colleague.user._id}/status`)
        .set(admin.headers)
        .send({ status: 'deactivated' });

      const res = await request(holder, { assignedTo: colleague.user._id });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not active/i);
    });

    /** One outstanding request per record, same as every other kind. */
    it('refuses a second request while the first is waiting', async () => {
      await request(holder, { assignedTo: colleague.user._id });
      const second = await request(holder, { assignedTo: colleague.user._id });

      expect(second.status).toBe(409);
    });
  });

  /**
   * A rep still cannot reassign directly. The request is the whole of what
   * they can do, and this is the assertion that the back door stayed shut.
   */
  it('does not give the rep the direct reassign endpoint', async () => {
    const res = await api()
      .patch(`/api/orders/${order._id}/assign`)
      .set(holder.headers)
      .send({ assignedTo: colleague.user._id });

    expect(res.status).toBe(403);
  });
});
