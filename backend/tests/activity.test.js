const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');
const Activity = require('../src/models/Activity');
const Order = require('../src/models/Order');

/**
 * The notes timeline on customers and orders.
 *
 * Two things are being pinned down here, and the second matters more than it
 * looks:
 *
 *   1. Notes borrow the permissions of the record they hang off, so there is
 *      no second definition of "yours" to drift out of step with the first.
 *   2. They are append-only in the MODEL, not merely in the absence of an edit
 *      route. "We didn't build that endpoint" holds until somebody builds it.
 */

/** An order assigned to `rep`, placed by `placer`. */
async function orderFor(placer, rep, customer, product) {
  const res = await api()
    .post('/api/orders')
    .set(placer.headers)
    .send({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1 }],
      assignedTo: rep.user._id,
    });

  expect(res.status).toBe(201);
  return res.body.data;
}

describe('Activity timeline', () => {
  describe('Writing a note', () => {
    it('records the note with its author, and returns it', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api()
        .post(`/api/customers/${customer._id}/activity`)
        .set(admin.headers)
        .send({ body: 'Rang about the March order. Wants delivery split in two.' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        entity: 'customer',
        body: 'Rang about the March order. Wants delivery split in two.',
        author: { name: admin.user.name, role: 'admin' },
      });
      expect(res.body.data.createdAt).toBeTruthy();
    });

    /*
     * The author is a snapshot, not a reference. A timeline that rewrites
     * itself when somebody is renamed or deleted is not a history of anything.
     */
    it('keeps the author name as it was, even after the account changes', async () => {
      const admin = await createAdmin({ name: 'Ayesha Khan' });
      const customer = await createCustomer(admin);

      await api()
        .post(`/api/customers/${customer._id}/activity`)
        .set(admin.headers)
        .send({ body: 'Agreed the discount.' });

      admin.user.name = 'Ayesha Khan-Rashid';
      await admin.user.save();

      const res = await api().get(`/api/customers/${customer._id}/activity`).set(admin.headers);

      expect(res.body.data[0].author.name).toBe('Ayesha Khan');
    });

    it('refuses an empty note', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api()
        .post(`/api/customers/${customer._id}/activity`)
        .set(admin.headers)
        .send({ body: '   ' });

      expect(res.status).toBe(400);
      expect(await Activity.countDocuments()).toBe(0);
    });

    it('refuses a note on a record that does not exist', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/customers/64b7f1c2e4b0a1a2b3c4d5e6/activity')
        .set(admin.headers)
        .send({ body: 'Anything' });

      expect(res.status).toBe(404);
    });
  });

  describe('Reading a timeline', () => {
    it('returns notes newest first', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      for (const body of ['First call', 'Second call', 'Third call']) {
        await api()
          .post(`/api/customers/${customer._id}/activity`)
          .set(admin.headers)
          .send({ body });
      }

      const res = await api().get(`/api/customers/${customer._id}/activity`).set(admin.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.map((n) => n.body)).toEqual([
        'Third call',
        'Second call',
        'First call',
      ]);
    });

    /** One record's notes, not everyone's. */
    it('does not mix in notes from another record', async () => {
      const admin = await createAdmin();
      const mine = await createCustomer(admin);
      const theirs = await createCustomer(admin);

      await api()
        .post(`/api/customers/${mine._id}/activity`)
        .set(admin.headers)
        .send({ body: 'Mine' });
      await api()
        .post(`/api/customers/${theirs._id}/activity`)
        .set(admin.headers)
        .send({ body: 'Theirs' });

      const res = await api().get(`/api/customers/${mine._id}/activity`).set(admin.headers);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].body).toBe('Mine');
    });

    /*
     * A customer and an order can share an id only by coincidence, but the
     * query filters on `entity` as well so that coincidence cannot merge two
     * unrelated timelines.
     */
    it('keeps customer and order timelines separate', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);
      const product = await createProduct();
      const order = await orderFor(admin, rep, customer, product);

      await api()
        .post(`/api/customers/${customer._id}/activity`)
        .set(admin.headers)
        .send({ body: 'About the account' });
      await api()
        .post(`/api/orders/${order._id}/activity`)
        .set(admin.headers)
        .send({ body: 'About this order' });

      const onOrder = await api().get(`/api/orders/${order._id}/activity`).set(admin.headers);

      expect(onOrder.body.data).toHaveLength(1);
      expect(onOrder.body.data[0].body).toBe('About this order');
    });
  });

  /*
   * THE PERMISSION RULES ARE THE RECORD'S OWN, WHICH IS THE WHOLE DESIGN.
   */
  describe('Who can reach which timeline', () => {
    it('lets the assigned rep read and write notes on their order', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);
      const product = await createProduct();
      const order = await orderFor(admin, rep, customer, product);

      const written = await api()
        .post(`/api/orders/${order._id}/activity`)
        .set(rep.headers)
        .send({ body: 'Delivered to reception, signed for by the office manager.' });

      expect(written.status).toBe(201);
      expect(written.body.data.author.role).toBe('sales_rep');

      const read = await api().get(`/api/orders/${order._id}/activity`).set(rep.headers);

      expect(read.status).toBe(200);
      expect(read.body.data).toHaveLength(1);
    });

    it('refuses a rep the timeline of an order held by a colleague', async () => {
      const admin = await createAdmin();
      const mine = await createRep();
      const theirs = await createRep();
      const customer = await createCustomer(admin);
      const product = await createProduct();
      const order = await orderFor(admin, theirs, customer, product);

      const read = await api().get(`/api/orders/${order._id}/activity`).set(mine.headers);
      const write = await api()
        .post(`/api/orders/${order._id}/activity`)
        .set(mine.headers)
        .send({ body: 'Nothing to do with me' });

      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
      expect(await Activity.countDocuments()).toBe(0);
    });

    /*
     * A rep has no access to the customer book at all, so they have none to its
     * notes either — where an account's history is often franker than its
     * fields.
     */
    it('refuses a rep the customer timeline entirely', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      const customer = await createCustomer(admin);

      const read = await api().get(`/api/customers/${customer._id}/activity`).set(rep.headers);
      const write = await api()
        .post(`/api/customers/${customer._id}/activity`)
        .set(rep.headers)
        .send({ body: 'Let me in' });

      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
    });

    /*
     * A manager's customer EDIT queues for approval. A note does not, and this
     * pins that decision down: it is additive, attributed and immutable, so it
     * overwrites nothing that would need a second pair of eyes — and a note
     * that appears whenever an admin gets round to it is one nobody writes.
     */
    it('lets a manager add a customer note directly, not as a change request', async () => {
      const manager = await createManager();
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api()
        .post(`/api/customers/${customer._id}/activity`)
        .set(manager.headers)
        .send({ body: 'Spoke to their finance team, invoice is in their next run.' });

      expect(res.status).toBe(201);

      const pending = await api().get('/api/change-requests').set(admin.headers);
      expect(pending.body.data).toHaveLength(0);

      const read = await api().get(`/api/customers/${customer._id}/activity`).set(admin.headers);
      expect(read.body.data).toHaveLength(1);
    });
  });

  /*
   * APPEND-ONLY.
   *
   * The routes not existing is how it is enforced today, and that lasts exactly
   * as long as nobody adds one. These go at the model, which is what makes the
   * rule survive a later generic admin screen or a well-meant bulk fix.
   */
  describe('Append-only', () => {
    it('exposes no way to edit or delete a note over HTTP', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const created = await api()
        .post(`/api/customers/${customer._id}/activity`)
        .set(admin.headers)
        .send({ body: 'As written' });

      const noteId = created.body.data._id;

      for (const call of [
        api().patch(`/api/customers/${customer._id}/activity/${noteId}`),
        api().delete(`/api/customers/${customer._id}/activity/${noteId}`),
        api().patch(`/api/customers/${customer._id}/activity`),
        api().delete(`/api/customers/${customer._id}/activity`),
      ]) {
        const res = await call.set(admin.headers).send({ body: 'Reworded' });
        expect(res.status).toBe(404);
      }

      const read = await api().get(`/api/customers/${customer._id}/activity`).set(admin.headers);
      expect(read.body.data[0].body).toBe('As written');
    });

    it('refuses an update straight through the model', async () => {
      const note = await Activity.create({
        entity: 'customer',
        entityId: '64b7f1c2e4b0a1a2b3c4d5e6',
        body: 'As written',
        author: { name: 'Someone', role: 'admin' },
      });

      await expect(Activity.updateOne({ _id: note._id }, { body: 'Reworded' })).rejects.toThrow(
        /append-only/i
      );

      await expect(
        Activity.findOneAndUpdate({ _id: note._id }, { body: 'Reworded' })
      ).rejects.toThrow(/append-only/i);

      const still = await Activity.findById(note._id);
      expect(still.body).toBe('As written');
    });

    it('refuses a delete straight through the model', async () => {
      const note = await Activity.create({
        entity: 'order',
        entityId: '64b7f1c2e4b0a1a2b3c4d5e6',
        body: 'Happened',
        author: { name: 'Someone', role: 'manager' },
      });

      await expect(Activity.deleteOne({ _id: note._id })).rejects.toThrow(/append-only/i);
      await expect(Activity.deleteMany({})).rejects.toThrow(/append-only/i);

      expect(await Activity.countDocuments()).toBe(1);
    });

    /** Re-saving a loaded document is the other way in, and is also refused. */
    it('refuses a re-save of a loaded note', async () => {
      const note = await Activity.create({
        entity: 'order',
        entityId: '64b7f1c2e4b0a1a2b3c4d5e6',
        body: 'Happened',
        author: { name: 'Someone', role: 'manager' },
      });

      const loaded = await Activity.findById(note._id);
      loaded.body = 'Did not happen';

      await expect(loaded.save()).rejects.toThrow(/append-only/i);

      const still = await Activity.findById(note._id);
      expect(still.body).toBe('Happened');
    });
  });

  /*
   * Deleting the order does not erase what people wrote about it. Same argument
   * as the audit trail: a history that disappears with the record cannot answer
   * anything about why the record was deleted.
   */
  it('keeps notes after the order they describe is deleted', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const customer = await createCustomer(admin);
    const product = await createProduct();
    const order = await orderFor(admin, rep, customer, product);

    await api()
      .post(`/api/orders/${order._id}/activity`)
      .set(admin.headers)
      .send({ body: 'Customer cancelled by phone, order raised in error.' });

    await api().delete(`/api/orders/${order._id}`).set(admin.headers);

    expect(await Order.findById(order._id)).toBeNull();
    expect(await Activity.countDocuments({ entityId: order._id })).toBe(1);
  });
});
