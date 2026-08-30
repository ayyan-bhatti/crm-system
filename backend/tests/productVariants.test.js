const { api, createAdmin, createCustomer, createProduct } = require('./helpers');
const Product = require('../src/models/Product');
const { buildOrderItems, decrementStock } = require('../src/controllers/orderController');
const { withTransaction } = require('../src/utils/transaction');

/**
 * Product variants: colour, optional size, and stock held per combination.
 *
 * THE TWO CLAIMS WORTH TESTING HARD
 *
 *   1. Per-variant stock is decremented ATOMICALLY. The single-stock version of
 *      this guarantee already existed and was already tested; a variant version
 *      that merely looks similar is not the same guarantee, and the way it fails
 *      is subtle — see the two-colour test below, which passes against a naive
 *      implementation for a single-variant product and oversells the moment a
 *      product has two.
 *
 *   2. A product with NO variants behaves exactly as it did before this feature
 *      existed. Every seeded and demo product is in that state, so a regression
 *      here breaks the whole catalogue rather than one screen.
 */

/** A product with two colours, each with its own stock. */
async function variantProduct(overrides = {}) {
  return Product.create({
    name: 'Field Jacket',
    sku: `FJ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    price: 100,
    category: 'Outerwear',
    imageUrl: 'https://example.test/jacket.jpg',
    variants: [
      { color: { name: 'Midnight', hex: '#111827' }, size: 'M', stockQty: 3 },
      { color: { name: 'Sand', hex: '#d6c7a1' }, size: 'M', stockQty: 1 },
    ],
    ...overrides,
  });
}

describe('The variant schema and its stock bookkeeping', () => {
  it('keeps the product stockQty equal to the sum of its variants', async () => {
    const product = await variantProduct();
    expect(product.stockQty).toBe(4);

    product.variants[0].stockQty = 10;
    await product.save();

    expect((await Product.findById(product._id)).stockQty).toBe(11);
  });

  it('leaves a product with no variants exactly as it was', async () => {
    const product = await createProduct({ stockQty: 7 });

    expect(product.variants).toHaveLength(0);
    expect(product.stockQty).toBe(7);

    // The hook must not touch stockQty when there are no variants to sum —
    // otherwise every pre-variant product would silently become zero.
    product.name = 'Renamed';
    await product.save();
    expect((await Product.findById(product._id)).stockQty).toBe(7);
  });

  it('refuses a colour that is not a six-digit hex', async () => {
    await expect(
      Product.create({
        name: 'Bad', sku: 'BAD-1', price: 1,
        variants: [{ color: { name: 'Red', hex: 'red' }, stockQty: 1 }],
      })
    ).rejects.toThrow(/hex/i);
  });
});

describe('Pricing an order line against a variant', () => {
  it('requires a variant to be chosen for a product that has them', async () => {
    const product = await variantProduct();

    await expect(
      buildOrderItems([{ product: product._id, quantity: 1 }])
    ).rejects.toThrow(/choose one/i);
  });

  it('refuses a variant id against a product that has none', async () => {
    const plain = await createProduct();
    const other = await variantProduct();

    await expect(
      buildOrderItems([
        { product: plain._id, quantity: 1, variantId: other.variants[0]._id },
      ])
    ).rejects.toThrow(/not sold in variants/i);
  });

  it('refuses a variant that does not belong to the product', async () => {
    const product = await variantProduct();
    const other = await variantProduct();

    await expect(
      buildOrderItems([
        { product: product._id, quantity: 1, variantId: other.variants[0]._id },
      ])
    ).rejects.toThrow(/no longer available/i);
  });

  it('snapshots the colour and size onto the line', async () => {
    const product = await variantProduct();
    const variant = product.variants[0];

    const { items, total } = await buildOrderItems([
      { product: product._id, quantity: 2, variantId: variant._id },
    ]);

    expect(items[0].variant.colorName).toBe('Midnight');
    expect(items[0].variant.colorHex).toBe('#111827');
    expect(items[0].variant.size).toBe('M');
    expect(String(items[0].variant.variantId)).toBe(String(variant._id));
    expect(total).toBe(200);
  });

  it("uses the variant's price override when it has one", async () => {
    const product = await variantProduct();
    product.variants[1].priceOverride = 60;
    await product.save();

    const { items, total } = await buildOrderItems([
      { product: product._id, quantity: 1, variantId: product.variants[1]._id },
    ]);

    expect(items[0].priceAtOrder).toBe(60);
    expect(total).toBe(60);
  });

  it('checks stock against the chosen variant, not the product total', async () => {
    const product = await variantProduct();

    /*
     * The product has 4 units in total but only 1 in Sand. Asking for 2 Sand
     * must fail — a check against the product-level 4 would let it through and
     * oversell one colour while another sat unsold.
     */
    await expect(
      buildOrderItems([
        { product: product._id, quantity: 2, variantId: product.variants[1]._id },
      ])
    ).rejects.toThrow(/Insufficient stock.*Sand/i);
  });

  /**
   * MERGING IS KEYED ON PRODUCT **AND** VARIANT.
   *
   * Keying on the product alone would fold two colours into one line of 3,
   * check that against one variant's stock, and write an order that has lost
   * half of what the customer asked for.
   */
  it('merges duplicate lines per variant rather than per product', async () => {
    const product = await variantProduct();
    const [midnight, sand] = product.variants;

    const { items } = await buildOrderItems([
      { product: product._id, quantity: 1, variantId: midnight._id },
      { product: product._id, quantity: 1, variantId: sand._id },
      { product: product._id, quantity: 1, variantId: midnight._id },
    ]);

    expect(items).toHaveLength(2);
    const midnightLine = items.find((i) => i.variant.colorName === 'Midnight');
    expect(midnightLine.quantity).toBe(2);
  });
});

describe('Per-variant stock decrement', () => {
  it('takes stock from the chosen variant and from the product total', async () => {
    const product = await variantProduct();
    const { items } = await buildOrderItems([
      { product: product._id, quantity: 2, variantId: product.variants[0]._id },
    ]);

    await withTransaction((session) => decrementStock(items, session));

    const reloaded = await Product.findById(product._id);
    expect(reloaded.variants[0].stockQty).toBe(1);
    expect(reloaded.variants[1].stockQty).toBe(1);
    expect(reloaded.stockQty).toBe(2);
  });

  /**
   * THE TEST THAT CATCHES THE SUBTLE WRONG IMPLEMENTATION.
   *
   * Writing the filter as `{ 'variants._id': v, 'variants.stockQty': { $gte: q } }`
   * looks equivalent to the `$elemMatch` form and is not: MongoDB evaluates
   * those two dotted conditions INDEPENDENTLY across the array, so a product
   * where one variant has the id and a DIFFERENT variant has the stock will
   * match. Here, Sand has 1 unit and Midnight has 3 — asking for 2 Sand would
   * match on Midnight's stock and decrement Sand into the negative.
   *
   * A single-variant product cannot distinguish the two implementations, which
   * is exactly why this test uses two.
   */
  it('cannot borrow one colour\'s stock to satisfy another', async () => {
    const product = await variantProduct();
    const sand = product.variants[1]; // 1 unit; Midnight has 3

    const items = [
      { product: product._id, quantity: 2, variant: { variantId: sand._id, colorName: 'Sand' } },
    ];

    await expect(
      withTransaction((session) => decrementStock(items, session))
    ).rejects.toThrow(/Insufficient stock/i);

    const reloaded = await Product.findById(product._id);
    expect(reloaded.variants[1].stockQty).toBe(1);
    expect(reloaded.variants[0].stockQty).toBe(3);
  });

  /**
   * Two buyers, one remaining unit of one specific colour. Exactly one wins.
   *
   * This is the variant-level restatement of the guarantee the single-stock
   * decrement already made, and it is run concurrently rather than in sequence
   * because a sequential version would pass against a read-then-write
   * implementation that has no guarantee at all.
   */
  it('lets exactly one of two concurrent orders take the last unit of a colour', async () => {
    const product = await variantProduct();
    const sand = product.variants[1]; // exactly 1 in stock

    const attempt = async () => {
      const items = [
        {
          product: product._id,
          quantity: 1,
          variant: { variantId: sand._id, colorName: 'Sand' },
        },
      ];
      return withTransaction((session) => decrementStock(items, session));
    };

    const results = await Promise.allSettled([attempt(), attempt()]);
    const won = results.filter((r) => r.status === 'fulfilled');

    expect(won).toHaveLength(1);

    const reloaded = await Product.findById(product._id);
    expect(reloaded.variants[1].stockQty).toBe(0);
    // Never negative, and never double-decremented.
    expect(reloaded.stockQty).toBe(3);
  });
});

describe('Variants through the API', () => {
  it('lets an admin create a product with variants and sums the stock', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/products')
      .set(admin.headers)
      .send({
        name: 'Trail Shirt',
        sku: 'TS-1',
        price: 45,
        category: 'Shirts',
        imageUrl: 'https://example.test/shirt.jpg',
        variants: [
          { color: { name: 'Olive', hex: '#556B2F' }, size: 'S', stockQty: 2 },
          { color: { name: 'Olive', hex: '#556B2F' }, size: 'L', stockQty: 5 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.variants).toHaveLength(2);
    expect(res.body.data.stockQty).toBe(7);
  });

  it('refuses two rows for the same colour and size', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/products')
      .set(admin.headers)
      .send({
        name: 'Dupe', sku: 'D-1', price: 10,
        imageUrl: 'https://example.test/d.jpg',
        variants: [
          { color: { name: 'Red', hex: '#ff0000' }, size: 'M', stockQty: 1 },
          { color: { name: 'red', hex: '#ff0000' }, size: 'M', stockQty: 2 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/repeats/i);
  });

  it('names the offending row when a colour is invalid', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/products')
      .set(admin.headers)
      .send({
        name: 'Bad', sku: 'B-1', price: 10,
        imageUrl: 'https://example.test/b.jpg',
        variants: [
          { color: { name: 'Fine', hex: '#000000' }, stockQty: 1 },
          { color: { name: 'Broken', hex: 'notahex' }, stockQty: 1 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Variant 2/);
    expect(res.body.message).toMatch(/Broken/);
  });

  it('keeps variant ids across an edit, so existing order lines stay addressable', async () => {
    const admin = await createAdmin();
    const product = await variantProduct();
    const originalId = String(product.variants[0]._id);

    const res = await api()
      .patch(`/api/products/${product._id}`)
      .set(admin.headers)
      .send({
        variants: [
          { _id: originalId, color: { name: 'Midnight', hex: '#111827' }, size: 'M', stockQty: 9 },
          { color: { name: 'Sand', hex: '#d6c7a1' }, size: 'M', stockQty: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(String(res.body.data.variants[0]._id)).toBe(originalId);
    expect(res.body.data.stockQty).toBe(10);
  });

  it('records the variant on an order line and restores it on cancellation', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await variantProduct();
    const sand = product.variants[1];

    const created = await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: product._id, quantity: 1, variantId: sand._id }],
      });

    expect(created.status).toBe(201);
    expect(created.body.data.items[0].variant.colorName).toBe('Sand');

    expect((await Product.findById(product._id)).variants[1].stockQty).toBe(0);

    await api()
      .patch(`/api/orders/${created.body.data._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    const reloaded = await Product.findById(product._id);
    expect(reloaded.variants[1].stockQty).toBe(1);
    expect(reloaded.stockQty).toBe(4);
  });

  it('restores a cancelled order even when the variant has since been deleted', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await variantProduct();
    const sand = product.variants[1];

    const created = await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: product._id, quantity: 1, variantId: sand._id }],
      });

    // The colour is discontinued while the order is live.
    const reloadedProduct = await Product.findById(product._id);
    reloadedProduct.variants.pull(sand._id);
    await reloadedProduct.save();

    await api()
      .patch(`/api/orders/${created.body.data._id}`)
      .set(admin.headers)
      .send({ status: 'cancelled' });

    /*
     * The variant is gone, so its own count cannot come back — but the unit
     * must not simply vanish from the product's headline stock. `restoreStock`
     * credits the parent with a second, unconditional update for exactly this.
     */
    const finalProduct = await Product.findById(product._id);
    expect(finalProduct.variants).toHaveLength(1);
    expect(finalProduct.stockQty).toBe(4);
  });
});

describe('The public storefront projection of a variant', () => {
  it('exposes the colour swatch but never a stock count', async () => {
    await variantProduct();

    const res = await api().get('/api/shop/products');
    const [product] = res.body.data;

    expect(product.variants).toHaveLength(2);
    expect(product.variants[0].color).toEqual({ name: 'Midnight', hex: '#111827' });
    expect(product.variants[0].inStock).toBe(true);
    // The exact per-colour count is as internal as the product-level one.
    expect(product.variants[0].stockQty).toBeUndefined();
    expect(product.stockQty).toBeUndefined();
    expect(product.lowStockThreshold).toBeUndefined();
  });

  it('reports a sold-out colour as out of stock while the product still is', async () => {
    const product = await variantProduct();
    product.variants[1].stockQty = 0;
    await product.save();

    const res = await api().get('/api/shop/products');
    const [shaped] = res.body.data;

    expect(shaped.inStock).toBe(true);
    expect(shaped.variants[1].inStock).toBe(false);
  });

  it('filters by colour, price range and stock, and sorts by price', async () => {
    await variantProduct();
    await createProduct({ name: 'Cheap Thing', price: 5, stockQty: 4 });
    await createProduct({ name: 'Sold Out', price: 500, stockQty: 0 });

    const byColour = await api().get('/api/shop/products?color=Sand');
    expect(byColour.body.data).toHaveLength(1);
    expect(byColour.body.data[0].name).toBe('Field Jacket');

    const byPrice = await api().get('/api/shop/products?maxPrice=50');
    expect(byPrice.body.data.map((p) => p.name)).toEqual(['Cheap Thing']);

    const inStock = await api().get('/api/shop/products?inStock=true');
    expect(inStock.body.data.map((p) => p.name).sort()).toEqual(['Cheap Thing', 'Field Jacket']);

    const sorted = await api().get('/api/shop/products?sort=price_desc');
    expect(sorted.body.data[0].name).toBe('Sold Out');
  });

  it('ignores a malformed price bound rather than matching nothing', async () => {
    await createProduct({ name: 'Thing', price: 20 });

    const res = await api().get('/api/shop/products?maxPrice=cheap');

    // An empty grid reads as "we sell nothing", which is a far worse answer to
    // a typo than an unfiltered one.
    expect(res.body.data).toHaveLength(1);
  });

  it('serves categories and colours publicly, with no session at all', async () => {
    await variantProduct();
    await createProduct({ category: 'Tools' });

    const categories = await api().get('/api/shop/products/categories');
    expect(categories.status).toBe(200);
    expect(categories.body.data).toContain('Outerwear');
    expect(categories.body.data).toContain('Tools');

    const colours = await api().get('/api/shop/products/colours');
    expect(colours.status).toBe(200);
    expect(colours.body.data.map((c) => c.name).sort()).toEqual(['Midnight', 'Sand']);
  });

  it('does not read "categories" as a product id', async () => {
    const res = await api().get('/api/shop/products/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
