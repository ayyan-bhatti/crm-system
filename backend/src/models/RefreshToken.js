const mongoose = require('mongoose');

/**
 * A server-side record of one issued refresh token.
 *
 * WHY THIS COLLECTION EXISTS
 *
 * Access tokens are stateless JWTs: fast to verify, but impossible to revoke
 * before they expire. That is an acceptable trade-off only because they live
 * for minutes. The long-lived half of the session therefore has to be
 * stateful — logging out, or detecting a stolen token, means deleting or
 * marking a row here, and the next refresh attempt fails immediately.
 *
 * WHAT IS STORED
 *
 * Never the token itself, only its SHA-256 hash. A refresh token is a
 * password-equivalent credential: anyone holding one can mint access tokens for
 * a week. If the database leaked, plaintext tokens would hand over every live
 * session; hashes are useless to an attacker. SHA-256 rather than bcrypt is
 * correct here because the token is 32 bytes of CSPRNG output, not a
 * human-chosen password — there is no dictionary to attack, so the slow hash
 * would only cost latency on every refresh.
 *
 * ROTATION AND FAMILIES
 *
 * Every refresh consumes the presented token and issues a new one
 * (`replacedBy` links the two). All tokens descended from one login share a
 * `family` id. If a token that was already used is presented again, either the
 * user's copy or a thief's copy is being replayed — we cannot tell which, so
 * the entire family is revoked and both parties are forced to log in again.
 * This is the standard "refresh token reuse detection" defence: stealing a
 * token buys an attacker access only until the real user next refreshes.
 */
const refreshTokenSchema = new mongoose.Schema({
  /** SHA-256 hex digest of the token handed to the client. */
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
  /**
   * Groups every token descended from a single login, so reuse detection can
   * revoke a whole session rather than one link in the chain.
   */
  family: {
    type: String,
    required: true,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  /** Set when the token is rotated away, revoked, or its family is burned. */
  revokedAt: {
    type: Date,
    default: null,
  },
  /** Why it was revoked — useful when reading an audit trail later. */
  revokedReason: {
    type: String,
    default: null,
  },
  /** Hash of the token issued in its place, for tracing a rotation chain. */
  replacedByHash: {
    type: String,
    default: null,
  },
  /** Request metadata, purely diagnostic ("where was this session opened?"). */
  userAgent: { type: String, default: '' },
  ip: { type: String, default: '' },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Let MongoDB delete expired rows for us.
 *
 * Without this the collection grows forever: every login and every refresh adds
 * a document that stops being interesting the moment it expires. `expireAfterSeconds: 0`
 * means "remove the document once the date in expiresAt has passed".
 */
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
