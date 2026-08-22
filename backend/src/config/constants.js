/**
 * Enum values shared across models, middleware and controllers.
 *
 * Defining them once means a typo like 'sales-rep' fails at import time in your
 * editor rather than silently never matching a role check.
 */

const ROLES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  SALES_REP: 'sales_rep',
};

/**
 * Account lifecycle.
 *
 *   pending      waiting on someone else. Cannot sign in. TWO different
 *                situations share this status, and they are told apart by
 *                whether `requestedRole` is set:
 *                  invited     an admin created the account; the person has
 *                              not yet set a password through their link.
 *                  requested   the person signed up and chose a role; an admin
 *                              has not yet approved them.
 *                The distinction matters at the login screen, where "use your
 *                invitation link" and "awaiting approval" send someone to two
 *                completely different places.
 *   active       normal.
 *   rejected     an admin declined a sign-up request. Cannot sign in. Kept
 *                rather than deleted — see the note in userController's reject
 *                handler for why.
 *   deactivated  an offboarded employee. Cannot sign in, and existing sessions
 *                stop working on their next request — see middleware/auth.
 *
 * Deactivation rather than deletion is the default for a departing colleague:
 * deleting the account would orphan every customer and order that references
 * it as `createdBy`, and the audit trail would lose the name behind past
 * actions. Deletion stays available for a record created by mistake.
 */
const USER_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  DEACTIVATED: 'deactivated',
  REJECTED: 'rejected',
};

/**
 * Roles a person may REQUEST for themselves when signing up.
 *
 * Admin is absent, and that is the point rather than an oversight. A request is
 * made by an anonymous member of the public; letting them ask for admin would
 * mean the only thing standing between a stranger and full control of the CRM
 * is an administrator reading a form carefully at the end of a long day.
 * Promotion to admin is a deliberate act by an existing admin, on the user
 * management screen, where the consequence is visible next to the person.
 */
const REQUESTABLE_ROLES = [ROLES.MANAGER, ROLES.SALES_REP];

const CUSTOMER_STATUS = {
  LEAD: 'lead',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
};

const ORDER_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

/** Default stock level at or below which a product counts as "low stock". */
const DEFAULT_LOW_STOCK_THRESHOLD = 10;

module.exports = {
  ROLES,
  REQUESTABLE_ROLES,
  ROLE_VALUES: Object.values(ROLES),
  USER_STATUS,
  USER_STATUS_VALUES: Object.values(USER_STATUS),
  CUSTOMER_STATUS,
  CUSTOMER_STATUS_VALUES: Object.values(CUSTOMER_STATUS),
  ORDER_STATUS,
  ORDER_STATUS_VALUES: Object.values(ORDER_STATUS),
  DEFAULT_LOW_STOCK_THRESHOLD,
};
