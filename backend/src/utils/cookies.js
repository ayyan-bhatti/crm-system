const env = require('./../config/env');
const ms = require('./ms');

/**
 * The one place cookie flags are decided.
 *
 * Auth cookies are only as safe as their attributes, and getting one wrong is
 * both easy and invisible — the app keeps working, it is just no longer
 * protected. Writing them once means the flags cannot differ between the login
 * response and the refresh response.
 *
 *   httpOnly  JavaScript cannot read the cookie. This is the whole point of
 *             moving off localStorage: an XSS can no longer exfiltrate the
 *             session.
 *   secure    HTTPS only. On in production; off locally, where there is no
 *             HTTPS and the browser would silently discard the cookie.
 *   sameSite  'lax' — the browser will not attach these cookies to a
 *             cross-site POST, which removes the classic CSRF vector before
 *             the CSRF token is even consulted.
 *   path      '/' for the access token (every API call needs it) but
 *             '/api/auth' for the refresh token, so the long-lived credential
 *             is not sent on the hundreds of ordinary requests that cannot use
 *             it. Fewer transmissions, fewer chances to leak.
 */

const ACCESS_COOKIE = 'simplecrm_access';
const REFRESH_COOKIE = 'simplecrm_refresh';
/** Path the refresh cookie is scoped to — the only routes that consume it. */
const REFRESH_COOKIE_PATH = '/api/auth';

function baseOptions() {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSameSite,
  };
}

/** Write both auth cookies after a login, registration or refresh. */
function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseOptions(),
    path: '/',
    maxAge: ms(env.accessTokenTtl),
  });

  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: ms(env.refreshTokenTtl),
  });
}

/**
 * Remove both cookies.
 *
 * The options passed here must match the ones the cookies were set with —
 * browsers key a cookie on (name, domain, path), so clearing "the access token"
 * with a different path leaves the original in place and logout silently fails.
 */
function clearAuthCookies(res) {
  const options = baseOptions();
  res.clearCookie(ACCESS_COOKIE, { ...options, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...options, path: REFRESH_COOKIE_PATH });
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  setAuthCookies,
  clearAuthCookies,
};
