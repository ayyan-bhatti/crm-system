const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
} = require('./helpers');
const Order = require('../src/models/Order');
const AuditLog = require('../src/models/AuditLog');

/**
 * Delivery tracking: the `fulfilment` axis, and how it stays out of the way of
 * the `status` axis that moves stock.
 *
 * THE CENTRAL CLAIM THESE TESTS DEFEND
 *
 * `status` and `fulfilment` are independent. It was tempting to make delivery a
 * longer version of the existing status enum, and the reason that is wrong is
 * mechanical rather than aesthetic: `completed` is what decrements stock, and
 * `delivered` must not be. A parcel's stock leaves when it is picked, not when
 * it arrives at somebody's door. Several tests below assert on that separation
 * directly, because a future simplification would break it silently — every
 * screen would still render, and inventory would start moving on the wrong day.
 */

async function placedOrder(actor, overrides = {}) {
  const customer = await createCustomer(actor);
  const product = await createProduct({ price: 10, stockQty: 20 });

  const res = await api()
    .post('/api/orders')
    .set(actor.headers)
    .send({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1 }],
      ...overrides,
    });

  return { order: res.body.data, product, customer };
}

const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

describe('The delivery status of a new order', () => {
  it('starts at processing, with a promised date and nothing else stamped', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    expect(order.fulfilment).toBe('processing');
    expect(order.shippedAt).toBeNull();
    expect(order.deliveredAt).toBeNull();

    /*
     * The estimate IS set at creation now. It used to stay null until a staff
     * member marked the parcel shipped and typed a date, which is too late to
     * be useful: a buyer choosing a delivery speed is choosing a DATE, and they
     * choose it before they pay. Until this, the confirmation page could only
     * say "we will let you know". Staff may still revise it when the parcel
     * actually ships — this is the promise, not an unchangeable prediction.
     */
    expect(order.estimatedDeliveryAt).not.toBeNull();
    expect(order.deliverySpeed).toBe('standard');
  });
});

describe('Advancing an order through delivery', () => {
  it('moves it along the sequence and stamps the timestamps once', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const confirmed = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'confirmed' });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.fulfilment).toBe('confirmed');
    expect(confirmed.body.data.shippedAt).toBeNull();

    const shipped = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW });

    expect(shipped.body.data.fulfilment).toBe('shipped');
    expect(shipped.body.data.shippedAt).not.toBeNull();
    expect(new Date(shipped.body.data.estimatedDeliveryAt).toISOString()).toBe(TOMORROW);

    const firstShippedAt = shipped.body.data.shippedAt;

    const delivered = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'delivered' });

    expect(delivered.body.data.deliveredAt).not.toBeNull();
    // `shippedAt` records when the parcel actually left, so a later transition
    // must not rewrite it.
    expect(delivered.body.data.shippedAt).toBe(firstShippedAt);
  });

  it('does NOT move stock, however far along delivery goes', async () => {
    const admin = await createAdmin();
    const { order, product } = await placedOrder(admin);

    for (const fulfilment of ['confirmed', 'shipped', 'out_for_delivery', 'delivered']) {
      await api()
        .patch(`/api/orders/${order._id}/fulfilment`)
        .set(admin.headers)
        .send({ fulfilment, estimatedDeliveryAt: TOMORROW });
    }

    /*
     * The order is `delivered` and still commercially `pending`, and its stock
     * has not moved — because nobody completed it. This is the separation of
     * the two axes, stated as an assertion.
     */
    const stored = await Order.findById(order._id);
    expect(stored.fulfilment).toBe('delivered');
    expect(stored.status).toBe('pending');
    expect(stored.stockTakenAt).toBeNull();

    const { stockQty } = await require('../src/models/Product').findById(product._id);
    expect(stockQty).toBe(20);
  });

  it('lets a correction move backwards, so a mis-click is fixable', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'delivered', estimatedDeliveryAt: TOMORROW });

    const back = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped' });

    expect(back.status).toBe(200);
    expect(back.body.data.fulfilment).toBe('shipped');
  });

  it('refuses a status that is not part of the sequence', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'teleported' });

    expect(res.status).toBe(400);
  });

  it('refuses `cancelled` through this endpoint — cancelling is a status change', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'cancelled' });

    expect(res.status).toBe(400);
  });
});

describe('The delivery estimate requirement', () => {
  it('refuses to mark an order shipped with no estimated delivery date', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    /*
     * The estimate is cleared FIRST, because an order no longer arrives without
     * one — it is set from the delivery speed at creation. The guard is
     * therefore unreachable through the normal flow, and is kept as defence for
     * the orders that predate that change: every order written before the field
     * was auto-populated still has a null estimate, and none of them should be
     * shippable without somebody supplying a date. That is exactly the state
     * simulated here.
     */
    await Order.updateOne({ _id: order._id }, { estimatedDeliveryAt: null });

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/estimated delivery/i);
    expect((await Order.findById(order._id)).fulfilment).toBe('processing');
  });

  /**
   * Jumping straight to `out_for_delivery` must not be a way round the rule.
   * Checking only for the literal `shipped` value would leave exactly that gap.
   */
  it('applies the same requirement to any stage past shipped', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await Order.updateOne({ _id: order._id }, { estimatedDeliveryAt: null });

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'out_for_delivery' });

    expect(res.status).toBe(400);
  });

  it('accepts a later stage once an estimate is already on the order', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW });

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'out_for_delivery' });

    expect(res.status).toBe(200);
  });

  it('refuses a date that is not a date', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: 'next tuesday-ish' });

    expect(res.status).toBe(400);
  });

  it('accepts an estimate before shipment without demanding one', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'confirmed', estimatedDeliveryAt: TOMORROW });

    expect(res.status).toBe(200);
    expect(res.body.data.estimatedDeliveryAt).not.toBeNull();
  });
});

describe('Who may update delivery status', () => {
  it('lets a manager update any order', async () => {
    const admin = await createAdmin();
    const manager = await createManager();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(manager.headers)
      .send({ fulfilment: 'confirmed' });

    expect(res.status).toBe(200);
  });

  /**
   * The rep holding the order is usually the person who physically knows it
   * went out. Gating this to manager-or-admin would leave the one person with
   * the fact unable to record it.
   */
  it('lets the assigned rep update their own order', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/assign`)
      .set(admin.headers)
      .send({ assignedTo: rep.user._id });

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(rep.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW });

    expect(res.status).toBe(200);
    expect(res.body.data.fulfilment).toBe('shipped');
  });

  it('refuses a rep who does not hold the order', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(rep.headers)
      .send({ fulfilment: 'confirmed' });

    expect(res.status).toBe(403);
    expect((await Order.findById(order._id)).fulfilment).toBe('processing');
  });

  it('refuses an unauthenticated caller', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .send({ fulfilment: 'confirmed' });

    expect(res.status).toBe(401);
  });
});

describe('Cancellation and delivery', () => {
  it('moves fulfilment to cancelled when the order is cancelled', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'confirmed' });

    await api()
      .patch(`/api/orders/${order._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    /*
     * A timeline still reading "Confirmed" under a cancelled order is a lie the
     * buyer will notice on their own tracking page.
     */
    expect((await Order.findById(order._id)).fulfilment).toBe('cancelled');
  });

  it('refuses to give a cancelled order a delivery status', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cancelled/i);
  });
});

describe('The audit trail for a delivery change', () => {
  it('records both ends of the move in readable words', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW });

    const entry = await AuditLog.findOne({ entityId: order._id, 'actor.user': admin.user._id })
      .sort({ createdAt: -1 });

    /*
     * "Processing → Shipped", not "processing → shipped" and certainly not
     * `out_for_delivery`, which does not read as a change at all a year later.
     */
    expect(entry.note).toBe('delivery: Processing → Shipped');
  });
});

describe('Stock still moves on completion, not on delivery', () => {
  it('takes stock when completed and gives it back when cancelled', async () => {
    const admin = await createAdmin();
    const { order, product } = await placedOrder(admin);
    const Product = require('../src/models/Product');

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'delivered', estimatedDeliveryAt: TOMORROW });

    expect((await Product.findById(product._id)).stockQty).toBe(20);

    await api()
      .patch(`/api/orders/${order._id}`)
      .set(admin.headers)
      .send({ status: 'completed' });

    expect((await Product.findById(product._id)).stockQty).toBe(19);
    expect((await Order.findById(order._id)).stockTakenAt).not.toBeNull();

    await api()
      .patch(`/api/orders/${order._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    expect((await Product.findById(product._id)).stockQty).toBe(20);
    expect((await Order.findById(order._id)).stockTakenAt).toBeNull();
  });

  /**
   * The legacy shape: an order completed before `stockTakenAt` existed has it
   * null while genuinely having had its stock taken. Cancelling one must still
   * restore, which is what `stockIsTaken` reading BOTH fields buys — and is why
   * this shipped without a data migration.
   */
  it('restores stock for a pre-existing order that has no stockTakenAt', async () => {
    const admin = await createAdmin();
    const { order, product } = await placedOrder(admin, { status: 'completed' });
    const Product = require('../src/models/Product');

    expect((await Product.findById(product._id)).stockQty).toBe(19);

    // Simulate a document written before the field existed.
    await Order.updateOne({ _id: order._id }, { $unset: { stockTakenAt: '' } });

    await api()
      .patch(`/api/orders/${order._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    expect((await Product.findById(product._id)).stockQty).toBe(20);
  });
});
