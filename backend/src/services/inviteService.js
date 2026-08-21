const crypto = require('crypto');
const InviteToken = require('../models/InviteToken');
const User = require('../models/User');
const env = require('../config/env');
const ms = require('../utils/ms');
const mailer = require('./mailer');
const ApiError = require('../utils/ApiError');
const { USER_STATUS } = require('../config/constants');

/**
 * Inviting colleagues, and accepting an invitation.
 *
 * WHY INVITES REPLACED OPEN SIGN-UP
 *
 * This is an internal CRM. Anyone who could reach the registration page could
 * create themselves an account and see the customer list — the role assigned
 * (`sales_rep`) limited the blast radius but did not stop the account existing.
 * For a tool whose users are employees, the correct model is that an
 * administrator decides who has access, not the person asking.
 *
 * WHAT AN INVITE DOES AND DOES NOT DO
 *
 * It creates the account immediately, in `pending`, with **no password**. That
 * matters: the account exists (so it shows in the admin's list, holds its role,
 * and reserves the email address) but cannot authenticate, because
 * `comparePassword` refuses an account with no password and `login` refuses a
 * non-active status. The invitee sets the password themselves, so it is never
 * transmitted, never known to the admin, and never needs a "change this on
 * first login" convention that everyone ignores.
 */

/** Long enough to survive a holiday — see the note in models/InviteToken. */
const TOKEN_TTL = '7d';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Invite someone, or re-invite a pending user.
 *
 * @returns {Promise<{ user: object, resent: boolean }>}
 */
async function inviteUser({ name, email, role }, invitedBy) {
  const normalised = String(email || '').toLowerCase().trim();

  if (!name || !normalised) {
    throw ApiError.badRequest('A name and email address are required');
  }

  const existing = await User.findOne({ email: normalised });

  /*
   * An existing ACTIVE or DEACTIVATED account is a conflict, but a PENDING one
   * is a re-send.
   *
   * Re-sending is the common case in practice — the first invite went to spam,
   * or was sent before the person's start date. Treating it as a duplicate
   * would force the admin to delete the account and recreate it, losing the
   * role they had already chosen.
   */
  if (existing && existing.status !== USER_STATUS.PENDING) {
    throw ApiError.conflict('An account with that email already exists');
  }

  const user =
    existing ||
    (await User.create({
      name,
      email: normalised,
      role,
      status: USER_STATUS.PENDING,
      invitedBy: invitedBy?._id ?? null,
      // No password. See the note at the top.
    }));

  // A re-invite may also be correcting the name or role.
  if (existing) {
    user.name = name;
    if (role) user.role = role;
    await user.save();
  }

  /*
   * Any outstanding invite for this person is invalidated first, so a re-send
   * does not leave two working links in two different inboxes.
   */
  await InviteToken.updateMany({ user: user._id, usedAt: null }, { usedAt: new Date() });

  const token = crypto.randomBytes(32).toString('hex');

  await InviteToken.create({
    tokenHash: hashToken(token),
    user: user._id,
    invitedBy: invitedBy?._id ?? null,
    expiresAt: new Date(Date.now() + ms(TOKEN_TTL)),
  });

  const link = `${env.appUrl}/accept-invite?token=${token}`;

  const delivery = await mailer.sendMail({
    to: user.email,
    subject: 'You have been invited to SimpleCRM',
    text:
      `Hello ${user.name},\n\n` +
      `${invitedBy?.name || 'An administrator'} has invited you to SimpleCRM as a ` +
      `${String(user.role).replace('_', ' ')}.\n\n` +
      `Use the link below to choose a password and activate your account. It works once ` +
      `and expires in 7 days.\n\n${link}\n\n` +
      `If you were not expecting this, you can ignore this message — the account cannot ` +
      `be used until someone sets a password through this link.`,
  });

  /*
   * WHETHER THE INVITEE ACTUALLY RECEIVED ANYTHING.
   *
   * The console transport reports `delivered: true`, which is honest about what
   * it did — it wrote the message somewhere real — but it is not the same thing
   * as mail arriving in someone's inbox. The caller needs to tell those apart,
   * because it previously did not: the endpoint answered "Invitation sent" on a
   * deployment with no mail provider configured, so the admin had every reason
   * to believe an email was on its way and the invitee waited for one that was
   * never going to come.
   *
   * `emailed` is therefore the narrower claim: a transport that leaves the
   * building said it succeeded.
   */
  const emailed = delivery.delivered && delivery.transport !== 'console';

  return { user, resent: Boolean(existing), emailed, transport: delivery.transport, link };
}

/**
 * Look at an invite token without consuming it.
 *
 * The accept page uses this to greet the invitee by name and show which role
 * they are accepting, and the controller uses it to validate the chosen
 * password before redeeming — the token is single use, so validating afterwards
 * would burn the invite on a password the policy rejected.
 */
async function peek(token) {
  const record = await InviteToken.findOne({ tokenHash: hashToken(token) }).populate('user');

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now() || !record.user) {
    return { ok: false };
  }

  // An invite for an account that has since been deactivated is not acceptable.
  if (record.user.status === USER_STATUS.DEACTIVATED) return { ok: false };

  return { ok: true, user: record.user };
}

/**
 * Redeem an invite: set the password and activate the account.
 *
 * Reasons are distinguishable here so the UI can say "this invite has expired"
 * rather than a blanket failure. Unlike the request side of a password reset
 * there is nothing to enumerate — a token is not an email address.
 */
async function acceptInvite(token, password) {
  const record = await InviteToken.findOne({ tokenHash: hashToken(token) }).populate('user');

  if (!record) return { ok: false, reason: 'invalid' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (record.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (!record.user) return { ok: false, reason: 'invalid' };
  if (record.user.status === USER_STATUS.DEACTIVATED) {
    return { ok: false, reason: 'deactivated' };
  }

  /*
   * Consume the token BEFORE setting the password, so two requests arriving
   * together with the same link cannot both succeed — otherwise the second
   * one's password wins, which is not necessarily the one the user typed.
   */
  record.usedAt = new Date();
  await record.save();

  const user = record.user;
  user.password = password; // The pre-save hook hashes it.
  user.status = USER_STATUS.ACTIVE;
  await user.save();

  return { ok: true, user };
}

module.exports = { inviteUser, acceptInvite, peek, TOKEN_TTL };
