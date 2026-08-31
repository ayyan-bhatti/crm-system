const { api, createAdmin, createRep, createCustomer, createProduct } = require('./helpers');
const Order = require('../src/models/Order');

/**
 * The delivery board: every parcel still on its way, worst first.
 *
 * WHAT THESE DEFEND is the ranking, because a queue whose order is wrong is
 * worse than no queue at all — it actively directs attention to the wrong
 * thing while looking authoritative.
 */

async function orderDue(actor, { days, fulfilment = 'processing', speed = 'standard' }) {
  const customer = await createCustomer(actor);
  const product = await createProduct({ price: 10, stockQty: 50 });

  const res = await api()
    .post('/api/orders')
    .set(actor.headers)
    .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

  const due = new Date();
  due.setDate(due.getDate() + days);

  await Order.updateOne(
    { _id: res.body.data._id },
    { estimatedDeliveryAt: due, fulfilment, deliverySpeed: speed }
  );

  return res.body.data._id;
}

const idsFrom = (res) => res.body.data.map((o) => String(o._id));

describe('GET /api/orders/deliveries', () => {
  it('puts an overdue order above everything else', async () => {
    const admin = await createAdmin();
    const soon = await orderDue(admin, { days: 1 });
    const late = await orderDue(admin, { days: -2 });
    const far = await orderDue(admin, { days: 9 });

    const res = await api().get('/api/orders/deliveries').set(admin.headers);
    const ids = idsFrom(res);

    expect(res.status).toBe(200);
    expect(ids[0]).toBe(String(late));
    expect(ids.indexOf(String(soon))).toBeLessThan(ids.indexOf(String(far)));
  });

  /**
   * A parcel already with a courier outranks one merely due tomorrow. It is the
   * one where an intervention still changes today's outcome; tomorrow's can be
   * dealt with this afternoon.
   */
  it('ranks out-for-delivery above an order due tomorrow', async () => {
    const admin = await createAdmin();
    const tomorrow = await orderDue(admin, { days: 1 });
    const withCourier = await orderDue(admin, { days: 4, fulfilment: 'out_for_delivery' });

    const ids = idsFrom(await api().get('/api/orders/deliveries').set(admin.headers));

    expect(ids.indexOf(String(withCourier))).toBeLessThan(ids.indexOf(String(tomorrow)));
  });

  /** Within a band, the tighter promise goes first. */
  it('puts express before standard when both are due the same day', async () => {
    const admin = await createAdmin();
    const standard = await orderDue(admin, { days: 1, speed: 'standard' });
    const express = await orderDue(admin, { days: 1, speed: 'express' });

    const ids = idsFrom(await api().get('/api/orders/deliveries').set(admin.headers));

    expect(ids.indexOf(String(express))).toBeLessThan(ids.indexOf(String(standard)));
  });

  /**
   * A delivered parcel is not a delivery problem, however long ago its estimate
   * passed. Including settled orders would fill the board with rows nobody can
   * act on, which is how a queue stops being read.
   */
  it('excludes delivered and cancelled orders', async () => {
    const admin = await createAdmin();
    const active = await orderDue(admin, { days: 2 });
    const done = await orderDue(admin, { days: -5, fulfilment: 'delivered' });
    const gone = await orderDue(admin, { days: -5, fulfilment: 'cancelled' });

    const ids = idsFrom(await api().get('/api/orders/deliveries').set(admin.headers));

    expect(ids).toContain(String(active));
    expect(ids).not.toContain(String(done));
    expect(ids).not.toContain(String(gone));
  });

  it('reports counts that match the rows it returned', async () => {
    const admin = await createAdmin();
    await orderDue(admin, { days: -1 });
    await orderDue(admin, { days: -3 });
    await orderDue(admin, { days: 1, speed: 'express' });

    const res = await api().get('/api/orders/deliveries').set(admin.headers);

    expect(res.body.summary.overdue).toBe(2);
    expect(res.body.summary.express).toBe(1);
    expect(res.body.summary.total).toBe(res.body.data.length);
  });

  /**
   * SCOPED LIKE EVERY OTHER ORDER READ. A board that ignored the scope would be
   * the one endpoint that hands a rep the whole book — and it would look like a
   * feature rather than a leak.
   */
  it('shows a sales rep only the deliveries on their own orders', async () => {
    const admin = await createAdmin();
    const rep = await createRep();

    const mine = await orderDue(admin, { days: 1 });
    await Order.updateOne({ _id: mine }, { assignedTo: rep.user._id });
    const theirs = await orderDue(admin, { days: 1 });

    const ids = idsFrom(await api().get('/api/orders/deliveries').set(rep.headers));

    expect(ids).toContain(String(mine));
    expect(ids).not.toContain(String(theirs));
  });

  it('is not reachable without a session', async () => {
    const res = await api().get('/api/orders/deliveries');
    expect(res.status).toBe(401);
  });
});

describe('Delivery speed', () => {
  /**
   * The promise is made at checkout, not when somebody gets round to it — the
   * estimate used to stay null until a staff member marked the parcel shipped.
   */
  it('gives a standard order a later promised date than an express one', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct({ price: 10, stockQty: 20 });

    const res = await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

    expect(res.body.data.deliverySpeed).toBe('standard');
    expect(res.body.data.estimatedDeliveryAt).not.toBeNull();

    const days = Math.round(
      (new Date(res.body.data.estimatedDeliveryAt) - new Date()) / 86400000
    );
    // Standard is four days out; express would be one.
    expect(days).toBeGreaterThanOrEqual(3);
  });
});
