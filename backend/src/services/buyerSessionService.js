const crypto = require('crypto');
const BuyerRefreshToken = require('../models/BuyerRefreshToken');
const { componentLogger } = require('../config/logger');

const log = componentLogger('shop-auth');
const ApiError = require('../utils/ApiError');
const {
  signBuyerAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
} = require('../utils/token');

/**
 * The buyer-track equivalent of `services/sessionService.js` — same rotation
 * and reuse-detection design, applied to `Buyer`/`BuyerRefreshToken` instead
 * of `User`/`RefreshToken`. See that file for the full reasoning; nothing
 * about the design differs here, only which collection it is applied to (see
 * `models/BuyerRefreshToken.js` for why that is a second collection rather
 * than a shared one).
 */

function requestMeta(req) {
  return {
    userAgent: String(req.get('user-agent') || '').slice(0, 255),
    ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 64),
  };
}

async function issueBuyerSession(buyer, req) {
  const family = crypto.randomUUID();
  return issueBuyerTokens(buyer, family, req);
}

async function issueBuyerTokens(buyer, family, req, replacesHash = null) {
  const refreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);

  await BuyerRefreshToken.create({
    tokenHash,
    buyer: buyer._id,
    family,
    expiresAt: refreshTokenExpiry(),
    ...requestMeta(req),
  });

  if (replacesHash) {
    await BuyerRefreshToken.updateOne(
      { tokenHash: replacesHash },
      { replacedByHash: tokenHash }
    );
  }

  return { accessToken: signBuyerAccessToken(buyer), refreshToken, family };
}

async function rotateBuyerSession(presentedToken, req) {
  const tokenHash = hashRefreshToken(presentedToken);
  const record = await BuyerRefreshToken.findOne({ tokenHash }).populate('buyer');

  if (!record) {
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  if (record.revokedAt) {
    await revokeBuyerFamily(record.family, 'refresh token reuse detected');
    log.warn(
      { buyerId: record.buyer?._id?.toString(), family: record.family },
      'buyer refresh token reuse detected — the entire session family was revoked'
    );
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  if (!record.buyer) {
    await revokeBuyerFamily(record.family, 'buyer no longer exists');
    throw ApiError.unauthorized('Session expired. Please sign in again.');
  }

  record.revokedAt = new Date();
  record.revokedReason = 'rotated';
  await record.save();

  const tokens = await issueBuyerTokens(record.buyer, record.family, req, tokenHash);

  return { ...tokens, buyer: record.buyer };
}

async function revokeBuyerToken(presentedToken, reason = 'logout') {
  if (!presentedToken) return;

  await BuyerRefreshToken.updateOne(
    { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason }
  );
}

async function revokeBuyerFamily(family, reason) {
  await BuyerRefreshToken.updateMany(
    { family, revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason }
  );
}

async function revokeAllForBuyer(buyerId, reason = 'all sessions revoked') {
  await BuyerRefreshToken.updateMany(
    { buyer: buyerId, revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason }
  );
}

module.exports = {
  issueBuyerSession,
  rotateBuyerSession,
  revokeBuyerToken,
  revokeBuyerFamily,
  revokeAllForBuyer,
};
