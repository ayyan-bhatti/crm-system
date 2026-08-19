const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const ms = require('./ms');
const env = require('../config/env');

/**
 * Auth strategy for this project (picked once, applied everywhere).
 *
 * The browser never stores a credential in JavaScript-reachable storage. Two
 * httpOnly cookies carry the session instead:
 *
 *   accessToken   short-lived (15m) signed JWT. Stateless, so verifying it is
 *                 one signature check with no database round trip.
 *   refreshToken  long-lived (7d) opaque random string. Stateful — its hash is
 *                 stored in the RefreshToken collection, so it can be revoked.
 *
 * WHY NOT localStorage (what this replaced)
 *
 * A token in localStorage is readable by any JavaScript running on the page.
 * One successful XSS — an injected script, a compromised npm dependency, a
 * third-party widget — and the attacker exfiltrates a credential that was, in
 * the old design, valid for seven days with no way to revoke it. httpOnly
 * cookies are not readable from JavaScript at all, so the same XSS can make
 * requests as the user while the page is open but cannot steal a token to use
 * later from anywhere else.
 *
 * THE COST, STATED HONESTLY
 *
 * Cookies are attached by the browser automatically, which is exactly what
 * makes CSRF possible — so this change requires CSRF protection (Phase 1.3) to
 * be a net win. SameSite=Lax already blocks the cross-site POST case; the
 * explicit token is the belt to that braces.
 *
 * `Authorization: Bearer <token>` is still accepted by the auth middleware for
 * non-browser callers (scripts, the test suite, any future mobile client).
 * That is not a hole in the cookie story: an attacker's page cannot set a
 * header on a cross-site request, so bearer requests are inherently
 * CSRF-immune, and they are opt-in per caller rather than sent automatically.
 */

/** Sign a short-lived access JWT. Only non-sensitive claims go in the payload. */
function signAccessToken(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, env.jwtSecret, {
    expiresIn: env.accessTokenTtl,
  });
}

/** Verify an access token, throwing if it is expired, tampered with, or malformed. */
function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

/**
 * Generate a refresh token: 32 bytes of CSPRNG output, hex encoded.
 *
 * It carries no claims at all. Everything about it — who it belongs to, when it
 * expires, whether it is still live — is looked up server-side by its hash, so
 * a stolen token reveals nothing and a forged one matches no row.
 */
function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Hash a refresh token for storage and lookup. See models/RefreshToken. */
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Absolute expiry date for a newly issued refresh token. */
function refreshTokenExpiry() {
  return new Date(Date.now() + ms(env.refreshTokenTtl));
}

module.exports = {
  signAccessToken,
  // Kept under the old name so existing callers (tests/helpers.js, seed.js)
  // keep working; it now mints the short-lived access token.
  signToken: signAccessToken,
  verifyToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
};
