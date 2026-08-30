const request = require('supertest');
const app = require('../src/app');
const env = require('../src/config/env');
const { api, createAdmin, createProduct } = require('./helpers');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const PendingCheckout = require('../src/models/PendingCheckout');
const ChangeRequest = require('../src/models/ChangeRequest');
const stripeService = require('../src/services/stripeService');
const changeRequestService = require('../src/services/changeRequestService');
const { SHOP_CSRF_COOKIE, SHOP_CSRF_HEADER } = require('../src/middleware/shopCsrf');

/**
 * Stripe Checkout, end to end, with Stripe itself replaced by a stub.
 *
 * NO TEST HERE MAKES A NETWORK CALL. The seam is `stripeService.__setStripeClient`,
 * which swaps the SDK instance the service holds — see the note on that export
 * for why it is a named function rather than a `jest.mock`. The service's own
 * code (signature handling, minor-unit conversion, idempotency keys) runs for
 * real; only the far side of the wire is fake.
 *
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 *
 * The expensive bugs in a payments integration are not "the happy path does not
 * work" — that is noticed in five minutes. They are:
 *
 *   - an order created before the money arrives, so an abandoned checkout ships
 *   - an order created twice, because Stripe retried a webhook
 *   - a forged webhook creating an order for free
 *   - stock restored on a refund that never actually went through
 *
 * Each has a test below, and each of those tests would pass just as readily
 * against a broken happy path — they assert on absence as much as presence.
 */

/** A Stripe stub that records what it was asked to do. */
function makeStripeStub(overrides = {}) {
  const calls = { sessions: [], refunds: [] };

  const stub = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.sessions.push(params);
          return {
            id: `cs_test_${calls.sessions.length}`,
            url: `https://checkout.stripe.test/pay/cs_test_${calls.sessions.length}`,
          };
        },
        retrieve: async (id) => ({ id, payment_status: 'unpaid' }),
        ...overrides.sessions,
      },
    },
    refunds: {
      create: async (params, options) => {
        calls.refunds.push({ params, options });
        return { id: 're_test_1', amount: 1000, status: 'succeeded' };
      },
      ...overrides.refunds,
    },
    webhooks: {
      /*
       * Stands in for a real HMAC check. `constructEvent` in the service wraps
       * whatever this throws into a 400, so throwing here exercises the real
       * rejection path rather than bypassing it.
       */
      constructEvent: (rawBody, signature) => {
        if (signature !== 'good-signature') {
          throw new Error('No signatures found matching the expected signature for payload');
        }
        return JSON.parse(rawBody.toString('utf8'));
      },
      ...overrides.webhooks,
    },
  };

  return { stub, calls };
}

function cookieValue(res, name) {
  const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
}

async function buyerAgent(email = 'payer@example.com') {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/shop/auth/register')
    .send({ name: 'Payer', email, password: 'Faisalabad-Kettle-41' });

  const csrf = cookieValue(res, SHOP_CSRF_COOKIE);
  const write = (method, url) => agent[method](url).set(SHOP_CSRF_HEADER, csrf);

  const saved = await write('post', '/api/shop/auth/addresses').send({
    label: 'Home',
    address: '12 Canal Road',
    city: 'Lahore',
    phone: '0300-1234567',
  });

  const addresses = saved.body.data.addresses;
  return { write, addressId: String(addresses[addresses.length - 1]._id), buyerRes: res };
}

/**
 * POST a webhook the way Stripe would: a raw JSON body plus a signature header.
 *
 * `.send(<string>)` RATHER THAN `.send(Buffer.from(...))`, AND THIS MATTERS.
 *
 * Superagent JSON-stringifies whatever object it is given when the content type
 * is `application/json` — and a Buffer is an object. Passing one therefore puts
 * the literal text `{"type":"Buffer","data":[123,34,...]}` on the wire. The
 * server dutifully receives a valid JSON body, parses it, finds `type: "Buffer"`,
 * matches no handler, and answers `200 {received: true}`.
 *
 * That is the worst possible failure for a test to have: every request
 * succeeds, every assertion about the WEBHOOK fails, and the obvious reading is
 * that the handler is broken. It cost a real debugging session here, so the
 * string form is used and the reason is written down.
 */
function postWebhook(event, signature = 'good-signature') {
  return api()
    .post('/api/shop/stripe/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', signature)
    .send(JSON.stringify(event));
}

function completedEvent(sessionId, overrides = {}) {
  return {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
        amount_total: 1000,
        currency: 'usd',
        ...overrides,
      },
    },
  };
}

let calls;

beforeEach(() => {
  /*
   * Stripe is "configured" for the duration of these tests. `env` is a plain
   * object every module holds a reference to, so assigning here is what makes
   * `stripeService.isEnabled()` true — no key is used, because the client below
   * never reaches the network.
   */
  env.stripeSecretKey = 'sk_test_not_a_real_key';
  env.stripeWebhookSecret = 'whsec_not_a_real_secret';

  const made = makeStripeStub();
  calls = made.calls;
  stripeService.__setStripeClient(made.stub);
});

afterEach(() => {
  env.stripeSecretKey = '';
  env.stripeWebhookSecret = '';
  stripeService.__setStripeClient(null);
});

describe('Starting a card checkout', () => {
  it('creates NO order and moves NO stock — only a pending checkout', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    const res = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 2 }],
      paymentMethod: 'card',
      addressId,
    });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('stripe');
    expect(res.body.data.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    // The whole point of the flow: nothing real exists yet.
    expect(await Order.countDocuments({})).toBe(0);
    expect((await Product.findById(product._id)).stockQty).toBe(5);

    const pending = await PendingCheckout.findOne({});
    expect(pending.status).toBe('pending');
    expect(pending.total).toBe(20);
  });

  it('sends Stripe the price in minor units, not dollars', async () => {
    const product = await createProduct({ price: 19.99, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    /*
     * 1999, not 19.99 and not 1998.9999999999998. Overcharging by 100x because
     * a float was passed where cents were expected is the single most common
     * Stripe integration bug, and `19.99 * 100` genuinely does produce that
     * trailing-nines value in JavaScript.
     */
    expect(calls.sessions[0].line_items[0].price_data.unit_amount).toBe(1999);
    expect(Number.isInteger(calls.sessions[0].line_items[0].price_data.unit_amount)).toBe(true);
  });

  it('refuses a card checkout when Stripe is not configured', async () => {
    env.stripeSecretKey = '';
    const product = await createProduct({ price: 10 });
    const { write, addressId } = await buyerAgent();

    const res = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    expect(res.status).toBe(400);
    expect(await Order.countDocuments({})).toBe(0);
  });
});

describe('The webhook', () => {
  it('rejects an event whose signature does not verify, and creates nothing', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    const res = await postWebhook(completedEvent(pending.stripeSessionId), 'forged');

    expect(res.status).toBe(400);
    expect(await Order.countDocuments({})).toBe(0);
    expect((await Product.findById(product._id)).stockQty).toBe(5);
  });

  it('refuses an event with no signature header at all', async () => {
    const res = await api()
      .post('/api/shop/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(completedEvent('cs_test_1'))));

    expect(res.status).toBe(400);
  });

  it('creates the order — and only then takes stock — once payment is confirmed', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId, buyerRes } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 2 }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    const res = await postWebhook(completedEvent(pending.stripeSessionId));

    expect(res.status).toBe(200);

    const order = await Order.findOne({});
    expect(order).not.toBeNull();
    expect(order.source).toBe('storefront');
    expect(String(order.buyerId)).toBe(buyerRes.body.data.buyer._id);
    expect(order.paymentMethod).toBe('card');
    expect(order.payment.status).toBe('paid');
    expect(order.payment.paymentIntentId).toBe('pi_test_1');

    /*
     * A paid order is `pending` (nobody has picked or posted it) but its stock
     * IS gone. That split is exactly why `stockTakenAt` exists as a field
     * separate from `completedAt`.
     */
    expect(order.status).toBe('pending');
    expect(order.completedAt).toBeNull();
    expect(order.stockTakenAt).not.toBeNull();
    expect((await Product.findById(product._id)).stockQty).toBe(3);

    expect((await PendingCheckout.findById(pending._id)).status).toBe('completed');
  });

  it('ignores a replayed event rather than creating a second order', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    const event = completedEvent(pending.stripeSessionId);

    await postWebhook(event);
    const second = await postWebhook(event);

    expect(second.status).toBe(200);
    expect(await Order.countDocuments({})).toBe(1);
    // And the stock was taken exactly once, not twice.
    expect((await Product.findById(product._id)).stockQty).toBe(4);
  });

  it('creates nothing when the session completed but is not actually paid', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    const res = await postWebhook(
      completedEvent(pending.stripeSessionId, { payment_status: 'unpaid' })
    );

    expect(res.status).toBe(200);
    expect(await Order.countDocuments({})).toBe(0);
    expect((await PendingCheckout.findById(pending._id)).status).toBe('pending');
  });

  it('marks an expired session expired, touching neither orders nor stock', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    const res = await postWebhook({
      id: 'evt_exp',
      type: 'checkout.session.expired',
      data: { object: { id: pending.stripeSessionId } },
    });

    expect(res.status).toBe(200);
    expect((await PendingCheckout.findById(pending._id)).status).toBe('expired');
    expect(await Order.countDocuments({})).toBe(0);
    expect((await Product.findById(product._id)).stockQty).toBe(5);
  });

  it('marks a declined payment failed', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    await postWebhook({
      id: 'evt_fail',
      type: 'checkout.session.async_payment_failed',
      data: { object: { id: pending.stripeSessionId } },
    });

    const reloaded = await PendingCheckout.findById(pending._id);
    expect(reloaded.status).toBe('failed');
    expect(reloaded.note).toMatch(/declined/i);
    expect(await Order.countDocuments({})).toBe(0);
  });

  it('never downgrades a completed checkout when a late expiry arrives', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    await postWebhook(completedEvent(pending.stripeSessionId));

    await postWebhook({
      id: 'evt_late',
      type: 'checkout.session.expired',
      data: { object: { id: pending.stripeSessionId } },
    });

    expect((await PendingCheckout.findById(pending._id)).status).toBe('completed');
    expect(await Order.countDocuments({})).toBe(1);
  });

  it('acknowledges an event type it does not handle', async () => {
    const res = await postWebhook({
      id: 'evt_other',
      type: 'customer.subscription.created',
      data: { object: {} },
    });

    expect(res.status).toBe(200);
  });

  it('prices the order from what was charged, not from a price that moved meanwhile', async () => {
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 2 }],
      paymentMethod: 'card',
      addressId,
    });

    // The catalogue price rises while the buyer is on Stripe's card form.
    product.price = 25;
    await product.save();

    const pending = await PendingCheckout.findOne({});
    await postWebhook(completedEvent(pending.stripeSessionId));

    /*
     * 20, the amount Stripe was told to charge — NOT 50. Every other order path
     * in this app deliberately re-prices from the live catalogue; this is the
     * one case where that would make the order total disagree with the money
     * actually taken.
     */
    const order = await Order.findOne({});
    expect(order.total).toBe(20);
    expect(order.items[0].priceAtOrder).toBe(10);
  });
});

describe('Refunds on cancellation', () => {
  /** Place a paid card order and return it. */
  async function paidOrder({ price = 10, stockQty = 5, quantity = 2 } = {}) {
    const product = await createProduct({ price, stockQty });
    const { write, addressId } = await buyerAgent();

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity }],
      paymentMethod: 'card',
      addressId,
    });

    const pending = await PendingCheckout.findOne({});
    await postWebhook(completedEvent(pending.stripeSessionId));

    return { order: await Order.findOne({}), product, write };
  }

  it('refunds through Stripe and restores stock when an admin cancels directly', async () => {
    const admin = await createAdmin();
    const { order, product } = await paidOrder();

    expect((await Product.findById(product._id)).stockQty).toBe(3);

    const res = await api()
      .patch(`/api/orders/${order._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);

    // The refund actually went to Stripe, against the PaymentIntent...
    expect(calls.refunds).toHaveLength(1);
    expect(calls.refunds[0].params.payment_intent).toBe('pi_test_1');
    // ...with a stable idempotency key, so a retry cannot refund twice.
    expect(calls.refunds[0].options.idempotencyKey).toBe(`refund_order_${order._id}`);

    const reloaded = await Order.findById(order._id);
    expect(reloaded.status).toBe('cancelled');
    expect(reloaded.payment.status).toBe('refunded');
    expect(reloaded.payment.refundId).toBe('re_test_1');
    expect(reloaded.stockTakenAt).toBeNull();

    // And only now does the stock come back.
    expect((await Product.findById(product._id)).stockQty).toBe(5);
  });

  it('refunds and restores stock through the approval queue too', async () => {
    const admin = await createAdmin();
    const { order, product, write } = await paidOrder();

    const requested = await write('post', `/api/shop/orders/${order._id}/request-cancel`);
    expect(requested.status).toBe(202);

    await changeRequestService.approve(requested.body.data._id, admin.user);

    expect(calls.refunds).toHaveLength(1);

    const reloaded = await Order.findById(order._id);
    expect(reloaded.status).toBe('cancelled');
    expect(reloaded.payment.status).toBe('refunded');
    expect(reloaded.fulfilment).toBe('cancelled');
    expect((await Product.findById(product._id)).stockQty).toBe(5);
  });

  /**
   * THE ORDERING GUARANTEE, STATED AS A TEST.
   *
   * If Stripe refuses the refund, nothing else may happen: the order stays
   * live, its stock stays out, and the change request stays pending. The
   * failure mode this prevents is an order marked cancelled with inventory
   * credited back and sold to somebody else, while the customer is still out
   * of pocket.
   */
  it('does NOT cancel or restore stock when the refund fails', async () => {
    const admin = await createAdmin();
    const { order, product } = await paidOrder();

    const failing = makeStripeStub({
      refunds: {
        create: async () => {
          throw new Error('card_declined: the refund could not be processed');
        },
      },
    });
    stripeService.__setStripeClient(failing.stub);

    const res = await api()
      .patch(`/api/orders/${order._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    expect(res.status).toBeGreaterThanOrEqual(400);

    const reloaded = await Order.findById(order._id);
    expect(reloaded.status).toBe('pending');
    expect(reloaded.payment.status).toBe('paid');
    expect(reloaded.stockTakenAt).not.toBeNull();
    expect((await Product.findById(product._id)).stockQty).toBe(3);
  });

  it('leaves the change request pending when the refund fails', async () => {
    const admin = await createAdmin();
    const { order, write } = await paidOrder();

    const requested = await write('post', `/api/shop/orders/${order._id}/request-cancel`);

    const failing = makeStripeStub({
      refunds: {
        create: async () => {
          throw new Error('refund unavailable');
        },
      },
    });
    stripeService.__setStripeClient(failing.stub);

    await expect(
      changeRequestService.approve(requested.body.data._id, admin.user)
    ).rejects.toThrow();

    const stored = await ChangeRequest.findById(requested.body.data._id);
    expect(stored.status).toBe('pending');
    expect((await Order.findById(order._id)).status).toBe('pending');
  });

  it('does not call Stripe at all when cancelling an unpaid order', async () => {
    const admin = await createAdmin();
    const product = await createProduct({ price: 10, stockQty: 5 });
    const { write, addressId } = await buyerAgent();

    const placed = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'cod',
      addressId,
    });

    await api()
      .patch(`/api/orders/${placed.body.data._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    expect(calls.refunds).toHaveLength(0);
    expect((await Order.findById(placed.body.data._id)).status).toBe('cancelled');
  });
});
