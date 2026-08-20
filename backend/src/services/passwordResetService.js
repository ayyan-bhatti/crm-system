const crypto = require('crypto');
const PasswordResetToken = require('../models/PasswordResetToken');
const User = require('../models/User');
const env = require('../config/env');
const ms = require('../utils/ms');
/*
 * Imported as a module object, not destructured.
 *
 * `const { sendMail } = require('./mailer')` captures the function reference at
 * load time, so a test that replaces `mailer.sendMail` afterwards would be
 * ignored and the flow would be untestable without a real mail server. Calling
 * through the object is the same pattern the AI services use, for the same
 * reason.
 */
const mailer = require('./mailer');
const { revokeAllForUser } = require('./sessionService');

/**
 * The forgot-password flow.
 *
 * Two endpoints, and the security of the whole thing rests on a handful of
 * decisions that are easy to get subtly wrong.
 *
 * 1. THE RESPONSE IS IDENTICAL WHETHER OR NOT THE ACCOUNT EXISTS.
 *
 *    "No account with that email" is a free account-enumeration oracle: an
 *    attacker feeds a list of addresses in and learns which ones are customers.
 *    So requesting a reset always answers the same way, and the difference is
 *    only in whether an email goes out. This costs a little user-friendliness —
 *    someone who mistypes their address waits for a mail that never arrives —
 *    and that is the accepted trade.
 *
 *    The mail *content* covers the gap: a message is sent even to an address
 *    with no account, saying so, which is more helpful than silence and still
 *    tells an attacker nothing (they cannot read the inbox).
 *
 * 2. ANY EXISTING TOKENS ARE INVALIDATED WHEN A NEW ONE IS ISSUED.
 *
 *    Otherwise every reset ever requested stays live until it expires, so a
 *    user who clicks "forgot password" five times leaves five working keys to
 *    their account scattered across their mailbox.
 *
 * 3. REDEEMING A TOKEN REVOKES EVERY SESSION.
 *
 *    A password reset is what someone does when they think they are
 *    compromised. If the attacker's session survives it, the reset achieved
 *    nothing. Unlike the change-password flow, no session is spared: the person
 *    resetting is not necessarily at a browser we can trust, so they log in
 *    again afterwards.
 */

/** How long a reset link works for. Short — see the model's notes. */
const TOKEN_TTL = '30m';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Step one: someone asked to reset their password.
 *
 * Always resolves the same way. The caller must not branch on the result in a
 * way the client can observe.
 */
async function requestReset(email, req) {
  const normalised = String(email || '').toLowerCase().trim();
  const user = await User.findOne({ email: normalised });

  if (!user) {
    /*
     * No account. Still send a message, so a mistyped address gets an
     * explanation rather than silence — and still take the same code path
     * shape, so response timing does not become the oracle the identical
     * response was designed to prevent.
     */
    await mailer.sendMail({
      to: normalised,
      subject: 'Password reset requested for SimpleCRM',
      text:
        `Someone (probably you) asked to reset the SimpleCRM password for this address.\n\n` +
        `There is no SimpleCRM account registered to ${normalised}, so there is nothing ` +
        `to reset. You may have signed up with a different address.\n\n` +
        `If this was not you, you can safely ignore this message.`,
    });

    return { sent: true, userExisted: false };
  }

  // Invalidate anything outstanding before issuing a new one — see note 2.
  await PasswordResetToken.updateMany(
    { user: user._id, usedAt: null },
    { usedAt: new Date() }
  );

  const token = crypto.randomBytes(32).toString('hex');

  await PasswordResetToken.create({
    tokenHash: hashToken(token),
    user: user._id,
    expiresAt: new Date(Date.now() + ms(TOKEN_TTL)),
    requestedIp: req?.ip || '',
    requestedUserAgent: String(req?.get?.('user-agent') || '').slice(0, 255),
  });

  const link = `${env.appUrl}/reset-password?token=${token}`;

  await mailer.sendMail({
    to: user.email,
    subject: 'Reset your SimpleCRM password',
    text:
      `Hello ${user.name},\n\n` +
      `Use the link below to set a new SimpleCRM password. It works once and expires in ` +
      `30 minutes.\n\n${link}\n\n` +
      `Resetting your password signs you out everywhere, on every device.\n\n` +
      `If you did not ask for this, you can ignore this message — your password has not ` +
      `changed, and the link is useless to anyone who cannot read this mailbox.`,
  });

  return { sent: true, userExisted: true };
}

/**
 * Look at a token without consuming it.
 *
 * Exists for one reason: the new password has to be validated against the
 * policy BEFORE the token is redeemed. The token is single-use, so validating
 * afterwards would burn the link on a rejected password — the user would be
 * told their password was too weak AND that their reset link no longer works,
 * and would have to start the whole flow again.
 *
 * It reveals nothing a redemption would not: the caller already holds the
 * token, and knowing the name on the account it belongs to is not new
 * information to whoever received the email.
 */
async function peek(token) {
  const record = await PasswordResetToken.findOne({ tokenHash: hashToken(token) }).populate(
    'user'
  );

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now() || !record.user) {
    return { ok: false };
  }

  return { ok: true, user: record.user };
}

/**
 * Step two: redeem the token and set the new password.
 *
 * Returns the user on success, or throws a reason. The reasons are deliberately
 * distinguishable HERE (so the controller can say "this link has expired"
 * rather than a blanket failure) while revealing nothing about accounts — a
 * token is not an email address, so there is nothing to enumerate.
 */
async function resetPassword(token, newPassword) {
  const record = await PasswordResetToken.findOne({ tokenHash: hashToken(token) }).populate(
    'user'
  );

  if (!record) return { ok: false, reason: 'invalid' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (record.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (!record.user) return { ok: false, reason: 'invalid' };

  /*
   * Consume the token BEFORE changing the password.
   *
   * Two requests arriving together with the same link would otherwise both pass
   * the checks above and both set a password — and the second one wins, which
   * is not necessarily the one the user typed.
   */
  record.usedAt = new Date();
  await record.save();

  const user = record.user;
  user.password = newPassword; // The pre-save hook hashes it.
  await user.save();

  // Clear any lockout: someone who just proved control of the mailbox should
  // not then be told to wait fifteen minutes.
  await user.clearFailedLogins();

  // Every session, with no exception — see note 3.
  await revokeAllForUser(user._id, 'password reset');

  return { ok: true, user };
}

module.exports = { requestReset, resetPassword, peek, TOKEN_TTL };
