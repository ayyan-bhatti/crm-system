const mongoose = require('mongoose');
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
 *
 * A LINE IS IDENTIFIED BY PRODUCT **AND** VARIANT.
 *
 * This is the change variants forced, and it runs through every handler below.
 * Two colours of one shirt are two independent lines: they have separate stock,
 * can be added and removed independently, and folding them together would make
 * "remove the blue one" impossible to express. Every lookup therefore goes
 * through `sameLine`, and the variant travels in the body or query string
 * rather than the URL path, so the existing `/items/:productId` routes keep
 * working unchanged for the products that have no variants.
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

/**
 * Do these two refer to the same cart line?
 *
 * Compared as strings because one side is an ObjectId off a document and the
 * other is whatever arrived in a request body. `null` and `undefined` and a
 * missing field all have to mean the same thing — "no variant" — which is why
 * both sides are normalised rather than compared directly.
 */
function sameLine(item, productId, variantId) {
  const itemVariant = item.variantId ? String(item.variantId) : '';
  const wanted = variantId ? String(variantId) : '';
  return String(item.product) === String(productId) && itemVariant === wanted;
}

/** Validate a variant id against the product it claims to belong to. */
function resolveVariant(product, variantId) {
  const hasVariants = product.variants && product.variants.length > 0;

  if (hasVariants && !variantId) {
    throw ApiError.badRequest(
      `"${product.name}" is sold in specific colours — choose one before adding it.`
    );
  }
  if (!hasVariants && variantId) {
    throw ApiError.badRequest(`"${product.name}" is not sold in variants.`);
  }
  if (!hasVariants) return null;

  if (!mongoose.isValidObjectId(variantId)) {
    throw ApiError.badRequest('That is not a valid variant');
  }

  const variant = product.variants.id(variantId);
  if (!variant) {
    throw ApiError.badRequest(`That colour is no longer available for "${product.name}".`);
  }

  return variant;
}

/** Shape the cart for the client: current product price/name/stock alongside each line. */
async function present(cart) {
  const productIds = cart.items.map((item) => item.product);
  const products = await Product.find({ _id: { $in: productIds } }).select(
    'name price stockQty imageUrl variants'
  );
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = cart.items.map((item) => {
    const product = byId.get(String(item.product));

    if (!product) {
      // The product was deleted since it was added. Shown rather than silently
      // dropped, so the buyer sees why their total changed and can remove the
      // line themselves.
      return {
        product: { _id: item.product, name: 'No longer available', price: 0, inStock: false },
        quantity: item.quantity,
        variant: null,
      };
    }

    const variant = item.variantId ? product.variants.id(item.variantId) : null;

    /*
     * A variant that has been discontinued while sitting in a cart is reported
     * as out of stock rather than dropped, for the same reason a deleted
     * product is: a line that vanishes silently makes the total change for no
     * visible reason.
     */
    const unavailableVariant = Boolean(item.variantId) && !variant;

    return {
      product: {
        _id: product._id,
        name: product.name,
        price: variant?.priceOverride ?? product.price,
        imageUrl: product.imageUrl || '',
        inStock: unavailableVariant
          ? false
          : variant
            ? variant.stockQty > 0
            : product.stockQty > 0,
      },
      quantity: item.quantity,
      variant: variant
        ? {
            variantId: variant._id,
            colorName: variant.color.name,
            colorHex: variant.color.hex,
            size: variant.size || '',
          }
        : unavailableVariant
          ? { variantId: item.variantId, colorName: 'No longer available', colorHex: '', size: '' }
          : null,
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

/** POST /api/shop/cart/items — body: { product, quantity, variantId } */
const addItem = asyncHandler(async (req, res) => {
  const { product: productId, quantity, variantId = null } = req.body;
  const qty = Number(quantity);

  if (!productId || !Number.isInteger(qty) || qty < 1) {
    throw ApiError.badRequest('A cart line needs a product and an integer quantity of at least 1');
  }

  const product = await Product.findById(productId);
  if (!product) throw ApiError.notFound('Product not found');

  const variant = resolveVariant(product, variantId);

  const cart = await loadCart(req.buyer._id);
  const existing = cart.items.find((item) => sameLine(item, productId, variantId));

  if (existing) {
    existing.quantity += qty;
  } else {
    cart.items.push({ product: productId, quantity: qty, variantId: variant?._id ?? null });
  }

  await cart.save();
  res.status(201).json({ success: true, data: await present(cart) });
});

/** PATCH /api/shop/cart/items/:productId — body: { quantity, variantId } */
const updateItem = asyncHandler(async (req, res) => {
  const qty = Number(req.body.quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    throw ApiError.badRequest('Quantity must be an integer of at least 1');
  }

  const cart = await loadCart(req.buyer._id);
  const line = cart.items.find((item) =>
    sameLine(item, req.params.productId, req.body.variantId)
  );
  if (!line) throw ApiError.notFound('That product is not in the cart');

  line.quantity = qty;
  await cart.save();

  res.json({ success: true, data: await present(cart) });
});

/** DELETE /api/shop/cart/items/:productId?variantId=… */
const removeItem = asyncHandler(async (req, res) => {
  const cart = await loadCart(req.buyer._id);
  const before = cart.items.length;

  cart.items = cart.items.filter(
    (item) => !sameLine(item, req.params.productId, req.query.variantId)
  );

  if (cart.items.length === before) throw ApiError.notFound('That product is not in the cart');

  await cart.save();
  res.json({ success: true, data: await present(cart) });
});

/**
 * POST /api/shop/cart/merge — body: { items: [{ product, quantity, variantId }] }
 *
 * Folds a guest's client-side cart into the buyer's server cart on login, so
 * signing in mid-shop does not lose what was already added. Quantities add
 * together on a shared line, the same as `addItem` — the guest cart is
 * discarded by the frontend immediately after a successful merge.
 *
 * INVALID LINES ARE SKIPPED, NOT REJECTED. A merge happens during login, and
 * failing the whole thing because one product was discontinued last week would
 * turn "sign in" into an error the buyer cannot act on or understand.
 */
const mergeCart = asyncHandler(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  const cart = await loadCart(req.buyer._id);

  for (const { product: productId, quantity, variantId = null } of rawItems) {
    const qty = Number(quantity);
    if (!productId || !Number.isInteger(qty) || qty < 1) continue;

    const existing = cart.items.find((item) => sameLine(item, productId, variantId));
    if (existing) {
      existing.quantity += qty;
    } else {
      cart.items.push({ product: productId, quantity: qty, variantId: variantId || null });
    }
  }

  await cart.save();
  res.json({ success: true, data: await present(cart) });
});

module.exports = { getCart, addItem, updateItem, removeItem, mergeCart };
