const { api, createAdmin, createManager } = require('./helpers');

/**
 * Product CRUD, focused on the one rule round 2 of the storefront work added:
 * a NEW product must have a photo. Every other product field's validation
 * already lives on the Mongoose schema and is exercised incidentally by the
 * audit and role-boundary suites; this file is specifically about `imageUrl`.
 */
describe('Product CRUD — image requirement', () => {
  describe('POST /api/products', () => {
    it('refuses a new product with no image URL', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/products')
        .set(admin.headers)
        .send({ name: 'No Photo Yet', sku: 'NOPHOTO-1', price: 10, stockQty: 5 });

      expect(res.status).toBe(400);
    });

    it('refuses a new product whose image URL is blank or whitespace', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/products')
        .set(admin.headers)
        .send({
          name: 'Blank Photo',
          sku: 'BLANK-1',
          price: 10,
          stockQty: 5,
          imageUrl: '   ',
        });

      expect(res.status).toBe(400);
    });

    it('creates a product once an image URL is supplied', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/products')
        .set(admin.headers)
        .send({
          name: 'Standing Desk',
          sku: 'DESK-1',
          price: 450,
          stockQty: 10,
          imageUrl: 'https://picsum.photos/seed/desk-1/480',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.imageUrl).toBe('https://picsum.photos/seed/desk-1/480');
    });
  });

  describe('PATCH /api/products/:id', () => {
    /**
     * The rule is "required on create", not "required forever". A product
     * seeded (or created) before this rule existed has an empty `imageUrl`,
     * and editing some OTHER field of it — a price change, a restock — must
     * keep working. Re-demanding a photo on every future edit would turn a
     * one-time onboarding rule into a trap for old data.
     */
    it('lets an existing image-less product be edited without supplying one', async () => {
      const manager = await createManager();

      const created = await api()
        .post('/api/products')
        .set(manager.headers)
        .send({
          name: 'Has Photo',
          sku: 'HASPHOTO-1',
          price: 20,
          stockQty: 5,
          imageUrl: 'https://picsum.photos/seed/hasphoto-1/480',
        });

      // Simulate a product that predates the rule, same as a seeded one would be.
      const Product = require('../src/models/Product');
      await Product.updateOne({ _id: created.body.data._id }, { $set: { imageUrl: '' } });

      const res = await api()
        .patch(`/api/products/${created.body.data._id}`)
        .set(manager.headers)
        .send({ stockQty: 3 });

      expect(res.status).toBe(200);
      expect(res.body.data.stockQty).toBe(3);
      expect(res.body.data.imageUrl).toBe('');
    });
  });
});
