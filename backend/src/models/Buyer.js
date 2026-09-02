const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MAX_TAG_LENGTH, MAX_TAGS_PER_CONTACT } = require('../config/marketing');
const { marketingConsentField } = require('./marketingConsent');

const SALT_ROUNDS = 10;

/**
 * A saved shipping address on a buyer's account.
 *
 * Free-text `address`, same reasoning as `Customer.address`: delivery address
 * formats are not one shape across countries, this app only ever displays the
 * block and hands it to a courier, and there is nothing to gain from parsing
 * it into fields nobody queries by. `label` and `phone` are what make several
 * addresses on one account distinguishable and reachable — "Home" vs "Work",
 * and who to call if the courier can't find either.
 */
const addressSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      trim: true,
      required: [true, 'An address needs a label, e.g. "Home" or "Work"'],
      maxlength: [40, 'A label cannot exceed 40 characters'],
    },
    address: {
      type: String,
      trim: true,
      required: [true, 'An address cannot be blank'],
      maxlength: [500, 'An address cannot be longer than 500 characters'],
    },
    /**
     * A separate field rather than folded into the free-text `address` block
     * above, unlike the rest of it — a courier needs the city to route the
     * parcel at all, so it is the one part of a delivery address worth being
     * able to see and require independently of the free-text block. Still no
     * postcode/street/country split: see the schema comment for why the rest
     * stays one block.
     */
    city: {
      type: String,
      trim: true,
      required: [true, 'A city is required so deliveries can be routed'],
      maxlength: [100, 'City cannot exceed 100 characters'],
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { _id: true }
);

/**
 * A storefront customer's own account — entirely separate from staff.
 *
 * WHY A SEPARATE MODEL RATHER THAN A FOURTH ROLE ON `User`.
 *
 * `User` and its `role` enum are the staff permission table: every place that
 * checks `hasFullRecordAccess`, `requireManagerOrAdmin` and so on is reasoning
 * about "which of the three staff roles is this". A buyer is not a smaller
 * staff role, it is not staff at all — folding it into the same collection
 * would mean every one of those checks needed a "and not a buyer" clause added
 * by hand, forever, and the one place that got missed is a buyer looking at
 * the customer book. A separate model makes that failure mode structurally
 * impossible: nothing in `middleware/roles.js` or `usePermissions.js` can
 * accidentally grant a buyer anything, because a `Buyer` document is never the
 * `req.user` those checks read.
 *
 * Password hashing, lockout and the hardened comparison below deliberately
 * mirror `User` — a buyer's password deserves exactly the same protection a
 * staff member's does, and there is no reason the policy should differ. See
 * `utils/passwordPolicy.js`, applied the same way at the API boundary.
 */
const buyerSchema = new mongoose.Schema({
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
    minlength: [10, 'Password must be at least 10 characters'],
    select: false,
  },

  addresses: {
    type: [addressSchema],
    default: [],
  },

  /**
   * The CRM `Customer` record this buyer's orders roll up under, set the
   * first time they check out. A sales rep follows up with the `Customer`,
   * not the `Buyer` — this is what lets that happen.
   */
  linkedCustomerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null,
  },

  /**
   * Whether this address has been confirmed to actually belong to this buyer.
   *
   * DOES NOT GATE SIGN-IN OR CHECKOUT — a deliberate choice, consistent with
   * how this app already treats marketing consent as informational rather
   * than access-controlling. Blocking a freshly-registered buyer from buying
   * anything until they click a link in their inbox is a real conversion
   * cost for a storefront, and nothing here depends on the address being
   * genuine the way, say, a password-reset link's destination does. This is
   * a signal shown to the buyer (and, on the CRM side, to staff), not a lock.
   */
  emailVerified: {
    type: Boolean,
    default: false,
  },

  /** Consecutive failed logins. See User.js for why this lives on the account. */
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
   * The same consent block `Customer` carries, from the same definition.
   *
   * WHY IT IS STORED HERE TOO, RATHER THAN ONLY ON THE LINKED `Customer`.
   *
   * A buyer who has registered and not yet ordered HAS NO LINKED CUSTOMER —
   * `linkedCustomerId` is set at their first checkout — and that person can
   * still tick a consent box on the registration form. Consent with nowhere to
   * live is consent that gets lost, and the loss is silent: they agreed, the
   * checkbox looked like it worked, and nothing recorded it.
   *
   * Two records holding one person's consent raises the obvious question of
   * what happens when they disagree. Every write propagates to BOTH records so
   * that they normally cannot, and services/contactService.js reconciles the
   * legacy case by taking the most recent decision — see the long note there.
   */
  marketing: marketingConsentField(),

  /** Staff-assigned tags, the same field as on `Customer` and unioned with it. */
  marketingTags: {
    type: [String],
    default: [],
    validate: [
      {
        validator: (tags) => tags.length <= MAX_TAGS_PER_CONTACT,
        message: `A contact cannot have more than ${MAX_TAGS_PER_CONTACT} tags`,
      },
      {
        validator: (tags) =>
          tags.every((t) => typeof t === 'string' && t.length <= MAX_TAG_LENGTH),
        message: `A tag cannot be longer than ${MAX_TAG_LENGTH} characters`,
      },
    ],
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

buyerSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  return next();
});

buyerSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

// Same exponential backoff as User.js — see the long note there for why it is
// exponential rather than a flat lock, and why the backoff is capped.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 60 * 1000;
const LOCKOUT_MAX_MS = 15 * 60 * 1000;

buyerSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

buyerSchema.methods.lockRemainingSeconds = function lockRemainingSeconds() {
  if (!this.isLocked()) return 0;
  return Math.ceil((this.lockUntil.getTime() - Date.now()) / 1000);
};

/** Same atomic-$inc reasoning as User.registerFailedLogin — see that file. */
buyerSchema.methods.registerFailedLogin = async function registerFailedLogin() {
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

buyerSchema.methods.clearFailedLogins = async function clearFailedLogins() {
  const known = this.failedLoginAttempts !== undefined && this.lockUntil !== undefined;
  if (known && !this.failedLoginAttempts && !this.lockUntil) return;

  await this.constructor.findByIdAndUpdate(this._id, {
    failedLoginAttempts: 0,
    lockUntil: null,
  });
};

/** Belt-and-braces: strip the hash and lockout state from any JSON response. */
buyerSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.failedLoginAttempts;
  delete obj.lockUntil;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Buyer', buyerSchema);
