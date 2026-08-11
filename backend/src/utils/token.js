const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * Auth strategy for this project (picked once, applied everywhere):
 *
 *   The API returns the JWT in the JSON login/register response. The React app
 *   stores it in localStorage and sends it back as `Authorization: Bearer <token>`.
 *
 * The alternative — an httpOnly cookie — is more resistant to XSS token theft,
 * but needs CSRF protection and cross-site cookie configuration. Bearer tokens
 * keep the flow explicit and are simpler to exercise from tests, which is the
 * right trade-off for this codebase.
 */

/** Sign a JWT for a user document. Only non-sensitive claims go in the payload. */
function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

/** Verify a token, throwing if it is expired, tampered with, or malformed. */
function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

module.exports = { signToken, verifyToken };
