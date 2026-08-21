const mongoose = require('mongoose');

/**
 * A single-use invitation token.
 *
 * Deliberately the same shape as PasswordResetToken — hashed, single-use,
 * expiring — because it is the same kind of credential: a link in an email that
 * grants control of an account to whoever holds it. Reusing the pattern means
 * one set of rules to reason about rather than two that drift.
 *
 * THE ONE DIFFERENCE THAT MATTERS: THE TTL
 *
 * A password reset lasts 30 minutes, because the person asked for it seconds
 * ago and is sitting at their inbox waiting. An invite is sent to someone who
 * may be on holiday, may not start until Monday, and did not ask for it — so it
 * lasts 7 days.
 *
 * That longer window is why the rest of the design has to be tight: single use,
 * hashed at rest, invalidated when a new invite is issued for the same person,
 * and revoked outright if the pending account is deleted.
 */
const inviteTokenSchema = new mongoose.Schema({
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
  /** The admin or manager who sent it — shown on the pending-invites list. */
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  /** Stamped on acceptance. A token with this set can never be used again. */
  usedAt: {
    type: Date,
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Expired invites are cleaned up automatically — an hour past expiry rather
 * than exactly at it, so someone clicking a just-expired link gets "this invite
 * has expired" rather than a generic "invalid link", which reads like a bug.
 *
 * Note this removes the TOKEN, not the pending user account. That is
 * deliberate: the account stays in the admin's list as an un-accepted invite
 * they can re-send or delete, rather than silently vanishing.
 */
inviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('InviteToken', inviteTokenSchema);
