const request = require('supertest');
const app = require('../src/app');
const { api, createAdmin, createProduct } = require('./helpers');
const Customer = require('../src/models/Customer');
const Order = require('../src/models/Order');
const Buyer = require('../src/models/Buyer');
const ChangeRequest = require('../src/models/ChangeRequest');
const { SHOP_CSRF_COOKIE, SHOP_CSRF_HEADER } = require('../src/middleware/shopCsrf');
const changeRequestService = require('../src/services/changeRequestService');

/**
 * Phase 3 of the storefront build: the public catalogue, the buyer's cart,
 * checkout (guest and buyer), and a buyer's own order history plus the
 * cancel/edit requests that feed the existing approval queue.
 */

function cookieValue(res, name) {
  const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
}

/** A signed-in buyer agent, with its CSRF token ready to send on writes. */
async function buyerAgent(overrides = {}) {
  const agent = request.agent(app);
  const res = await agent.post('/api/shop/auth/register').send({
    name: 'Bilal Ahmed',
    email: 'bilal@example.com',
    password: 'Faisalabad-Kettle-41',
    ...overrides,
  });

  const csrf = cookieValue(res, SHOP_CSRF_COOKIE);
  const write = (method, url) => agent[method](url).set(SHOP_CSRF_HEADER, csrf);

  return { agent, res, write };
}

describe('Storefront catalogue', () => {
  it('lists products with no authentication at all', async () => {
    await createProduct({ name: 'Widget', price: 9.99, category: 'Tools' });

    const res = await api().get('/api/shop/products');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Widget');
  });

  /*
   * The whole point of the endpoint: an internal field must be genuinely
   * absent, not merely unused by the frontend that happens to call it today.
   */
  it('never exposes sku, lowStockThreshold, or the exact stock count', async () => {
    await createProduct({ sku: 'SEC-1', lowStockThreshold: 3, stockQty: 47 });

    const res = await api().get('/api/shop/products');
    const [product] = res.body.data;

    expect(product.sku).toBeUndefined();
    expect(product.lowStockThreshold).toBeUndefined();
    expect(product.stockQty).toBeUndefined();
    expect(product.inStock).toBe(true);
  });

  it('reports out of stock rather than a count', async () => {
    await createProduct({ stockQty: 0 });

    const res = await api().get('/api/shop/products');
    expect(res.body.data[0].inStock).toBe(false);
  });

  it('filters by category', async () => {
    await createProduct({ name: 'Chair', category: 'Furniture' });
    await createProduct({ name: 'Bolt', category: 'Hardware' });

    const res = await api().get('/api/shop/products?category=Furniture');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Chair');
  });

  it('returns a single product with the same narrow projection', async () => {
    const product = await createProduct({ sku: 'SEC-2' });

    const res = await api().get(`/api/shop/products/${product._id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sku).toBeUndefined();
  });

  it('404s a product that does not exist', async () => {
    const res = await api().get('/api/shop/products/64b7f1c2e4b0a1a2b3c4d5e6');
    expect(res.status).toBe(404);
  });
});

describe('Buyer cart', () => {
  it('refuses an unauthenticated caller entirely', async () => {
    const res = await api().get('/api/shop/cart');
    expect(res.status).toBe(401);
  });

  it('adds an item and reports its live price', async () => {
    const product = await createProduct({ price: 12.5 });
    const { write } = await buyerAgent();

    const res = await write('post', '/api/shop/cart/items').send({
      product: product._id,
      quantity: 2,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.total).toBe(25);
  });

  it('adding the same product twice combines the quantity on one line', async () => {
    const product = await createProduct({ price: 10 });
    const { write } = await buyerAgent();

    await write('post', '/api/shop/cart/items').send({ product: product._id, quantity: 1 });
    const res = await write('post', '/api/shop/cart/items').send({
      product: product._id,
      quantity: 2,
    });

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].quantity).toBe(3);
  });

  it('updates and removes a line', async () => {
    const product = await createProduct({ price: 5 });
    const { write } = await buyerAgent();
    await write('post', '/api/shop/cart/items').send({ product: product._id, quantity: 1 });

    const updated = await write('patch', `/api/shop/cart/items/${product._id}`).send({
      quantity: 4,
    });
    expect(updated.body.data.items[0].quantity).toBe(4);

    const removed = await write('delete', `/api/shop/cart/items/${product._id}`);
    expect(removed.body.data.items).toHaveLength(0);
  });

  it('merges a guest cart on login without duplicating an existing line', async () => {
    const product = await createProduct({ price: 8 });
    const { write } = await buyerAgent();
    await write('post', '/api/shop/cart/items').send({ product: product._id, quantity: 1 });

    const merged = await write('post', '/api/shop/cart/merge').send({
      items: [{ product: product._id, quantity: 2 }],
    });

    expect(merged.body.data.items).toHaveLength(1);
    expect(merged.body.data.items[0].quantity).toBe(3);
  });
});

describe('Checkout', () => {
  const GUEST = { name: 'Sana Malik', email: 'sana@example.com', phone: '0300-1234567' };

  it('places a guest order and creates a matching Customer', async () => {
    const product = await createProduct({ price: 20 });

    const res = await api()
      .post('/api/shop/checkout')
      .send({ ...GUEST, items: [{ product: product._id, quantity: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.source).toBe('storefront');
    expect(res.body.data.buyerId).toBeNull();
    expect(res.body.data.status).toBe('pending');

    const customer = await Customer.findOne({ email: 'sana@example.com' });
    expect(customer).not.toBeNull();
    expect(String(res.body.data.customer._id)).toBe(String(customer._id));
  });

  it('matches a second guest order to the same Customer rather than duplicating it', async () => {
    const product = await createProduct({ price: 5 });

    await api()
      .post('/api/shop/checkout')
      .send({ ...GUEST, items: [{ product: product._id, quantity: 1 }] });
    await api()
      .post('/api/shop/checkout')
      .send({ ...GUEST, items: [{ product: product._id, quantity: 1 }] });

    expect(await Customer.countDocuments({ email: 'sana@example.com' })).toBe(1);
    expect(await Order.countDocuments({})).toBe(2);
  });

  it('does not decrement stock for a pending storefront order', async () => {
    const product = await createProduct({ price: 5, stockQty: 10 });

    await api()
      .post('/api/shop/checkout')
      .send({ ...GUEST, items: [{ product: product._id, quantity: 3 }] });

    const reloaded = await require('../src/models/Product').findById(product._id);
    expect(reloaded.stockQty).toBe(10);
  });

  it('replays the same order on a retried checkout with the same idempotency key', async () => {
    const product = await createProduct({ price: 15 });
    const key = 'checkout-retry-key-123456';

    const first = await api()
      .post('/api/shop/checkout')
      .set('Idempotency-Key', key)
      .send({ ...GUEST, items: [{ product: product._id, quantity: 1 }] });

    const second = await api()
      .post('/api/shop/checkout')
      .set('Idempotency-Key', key)
      .send({ ...GUEST, items: [{ product: product._id, quantity: 1 }] });

    expect(second.status).toBe(201);
    expect(second.body.data._id).toBe(first.body.data._id);
    expect(await Order.countDocuments({})).toBe(1);
  });

  it('links a signed-in buyer to the order and to their matched Customer', async () => {
    const product = await createProduct({ price: 30 });
    const { write, res: registered } = await buyerAgent();

    const res = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.buyerId).toBe(registered.body.data.buyer._id);

    const buyer = await Buyer.findById(registered.body.data.buyer._id);
    expect(buyer.linkedCustomerId).not.toBeNull();

    const customer = await Customer.findById(buyer.linkedCustomerId);
    expect(customer.email).toBe('bilal@example.com');
  });

  it("reuses the buyer's linked Customer on a second order, not a fresh match", async () => {
    const product = await createProduct({ price: 5 });
    const { write } = await buyerAgent();

    const firstOrder = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
    });
    const secondOrder = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
    });

    expect(secondOrder.body.data.customer._id).toBe(firstOrder.body.data.customer._id);
    expect(await Customer.countDocuments({ email: 'bilal@example.com' })).toBe(1);
  });

  it('empties the buyer cart on a successful checkout', async () => {
    const product = await createProduct({ price: 5 });
    const { write } = await buyerAgent();

    await write('post', '/api/shop/cart/items').send({ product: product._id, quantity: 2 });
    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
    });

    const cart = await write('get', '/api/shop/cart');
    expect(cart.body.data.items).toHaveLength(0);
  });

  it('refuses a guest checkout with no name or email', async () => {
    const product = await createProduct();

    const res = await api()
      .post('/api/shop/checkout')
      .send({ items: [{ product: product._id, quantity: 1 }] });

    expect(res.status).toBe(400);
  });
});

describe("A buyer's own orders", () => {
  it("lists only the signed-in buyer's orders", async () => {
    const product = await createProduct({ price: 5 });
    const mine = await buyerAgent({ email: 'mine@example.com' });
    const theirs = await buyerAgent({ email: 'theirs@example.com' });

    await mine.write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
    });
    await theirs.write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
    });

    const res = await mine.write('get', '/api/shop/orders');
    expect(res.body.data).toHaveLength(1);
  });

  it("404s a colleague buyer's order rather than exposing it", async () => {
    const product = await createProduct({ price: 5 });
    const mine = await buyerAgent({ email: 'mine2@example.com' });
    const theirs = await buyerAgent({ email: 'theirs2@example.com' });

    const theirOrder = await theirs.write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
    });

    const res = await mine.write('get', `/api/shop/orders/${theirOrder.body.data._id}`);
    expect(res.status).toBe(404);
  });

  it('never lists a staff-placed order among a buyer\'s own', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ price: 5 });
    const customer = await require('./helpers').createCustomer(admin);

    await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

    const { write } = await buyerAgent();
    const res = await write('get', '/api/shop/orders');
    expect(res.body.data).toHaveLength(0);
  });

  describe('request-cancel', () => {
    it('queues a cancellation for a pending order, labelled as coming from the buyer', async () => {
      const product = await createProduct({ price: 5 });
      const { write } = await buyerAgent();

      const order = await write('post', '/api/shop/checkout').send({
        items: [{ product: product._id, quantity: 1 }],
      });

      const res = await write(
        'post',
        `/api/shop/orders/${order.body.data._id}/request-cancel`
      );

      expect(res.status).toBe(202);

      const stored = await ChangeRequest.findById(res.body.data._id);
      expect(stored.action).toBe('cancel');
      expect(stored.requestedByModel).toBe('Buyer');
      expect(stored.entityId.toString()).toBe(order.body.data._id);
    });

    it('refuses a cancel request against an order that is not pending', async () => {
      const admin = await createAdmin();
      const product = await createProduct({ price: 5 });
      const { write, agent } = await buyerAgent({ email: 'notpending@example.com' });

      const order = await write('post', '/api/shop/checkout').send({
        items: [{ product: product._id, quantity: 1 }],
      });

      await api()
        .patch(`/api/orders/${order.body.data._id}`)
        .set(admin.headers)
        .send({ status: 'completed' });

      const res = await write(
        'post',
        `/api/shop/orders/${order.body.data._id}/request-cancel`
      );

      expect(res.status).toBe(400);
      void agent;
    });

    it('still enforces one outstanding request per order', async () => {
      const product = await createProduct({ price: 5 });
      const { write } = await buyerAgent();

      const order = await write('post', '/api/shop/checkout').send({
        items: [{ product: product._id, quantity: 1 }],
      });

      await write('post', `/api/shop/orders/${order.body.data._id}/request-cancel`);
      const second = await write(
        'post',
        `/api/shop/orders/${order.body.data._id}/request-cancel`
      );

      expect(second.status).toBe(409);
    });

    /*
     * Approval reuses the SAME queue and the same transactional apply path a
     * manager's request goes through — this is what proves it, end to end.
     */
    it('leaves the order cancelled but not deleted once approved', async () => {
      const admin = await createAdmin();
      const product = await createProduct({ price: 5 });
      const { write } = await buyerAgent();

      const order = await write('post', '/api/shop/checkout').send({
        items: [{ product: product._id, quantity: 1 }],
      });

      const requested = await write(
        'post',
        `/api/shop/orders/${order.body.data._id}/request-cancel`
      );

      await changeRequestService.approve(requested.body.data._id, admin.user);

      const stored = await Order.findById(order.body.data._id);
      expect(stored).not.toBeNull();
      expect(stored.status).toBe('cancelled');
    });
  });

  describe('request-edit', () => {
    it('queues an item change for a pending order', async () => {
      const product = await createProduct({ price: 5 });
      const other = await createProduct({ price: 8 });
      const { write } = await buyerAgent();

      const order = await write('post', '/api/shop/checkout').send({
        items: [{ product: product._id, quantity: 1 }],
      });

      const res = await write(
        'post',
        `/api/shop/orders/${order.body.data._id}/request-edit`
      ).send({ items: [{ product: other._id, quantity: 2 }] });

      expect(res.status).toBe(202);

      const stored = await ChangeRequest.findById(res.body.data._id);
      expect(stored.action).toBe('update');
      expect(stored.requestedByModel).toBe('Buyer');
    });

    /** Re-priced at approval time, same rule as a manager's own edit request. */
    it('re-prices the order at approval time, not at request time', async () => {
      const admin = await createAdmin();
      const product = await createProduct({ price: 5 });
      const { write } = await buyerAgent();

      const order = await write('post', '/api/shop/checkout').send({
        items: [{ product: product._id, quantity: 1 }],
      });

      const requested = await write(
        'post',
        `/api/shop/orders/${order.body.data._id}/request-edit`
      ).send({ items: [{ product: product._id, quantity: 3 }] });

      // Price rises after the request was made, before it is approved.
      product.price = 10;
      await product.save();

      await changeRequestService.approve(requested.body.data._id, admin.user);

      const stored = await Order.findById(order.body.data._id);
      expect(stored.total).toBe(30);
    });
  });
});
