const Buyer = require('../models/Buyer');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { PUBLIC_PRODUCT_FIELDS, toPublicShape } = require('./shopProductController');

/**
 * A signed-in buyer's wishlist: `/api/shop/wishlist*`, buyer-only.
 *
 * A GUEST NEVER REACHES THIS FILE — their wishlist is `localStorage`, exactly
 * like their cart (see `models/Cart.js`'s note on the same split), and is
 * merged in here the first time they sign in via `POST /merge`.
 *
 * Every response is shaped through the storefront's own public product
 * projection (`toPublicShape`), the same one the catalogue and search use —
 * a wishlisted product must never leak anything the catalogue itself would
 * withhold (cost fields, exact stock, `lowStockThreshold`).
 */

/** The buyer's wishlisted products, in the public shape, newest-added first. */
async function presentWishlist(buyer) {
  if (!buyer.wishlist.length) return [];

  const products = await Product.find({ _id: { $in: buyer.wishlist } })
    .select(PUBLIC_PRODUCT_FIELDS)
    .lean();

  const byId = new Map(products.map((p) => [String(p._id), p]));

  /*
   * Ordered by the buyer's own list, most-recently-added first, and silently
   * skipping a product that has since been deleted — a wishlist is a list of
   * intentions, and a deleted product is simply no longer one of them, not an
   * error to surface.
   */
  return buyer.wishlist
    .slice()
    .reverse()
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map(toPublicShape);
}

/** GET /api/shop/wishlist */
const getWishlist = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await presentWishlist(req.buyer) });
});

/** POST /api/shop/wishlist — body: { productId } */
const addToWishlist = asyncHandler(async (req, res) => {
  const { productId } = req.body;
  if (!productId) throw ApiError.badRequest('A product id is required');

  const product = await Product.findById(productId).select('_id');
  if (!product) throw ApiError.notFound('Product not found');

  /*
   * $addToSet, not push-then-save: two rapid clicks on the same wishlist
   * button (a slow connection, a double-tap) must not produce two entries
   * for one product, and the atomic operator makes that true regardless of
   * how the two requests interleave — a read-then-write in JS could not.
   */
  const buyer = await Buyer.findByIdAndUpdate(
    req.buyer._id,
    { $addToSet: { wishlist: productId } },
    { new: true }
  );

  res.status(201).json({ success: true, data: await presentWishlist(buyer) });
});

/** DELETE /api/shop/wishlist/:productId */
const removeFromWishlist = asyncHandler(async (req, res) => {
  const buyer = await Buyer.findByIdAndUpdate(
    req.buyer._id,
    { $pull: { wishlist: req.params.productId } },
    { new: true }
  );

  res.json({ success: true, data: await presentWishlist(buyer) });
});

/**
 * POST /api/shop/wishlist/merge — body: { productIds: [...] }
 *
 * Folds a guest's client-side wishlist into the buyer's on sign-in, mirroring
 * `shopCartController.mergeCart`. A product id that no longer exists is
 * simply dropped by `presentWishlist` above rather than rejected here — the
 * same "don't fail login over stale local data" reasoning as the cart merge.
 */
const mergeWishlist = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.productIds)
    ? req.body.productIds.filter((id) => typeof id === 'string')
    : [];

  const buyer = ids.length
    ? await Buyer.findByIdAndUpdate(
        req.buyer._id,
        { $addToSet: { wishlist: { $each: ids } } },
        { new: true }
      )
    : req.buyer;

  res.json({ success: true, data: await presentWishlist(buyer) });
});

module.exports = { getWishlist, addToWishlist, removeFromWishlist, mergeWishlist };
