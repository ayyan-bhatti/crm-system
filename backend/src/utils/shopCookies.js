const env = require('./../config/env');
const ms = require('./ms');

/**
 * The buyer-track equivalent of `utils/cookies.js`.
 *
 * DISTINCT NAMES AND A DISTINCT REFRESH PATH, ON PURPOSE.
 *
 * A person can be signed into the internal CRM as staff and into the
 * storefront as a buyer in the same browser at the same time — a manager
 * checking how the checkout looks, say. That only works if the two sessions
 * cannot collide: different cookie names so neither overwrites the other,
 * and a refresh cookie scoped to the path that actually consumes it so it is
 * never sent to `/api/auth/refresh` or vice versa. This is the same lesson
 * the multi-tab session bug taught about cookie scoping, applied up front
 * instead of discovered later.
 *
 * The flags themselves — httpOnly, secure, sameSite — are identical to the
 * staff cookies, for the same reasons documented in `cookies.js`: a buyer's
 * session deserves the same protection a staff member's does.
 */

const SHOP_ACCESS_COOKIE = 'shop_access';
const SHOP_REFRESH_COOKIE = 'shop_refresh';
/** Path the buyer refresh cookie is scoped to — the only routes that consume it. */
const SHOP_REFRESH_COOKIE_PATH = '/api/shop/auth';

function baseOptions() {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSameSite,
  };
}

function setShopAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(SHOP_ACCESS_COOKIE, accessToken, {
    ...baseOptions(),
    path: '/',
    maxAge: ms(env.accessTokenTtl),
  });

  res.cookie(SHOP_REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    path: SHOP_REFRESH_COOKIE_PATH,
    maxAge: ms(env.refreshTokenTtl),
  });
}

/** See the matching note on `clearAuthCookies` — the options must match exactly. */
function clearShopAuthCookies(res) {
  const options = baseOptions();
  res.clearCookie(SHOP_ACCESS_COOKIE, { ...options, path: '/' });
  res.clearCookie(SHOP_REFRESH_COOKIE, { ...options, path: SHOP_REFRESH_COOKIE_PATH });
}

module.exports = {
  SHOP_ACCESS_COOKIE,
  SHOP_REFRESH_COOKIE,
  SHOP_REFRESH_COOKIE_PATH,
  setShopAuthCookies,
  clearShopAuthCookies,
};
