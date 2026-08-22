const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { recordAudit } = require('../services/auditService');
const mailer = require('../services/mailer');
const { publicUrl } = require('../utils/publicUrl');
const { componentLogger } = require('../config/logger');
const inviteService = require('../services/inviteService');
const { revokeAllForUser } = require('../services/sessionService');
const { ROLE_VALUES, ROLES, USER_STATUS } = require('../config/constants');
const { containsRegex } = require('../utils/queryHelpers');

const log = componentLogger('users');

/**
 * User management. Every route in this controller is admin-only — that
 * restriction is applied once in routes/userRoutes.js rather than repeated here.
 */

/**
 * GET /api/users
 * Supports `?role=` and `?search=` (name or email).
 *
 * Note: managers and sales reps are allowed to call GET /api/users/assignable
 * instead (see below), because assigning a customer to a colleague requires
 * knowing who your colleagues are.
 */
const listUsers = asyncHandler(async (req, res) => {
  const { role, search } = req.query;
  const filter = {};

  if (role) filter.role = role;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const users = await User.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, count: users.length, data: users });
});

/**
 * GET /api/users/assignable?search=
 *
 * A trimmed list (id + name + role only) for populating "assigned to" pickers.
 * Available to any authenticated user — it exposes no sensitive fields.
 *
 * ONLY ACTIVE ACCOUNTS.
 *
 * A deactivated colleague cannot sign in, so work assigned to them lands in a
 * list nobody opens — which looks exactly like the work being handled, and is
 * the opposite. Pending accounts are excluded for the same reason: the person
 * has not set a password yet. Offering names that the write endpoints then
 * refuse would be a picker whose options are partly decorative.
 *
 * `?search=` narrows by name or email so the picker can query the server rather
 * than pulling down every colleague and filtering in the browser. Capped,
 * because a picker only ever displays a handful and an uncapped list grows with
 * the company.
 */
const listAssignableUsers = asyncHandler(async (req, res) => {
  const { search } = req.query;

  const filter = { status: USER_STATUS.ACTIVE };

  if (search) {
    const rx = containsRegex(search);
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const users = await User.find(filter).select('name email role').sort({ name: 1 }).limit(25);

  res.json({ success: true, count: users.length, data: users });
});

/** GET /api/users/:id */
const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, data: user });
});

/**
 * POST /api/users
 * Admin-created accounts, where specifying the role IS allowed.
 */
const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    throw ApiError.badRequest('Name, email and password are required');
  }
  if (role && !ROLE_VALUES.includes(role)) {
    throw ApiError.badRequest(`Role must be one of: ${ROLE_VALUES.join(', ')}`);
  }

  const user = await User.create({ name, email, password, role });

  // The password hash is stripped by the audit service's redaction list — an
  // audit trail is read by administrators and never overwritten, which makes it
  // exactly the wrong place to accumulate credentials.
  await recordAudit(req, { action: 'create', entity: 'user', entityId: user._id, after: user });

  res.status(201).json({ success: true, data: user });
});

/**
 * PATCH /api/users/:id
 * Updates name, email, role and/or password.
 */
const updateUser = asyncHandler(async (req, res) => {
  const { name, email, role, password } = req.body;

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  if (role && !ROLE_VALUES.includes(role)) {
    throw ApiError.badRequest(`Role must be one of: ${ROLE_VALUES.join(', ')}`);
  }

  // Role changes are the single most security-relevant write in the app —
  // "who made this person an admin, and when" is the question this answers.
  const before = user.toObject();

  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = email;
  if (role !== undefined) user.role = role;
  // Assigning here (rather than findByIdAndUpdate) keeps the pre-save hook in
  // play, so the new password is hashed.
  if (password !== undefined) user.password = password;

  await user.save();

  await recordAudit(req, {
    action: 'update',
    entity: 'user',
    entityId: user._id,
    before,
    after: user,
  });

  res.json({ success: true, data: user });
});

/**
 * DELETE /api/users/:id
 * Blocks self-deletion, which would otherwise let the last admin lock everyone
 * out of user management.
 */
const deleteUser = asyncHandler(async (req, res) => {
  if (req.params.id === req.user._id.toString()) {
    throw ApiError.badRequest('You cannot delete your own account');
  }

  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  await recordAudit(req, {
    action: 'delete',
    entity: 'user',
    entityId: user._id,
    label: user.name,
    before: user,
  });

  res.json({ success: true, message: 'User deleted', data: { id: req.params.id } });
});

/** Escape user input before it is embedded in a RegExp. */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * POST /api/users/invite — admin and manager.
 *
 * Creates the account in `pending` with no password and emails a single-use
 * link. See services/inviteService for why the account exists before the
 * password does.
 *
 * MANAGERS MAY INVITE, BUT NOT AS ADMIN.
 *
 * Managers run teams and are the people who actually know when someone joins,
 * so requiring an admin for every hire makes the admin a bottleneck on
 * onboarding. Letting a manager mint an admin, though, would be a privilege
 * escalation dressed up as a convenience feature — a manager who can create an
 * admin account is an admin. So the role they may grant is capped.
 */
const inviteUserHandler = asyncHandler(async (req, res) => {
  const { name, email, role } = req.body;

  if (role && !ROLE_VALUES.includes(role)) {
    throw ApiError.badRequest(`Role must be one of: ${ROLE_VALUES.join(', ')}`);
  }

  if (role === ROLES.ADMIN && req.user.role !== ROLES.ADMIN) {
    throw ApiError.forbidden('Only an administrator can invite another administrator');
  }

  const { user, resent, emailed, link } = await inviteService.inviteUser(
    { name, email, role: role || ROLES.SALES_REP },
    req.user,
    req
  );

  await recordAudit(req, {
    action: resent ? 'update' : 'create',
    entity: 'user',
    entityId: user._id,
    label: user.name,
    after: user,
  });

  /*
   * WHY THE LINK COMES BACK IN THE RESPONSE WHEN NO EMAIL WAS SENT.
   *
   * With no mail provider configured, the invite link only ever reached the
   * server log. The endpoint still answered "Invitation sent", so the feature
   * looked like it worked and simply did not — the admin waited, the invitee
   * waited, and the only copy of the link was in a log neither of them reads.
   *
   * The alternative to handing it back is refusing to invite at all without a
   * transport, which makes a working feature unusable on any deployment that
   * has not bought an email provider yet.
   *
   * It is safe HERE and would not be safe anywhere else in this codebase. The
   * recipient is the manager or admin who just issued this invite, one call
   * after passing `protect` and `requireManagerOrAdmin`. They chose the address
   * and the role, they can re-issue the invite at will, and they can already
   * deactivate the account outright. Handing them the link grants them nothing
   * they did not already have.
   *
   * The password-reset flow deliberately does NOT do this, and the difference
   * is the point: there the requester is an anonymous member of the public
   * claiming to own an address, so returning the token would let anyone take
   * over any account by typing in an email.
   *
   * When mail genuinely went out, the link is withheld. The invitee's inbox
   * should be the only place it exists.
   */
  const deliveredElsewhere = emailed;

  res.status(resent ? 200 : 201).json({
    success: true,
    message: deliveredElsewhere
      ? resent
        ? 'A fresh invitation has been emailed, and any earlier link no longer works.'
        : 'Invitation emailed.'
      : resent
        ? 'A fresh invite link has been created, and any earlier link no longer works. ' +
          'No email was sent — share the link below with them directly.'
        : 'Invite link created. No email was sent, because this deployment has no mail ' +
          'transport configured — share the link below with them directly.',
    data: user,
    meta: { emailed: deliveredElsewhere, ...(deliveredElsewhere ? {} : { inviteLink: link }) },
  });
});

/**
 * PATCH /api/users/:id/status — admin only.
 *
 * Deactivate or reactivate an account. A separate endpoint from the general
 * update because it is a different kind of action with different consequences:
 * changing a name is cosmetic, while deactivating cuts off access mid-session.
 * Keeping it separate also keeps the audit entries legible — "status:
 * active -> deactivated" rather than a general update that happens to include
 * a status field.
 */
const setUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  if (![USER_STATUS.ACTIVE, USER_STATUS.DEACTIVATED].includes(status)) {
    throw ApiError.badRequest('Status must be either active or deactivated');
  }

  /*
   * Locking yourself out is the classic own-goal here, and on a single-admin
   * install it is unrecoverable through the UI.
   */
  if (req.params.id === req.user._id.toString()) {
    throw ApiError.badRequest('You cannot change your own account status');
  }

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  /*
   * A pending invite cannot be "activated" from here — that would create an
   * account with no password that is nonetheless allowed to sign in, except it
   * still could not, because there is nothing to sign in with. Refusing is
   * clearer than a state that looks active and behaves otherwise.
   */
  if (user.status === USER_STATUS.PENDING && status === USER_STATUS.ACTIVE) {
    throw ApiError.badRequest(
      'This user has not accepted their invitation yet. Re-send the invitation instead.'
    );
  }

  const before = user.toObject();
  user.status = status;
  await user.save();

  /*
   * Deactivating revokes every session immediately.
   *
   * `protect` already refuses a deactivated user on their next request, so this
   * is belt and braces — but it is the difference between "cannot make new
   * requests" and "is signed out", and it invalidates the refresh token so the
   * session cannot be resurrected.
   */
  if (status === USER_STATUS.DEACTIVATED) {
    await revokeAllForUser(user._id, 'account deactivated');
  }

  await recordAudit(req, {
    action: 'update',
    entity: 'user',
    entityId: user._id,
    label: user.name,
    before,
    after: user,
  });

  res.json({ success: true, data: user });
});

/**
 * GET /api/users/pending — admin only.
 *
 * The sign-up requests waiting on a decision.
 *
 * Deliberately its own endpoint rather than `GET /api/users?status=pending`,
 * even though that filter would return the same rows. Two reasons: this list is
 * a WORK QUEUE and the admin screen polls it for a badge count, so it should be
 * cheap and shaped for that; and `pending` covers two different situations —
 * an unaccepted invite and an unapproved request — of which only the second is
 * a decision anybody is waiting on. Filtering by status alone would put invited
 * colleagues into the approvals queue, where there is nothing to approve.
 */
const listPendingRequests = asyncHandler(async (req, res) => {
  const users = await User.find({
    status: USER_STATUS.PENDING,
    // What separates a request from an unaccepted invite.
    requestedRole: { $ne: null },
  })
    .select('name email role requestedRole createdAt')
    .sort({ createdAt: 1 });

  /*
   * Oldest first, unlike every other list in the app. A queue is worked from
   * the front — newest-first would leave the person who has been waiting
   * longest permanently at the bottom of the screen.
   */
  res.json({ success: true, count: users.length, data: users });
});

/**
 * PATCH /api/users/:id/approve — admin only.
 *
 * Body: { "role": "manager" } to grant something other than what was asked for,
 * or omit it to grant the requested role.
 *
 * THE ADMIN MAY OVERRIDE THE REQUESTED ROLE, AND THAT IS THE POINT.
 *
 * A request is a request. Someone asking to be a manager is telling you what
 * they believe their job is, which is useful information and not a decision.
 * Forcing an admin to approve-then-demote would mean a window, however brief,
 * where somebody holds access nobody agreed to give them.
 */
const approveUser = asyncHandler(async (req, res) => {
  const { role } = req.body;

  if (role !== undefined && !ROLE_VALUES.includes(role)) {
    throw ApiError.badRequest(`Role must be one of: ${ROLE_VALUES.join(', ')}`);
  }

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  /*
   * Only a pending REQUEST can be approved. An unaccepted invite is not one:
   * that account has no password, so activating it would produce an account
   * nobody can sign in to, in a state the invite flow would then refuse to fix.
   */
  if (user.status !== USER_STATUS.PENDING || !user.requestedRole) {
    throw ApiError.badRequest('That account does not have a pending request to approve');
  }

  const before = user.toObject();
  const granted = role || user.requestedRole;

  user.role = granted;
  user.status = USER_STATUS.ACTIVE;
  user.reviewedAt = new Date();
  user.reviewedBy = req.user._id;
  await user.save();

  await recordAudit(req, {
    action: 'update',
    entity: 'user',
    entityId: user._id,
    label: user.name,
    before,
    after: user,
    // The requested role is recorded next to the granted one, because
    // "approved, but as something else" is the interesting case and the diff
    // alone would not say that a different decision had been made.
    note:
      granted === user.requestedRole
        ? `approved as ${granted}`
        : `approved as ${granted} (asked for ${user.requestedRole})`,
  });

  await notifyDecision(user, req, true);

  res.json({ success: true, message: `${user.name} can now sign in.`, data: user });
});

/**
 * PATCH /api/users/:id/reject — admin only.
 *
 * WHY THE ACCOUNT IS KEPT RATHER THAN DELETED.
 *
 * The brief allowed either. Keeping it wins on three counts:
 *
 *   - Deleting frees the email address, so the same person can immediately
 *     apply again and the admin sees an identical request with no memory of
 *     having declined it. A queue you cannot clear permanently is not a queue.
 *   - The decision itself is worth keeping. "Who asked for access and what was
 *     decided" is exactly the question an audit of an internal system asks, and
 *     deleting the row deletes the answer.
 *   - The person gets a truthful message at the login screen instead of
 *     "invalid email or password", which would send them round the password
 *     reset loop for an account that no longer exists.
 *
 * The cost is that a rejected applicant cannot re-apply on their own. That is
 * deliberate — re-applying after a refusal is a conversation with an
 * administrator, not a form. An admin can still approve a rejected request
 * later (the decision is reversible), or delete the account outright to free
 * the address.
 */
const rejectUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  if (user.status !== USER_STATUS.PENDING || !user.requestedRole) {
    throw ApiError.badRequest('That account does not have a pending request to reject');
  }

  const before = user.toObject();

  user.status = USER_STATUS.REJECTED;
  user.reviewedAt = new Date();
  user.reviewedBy = req.user._id;
  await user.save();

  await recordAudit(req, {
    action: 'update',
    entity: 'user',
    entityId: user._id,
    label: user.name,
    before,
    after: user,
    note: `rejected (asked for ${user.requestedRole})`,
  });

  await notifyDecision(user, req, false);

  res.json({ success: true, message: `${user.name}'s request was rejected.`, data: user });
});

/**
 * Tell the applicant what was decided.
 *
 * Best-effort for the same reason the admin notification is: the decision is
 * already recorded and the login screen states it plainly, so losing the email
 * costs the applicant a little time and nothing else. Turning a mail outage
 * into a failed approval would be far worse — the admin would retry, and the
 * second attempt would be refused because the account is no longer pending.
 */
async function notifyDecision(user, req, approved) {
  try {
    await mailer.sendMail({
      to: user.email,
      subject: approved ? 'Your SimpleCRM account is ready' : 'About your SimpleCRM request',
      text: approved
        ? `Hello ${user.name},\n\n` +
          `Your account has been approved as a ${String(user.role).replace('_', ' ')}. ` +
          `You can sign in with the password you chose when you signed up:\n\n` +
          `${publicUrl(req, '/login')}`
        : `Hello ${user.name},\n\n` +
          `Your request for a SimpleCRM account was not approved. If you think this is a ` +
          `mistake, please speak to an administrator.`,
    });
  } catch (err) {
    log.warn({ err, userId: user._id }, 'could not tell an applicant what was decided');
  }
}

module.exports = {
  listUsers,
  listPendingRequests,
  approveUser,
  rejectUser,
  inviteUser: inviteUserHandler,
  setUserStatus,
  listAssignableUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
};
