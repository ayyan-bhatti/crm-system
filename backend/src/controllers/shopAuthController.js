const Buyer = require('../models/Buyer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const {
  issueBuyerSession,
  rotateBuyerSession,
  revokeBuyerToken,
} = require('../services/buyerSessionService');
const {
  setShopAuthCookies,
  clearShopAuthCookies,
  SHOP_REFRESH_COOKIE,
} = require('../utils/shopCookies');
const { assertStrongPassword } = require('../utils/passwordPolicy');

/**
 * Buyer auth: `/api/shop/auth/*`.
 *
 * Deliberately the CRM's `authController.js` with the CRM-specific parts
 * removed rather than reused wholesale. What carries over unchanged: cookie
 * transport, the password strength policy, per-account lockout, and rotating
 * refresh tokens with reuse detection — a buyer's account deserves the same
 * protection a staff member's does. What does NOT carry over:
 *
 *   - pending-approval registration. Staff sign-up creates a request an
 *     admin must approve, because an internal CRM account grants access to
 *     the customer book the moment it works. A storefront account grants
 *     access to nothing but the buyer's own cart and orders — there is
 *     nothing here for an admin to gate, so registration activates
 *     immediately, which is the normal shape of a storefront account.
 *   - requested roles, invites, first-user-becomes-admin. All staff-role
 *     concepts that have no buyer equivalent.
 *
 * No forgot-password flow for buyers yet — not asked for in this round, and
 * adding one un-asked would be scope creep on a security-sensitive surface.
 */

/** See `sendSession` in `authController.js` — same shape, buyer cookies. */
function sendShopSession(res, { buyer, accessToken, refreshToken }, statusCode = 200) {
  setShopAuthCookies(res, { accessToken, refreshToken });

  res.status(statusCode).json({
    success: true,
    data: { buyer, token: accessToken },
  });
}

/** POST /api/shop/auth/register */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    throw ApiError.badRequest('Name, email and password are required');
  }

  await assertStrongPassword(password, { name, email });

  const existing = await Buyer.findOne({ email: String(email).toLowerCase().trim() });
  if (existing) {
    throw ApiError.conflict('An account with that email already exists');
  }

  const buyer = await Buyer.create({ name, email, password });

  const session = await issueBuyerSession(buyer, req);
  sendShopSession(res, { buyer, ...session }, 201);
});

/**
 * POST /api/shop/auth/login
 *
 * Same enumeration-resistant shape as the staff login: identical message for
 * an unknown email and a wrong password, lockout checked before the password
 * comparison. See `authController.login` for the full reasoning — it applies
 * unchanged here.
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw ApiError.badRequest('Email and password are required');
  }

  const buyer = await Buyer.findOne({ email: String(email).toLowerCase().trim() }).select(
    '+password +failedLoginAttempts +lockUntil'
  );

  if (buyer && buyer.isLocked()) {
    const seconds = buyer.lockRemainingSeconds();
    res.set('Retry-After', String(seconds));
    return res.status(429).json({
      success: false,
      message: `Too many failed sign-in attempts. Try again in ${formatWait(seconds)}.`,
      retryAfterSeconds: seconds,
    });
  }

  if (!buyer || !(await buyer.comparePassword(password))) {
    if (buyer) await buyer.registerFailedLogin();
    throw ApiError.unauthorized('Invalid email or password');
  }

  await buyer.clearFailedLogins();

  const session = await issueBuyerSession(buyer, req);
  return sendShopSession(res, { buyer, ...session });
});

function formatWait(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** POST /api/shop/auth/refresh — see `authController.refresh` for the shape. */
const refresh = asyncHandler(async (req, res) => {
  const presented = req.cookies?.[SHOP_REFRESH_COOKIE];

  if (!presented) {
    throw ApiError.unauthorized('No session to refresh');
  }

  let session;
  try {
    session = await rotateBuyerSession(presented, req);
  } catch (err) {
    clearShopAuthCookies(res);
    throw err;
  }

  sendShopSession(res, session);
});

/** POST /api/shop/auth/logout — see `authController.logout` for the shape. */
const logout = asyncHandler(async (req, res) => {
  await revokeBuyerToken(req.cookies?.[SHOP_REFRESH_COOKIE], 'logout');
  clearShopAuthCookies(res);

  res.json({ success: true, message: 'Signed out' });
});

/** GET /api/shop/auth/me — the currently authenticated buyer, for session restore. */
const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { buyer: req.buyer } });
});

/**
 * The saved-address book on a buyer's own account.
 *
 * Nested under `/api/shop/auth` rather than a separate router: there is
 * exactly one buyer these can ever belong to — the signed-in one — so there
 * is no id in any of these URLs and no scoping question to get wrong. Every
 * handler here mutates `req.buyer`, which `protectBuyer` has already loaded
 * and verified belongs to the caller.
 */

/** POST /api/shop/auth/addresses — body: { label, address, phone } */
const addAddress = asyncHandler(async (req, res) => {
  const { label, address, phone } = req.body;
  if (!label || !address) {
    throw ApiError.badRequest('An address needs a label and the address itself');
  }

  req.buyer.addresses.push({ label, address, phone: phone || '' });
  await req.buyer.save();

  res.status(201).json({ success: true, data: { addresses: req.buyer.addresses } });
});

/** PATCH /api/shop/auth/addresses/:addressId */
const updateAddress = asyncHandler(async (req, res) => {
  const entry = req.buyer.addresses.id(req.params.addressId);
  if (!entry) throw ApiError.notFound('Address not found');

  const { label, address, phone } = req.body;
  if (label !== undefined) entry.label = label;
  if (address !== undefined) entry.address = address;
  if (phone !== undefined) entry.phone = phone;

  await req.buyer.save();

  res.json({ success: true, data: { addresses: req.buyer.addresses } });
});

/** DELETE /api/shop/auth/addresses/:addressId */
const deleteAddress = asyncHandler(async (req, res) => {
  const entry = req.buyer.addresses.id(req.params.addressId);
  if (!entry) throw ApiError.notFound('Address not found');

  entry.deleteOne();
  await req.buyer.save();

  res.json({ success: true, data: { addresses: req.buyer.addresses } });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  getMe,
  addAddress,
  updateAddress,
  deleteAddress,
};
