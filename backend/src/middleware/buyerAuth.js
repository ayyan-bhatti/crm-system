const Buyer = require('../models/Buyer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyToken } = require('../utils/token');
const { SHOP_ACCESS_COOKIE } = require('../utils/shopCookies');
const { currentContext } = require('../config/logger');

/**
 * The buyer-track equivalent of `middleware/auth.js`'s `protect`.
 *
 * Structurally parallel on purpose — same two transports, same "reload from
 * the database on every request" rule so a password change or a revoked
 * session takes effect immediately rather than whenever an access token
 * happens to expire. What is deliberately NOT here is anything from the staff
 * permission table: this never sets `req.user`, is never given to
 * `requireRole`/`requireManagerOrAdmin`, and a `Buyer` document is never what
 * any staff-facing check reads. That is the entire point of a separate model
 * — see `models/Buyer.js`.
 *
 * `kind: 'buyer'` on the decoded token is checked explicitly, rather than
 * relying only on a buyer id failing to resolve against `Buyer` by accident.
 * A staff access token has no `kind` claim at all, so presenting one here is
 * rejected on that alone, before a lookup is even attempted.
 */
const protectBuyer = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';

  let token = null;

  if (header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length).trim();
  } else if (req.cookies?.[SHOP_ACCESS_COOKIE]) {
    token = req.cookies[SHOP_ACCESS_COOKIE];
  }

  if (!token) {
    throw ApiError.unauthorized('Not authenticated: no session');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw ApiError.unauthorized('Not authenticated: invalid or expired token');
  }

  if (payload.kind !== 'buyer') {
    throw ApiError.unauthorized('Not authenticated: invalid or expired token');
  }

  const buyer = await Buyer.findById(payload.id);
  if (!buyer) {
    throw ApiError.unauthorized('Not authenticated: account no longer exists');
  }

  req.buyer = buyer;

  const context = currentContext();
  if (context) context.buyerId = buyer._id.toString();

  return next();
});

/**
 * Attach `req.buyer` if the caller is signed in, without requiring it.
 *
 * Checkout is the one route a guest and a signed-in buyer both use — the
 * whole reason a guest checkout is supported at all. This is `protectBuyer`
 * with the "or else fail" removed: a present-and-valid session populates
 * `req.buyer` exactly as it would there, a missing or invalid one is treated
 * as "checking out as a guest" rather than an error. Anything downstream
 * that actually requires a buyer (the cart, `/api/shop/auth/me`) still uses
 * `protectBuyer`, which does fail.
 */
const attachBuyerIfPresent = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';

  let token = null;

  if (header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length).trim();
  } else if (req.cookies?.[SHOP_ACCESS_COOKIE]) {
    token = req.cookies[SHOP_ACCESS_COOKIE];
  }

  if (!token) return next();

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return next();
  }

  if (payload.kind !== 'buyer') return next();

  const buyer = await Buyer.findById(payload.id);
  if (buyer) req.buyer = buyer;

  return next();
});

module.exports = { protectBuyer, attachBuyerIfPresent };
