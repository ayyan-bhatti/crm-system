const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const {
  ROLES,
  ROLE_VALUES,
  USER_STATUS,
  USER_STATUS_VALUES,
  REQUESTABLE_ROLES,
} = require('../config/constants');

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
    /*
     * NOT required, because an invited user exists before they have one.
     *
     * The invite flow creates the account in `pending` with no password at all,
     * and the accept-invite step sets it. A required field would force a
     * placeholder value here — and a placeholder password is a real password
     * until someone proves otherwise, which is exactly the kind of thing that
     * turns into an incident. `select: false` plus the login guard below means
     * an account with no password simply cannot authenticate.
     */
    required: false,
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

  /**
   * Account lifecycle — see USER_STATUS in config/constants.
   *
   * Enforced in three places, because any one of them alone leaves a hole:
   *   login       a deactivated or pending account cannot obtain a session
   *   protect     an EXISTING session stops working on the next request, so
   *               deactivating someone takes effect immediately rather than
   *               whenever their token happens to expire
   *   the UI      hides the controls, which is courtesy rather than security
   */
  status: {
    type: String,
    enum: {
      values: USER_STATUS_VALUES,
      message: `Status must be one of: ${USER_STATUS_VALUES.join(', ')}`,
    },
    default: USER_STATUS.ACTIVE,
  },

  /** Who invited this user, for the pending-invite list. */
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  /**
   * The role this person asked for when they signed up.
   *
   * Set only on a self-service SIGN-UP, never on an invite, which is what
   * distinguishes the two kinds of `pending` account: an invited user has no
   * password and no requested role, a sign-up has both. The login screen needs
   * that distinction, because "use your invitation link" and "awaiting
   * approval" send someone to two completely different places.
   *
   * It is a REQUEST and never a grant. `role` is what the person actually has,
   * and stays at the least-privileged default until an admin approves them —
   * approving is what copies this across, and the admin may choose a different
   * role instead. Storing the request separately is what lets the approval
   * screen show "asked for manager" next to the decision.
   *
   * Kept after approval rather than cleared, so the trail still answers "what
   * did they ask for" months later.
   */
  requestedRole: {
    type: String,
    enum: {
      values: [...REQUESTABLE_ROLES, null],
      message: `A requested role must be one of: ${REQUESTABLE_ROLES.join(', ')}`,
    },
    default: null,
  },

  /** When an admin approved or rejected the request, and who did it. */
  reviewedAt: {
    type: Date,
    default: null,
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
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
  // A pending invite has no password yet, and hashing `undefined` would throw.
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  return next();
});

/** Compare a plaintext login attempt against the stored hash. */
userSchema.methods.comparePassword = function comparePassword(candidate) {
  /*
   * An account with no password can never match one.
   *
   * bcrypt.compare(x, undefined) rejects rather than returning false, which
   * would surface as a 500 on a perfectly ordinary login attempt against a
   * pending invite. Answering `false` is both correct and the same answer a
   * wrong password gives, so it reveals nothing about the account's state.
   */
  if (!this.password) return Promise.resolve(false);
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

/** Can this account be used to sign in at all? */
userSchema.methods.canSignIn = function canSignIn() {
  return this.status === USER_STATUS.ACTIVE;
};

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
 * Clear the counters after a successful sign-in, or a password reset.
 *
 * Skipped only when the fields were actually loaded AND are already clear, so
 * the overwhelmingly common case — a correct password — costs no extra write.
 *
 * The distinction between "loaded and zero" and "not loaded" matters more than
 * it looks. `failedLoginAttempts` and `lockUntil` are `select: false`, so a
 * document fetched without them has `undefined` in both. A truthiness check
 * (`if (!this.failedLoginAttempts && !this.lockUntil) return`) cannot tell that
 * apart from "already clear" and silently does nothing — which is exactly what
 * happened on the password-reset path, where the user arrives via `populate()`
 * and a locked-out account stayed locked after a successful reset.
 *
 * Comparing explicitly means an unloaded field falls through to the write,
 * which is the safe direction: at worst one redundant update.
 */
userSchema.methods.clearFailedLogins = async function clearFailedLogins() {
  const known = this.failedLoginAttempts !== undefined && this.lockUntil !== undefined;
  if (known && !this.failedLoginAttempts && !this.lockUntil) return;

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
