const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { recordAudit } = require('../services/auditService');
const inviteService = require('../services/inviteService');
const { revokeAllForUser } = require('../services/sessionService');
const { ROLE_VALUES, ROLES, USER_STATUS } = require('../config/constants');
const { containsRegex } = require('../utils/queryHelpers');

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

module.exports = {
  listUsers,
  inviteUser: inviteUserHandler,
  setUserStatus,
  listAssignableUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
};
