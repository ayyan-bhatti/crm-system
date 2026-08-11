const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyToken } = require('../utils/token');

/**
 * Authentication middleware.
 *
 * Reads the `Authorization: Bearer <token>` header, verifies the JWT, loads the
 * matching user from the database and attaches it to `req.user`.
 *
 * The user is re-loaded on every request rather than trusted from the token
 * payload, so a deleted account or a role change takes effect immediately
 * instead of when the old token happens to expire.
 */
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Not authenticated: missing bearer token');
  }

  const token = header.slice('Bearer '.length).trim();

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    // Covers expired, malformed and tampered tokens alike — the client only
    // needs to know it must log in again.
    throw ApiError.unauthorized('Not authenticated: invalid or expired token');
  }

  const user = await User.findById(payload.id);
  if (!user) {
    throw ApiError.unauthorized('Not authenticated: user no longer exists');
  }

  req.user = user;
  return next();
});

module.exports = { protect };
