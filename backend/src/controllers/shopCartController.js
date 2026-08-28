const Cart = require('../models/Cart');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * The server-side cart: `/api/shop/cart*`, buyer-only.
 *
 * A GUEST NEVER REACHES THIS FILE. Their cart is pure frontend state — see
 * `models/Cart.js` for why — so every handler here assumes `req.buyer`
 * exists, which `protectBuyer` guarantees.
 *
 * No price is stored or returned from here beyond what `Product.price`
 * currently is: a cart is not a quote, and checkout re-resolves price from
 * the product at the moment of purchase regardless of what this endpoint
 * last reported, the same as every other order path in this app.
 */

/** Load (or lazily create) the one cart a buyer has. */
async function loadCart(buyerId) {
  const cart = await Cart.findOneAndUpdate(
    { buyer: buyerId },
    { $setOnInsert: { buyer: buyerId, items: [] } },
    { new: true, upsert: true }
  );
  return cart;
}

/** Shape the cart for the client: current product price/name/stock alongside each line. */
async function present(cart) {
  const productIds = cart.items.map((item) => item.product);
  const products = await Product.find({ _id: { $in: productIds } }).select(
    'name price stockQty imageUrl'
  );
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = cart.items.map((item) => {
    const product = byId.get(String(item.product));
    return {
      product: product
        ? {
            _id: product._id,
            name: product.name,
            price: product.price,
            imageUrl: product.imageUrl || '',
            inStock: product.stockQty > 0,
          }
        : // The product was deleted since it was added. Shown rather than
          // silently dropped, so the buyer sees why their total changed and
          // can remove the line themselves.
          { _id: item.product, name: 'No longer available', price: 0, inStock: false },
      quantity: item.quantity,
    };
  });

  const total = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

  return { items, total: Math.round(total * 100) / 100 };
}

/** GET /api/shop/cart */
const getCart = asyncHandler(async (req, res) => {
  const cart = await loadCart(req.buyer._id);
  res.json({ success: true, data: await present(cart) });
});

/** POST /api/shop/cart/items — body: { product, quantity } */
const addItem = asyncHandler(async (req, res) => {
  const { product: productId, quantity } = req.body;
  const qty = Number(quantity);

  if (!productId || !Number.isInteger(qty) || qty < 1) {
    throw ApiError.badRequest('A cart line needs a product and an integer quantity of at least 1');
  }

  const product = await Product.findById(productId);
  if (!product) throw ApiError.notFound('Product not found');

  const cart = await loadCart(req.buyer._id);
  const existing = cart.items.find((item) => String(item.product) === String(productId));

  if (existing) {
    existing.quantity += qty;
  } else {
    cart.items.push({ product: productId, quantity: qty });
  }

  await cart.save();
  res.status(201).json({ success: true, data: await present(cart) });
});

/** PATCH /api/shop/cart/items/:productId — body: { quantity } */
const updateItem = asyncHandler(async (req, res) => {
  const qty = Number(req.body.quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    throw ApiError.badRequest('Quantity must be an integer of at least 1');
  }

  const cart = await loadCart(req.buyer._id);
  const line = cart.items.find((item) => String(item.product) === req.params.productId);
  if (!line) throw ApiError.notFound('That product is not in the cart');

  line.quantity = qty;
  await cart.save();

  res.json({ success: true, data: await present(cart) });
});

/** DELETE /api/shop/cart/items/:productId */
const removeItem = asyncHandler(async (req, res) => {
  const cart = await loadCart(req.buyer._id);
  const before = cart.items.length;
  cart.items = cart.items.filter((item) => String(item.product) !== req.params.productId);

  if (cart.items.length === before) throw ApiError.notFound('That product is not in the cart');

  await cart.save();
  res.json({ success: true, data: await present(cart) });
});

/**
 * POST /api/shop/cart/merge — body: { items: [{ product, quantity }] }
 *
 * Folds a guest's client-side cart into the buyer's server cart on login, so
 * signing in mid-shop does not lose what was already added. Quantities add
 * together on a shared line, the same as `addItem` — the guest cart is
 * discarded by the frontend immediately after a successful merge.
 */
const mergeCart = asyncHandler(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  const cart = await loadCart(req.buyer._id);

  for (const { product: productId, quantity } of rawItems) {
    const qty = Number(quantity);
    if (!productId || !Number.isInteger(qty) || qty < 1) continue;

    const existing = cart.items.find((item) => String(item.product) === String(productId));
    if (existing) {
      existing.quantity += qty;
    } else {
      cart.items.push({ product: productId, quantity: qty });
    }
  }

  await cart.save();
  res.json({ success: true, data: await present(cart) });
});

module.exports = { getCart, addItem, updateItem, removeItem, mergeCart };
