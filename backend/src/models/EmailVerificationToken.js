const mongoose = require('mongoose');

/**
 * A one-time email-verification token — shaped almost exactly like
 * `PasswordResetToken`, and for the same reasons (hashed, single-use,
 * auto-expiring); see that model's notes for the full rationale.
 *
 * ONE MODEL FOR BOTH ACCOUNT KINDS, RATHER THAN A SECOND COPY FOR `Buyer`.
 *
 * `accountType` + `accountId` stand in for a single `ref`, because Mongoose
 * refs point at one collection. The alternative — a `BuyerEmailVerification
 * Token` model duplicating every field and every line of
 * `emailVerificationService.js` — would be the same logic maintained twice,
 * which is exactly how the two tracks would eventually drift (one gets a
 * bug fix, the other does not, and nobody notices until a buyer reports it).
 *
 * Longer-lived than a password reset (7 days, not 30 minutes) because this
 * token cannot do anything on its own — it only flips an informational flag,
 * never a password, never a session — so there is no urgency pushing its
 * window down to minutes.
 */
const emailVerificationTokenSchema = new mongoose.Schema({
  /** SHA-256 hex digest of the token that went into the email. */
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  accountType: {
    type: String,
    enum: ['user', 'buyer'],
    required: true,
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
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
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/** Expired tokens are removed automatically — see PasswordResetToken's note. */
emailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('EmailVerificationToken', emailVerificationTokenSchema);
