const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyToken } = require('../utils/token');
const { ACCESS_COOKIE } = require('../utils/cookies');

/**
 * Authentication middleware.
 *
 * Finds the access token, verifies it, loads the matching user and attaches it
 * to `req.user`.
 *
 * TWO ACCEPTED TRANSPORTS, IN THIS ORDER
 *
 *   1. `Authorization: Bearer <token>` — explicit, used by scripts, the test
 *      suite and any non-browser client.
 *   2. the httpOnly `simplecrm_access` cookie — used by the React app, which
 *      never handles a token itself.
 *
 * The header is checked first so that a caller who sends one deliberately is
 * never overridden by a stale cookie the browser happened to still have.
 *
 * `req.authVia` records which transport was used, because it changes what else
 * is required: cookie-authenticated requests are attached automatically by the
 * browser and therefore need CSRF protection, while a bearer header cannot be
 * set by an attacker's cross-origin page and does not.
 *
 * The user is re-loaded from the database on every request rather than trusted
 * from the token payload, so a deleted account or a role change takes effect
 * immediately instead of whenever the old token happens to expire.
 */
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';

  let token = null;
  let authVia = null;

  if (header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length).trim();
    authVia = 'bearer';
  } else if (req.cookies?.[ACCESS_COOKIE]) {
    token = req.cookies[ACCESS_COOKIE];
    authVia = 'cookie';
  }

  if (!token) {
    throw ApiError.unauthorized('Not authenticated: no session');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    // Covers expired, malformed and tampered tokens alike. The client's only
    // useful reaction is the same in every case: refresh, or log in again.
    // The error object is deliberately not bound: nothing here inspects it, and
    // its message must never reach the client — "invalid signature" tells an
    // attacker more than "invalid or expired token" does.
    throw ApiError.unauthorized('Not authenticated: invalid or expired token');
  }

  const user = await User.findById(payload.id);
  if (!user) {
    throw ApiError.unauthorized('Not authenticated: user no longer exists');
  }

  /*
   * A deactivated account's EXISTING sessions stop working here.
   *
   * Checking only at login would leave an offboarded employee signed in until
   * their access token expired — up to fifteen minutes of continued access to
   * the customer list after someone pressed "deactivate", which is exactly the
   * window that matters. Because `protect` reloads the user on every request,
   * this takes effect on their very next one.
   *
   * `pending` is included for completeness: such an account has no password and
   * cannot obtain a token in the first place, so reaching here would mean
   * something else had already gone wrong.
   */
  if (!user.canSignIn()) {
    throw ApiError.unauthorized(
      'Your account is no longer active. Please contact an administrator.'
    );
  }

  req.user = user;
  req.authVia = authVia;
  return next();
});

module.exports = { protect };
