const { api, createAdmin, createRep, createCustomer, createProduct } = require('./helpers');
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');

/**
 * Order CRUD and — the important part — the stock rules.
 *
 * Stock is the only place in this app where one request mutates a second
 * collection, so it is where a bug would be both easiest to introduce and
 * hardest to notice: nothing errors, the numbers are just quietly wrong.
 */
describe('Order CRUD and stock handling', () => {
  /** Convenience: read a product's current stock level. */
  const stockOf = async (id) => (await Product.findById(id)).stockQty;

  describe('POST /api/orders', () => {
    it('creates a pending order', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ price: 10, stockQty: 50 });

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 3 }] });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.items).toHaveLength(1);
    });

    it('computes the total on the server and ignores one sent by the client', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ price: 10.5, stockQty: 50 });

      const res = await api().post('/api/orders').set(admin.headers).send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 2 }],
        total: 0.01, // an attempt to pay a penny
      });

      expect(res.body.data.total).toBe(21);
    });

    it('snapshots the price at the time of the order', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ price: 10, stockQty: 50 });

      const created = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      // Price rises after the order was placed.
      await api().patch(`/api/products/${product._id}`).set(admin.headers).send({ price: 99 });

      const res = await api().get(`/api/orders/${created.body.data._id}`).set(admin.headers);

      expect(res.body.data.items[0].priceAtOrder).toBe(10);
      expect(res.body.data.total).toBe(10);
    });

    it('does not move stock while the order is pending', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 50 });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 5 }] });

      expect(await stockOf(product._id)).toBe(50);
    });

    it('rejects an order for more than the available stock', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 5, name: 'Scarce Widget' });

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 6 }] });

      expect(res.status).toBe(400);
      // The message should name the offending product, not just fail.
      expect(res.body.message).toContain('Scarce Widget');
    });

    /**
     * Two lines for the same product must be considered together. Checked
     * separately, 3 + 3 against a stock of 5 would both pass and oversell.
     */
    it('merges duplicate lines before checking stock', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 5 });

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({
          customer: customer._id,
          items: [
            { product: product._id, quantity: 3 },
            { product: product._id, quantity: 3 },
          ],
        });

      expect(res.status).toBe(400);
    });

    it('merges duplicate lines into a single item when they do fit', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ price: 10, stockQty: 50 });

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({
          customer: customer._id,
          items: [
            { product: product._id, quantity: 2 },
            { product: product._id, quantity: 3 },
          ],
        });

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].quantity).toBe(5);
      expect(res.body.data.total).toBe(50);
    });

    it('rejects an unknown product id', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({
          customer: customer._id,
          items: [{ product: '507f1f77bcf86cd799439011', quantity: 1 }],
        });

      expect(res.status).toBe(400);
    });

    it('rejects an empty item list', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [] });

      expect(res.status).toBe(400);
    });

    it('rejects a zero or negative quantity', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct();

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 0 }] });

      expect(res.status).toBe(400);
    });

    it('rejects a missing customer', async () => {
      const admin = await createAdmin();
      const product = await createProduct();

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ items: [{ product: product._id, quantity: 1 }] });

      expect(res.status).toBe(400);
    });

    it('returns 404 for a customer that does not exist', async () => {
      const admin = await createAdmin();
      const product = await createProduct();

      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({
          customer: '507f1f77bcf86cd799439011',
          items: [{ product: product._id, quantity: 1 }],
        });

      expect(res.status).toBe(404);
    });

    it('decrements stock when the order is created as completed', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 20 });

      const res = await api().post('/api/orders').set(admin.headers).send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 4 }],
        status: 'completed',
      });

      expect(res.status).toBe(201);
      expect(await stockOf(product._id)).toBe(16);
    });

    it('refuses to create an order directly as cancelled', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct();

      const res = await api().post('/api/orders').set(admin.headers).send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1 }],
        status: 'cancelled',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('Stock movement on status changes', () => {
    /** Creates a pending order for `quantity` units and returns its id. */
    async function pendingOrder(auth, quantity = 4, stockQty = 20) {
      const customer = await createCustomer(auth);
      const product = await createProduct({ stockQty, price: 10 });

      const res = await api()
        .post('/api/orders')
        .set(auth.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity }] });

      return { orderId: res.body.data._id, productId: product._id };
    }

    it('decrements stock on completion', async () => {
      const admin = await createAdmin();
      const { orderId, productId } = await pendingOrder(admin, 4, 20);

      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'completed' });

      expect(await stockOf(productId)).toBe(16);
    });

    it('stamps completedAt on completion', async () => {
      const admin = await createAdmin();
      const { orderId } = await pendingOrder(admin);

      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'completed' });

      const order = await Order.findById(orderId);
      expect(order.completedAt).toBeInstanceOf(Date);
    });

    /**
     * The guard that matters most. A retried request, a double-clicked button,
     * or an at-least-once webhook must not take the stock twice.
     */
    it('does not decrement twice when completion is requested again', async () => {
      const admin = await createAdmin();
      const { orderId, productId } = await pendingOrder(admin, 4, 20);

      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'completed' });
      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'completed' });
      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'completed' });

      expect(await stockOf(productId)).toBe(16);
    });

    it('restores stock when a completed order is cancelled', async () => {
      const admin = await createAdmin();
      const { orderId, productId } = await pendingOrder(admin, 4, 20);

      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'completed' });
      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'cancelled' });

      expect(await stockOf(productId)).toBe(20);
    });

    it('does not change stock when a pending order is cancelled', async () => {
      const admin = await createAdmin();
      const { orderId, productId } = await pendingOrder(admin, 4, 20);

      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'cancelled' });

      expect(await stockOf(productId)).toBe(20);
    });

    it('refuses to reopen a cancelled order', async () => {
      const admin = await createAdmin();
      const { orderId } = await pendingOrder(admin);

      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'cancelled' });
      const res = await api()
        .patch(`/api/orders/${orderId}`)
        .set(admin.headers)
        .send({ status: 'completed' });

      expect(res.status).toBe(400);
    });

    it('refuses to move an order back to pending', async () => {
      const admin = await createAdmin();
      const { orderId } = await pendingOrder(admin);

      await api().patch(`/api/orders/${orderId}`).set(admin.headers).send({ status: 'completed' });
      const res = await api()
        .patch(`/api/orders/${orderId}`)
        .set(admin.headers)
        .send({ status: 'pending' });

      expect(res.status).toBe(400);
    });

    it('rejects completion when stock has since been sold elsewhere', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 10 });

      // Order raised while there was stock…
      const order = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 8 }] });

      // …but the shelf is emptied before it is completed.
      await api().patch(`/api/products/${product._id}`).set(admin.headers).send({ stockQty: 2 });

      const res = await api()
        .patch(`/api/orders/${order.body.data._id}`)
        .set(admin.headers)
        .send({ status: 'completed' });

      expect(res.status).toBe(400);
      expect(await stockOf(product._id)).toBe(2);
    });

    /**
     * Rollback: if the second line cannot be fulfilled, the stock taken for the
     * first must be put back rather than silently lost.
     */
    it('rolls back the first line when a later line has insufficient stock', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const plenty = await createProduct({ stockQty: 50 });
      const scarce = await createProduct({ stockQty: 10 });

      const order = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({
          customer: customer._id,
          items: [
            { product: plenty._id, quantity: 5 },
            { product: scarce._id, quantity: 8 },
          ],
        });

      await api().patch(`/api/products/${scarce._id}`).set(admin.headers).send({ stockQty: 1 });

      const res = await api()
        .patch(`/api/orders/${order.body.data._id}`)
        .set(admin.headers)
        .send({ status: 'completed' });

      expect(res.status).toBe(400);
      expect(await stockOf(plenty._id)).toBe(50); // untouched, not 45
      expect(await stockOf(scarce._id)).toBe(1);
    });
  });

  describe('PATCH /api/orders/:id — item edits', () => {
    it('allows editing items on a pending order', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ price: 10, stockQty: 50 });

      const order = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api()
        .patch(`/api/orders/${order.body.data._id}`)
        .set(admin.headers)
        .send({ items: [{ product: product._id, quantity: 4 }] });

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(40);
    });

    it('refuses to edit items on a completed order', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 50 });

      const order = await api().post('/api/orders').set(admin.headers).send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1 }],
        status: 'completed',
      });

      const res = await api()
        .patch(`/api/orders/${order.body.data._id}`)
        .set(admin.headers)
        .send({ items: [{ product: product._id, quantity: 5 }] });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/orders', () => {
    it('filters by status', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 50 });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      await api().post('/api/orders').set(admin.headers).send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1 }],
        status: 'completed',
      });

      const res = await api().get('/api/orders?status=completed').set(admin.headers);

      expect(res.body.total).toBe(1);
    });

    it('filters by customer', async () => {
      const admin = await createAdmin();
      const a = await createCustomer(admin);
      const b = await createCustomer(admin);
      const product = await createProduct({ stockQty: 50 });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: a._id, items: [{ product: product._id, quantity: 1 }] });
      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: b._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api().get(`/api/orders?customer=${a._id}`).set(admin.headers);

      expect(res.body.total).toBe(1);
    });

    it('filters by a date range that includes today', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 50 });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const today = new Date().toISOString().slice(0, 10);
      const res = await api()
        .get(`/api/orders?from=${today}&to=${today}`)
        .set(admin.headers);

      expect(res.body.total).toBe(1);
    });

    it('excludes orders outside the date range', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 50 });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api()
        .get('/api/orders?from=2020-01-01&to=2020-12-31')
        .set(admin.headers);

      expect(res.body.total).toBe(0);
    });

    it('populates the customer on each order', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin, { name: 'Populated Co' });
      const product = await createProduct({ stockQty: 50 });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api().get('/api/orders').set(admin.headers);

      expect(res.body.data[0].customer.name).toBe('Populated Co');
    });
  });

  describe('DELETE /api/orders/:id', () => {
    it('deletes a pending order without touching stock', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 20 });

      const order = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 5 }] });

      const res = await api().delete(`/api/orders/${order.body.data._id}`).set(admin.headers);

      expect(res.status).toBe(200);
      expect(await stockOf(product._id)).toBe(20);
      expect(await Order.findById(order.body.data._id)).toBeNull();
    });

    it('restores stock when deleting a completed order', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);
      const product = await createProduct({ stockQty: 20 });

      const order = await api().post('/api/orders').set(admin.headers).send({
        customer: customer._id,
        items: [{ product: product._id, quantity: 5 }],
        status: 'completed',
      });

      expect(await stockOf(product._id)).toBe(15);

      await api().delete(`/api/orders/${order.body.data._id}`).set(admin.headers);

      expect(await stockOf(product._id)).toBe(20);
    });
  });

  describe('Sales-rep scoping', () => {
    it('shows a rep only their own orders', async () => {
      const owner = await createRep();
      const other = await createRep();
      const product = await createProduct({ stockQty: 50 });

      const ownersCustomer = await createCustomer(owner);
      const othersCustomer = await createCustomer(other);

      await api()
        .post('/api/orders')
        .set(owner.headers)
        .send({ customer: ownersCustomer._id, items: [{ product: product._id, quantity: 1 }] });
      await api()
        .post('/api/orders')
        .set(other.headers)
        .send({ customer: othersCustomer._id, items: [{ product: product._id, quantity: 1 }] });

      const res = await api().get('/api/orders').set(owner.headers);

      expect(res.body.total).toBe(1);
    });
  });
});
