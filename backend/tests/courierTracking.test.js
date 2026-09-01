const { api, createAdmin, createRep, createCustomer, createProduct } = require('./helpers');
const Order = require('../src/models/Order');
const AuditLog = require('../src/models/AuditLog');
const courierService = require('../src/services/courierService');

/**
 * Courier tracking: recording who a parcel went out with, and the two
 * honestly different levels of "real" that come with it.
 *
 * See the long note at the top of services/courierService.js for why DHL is
 * the only courier with a live status lookup here — TCS and Leopards both
 * require a merchant-account application before issuing ANY API credential,
 * so there is no free sandbox this app can call for either of them. What every
 * courier gets, with zero configuration, is a real link to their own public
 * tracking page.
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

describe('buildTrackingUrl — a pure, no-account link to the courier itself', () => {
  it('deep-links DHL, whose tracking page takes the number in the URL', () => {
    const url = courierService.buildTrackingUrl('dhl', 'ABC123');
    expect(url).toBe('https://www.dhl.com/pk-en/home/tracking.html?tracking-id=ABC123');
  });

  it('links TCS and Leopards to their tracking page without guessing a query param', () => {
    expect(courierService.buildTrackingUrl('tcs', 'CN1')).toBe('https://www.tcsexpress.com/track/');
    expect(courierService.buildTrackingUrl('leopards', 'CN2')).toBe(
      'https://www.leopardscourier.com/leopards-tracking'
    );
  });

  it('returns null for an unknown or unset courier', () => {
    expect(courierService.buildTrackingUrl('other', '123')).toBeNull();
    expect(courierService.buildTrackingUrl(null, null)).toBeNull();
  });
});

describe('Recording a courier and tracking number on an order', () => {
  it('stores both when marking an order shipped', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({
        fulfilment: 'shipped',
        estimatedDeliveryAt: TOMORROW,
        courier: 'tcs',
        trackingNumber: 'TCS0001',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.courier).toBe('tcs');
    expect(res.body.data.trackingNumber).toBe('TCS0001');
  });

  it('refuses an unknown courier value', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'confirmed', courier: 'fedex' });

    expect(res.status).toBe(400);
    expect((await Order.findById(order._id)).courier).toBeNull();
  });

  it('refuses a tracking number with no courier anywhere on the request or the order', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'confirmed', trackingNumber: 'NO-COURIER-SET' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/courier/i);
  });

  it('accepts a tracking number added later, once a courier is already on the order', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'confirmed', courier: 'dhl' });

    const res = await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW, trackingNumber: 'JD0141' });

    expect(res.status).toBe(200);
    expect(res.body.data.courier).toBe('dhl');
    expect(res.body.data.trackingNumber).toBe('JD0141');
  });

  it('records the courier and tracking number on the audit trail', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({
        fulfilment: 'shipped',
        estimatedDeliveryAt: TOMORROW,
        courier: 'leopards',
        trackingNumber: 'LCS999',
      });

    const entry = await AuditLog.findOne({ entityId: order._id, 'actor.user': admin.user._id }).sort({
      createdAt: -1,
    });

    expect(entry.note).toMatch(/Leopards Courier/);
    expect(entry.note).toMatch(/LCS999/);
  });
});

describe('GET /api/orders/:id/tracking', () => {
  it('reports no tracking when nothing has been recorded', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api().get(`/api/orders/${order._id}/tracking`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.trackingUrl).toBeNull();
    expect(res.body.data.live).toBe(false);
  });

  it('gives a real tracking link for TCS with no live status, and says why', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW, courier: 'tcs', trackingNumber: 'CN123' });

    const res = await api().get(`/api/orders/${order._id}/tracking`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.trackingUrl).toBe('https://www.tcsexpress.com/track/');
    expect(res.body.data.live).toBe(false);
    expect(res.body.data.reason).toMatch(/only available for DHL/i);
  });

  it('reports DHL as not live when DHL_TRACKING_API_KEY is unset — the honest default', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    await api()
      .patch(`/api/orders/${order._id}/fulfilment`)
      .set(admin.headers)
      .send({ fulfilment: 'shipped', estimatedDeliveryAt: TOMORROW, courier: 'dhl', trackingNumber: 'JD0141' });

    const res = await api().get(`/api/orders/${order._id}/tracking`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.trackingUrl).toContain('tracking-id=JD0141');
    expect(res.body.data.live).toBe(false);
    expect(res.body.data.reason).toMatch(/DHL_TRACKING_API_KEY/);
  });

  it('is scoped exactly like the fulfilment update — refuses a rep who does not hold the order', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const { order } = await placedOrder(admin);

    const res = await api().get(`/api/orders/${order._id}/tracking`).set(rep.headers);

    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const admin = await createAdmin();
    const { order } = await placedOrder(admin);

    const res = await api().get(`/api/orders/${order._id}/tracking`);

    expect(res.status).toBe(401);
  });
});
