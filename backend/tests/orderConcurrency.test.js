const { api, createManager, createCustomer, createProduct } = require('./helpers');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const IdempotencyKey = require('../src/models/IdempotencyKey');

/**
 * Concurrency safety and idempotency for order creation.
 *
 * The two failure modes here are the ones that survive a passing test suite and
 * show up in production as "the numbers don't add up":
 *
 *   overselling  two requests each check stock, each see enough, each take it.
 *   duplicates   one logical submission becomes two orders because the response
 *                was lost and the client retried.
 *
 * Neither can be found by testing one request at a time, which is why these
 * tests fire requests in parallel and replay them.
 */

describe('Concurrent stock', () => {
  let manager;
  let customer;

  beforeEach(async () => {
    manager = await createManager();
    customer = await createCustomer(manager);
  });

  const buy = (productId, quantity) =>
    api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: productId, quantity }],
      });

  /**
   * The headline case: two people buy the last unit at the same moment.
   *
   * A read-then-write check lets both through — each reads stock 1, each sees
   * enough, each decrements, and stock ends at -1. The conditional update in
   * decrementStock cannot be raced: MongoDB matches and decrements as one
   * operation, so the loser matches no document.
   */
  it('lets only one of two simultaneous buyers take the last unit', async () => {
    const product = await createProduct({ stockQty: 1 });

    const results = await Promise.all([buy(product._id, 1), buy(product._id, 1)]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 400]);
    expect((await Product.findById(product._id)).stockQty).toBe(0);
    expect(await Order.countDocuments({})).toBe(1);
  });

  /** Stock must never go below zero, whatever the traffic. */
  it('never drives stock negative under a burst of orders', async () => {
    const product = await createProduct({ stockQty: 5 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => buy(product._id, 1))
    );

    const created = results.filter((r) => r.status === 201).length;

    expect(created).toBe(5);
    expect((await Product.findById(product._id)).stockQty).toBe(0);
  });

  it('accounts for every unit sold', async () => {
    const product = await createProduct({ stockQty: 12 });

    const results = await Promise.all([
      buy(product._id, 5),
      buy(product._id, 5),
      buy(product._id, 5),
    ]);

    const soldUnits = results.filter((r) => r.status === 201).length * 5;
    const remaining = (await Product.findById(product._id)).stockQty;

    // Whatever the outcome of the race, sold + remaining must equal the
    // starting stock. Anything else means units were created or destroyed.
    expect(soldUnits + remaining).toBe(12);
  });

  /**
   * Two lines for the same product on ONE order. Merged before the check, so
   * they cannot each pass individually and oversell together.
   */
  it('merges duplicate lines rather than checking them separately', async () => {
    const product = await createProduct({ stockQty: 10 });

    const res = await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [
          { product: product._id, quantity: 6 },
          { product: product._id, quantity: 6 },
        ],
      });

    expect(res.status).toBe(400);
    expect((await Product.findById(product._id)).stockQty).toBe(10);
  });

  /** Completing two pending orders at once races on the same stock. */
  it('lets only one of two simultaneous completions take the stock', async () => {
    const product = await createProduct({ stockQty: 1 });

    const pending = await Promise.all([
      api()
        .post('/api/orders')
        .set(manager.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] }),
      api()
        .post('/api/orders')
        .set(manager.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] }),
    ]);

    const results = await Promise.all(
      pending.map((res) =>
        api()
          .patch(`/api/orders/${res.body.data._id}`)
          .set(manager.headers)
          .send({ status: 'completed' })
      )
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await Product.findById(product._id)).stockQty).toBe(0);
  });
});

describe('Idempotent order creation', () => {
  let manager;
  let customer;
  let product;

  beforeEach(async () => {
    manager = await createManager();
    customer = await createCustomer(manager);
    product = await createProduct({ stockQty: 100 });
  });

  const create = (key, quantity = 2) => {
    const request = api().post('/api/orders').set(manager.headers);
    if (key) request.set('Idempotency-Key', key);
    return request.send({
      customer: customer._id,
      status: 'completed',
      items: [{ product: product._id, quantity }],
    });
  };

  const KEY = '11111111-2222-3333-4444-555555555555';

  it('creates the order on the first request', async () => {
    const res = await create(KEY);

    expect(res.status).toBe(201);
    expect(await Order.countDocuments({})).toBe(1);
  });

  /**
   * The case that matters: the client never saw the first response and retried.
   * It must get the SAME order back, not a second one.
   */
  it('replays the original response instead of creating a second order', async () => {
    const first = await create(KEY);
    const second = await create(KEY);

    expect(second.status).toBe(201);
    expect(second.body.data._id).toBe(first.body.data._id);
    expect(await Order.countDocuments({})).toBe(1);
  });

  it('takes the stock only once', async () => {
    await create(KEY);
    await create(KEY);

    expect((await Product.findById(product._id)).stockQty).toBe(98);
  });

  it('marks a replayed response so the client can tell', async () => {
    await create(KEY);
    const replay = await create(KEY);

    expect(replay.headers['idempotent-replay']).toBe('true');
  });

  /** Two retries arriving together must still produce one order. */
  it('survives two simultaneous retries of the same key', async () => {
    const results = await Promise.all([create(KEY), create(KEY)]);

    // One executes; the other either replays it or is told the original is
    // still running. Either answer is correct — what must never happen is two
    // orders.
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(await Order.countDocuments({})).toBe(1);
  });

  /**
   * A key reused with a different body is a client bug, not a retry. Replaying
   * the stored response would hand back an order the caller never asked for.
   */
  it('refuses a key reused for a different request', async () => {
    await create(KEY, 2);
    const res = await create(KEY, 7);

    expect(res.status).toBe(409);
    expect(await Order.countDocuments({})).toBe(1);
  });

  /** Different keys are different operations, even with identical bodies. */
  it('creates separate orders for different keys', async () => {
    await create('key-one-aaaaaaaaaaaa');
    await create('key-two-bbbbbbbbbbbb');

    expect(await Order.countDocuments({})).toBe(2);
  });

  /** Keys are per user, so one user cannot read another's stored response. */
  it('scopes keys to the user who used them', async () => {
    const other = await createManager();
    const otherCustomer = await createCustomer(other);

    await create(KEY);
    const res = await api()
      .post('/api/orders')
      .set(other.headers)
      .set('Idempotency-Key', KEY)
      .send({
        customer: otherCustomer._id,
        status: 'completed',
        items: [{ product: product._id, quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(await Order.countDocuments({})).toBe(2);
  });

  /**
   * A failed request created nothing, so the key is released — otherwise
   * fixing a typo would require inventing a new key, which is a confusing rule.
   */
  it('releases the key when the request failed', async () => {
    const tooMany = await create(KEY, 1000);
    expect(tooMany.status).toBe(400);

    const retry = await create(KEY, 2);

    expect(retry.status).toBe(201);
    expect(await Order.countDocuments({})).toBe(1);
  });

  /** Backwards compatible: a client that sends no key still works. */
  it('works without a key at all', async () => {
    const res = await create(null);
    expect(res.status).toBe(201);
    expect(await IdempotencyKey.countDocuments({})).toBe(0);
  });

  it('rejects an implausibly short key rather than pretending to protect it', async () => {
    const res = await create('abc');
    expect(res.status).toBe(400);
  });
});
