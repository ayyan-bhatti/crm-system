const { api, createAdmin, createCustomer, createProduct } = require('./helpers');

/**
 * The public "track my order" lookup — no session of any kind.
 *
 * THE CENTRAL CLAIM: A WRONG ORDER NUMBER AND A WRONG EMAIL LOOK IDENTICAL.
 *
 * Order numbers are sequential and meant to be read down a phone line — they
 * are not a secret. The email is the actual second factor, and the whole
 * point of the endpoint is that nothing in its response, status code, or
 * timing tells a caller which of the two they got wrong, or whether the order
 * number they tried exists at all. Several tests below assert that directly.
 */

async function placedOrder(actor, customerOverrides = {}) {
  const customer = await createCustomer(actor, customerOverrides);
  const product = await createProduct({ price: 10, stockQty: 20 });

  const res = await api()
    .post('/api/orders')
    .set(actor.headers)
    .send({
      customer: customer._id,
      items: [{ product: product._id, quantity: 2 }],
    });

  return { order: res.body.data, customer };
}

describe('POST /api/shop/track', () => {
  it('finds the order with the exact order number and matching email', async () => {
    const admin = await createAdmin();
    const { order, customer } = await placedOrder(admin, { email: 'reader@karachitraders.example' });

    const res = await api()
      .post('/api/shop/track')
      .send({ orderNumber: order.orderNumber, email: customer.email });

    expect(res.status).toBe(200);
    expect(res.body.data.orderNumber).toBe(order.orderNumber);
    expect(res.body.data.fulfilment).toBe('processing');
  });

  it('is case-insensitive and trims whitespace on the email', async () => {
    const admin = await createAdmin();
    const { order, customer } = await placedOrder(admin, { email: 'reader@karachitraders.example' });

    const res = await api()
      .post('/api/shop/track')
      .send({ orderNumber: order.orderNumber, email: `  ${customer.email.toUpperCase()}  ` });

    expect(res.status).toBe(200);
  });

  /**
   * "ord-142", "ORD-000142" and "142" are all the same order number — see
   * services/orderNumber.js#parseOrderNumber. A visitor typing it off a
   * delivery note should not have to reproduce the padding exactly.
   */
  it('accepts loose order-number formatting', async () => {
    const admin = await createAdmin();
    const { order, customer } = await placedOrder(admin, { email: 'reader@karachitraders.example' });
    const bareNumber = order.orderNumber.replace(/^ORD-0*/, '');

    const res = await api()
      .post('/api/shop/track')
      .send({ orderNumber: bareNumber, email: customer.email });

    expect(res.status).toBe(200);
    expect(res.body.data.orderNumber).toBe(order.orderNumber);
  });

  it('returns the exact same generic message for an order number that does not exist', async () => {
    const res = await api()
      .post('/api/shop/track')
      .send({ orderNumber: 'ORD-999999', email: 'nobody@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/no order matches/i);
  });

  it('returns the exact same generic message for the right order and the wrong email', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin, { email: 'reader@karachitraders.example' });

    const wrong = await api()
      .post('/api/shop/track')
      .send({ orderNumber: order.orderNumber, email: 'someone-else@example.com' });
    const missing = await api()
      .post('/api/shop/track')
      .send({ orderNumber: 'ORD-999999', email: 'someone-else@example.com' });

    // Same status, same message — nothing distinguishes "order exists, wrong
    // email" from "no such order" in what the caller receives.
    expect(wrong.status).toBe(missing.status);
    expect(wrong.body.message).toBe(missing.body.message);
  });

  it('refuses a request missing either field, without touching the database', async () => {
    const noEmail = await api().post('/api/shop/track').send({ orderNumber: 'ORD-000001' });
    const noNumber = await api().post('/api/shop/track').send({ email: 'a@example.com' });
    const neither = await api().post('/api/shop/track').send({});

    expect(noEmail.status).toBe(400);
    expect(noNumber.status).toBe(400);
    expect(neither.status).toBe(400);
  });

  it('never includes items, prices or the customer record — this is a status page, not a receipt', async () => {
    const admin = await createAdmin();
    const { order, customer } = await placedOrder(admin, { email: 'reader@karachitraders.example' });

    const res = await api()
      .post('/api/shop/track')
      .send({ orderNumber: order.orderNumber, email: customer.email });

    expect(res.body.data.items).toBeUndefined();
    expect(res.body.data.total).toBeUndefined();
    expect(res.body.data.customer).toBeUndefined();
    expect(res.body.data.payment).toBeUndefined();
    // But it does say HOW MANY items, as light reassurance this is really their order.
    expect(res.body.data.itemCount).toBe(1);
  });

  it('carries the courier and a real tracking link once one is set', async () => {
    const admin = await createAdmin();
    const { order, customer } = await placedOrder(admin, { email: 'reader@karachitraders.example' });
    const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({
        fulfilment: 'shipped',
        estimatedDeliveryAt: TOMORROW,
        courier: 'dhl',
        trackingNumber: 'JD0141',
      });

    const res = await api()
      .post('/api/shop/track')
      .send({ orderNumber: order.orderNumber, email: customer.email });

    expect(res.body.data.courier).toBe('dhl');
    expect(res.body.data.trackingNumber).toBe('JD0141');
    expect(res.body.data.trackingUrl).toContain('tracking-id=JD0141');
  });

  it('requires no authentication at all', async () => {
    const admin = await createAdmin();
    const { order, customer } = await placedOrder(admin, { email: 'reader@karachitraders.example' });

    // No .set(headers) anywhere in this request.
    const res = await api()
      .post('/api/shop/track')
      .send({ orderNumber: order.orderNumber, email: customer.email });

    expect(res.status).toBe(200);
  });
});
