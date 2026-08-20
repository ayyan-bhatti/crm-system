const mongoose = require('mongoose');

/**
 * A one-time password-reset token.
 *
 * Shaped almost exactly like RefreshToken, and for the same reasons — worth
 * reading that model's notes too. The differences are the ones that matter for
 * a reset link:
 *
 *   SHORT LIFETIME (30 minutes). A reset link is a bearer credential that
 *   bypasses the password entirely, and it travels through email — which is
 *   stored, forwarded, synced to phones and often not encrypted at rest. The
 *   window in which a leaked link is useful should be minutes, not days.
 *
 *   SINGLE USE. `usedAt` is stamped the moment it is redeemed. Without it, a
 *   link sitting in an inbox stays a working key to the account for its whole
 *   lifetime, and anyone who later reads that mailbox can take the account over.
 *
 *   HASHED, like the refresh token. If this collection leaked, plaintext tokens
 *   would be live account-takeover links for every pending reset.
 */
const passwordResetTokenSchema = new mongoose.Schema({
  /** SHA-256 hex digest of the token that went into the email. */
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  /** Set when redeemed. A token with this set can never be used again. */
  usedAt: {
    type: Date,
    default: null,
  },
  /** Request metadata for the request that ASKED for the reset. */
  requestedIp: { type: String, default: '' },
  requestedUserAgent: { type: String, default: '' },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Expired tokens are removed automatically. Unlike the audit log, there is
 * nothing to investigate here — a used or expired reset token is dead weight,
 * and keeping it only prolongs the window in which a leaked database is useful.
 *
 * An hour past expiry rather than exactly at it, so that a user clicking a
 * just-expired link gets "this link has expired" rather than a generic
 * "invalid link", which reads like the system is broken.
 */
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
