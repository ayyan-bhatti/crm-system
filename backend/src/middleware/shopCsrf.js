const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { SHOP_ACCESS_COOKIE } = require('../utils/shopCookies');

/**
 * CSRF protection for the buyer session — the same double-submit mechanism as
 * `middleware/csrf.js`, kept as its own module rather than a shared one.
 *
 * `middleware/csrf.js`'s `verifyCsrf` decides whether a request is
 * cookie-authenticated by checking for the STAFF access cookie specifically.
 * A buyer request never carries that cookie, so it would fall straight
 * through the staff check as "nothing to forge" — which is the right answer
 * for the staff middleware (there genuinely is no staff session to forge) but
 * leaves the buyer session completely unchecked if nothing else runs. Rather
 * than generalise the staff middleware to recognise a second cookie family —
 * which would mean every future staff-auth change has to be re-reasoned about
 * for buyers too, the same coupling risk the separate `BuyerRefreshToken`
 * collection exists to avoid — this is a second, independent instance of the
 * same mechanism, scoped to the buyer cookies only.
 *
 * See `middleware/csrf.js` for the full reasoning behind the double-submit
 * technique itself; nothing about the mechanism differs here.
 */

const SHOP_CSRF_COOKIE = 'shop_csrf';
const SHOP_CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function issueShopCsrfToken(req, res, next) {
  if (!req.cookies?.[SHOP_CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString('hex');

    res.cookie(SHOP_CSRF_COOKIE, token, {
      httpOnly: false,
      secure: env.cookieSecure,
      sameSite: env.cookieSameSite,
      path: '/',
    });

    req.cookies = { ...req.cookies, [SHOP_CSRF_COOKIE]: token };
    res.locals.shopCsrfToken = token;
  }

  return next();
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function verifyShopCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const usedBearer = (req.headers.authorization || '').startsWith('Bearer ');
  if (usedBearer) return next();

  /*
   * No shop access cookie at all — a guest browsing or checking out, or the
   * buyer login/register endpoints themselves, before any session exists.
   * There is no session to ride, so there is nothing to forge.
   */
  if (!req.cookies?.[SHOP_ACCESS_COOKIE]) return next();

  const cookieToken = req.cookies[SHOP_CSRF_COOKIE];
  const headerToken = req.get(SHOP_CSRF_HEADER);

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    throw ApiError.forbidden(
      'CSRF check failed. Reload the page and try again — if this keeps happening, ' +
        'your browser may be blocking cookies for this site.'
    );
  }

  return next();
}

module.exports = {
  SHOP_CSRF_COOKIE,
  SHOP_CSRF_HEADER,
  issueShopCsrfToken,
  verifyShopCsrf,
};
