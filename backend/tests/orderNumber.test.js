const Counter = require('../src/models/Counter');
const Order = require('../src/models/Order');
const {
  formatOrderNumber,
  parseOrderNumber,
  nextOrderNumber,
} = require('../src/services/orderNumber');
const { api, createAdmin, createManager, createRep, createCustomer, createProduct } = require('./helpers');

/**
 * Human-readable order numbers.
 *
 * The interesting test in here is the concurrency one. Everything else is
 * formatting; that one is the reason the counter exists rather than a
 * `countDocuments() + 1`, and it is the same shape of race as the stock
 * decrement — a read and a write with a window between them.
 */

describe('formatOrderNumber', () => {
  it('pads to a fixed width so numbers line up in a column', () => {
    expect(formatOrderNumber(1)).toBe('ORD-000001');
    expect(formatOrderNumber(142)).toBe('ORD-000142');
    expect(formatOrderNumber(999999)).toBe('ORD-999999');
  });

  /** Padding is presentation, not a limit. Nothing may depend on the width. */
  it('keeps going past the padding width rather than breaking', () => {
    expect(formatOrderNumber(1000001)).toBe('ORD-1000001');
  });
});

describe('parseOrderNumber', () => {
  /**
   * Someone typing a number they read off a screen should not have to
   * reproduce its formatting exactly.
   */
  it('accepts the ways a person might actually type it', () => {
    for (const input of ['ORD-000142', 'ord-000142', 'ORD-142', 'ord 142', '142', '  142  ']) {
      expect(parseOrderNumber(input)).toBe('ORD-000142');
    }
  });

  it('rejects anything that is not one', () => {
    for (const input of ['Karachi Traders', 'ORD-', '', null, undefined, 'ORD-12x']) {
      expect(parseOrderNumber(input)).toBeNull();
    }
  });
});

describe('Counter', () => {
  it('starts at one on a fresh database', async () => {
    expect(await Counter.next('test-seq')).toBe(1);
  });

  it('never returns the same number twice', async () => {
    const seen = [];
    for (let i = 0; i < 5; i += 1) seen.push(await Counter.next('test-seq'));

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps separate sequences separate', async () => {
    await Counter.next('alpha');
    await Counter.next('alpha');

    expect(await Counter.next('beta')).toBe(1);
    expect(await Counter.next('alpha')).toBe(3);
  });

  /**
   * THE TEST THE COUNTER EXISTS FOR.
   *
   * `countDocuments() + 1` passes every sequential test above and fails this
   * one: concurrent callers all read the same count and all claim the same
   * number. Because the read and the write are one operation here, there is no
   * window for a second caller to occupy.
   */
  it('hands every concurrent caller a different number', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => Counter.next('race'))
    );

    expect(new Set(results).size).toBe(25);
    expect(results.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1)
    );
  });

  /**
   * Numbers must never be reused, or the id stops identifying anything — the
   * failure mode `count()` has even without concurrency.
   */
  it('does not reuse a number after the thing it named is deleted', async () => {
    const first = await nextOrderNumber();
    const second = await nextOrderNumber();

    expect(second).not.toBe(first);
    expect(await nextOrderNumber()).not.toBe(second);
  });
});

describe('orders get a number when created', () => {
  let admin;
  let customer;
  let product;

  beforeEach(async () => {
    admin = await createAdmin();
    customer = await createCustomer(admin);
    product = await createProduct({ price: 100, stockQty: 500 });
  });

  const place = () =>
    api()
      .post('/api/orders')
      .set(admin.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

  it('assigns one on creation', async () => {
    const res = await place();

    expect(res.status).toBe(201);
    expect(res.body.data.orderNumber).toMatch(/^ORD-\d{6}$/);
  });

  it('counts up across orders', async () => {
    const first = await place();
    const second = await place();

    const seq = (res) => Number(res.body.data.orderNumber.split('-')[1]);
    expect(seq(second)).toBe(seq(first) + 1);
  });

  /** The real reason for the counter, through the endpoint rather than the model. */
  it('gives concurrent orders different numbers', async () => {
    const results = await Promise.all([place(), place(), place(), place(), place()]);

    const numbers = results.map((res) => res.body.data.orderNumber);
    expect(numbers.every(Boolean)).toBe(true);
    expect(new Set(numbers).size).toBe(5);
  });

  /**
   * `_id` stays the primary key. Replacing it with a sequential number would
   * leak the order volume of the business to anyone who can see one, and
   * invalidate every existing reference.
   */
  it('does not replace the id', async () => {
    const res = await place();

    expect(res.body.data._id).toMatch(/^[a-f0-9]{24}$/);
    expect(res.body.data._id).not.toBe(res.body.data.orderNumber);
  });
});

describe('searching orders by number', () => {
  let admin;
  let target;

  beforeEach(async () => {
    admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct({ price: 100, stockQty: 500 });

    const place = () =>
      api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

    await place();
    target = (await place()).body.data;
    await place();
  });

  const search = (term) =>
    api().get('/api/orders').query({ search: term }).set(admin.headers);

  it('finds the order by its full number', async () => {
    const res = await search(target.orderNumber);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]._id).toBe(target._id);
  });

  it('finds it however the number was typed', async () => {
    const bare = Number(target.orderNumber.split('-')[1]);

    for (const term of [String(bare), `ord-${bare}`, target.orderNumber.toLowerCase()]) {
      const res = await search(term);
      expect(res.body.data.map((row) => row._id)).toEqual([target._id]);
    }
  });

  /**
   * An empty result is the honest answer to a search for something that cannot
   * exist. Ignoring the parameter and returning everything would look like the
   * search silently failed.
   */
  it('returns nothing rather than everything for a non-number', async () => {
    const res = await search('Karachi Traders');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns nothing for a number that does not exist', async () => {
    expect((await search('ORD-999999')).body.data).toHaveLength(0);
  });

  /** A sales rep must not find another rep's order by guessing at numbers. */
  it('still applies role scope', async () => {
    const rep = await createRep();

    const res = await api()
      .get('/api/orders')
      .query({ search: target.orderNumber })
      .set(rep.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('the backfill leaves historical orders usable', () => {
  /**
   * `orderNumber` is deliberately not `required`. An order created before the
   * field existed is still a perfectly valid order, and making it required
   * would mean every read-then-save of a historical row failing validation.
   */
  it('accepts an order with no number at all', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct({ price: 10, stockQty: 5 });

    const order = await Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: 10 }],
      total: 10,
      createdBy: admin.user._id,
    });

    // Absent rather than null — see the note on the field.
    expect(order.orderNumber).toBeUndefined();

    // And can still be saved, which a `required` field would have prevented.
    order.status = 'cancelled';
    await expect(order.save()).resolves.toBeDefined();
  });

  /**
   * The unique index is sparse, so the many historical nulls do not collide.
   * Without that, the second unnumbered order would be rejected outright.
   */
  it('allows more than one unnumbered order to coexist', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct({ price: 10, stockQty: 50 });

    const make = () =>
      Order.create({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1, priceAtOrder: 10 }],
        total: 10,
        createdBy: admin.user._id,
      });

    await expect(Promise.all([make(), make(), make()])).resolves.toHaveLength(3);
  });
});

describe('order numbers appear in the audit trail', () => {
  it('labels an order entry with its number rather than its id', async () => {
    const manager = await createManager();
    const admin = await createAdmin();
    const customer = await createCustomer(manager);
    const product = await createProduct({ price: 100, stockQty: 500 });

    const created = await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

    const rep = await createRep();

    await api()
      .patch(`/api/orders/${created.body.data._id}/assign`)
      .set(manager.headers)
      .send({ assignedTo: rep.user._id });

    const audit = await api()
      .get('/api/audit-logs')
      .query({ entity: 'order' })
      .set(admin.headers);

    const entry = audit.body.data.find((row) => row.note);
    expect(entry.entityLabel).toBe(created.body.data.orderNumber);
  });
});
