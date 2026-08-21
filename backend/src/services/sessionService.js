const crypto = require('crypto');
const RefreshToken = require('../models/RefreshToken');
const { componentLogger } = require('../config/logger');

const log = componentLogger('auth');
const ApiError = require('../utils/ApiError');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
} = require('../utils/token');

/**
 * Everything that creates, rotates or destroys a login session.
 *
 * Kept out of the controller because all three auth endpoints (login, register,
 * refresh) need the same "issue a pair of tokens" behaviour, and logout and
 * reuse-detection need the same revocation behaviour. One copy means the
 * security rules cannot drift between entry points.
 */

/** Small request fingerprint, stored purely so sessions are identifiable later. */
function requestMeta(req) {
  return {
    userAgent: String(req.get('user-agent') || '').slice(0, 255),
    // Express only trusts X-Forwarded-For when `trust proxy` is set (it is, in
    // app.js), so this is the real client address behind Vercel's edge.
    ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 64),
  };
}

/**
 * Start a brand new session: a fresh family, an access token and a refresh token.
 *
 * Used by login and register — the two places a session comes into existence
 * from credentials rather than from an older token.
 */
async function issueSession(user, req) {
  const family = crypto.randomUUID();
  return issueTokens(user, family, req);
}

/**
 * Mint a token pair inside an existing (or new) family and persist the refresh
 * token's hash.
 */
async function issueTokens(user, family, req, replacesHash = null) {
  const refreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);

  await RefreshToken.create({
    tokenHash,
    user: user._id,
    family,
    expiresAt: refreshTokenExpiry(),
    ...requestMeta(req),
  });

  // Link the old record to the new one so a rotation chain can be walked when
  // investigating a reuse alert.
  if (replacesHash) {
    await RefreshToken.updateOne({ tokenHash: replacesHash }, { replacedByHash: tokenHash });
  }

  return { accessToken: signAccessToken(user), refreshToken, family };
}

/**
 * Exchange a refresh token for a new pair, rotating the old one out.
 *
 * The three failure paths are deliberately distinct in what they *do* while
 * being identical in what they *say* to the client:
 *
 *   unknown hash    - forged, or already cleaned up after expiry. Reject.
 *   already revoked - REPLAY. Someone is using a token that was consumed. We
 *                     cannot tell whether that is the legitimate user (whose
 *                     token was stolen and used first) or the thief, so the
 *                     whole family is burned and both must log in again.
 *   expired         - normal end of a week-long session. Reject.
 *
 * The client only ever sees 401, because telling it which case applied would
 * tell an attacker whether a guessed token had ever been valid.
 */
async function rotateSession(presentedToken, req) {
  const tokenHash = hashRefreshToken(presentedToken);
  const record = await RefreshToken.findOne({ tokenHash }).populate('user');

  if (!record) {
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  if (record.revokedAt) {
    await revokeFamily(record.family, 'refresh token reuse detected');
    /*
     * Worth an alert in a real deployment: either a token was stolen, or a
     * client is refreshing concurrently and has a bug. Both are investigable
     * from the user and family recorded here.
     */
    log.warn(
      { userId: record.user?._id?.toString(), family: record.family },
      'refresh token reuse detected — the entire session family was revoked'
    );
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  // A token whose user was deleted while the session was live.
  if (!record.user) {
    await revokeFamily(record.family, 'user no longer exists');
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  // Consume the presented token BEFORE issuing its replacement, so that two
  // concurrent refreshes with the same token cannot both succeed.
  record.revokedAt = new Date();
  record.revokedReason = 'rotated';
  await record.save();

  const tokens = await issueTokens(record.user, record.family, req, tokenHash);

  return { ...tokens, user: record.user };
}

/** Revoke a single refresh token. Used by logout. Unknown tokens are a no-op. */
async function revokeToken(presentedToken, reason = 'logout') {
  if (!presentedToken) return;

  await RefreshToken.updateOne(
    { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason }
  );
}

/** Revoke every live token descended from one login. */
async function revokeFamily(family, reason) {
  await RefreshToken.updateMany(
    { family, revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason }
  );
}

/**
 * Revoke every session a user has, everywhere.
 *
 * Not wired to an endpoint yet, but this is the primitive that "log out all
 * devices", a password change, and a disabled account all need — and having it
 * here is what makes those one-liners rather than redesigns.
 */
async function revokeAllForUser(userId, reason = 'all sessions revoked') {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason }
  );
}

module.exports = {
  issueSession,
  rotateSession,
  revokeToken,
  revokeFamily,
  revokeAllForUser,
};
