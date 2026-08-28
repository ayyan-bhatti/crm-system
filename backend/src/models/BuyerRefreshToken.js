const mongoose = require('mongoose');

/**
 * The buyer-track equivalent of `RefreshToken`.
 *
 * A DELIBERATE DUPLICATE, NOT A SHARED COLLECTION.
 *
 * The obvious reuse move is a `refPath` on `RefreshToken.user`, the same
 * technique used on `ChangeRequest.requestedBy` in this same round of work.
 * It was rejected here on purpose: refresh-token rotation and reuse detection
 * is the single most security-sensitive piece of machinery in this app, and
 * the buyer and staff tracks are meant to be fully independent (distinct
 * cookies, distinct paths, distinct middleware — see the buyer-auth build-log
 * entry). Threading a second actor type through the staff session store would
 * mean every future change to staff session logic has to be re-reasoned about
 * for buyers too, and a bug in one track's rotation could revoke or leak
 * sessions in the other. A second, identically-shaped collection costs a
 * little duplication and buys genuine isolation: a defect in buyer auth
 * cannot touch a staff session, and vice versa.
 *
 * Every field below has the same meaning as the corresponding field in
 * `RefreshToken.js` — see that file for the full reasoning on hashing,
 * rotation and family-based reuse detection, which applies unchanged here.
 */
const buyerRefreshTokenSchema = new mongoose.Schema({
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    required: true,
    index: true,
  },
  family: {
    type: String,
    required: true,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  revokedAt: {
    type: Date,
    default: null,
  },
  revokedReason: {
    type: String,
    default: null,
  },
  replacedByHash: {
    type: String,
    default: null,
  },
  userAgent: { type: String, default: '' },
  ip: { type: String, default: '' },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

buyerRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('BuyerRefreshToken', buyerRefreshTokenSchema);
