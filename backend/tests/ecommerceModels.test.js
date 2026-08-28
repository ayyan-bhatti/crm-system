const mongoose = require('mongoose');
const { createAdmin, createCustomer, createProduct, createBuyer } = require('./helpers');
const Buyer = require('../src/models/Buyer');
const Cart = require('../src/models/Cart');
const Order = require('../src/models/Order');
const ChangeRequest = require('../src/models/ChangeRequest');

/**
 * Phase 1 of the storefront build: the data-model changes underneath
 * everything else (buyer accounts, carts, and the order/change-request
 * fields a storefront order needs). No routes exist yet — these pin down the
 * schemas themselves before anything is built on top of them.
 */

describe('Buyer account', () => {
  it('hashes the password and never returns it', async () => {
    const buyer = await createBuyer({ password: 'Correct-Horse-9-Battery' });

    expect(buyer.toJSON().password).toBeUndefined();

    const stored = await Buyer.findById(buyer._id).select('+password');
    expect(stored.password).not.toBe('Correct-Horse-9-Battery');
    expect(await stored.comparePassword('Correct-Horse-9-Battery')).toBe(true);
    expect(await stored.comparePassword('wrong')).toBe(false);
  });

  it('refuses a second account on the same email', async () => {
    await createBuyer({ email: 'dup@test.com' });
    await expect(createBuyer({ email: 'dup@test.com' })).rejects.toThrow();
  });

  /*
   * Same exponential backoff as staff accounts (see User.js) — a buyer's
   * password deserves the same protection, and there is no reason a
   * storefront login should be easier to brute-force than a staff one.
   */
  it('locks out after repeated failed logins, same as a staff account', async () => {
    const buyer = await createBuyer();

    for (let i = 0; i < 5; i += 1) {
      await buyer.registerFailedLogin();
    }

    const reloaded = await Buyer.findById(buyer._id).select('+lockUntil');
    expect(reloaded.isLocked()).toBe(true);
    expect(reloaded.lockRemainingSeconds()).toBeGreaterThan(0);

    await reloaded.clearFailedLogins();
    const cleared = await Buyer.findById(buyer._id).select('+lockUntil');
    expect(cleared.isLocked()).toBe(false);
  });
});

describe('Cart', () => {
  it('holds one cart per buyer', async () => {
    const buyer = await createBuyer();
    const product = await createProduct();

    await Cart.create({ buyer: buyer._id, items: [{ product: product._id, quantity: 2 }] });

    await expect(
      Cart.create({ buyer: buyer._id, items: [{ product: product._id, quantity: 1 }] })
    ).rejects.toThrow();
  });
});

describe('Product.imageUrl', () => {
  it('defaults to empty so older products fall back to a placeholder', async () => {
    const product = await createProduct();
    expect(product.imageUrl).toBe('');
  });

  it('can be set for the storefront catalogue', async () => {
    const product = await createProduct({ imageUrl: 'https://example.com/widget.jpg' });
    expect(product.imageUrl).toBe('https://example.com/widget.jpg');
  });
});

describe('Order.source and Order.buyerId', () => {
  it('defaults an order to internal with no buyer', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct();

    const order = await Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: product.price }],
      total: product.price,
      createdBy: admin.user._id,
    });

    expect(order.source).toBe('internal');
    expect(order.buyerId).toBeNull();
  });

  it('records a storefront order against the buyer who placed it', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct();
    const buyer = await createBuyer();

    const order = await Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: product.price }],
      total: product.price,
      createdBy: admin.user._id,
      source: 'storefront',
      buyerId: buyer._id,
    });

    expect(order.source).toBe('storefront');
    expect(order.buyerId).toEqual(buyer._id);
  });

  it('refuses a source outside internal/storefront', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct();

    await expect(
      Order.create({
        customer: customer._id,
        items: [{ product: product._id, quantity: 1, priceAtOrder: product.price }],
        total: product.price,
        createdBy: admin.user._id,
        source: 'wholesale',
      })
    ).rejects.toThrow();
  });
});

describe('ChangeRequest.requestedByModel', () => {
  it('defaults to User for a request created the existing way', async () => {
    const admin = await createAdmin();

    const request = await ChangeRequest.create({
      entity: 'customer',
      action: 'update',
      payload: { company: 'New Co' },
      requestedBy: admin.user._id,
    });

    expect(request.requestedByModel).toBe('User');

    const populated = await ChangeRequest.findById(request._id).populate('requestedBy', 'name');
    expect(populated.requestedBy.name).toBe(admin.user.name);
  });

  it('accepts a buyer as the requester', async () => {
    const buyer = await createBuyer();

    const request = await ChangeRequest.create({
      entity: 'order',
      entityId: new mongoose.Types.ObjectId(),
      action: 'cancel',
      requestedBy: buyer._id,
      requestedByModel: 'Buyer',
    });

    const populated = await ChangeRequest.findById(request._id).populate('requestedBy', 'name');
    expect(populated.requestedBy.name).toBe(buyer.name);
    expect(populated.requestedBy).toBeInstanceOf(mongoose.Document);
  });

  /*
   * A request written before this field existed has no `requestedByModel` in
   * the database at all — this is what proves the default makes it read back
   * correctly anyway, with no migration.
   */
  it('still resolves a legacy request with no stored requestedByModel as a User', async () => {
    const admin = await createAdmin();

    const inserted = await mongoose.connection.collection('changerequests').insertOne({
      entity: 'customer',
      action: 'update',
      payload: { company: 'Legacy Co' },
      status: 'pending',
      requestedBy: admin.user._id,
      createdAt: new Date(),
    });

    const legacy = await ChangeRequest.findById(inserted.insertedId).populate(
      'requestedBy',
      'name'
    );

    expect(legacy.requestedByModel).toBe('User');
    expect(legacy.requestedBy.name).toBe(admin.user.name);
  });

  it('accepts the new cancel action, distinct from delete', async () => {
    const buyer = await createBuyer();

    const request = await ChangeRequest.create({
      entity: 'order',
      entityId: new mongoose.Types.ObjectId(),
      action: 'cancel',
      requestedBy: buyer._id,
      requestedByModel: 'Buyer',
    });

    expect(request.action).toBe('cancel');
  });
});
