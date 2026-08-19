const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES, ROLE_VALUES } = require('../config/constants');

const SALT_ROUNDS = 10;

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    // Backstop for documents created directly through the model (the seed
    // script, test factories). The real policy — length, blocklist, and not
    // being derived from the account — is enforced at the API boundary in
    // utils/passwordPolicy.js, because only there do we know the user's name
    // and email to check the password against.
    minlength: [10, 'Password must be at least 10 characters'],
    // Never ship the hash to a client by accident: it must be asked for
    // explicitly with .select('+password'), which only the login flow does.
    select: false,
  },
  role: {
    type: String,
    enum: {
      values: ROLE_VALUES,
      message: `Role must be one of: ${ROLE_VALUES.join(', ')}`,
    },
    default: ROLES.SALES_REP,
  },

  /*
   * ---------------------------------------------------------------------
   * Failed-login tracking, for the account lockout.
   *
   * WHY ON THE USER RATHER THAN IN THE RATE LIMITER
   *
   * The per-IP limiter in middleware/rateLimit.js counts requests from one
   * address. An attacker with a botnet defeats that trivially: a thousand
   * addresses each making five attempts never trips it, while the account
   * under attack absorbs five thousand guesses. Counting on the *account*
   * instead follows the thing being attacked, no matter where the traffic
   * comes from.
   *
   * Storing it here also means it survives a serverless instance being
   * recycled, which an in-memory counter would not.
   * ---------------------------------------------------------------------
   */

  /** Consecutive failures. Reset to 0 by any successful sign-in. */
  failedLoginAttempts: {
    type: Number,
    default: 0,
    select: false,
  },
  /** While this is in the future, sign-in is refused outright. */
  lockUntil: {
    type: Date,
    default: null,
    select: false,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Hash the password before saving.
 *
 * Guarded by isModified so that updating a user's name doesn't re-hash an
 * already-hashed password (which would lock the account out).
 */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  return next();
});

/** Compare a plaintext login attempt against the stored hash. */
userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

/**
 * Lockout policy.
 *
 * The first few failures cost nothing — people mistype passwords. From the
 * fifth consecutive failure onwards each one doubles the wait:
 *
 *   attempt 5  ->  1 minute      attempt 8  ->  8 minutes
 *   attempt 6  ->  2 minutes     attempt 9+ -> 15 minutes (capped)
 *   attempt 7  ->  4 minutes
 *
 * Exponential rather than a flat lock because the two failure modes pull in
 * opposite directions. A flat 15-minute lock after 5 tries punishes the real
 * user who genuinely forgot their password just as hard as an attacker. Backoff
 * barely inconveniences someone on their fifth try but makes sustained guessing
 * arithmetically hopeless — an attacker gets roughly four attempts an hour once
 * the cap is reached.
 *
 * The cap exists so the account is never permanently bricked by someone else
 * deliberately failing logins against it. That is the denial-of-service risk
 * every lockout scheme carries, and an uncapped backoff turns it into a way to
 * lock a competitor out of their own CRM forever.
 */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 60 * 1000;
const LOCKOUT_MAX_MS = 15 * 60 * 1000;

/** True while the account is inside a lockout window. */
userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

/** Seconds until the lock lifts — what the client needs in order to tell the user. */
userSchema.methods.lockRemainingSeconds = function lockRemainingSeconds() {
  if (!this.isLocked()) return 0;
  return Math.ceil((this.lockUntil.getTime() - Date.now()) / 1000);
};

/**
 * Record a failed sign-in and apply the backoff.
 *
 * Written with an atomic $inc rather than read-modify-write so that several
 * simultaneous guesses each count. Reading the value into JavaScript and
 * writing it back would let a burst of parallel attempts all read "4" and all
 * write "5", turning a hundred guesses into one recorded failure — which is
 * exactly the traffic pattern this is supposed to catch.
 */
userSchema.methods.registerFailedLogin = async function registerFailedLogin() {
  const { failedLoginAttempts: attempts } = await this.constructor
    .findByIdAndUpdate(this._id, { $inc: { failedLoginAttempts: 1 } }, { new: true })
    .select('+failedLoginAttempts');

  if (attempts < LOCKOUT_THRESHOLD) return { attempts, lockedForSeconds: 0 };

  const backoff = Math.min(
    LOCKOUT_BASE_MS * 2 ** (attempts - LOCKOUT_THRESHOLD),
    LOCKOUT_MAX_MS
  );
  const lockUntil = new Date(Date.now() + backoff);

  await this.constructor.findByIdAndUpdate(this._id, { lockUntil });

  return { attempts, lockedForSeconds: Math.ceil(backoff / 1000) };
};

/**
 * Clear the counters after a successful sign-in.
 *
 * Skipped when there is nothing to clear, so the overwhelmingly common case —
 * a correct password — costs no extra write.
 */
userSchema.methods.clearFailedLogins = async function clearFailedLogins() {
  if (!this.failedLoginAttempts && !this.lockUntil) return;

  await this.constructor.findByIdAndUpdate(this._id, {
    failedLoginAttempts: 0,
    lockUntil: null,
  });
};

/** Belt-and-braces: strip the hash from any JSON representation of a user. */
userSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.password;
  // Lockout state is internal bookkeeping, not something a client should see —
  // and exposing it would tell an attacker exactly how close they are.
  delete obj.failedLoginAttempts;
  delete obj.lockUntil;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
