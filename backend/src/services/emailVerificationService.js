const crypto = require('crypto');
const EmailVerificationToken = require('../models/EmailVerificationToken');
const User = require('../models/User');
const Buyer = require('../models/Buyer');
const ms = require('../utils/ms');
const mailer = require('./mailer');
const { publicUrl } = require('../utils/publicUrl');

/**
 * Confirming that the address on a staff or buyer account is one they
 * actually control — shared by both tracks; see EmailVerificationToken's
 * own note on why one model and one service serve both rather than two.
 *
 * DOES NOT GATE ANYTHING. See the `emailVerified` field's own comment on
 * `User`/`Buyer` for why this is a signal rather than a lock — nothing in
 * `middleware/auth.js` or `middleware/buyerAuth.js` checks it, on purpose.
 */

const TOKEN_TTL = '7d';
const MODELS = { user: User, buyer: Buyer };
const LINK_PATH = { user: '/crm/verify-email', buyer: '/verify-email' };

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a token and email the link. Fire-and-forget from the caller's point
 * of view — registration must succeed whether or not mail delivery does, so
 * this never throws; a failure is logged by `mailer.sendMail` itself, which
 * already never throws either.
 *
 * @param {'user'|'buyer'} accountType
 * @param {{ _id, name, email }} account
 * @param {import('express').Request} [req] for building an absolute link
 */
async function sendVerificationEmail(accountType, account, req) {
  const token = crypto.randomBytes(32).toString('hex');

  await EmailVerificationToken.create({
    tokenHash: hashToken(token),
    accountType,
    accountId: account._id,
    expiresAt: new Date(Date.now() + ms(TOKEN_TTL)),
  });

  const link = publicUrl(req, `${LINK_PATH[accountType]}?token=${token}`);

  await mailer.sendMail({
    to: account.email,
    subject: 'Confirm your email address',
    text:
      `Hello ${account.name},\n\n` +
      `Confirm this is your email address by following the link below. It works once ` +
      `and expires in 7 days.\n\n${link}\n\n` +
      `Nothing about your account changes if you don't — this is a confirmation, not a ` +
      `requirement to use it.`,
  });
}

/**
 * Look at a token without consuming it — the GET half of the verify flow.
 *
 * Same reasoning as `unsubscribeService`'s split: a mail client or a
 * security scanner can and does prefetch links in an email before a human
 * ever clicks one, and a GET that verifies-on-load would let that prefetch
 * silently consume the one-time token. GET only reports whether the token is
 * currently valid; `verify()` below is the POST that actually acts on it.
 */
async function peek(token) {
  const record = await EmailVerificationToken.findOne({ tokenHash: hashToken(token) });

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    return { ok: false };
  }

  return { ok: true, accountType: record.accountType };
}

/** Redeem the token and mark the account verified. */
async function verify(token) {
  const record = await EmailVerificationToken.findOne({ tokenHash: hashToken(token) });

  if (!record) return { ok: false, reason: 'invalid' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (record.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const Model = MODELS[record.accountType];
  const account = await Model.findById(record.accountId);
  if (!account) return { ok: false, reason: 'invalid' };

  /*
   * Consume before writing the flag — the same ordering `passwordResetService`
   * uses, and for the same reason: two requests racing on the same link must
   * not both pass the checks above.
   */
  record.usedAt = new Date();
  await record.save();

  // Already verified is not an error — a second click of the same link (or a
  // link opened in two tabs) is a no-op, not a failure.
  if (!account.emailVerified) {
    account.emailVerified = true;
    await account.save();
  }

  return { ok: true, accountType: record.accountType, account };
}

/**
 * Ask for a fresh link — used when the old one expired, or never arrived.
 *
 * Invalidates anything outstanding first, same as a password-reset request,
 * so a person mashing "resend" does not scatter several live tokens.
 */
async function resend(accountType, account, req) {
  await EmailVerificationToken.updateMany(
    { accountType, accountId: account._id, usedAt: null },
    { usedAt: new Date() }
  );

  await sendVerificationEmail(accountType, account, req);
}

module.exports = { sendVerificationEmail, peek, verify, resend, TOKEN_TTL };
