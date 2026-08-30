const mongoose = require('mongoose');

/**
 * An email address someone typed into the storefront footer.
 *
 * WHAT THIS IS AND, MORE IMPORTANTLY, IS NOT
 *
 * It is a stored address. It is NOT a subscription: nothing here talks to an
 * email service provider, nothing sends, and no confirmation is requested. The
 * brief asked for the form to capture and store the address without connecting
 * a provider, so that is exactly what this does and the limit is written down
 * here rather than left for someone to discover by waiting for an email that
 * never arrives.
 *
 * If a provider is ever wired up, the missing piece is double opt-in — storing
 * an address someone typed is not consent to mail it, and a `confirmedAt` field
 * plus a token flow is what would have to arrive with the integration.
 *
 * The address is lowercased and unique, so the same person signing up three
 * times leaves one row rather than three. That is enforced by the index rather
 * than by a find-then-insert, because two submissions racing is a real thing on
 * a double-clicked button.
 */
const newsletterSignupSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'An email address is required'],
    trim: true,
    lowercase: true,
    unique: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'That does not look like an email address'],
  },
  /** Where on the site it was typed, so the footer and a future modal are distinguishable. */
  source: {
    type: String,
    trim: true,
    default: 'footer',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('NewsletterSignup', newsletterSignupSchema);
