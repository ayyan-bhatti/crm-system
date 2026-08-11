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
    minlength: [8, 'Password must be at least 8 characters'],
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

/** Belt-and-braces: strip the hash from any JSON representation of a user. */
userSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
