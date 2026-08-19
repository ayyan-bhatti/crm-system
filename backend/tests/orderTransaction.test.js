const mongoose = require('mongoose');
const { api, createManager, createCustomer, createProduct } = require('./helpers');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Customer = require('../src/models/Customer');
const { withTransaction } = require('../src/utils/transaction');

/**
 * Transactional integrity of the order lifecycle.
 *
 * The ordinary order tests check that the right answer comes back. These check
 * something different and harder to see: that when a request fails PART WAY
 * THROUGH, the database is left exactly as it was. That is the property a
 * transaction buys, and it is invisible in a passing request — the only way to
 * observe it is to break something in the middle on purpose.
 */

describe('Order creation is atomic', () => {
  let manager;
  let customer;

  beforeEach(async () => {
    manager = await createManager();
    customer = await createCustomer(manager);
  });

  /**
   * The classic partial write. Two lines, the second short of stock: the first
   * product's decrement is applied and then the request fails. Without a
   * transaction those units are simply gone.
   */
  it('leaves no stock taken when a later line is short', async () => {
    const plenty = await createProduct({ stockQty: 100 });
    const scarce = await createProduct({ stockQty: 1 });

    const res = await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [
          { product: plenty._id, quantity: 5 },
          { product: scarce._id, quantity: 50 },
        ],
      });

    expect(res.status).toBe(400);

    // The first product must be untouched, not down by 5.
    expect((await Product.findById(plenty._id)).stockQty).toBe(100);
    expect((await Product.findById(scarce._id)).stockQty).toBe(1);
  });

  it('writes no order when the stock check fails', async () => {
    const scarce = await createProduct({ stockQty: 1 });

    await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: scarce._id, quantity: 50 }],
      });

    expect(await Order.countDocuments({})).toBe(0);
  });

  /**
   * The reverse partial write: the order document is written first, then the
   * stock fails. If the transaction did not roll back, an order would exist
   * whose stock was never taken — and its units could be sold again.
   */
  it('rolls the order document back too, not just the stock', async () => {
    const product = await createProduct({ stockQty: 3 });

    await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: product._id, quantity: 4 }],
      });

    expect(await Order.countDocuments({})).toBe(0);
    expect((await Product.findById(product._id)).stockQty).toBe(3);
  });

  it('commits everything together on success', async () => {
    const product = await createProduct({ stockQty: 10 });

    const res = await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: product._id, quantity: 4 }],
      });

    expect(res.status).toBe(201);
    expect(await Order.countDocuments({})).toBe(1);
    expect((await Product.findById(product._id)).stockQty).toBe(6);
  });

  /** A pending order takes no stock at all, transaction or not. */
  it('takes no stock for a pending order', async () => {
    const product = await createProduct({ stockQty: 10 });

    await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity: 4 }] });

    expect((await Product.findById(product._id)).stockQty).toBe(10);
  });

  /**
   * An access failure has to roll back as cleanly as a stock failure. The
   * customer check runs inside the transaction, so this proves the whole
   * handler is covered rather than just the parts that touch inventory.
   */
  it('rolls back when the customer is rejected', async () => {
    const product = await createProduct({ stockQty: 10 });

    const res = await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({
        customer: new mongoose.Types.ObjectId(),
        status: 'completed',
        items: [{ product: product._id, quantity: 4 }],
      });

    expect(res.status).toBe(404);
    expect((await Product.findById(product._id)).stockQty).toBe(10);
  });
});

describe('Status transitions are atomic', () => {
  let manager;
  let customer;

  beforeEach(async () => {
    manager = await createManager();
    customer = await createCustomer(manager);
  });

  /** Create a pending order for `quantity` of a product with `stockQty` on hand. */
  async function pendingOrder(stockQty, quantity) {
    const product = await createProduct({ stockQty });
    const res = await api()
      .post('/api/orders')
      .set(manager.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity }] });

    return { product, orderId: res.body.data._id };
  }

  /**
   * Stock can be sold out between placing a pending order and completing it —
   * the pending order never reserved anything. The failed completion must leave
   * the order pending, not half-completed.
   */
  it('leaves the order pending when completion cannot take the stock', async () => {
    const { product, orderId } = await pendingOrder(10, 8);

    // Someone else buys the stock in the meantime.
    await Product.findByIdAndUpdate(product._id, { stockQty: 2 });

    const res = await api()
      .patch(`/api/orders/${orderId}`)
      .set(manager.headers)
      .send({ status: 'completed' });

    expect(res.status).toBe(400);

    const order = await Order.findById(orderId);
    expect(order.status).toBe('pending');
    // completedAt is the guard that stops a second decrement. If it were set
    // while the decrement failed, the order could never be completed properly.
    expect(order.completedAt).toBeNull();
    expect((await Product.findById(product._id)).stockQty).toBe(2);
  });

  it('completes the order and takes the stock together', async () => {
    const { product, orderId } = await pendingOrder(10, 4);

    await api()
      .patch(`/api/orders/${orderId}`)
      .set(manager.headers)
      .send({ status: 'completed' });

    const order = await Order.findById(orderId);
    expect(order.status).toBe('completed');
    expect(order.completedAt).not.toBeNull();
    expect((await Product.findById(product._id)).stockQty).toBe(6);
  });

  it('restores the stock and cancels together', async () => {
    const { product, orderId } = await pendingOrder(10, 4);

    await api()
      .patch(`/api/orders/${orderId}`)
      .set(manager.headers)
      .send({ status: 'completed' });
    await api()
      .patch(`/api/orders/${orderId}`)
      .set(manager.headers)
      .send({ status: 'cancelled' });

    expect((await Product.findById(product._id)).stockQty).toBe(10);
    expect((await Order.findById(orderId)).completedAt).toBeNull();
  });

  /**
   * Deleting a completed order restores its stock. Both must happen or
   * neither — restoring stock for an order that still exists would let the
   * same units be credited twice.
   */
  it('deletes the order and restores its stock together', async () => {
    const { product, orderId } = await pendingOrder(10, 4);

    await api()
      .patch(`/api/orders/${orderId}`)
      .set(manager.headers)
      .send({ status: 'completed' });
    await api().delete(`/api/orders/${orderId}`).set(manager.headers);

    expect(await Order.countDocuments({})).toBe(0);
    expect((await Product.findById(product._id)).stockQty).toBe(10);
  });

  it('leaves everything alone when the delete is not permitted', async () => {
    const { product, orderId } = await pendingOrder(10, 4);
    await api()
      .patch(`/api/orders/${orderId}`)
      .set(manager.headers)
      .send({ status: 'completed' });

    const { createRep } = require('./helpers');
    const stranger = await createRep();

    const res = await api().delete(`/api/orders/${orderId}`).set(stranger.headers);

    expect(res.status).toBe(403);
    expect(await Order.countDocuments({})).toBe(1);
    // The forbidden request must not have credited the stock back.
    expect((await Product.findById(product._id)).stockQty).toBe(6);
  });
});


/**
 * Proof that a real transaction is doing the work.
 *
 * Worth being honest about why this block exists: every test above would also
 * pass against the OLD hand-rolled compensation, because each of those failures
 * happens at a point the compensation code knew how to undo. What compensation
 * cannot survive is a failure it never gets to handle — the process dying, or
 * an error thrown from somewhere that has no undo written for it.
 *
 * These tests reproduce that: writes to two collections, then a throw. Nothing
 * in the application puts them back. Only the database can, and only if the
 * work really was inside a transaction.
 */
describe('the transaction wrapper itself', () => {
  it('discards writes to every collection when the work throws', async () => {
    const manager = await createManager();
    const customer = await createCustomer(manager);
    const product = await createProduct({ stockQty: 10 });

    await expect(
      withTransaction(async (session) => {
        await Product.updateOne(
          { _id: product._id },
          { $inc: { stockQty: -5 } },
          { session }
        );
        await Order.create(
          [
            {
              customer: customer._id,
              items: [{ product: product._id, quantity: 5, priceAtOrder: 10 }],
              total: 50,
              createdBy: manager.user._id,
            },
          ],
          { session }
        );

        // No compensation exists for this. The rollback is the database's.
        throw new Error('something failed after both writes landed');
      })
    ).rejects.toThrow('something failed after both writes landed');

    expect((await Product.findById(product._id)).stockQty).toBe(10);
    expect(await Order.countDocuments({})).toBe(0);
  });

  it('commits writes to every collection when the work returns', async () => {
    const manager = await createManager();
    const product = await createProduct({ stockQty: 10 });

    await withTransaction(async (session) => {
      await Product.updateOne({ _id: product._id }, { $inc: { stockQty: -5 } }, { session });
      await Customer.create(
        [{ name: 'Committed Co', email: 'committed@test.com', createdBy: manager.user._id }],
        { session }
      );
    });

    expect((await Product.findById(product._id)).stockQty).toBe(5);
    expect(await Customer.countDocuments({ name: 'Committed Co' })).toBe(1);
  });

  /**
   * If the test database were a standalone server, `withTransaction` would
   * silently fall back to running without one and every test above would still
   * pass while proving nothing. This asserts the harness really is a replica
   * set — see the note in tests/setup.js.
   */
  it('is actually running transactions, not the standalone fallback', async () => {
    const received = await withTransaction(async (session) => session);
    expect(received).not.toBeNull();
  });
});
