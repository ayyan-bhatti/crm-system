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
const { applyConsent, consentFromBody } = require('../models/marketingConsent');
const emailVerificationService = require('../services/emailVerificationService');
const { componentLogger } = require('../config/logger');

const log = componentLogger('shop-auth');

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

  /*
   * MARKETING CONSENT AT REGISTRATION.
   *
   * This is where the round's "opt-in checkboxes on guest checkout" lands, and
   * it is worth saying why it is not on a guest checkout. There is no guest
   * checkout any more — an earlier round made an account mandatory before
   * buying, enforced by `protectBuyer` on the route rather than only in the UI
   * — so registration IS the step every storefront purchase now passes
   * through. Putting the boxes anywhere else would mean building a form nobody
   * can reach.
   *
   * Applied AFTER the account is created rather than passed to `create`, so
   * that a malformed consent body can never be the reason a registration
   * fails. Somebody who cannot make an account because a checkbox confused the
   * server has lost more than a marketing opt-in.
   *
   * `consentFromBody` only accepts a literal `true`, so every value that is
   * not an explicitly ticked box leaves the channel off.
   */
  const consentChanges = consentFromBody(req.body);
  if (Object.keys(consentChanges).length && applyConsent(buyer, consentChanges).length) {
    await buyer.save();
  }

  /*
   * Awaited, with the failure swallowed inside the try/catch rather than the
   * call left un-awaited — see the identical note on the CRM-side
   * `authController.register` for why: an un-awaited send could still be in
   * flight when the response goes out, which is racy for no benefit. A mail
   * outage must not turn registration into an error either way, and this
   * never gates checkout or sign-in — see the field's own comment on Buyer.
   */
  try {
    await emailVerificationService.sendVerificationEmail('buyer', buyer, req);
  } catch (err) {
    log.warn({ err }, 'could not send the verification email');
  }

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

/** POST /api/shop/auth/addresses — body: { label, address, city, phone } */
const addAddress = asyncHandler(async (req, res) => {
  const { label, address, city, phone } = req.body;
  if (!label || !address || !city) {
    throw ApiError.badRequest('An address needs a label, city and the address itself');
  }

  req.buyer.addresses.push({ label, address, city, phone: phone || '' });
  await req.buyer.save();

  res.status(201).json({ success: true, data: { addresses: req.buyer.addresses } });
});

/** PATCH /api/shop/auth/addresses/:addressId */
const updateAddress = asyncHandler(async (req, res) => {
  const entry = req.buyer.addresses.id(req.params.addressId);
  if (!entry) throw ApiError.notFound('Address not found');

  const { label, address, city, phone } = req.body;
  if (label !== undefined) entry.label = label;
  if (address !== undefined) entry.address = address;
  if (city !== undefined) entry.city = city;
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

/**
 * GET /api/shop/verify-email/:token — check only. See the identical CRM-side
 * note on `authController.checkEmailVerification` for why GET never redeems.
 */
const checkEmailVerification = asyncHandler(async (req, res) => {
  const result = await emailVerificationService.peek(req.params.token);
  res.json({ success: true, data: result });
});

/** POST /api/shop/verify-email — body: `{ token }`. Actually redeems it. */
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) throw ApiError.badRequest('A token is required');

  const result = await emailVerificationService.verify(token);

  if (!result.ok) {
    const messages = {
      expired: 'This verification link has expired. Request a new one from your account.',
      used: 'This verification link has already been used.',
      invalid: 'This verification link is not valid.',
    };
    throw ApiError.badRequest(messages[result.reason] || messages.invalid);
  }

  res.json({ success: true, message: 'Email confirmed.' });
});

/** POST /api/shop/auth/resend-verification — requires a buyer session. */
const resendVerification = asyncHandler(async (req, res) => {
  if (req.buyer.emailVerified) {
    return res.json({ success: true, message: 'Your email is already confirmed.' });
  }

  await emailVerificationService.resend('buyer', req.buyer, req);
  res.json({ success: true, message: 'Verification email sent.' });
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
  checkEmailVerification,
  verifyEmail,
  resendVerification,
};
