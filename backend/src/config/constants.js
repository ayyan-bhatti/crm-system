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
 *   pending      invited, but has not set a password yet. Cannot sign in.
 *   active       normal.
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
};

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
  ROLE_VALUES: Object.values(ROLES),
  USER_STATUS,
  USER_STATUS_VALUES: Object.values(USER_STATUS),
  CUSTOMER_STATUS,
  CUSTOMER_STATUS_VALUES: Object.values(CUSTOMER_STATUS),
  ORDER_STATUS,
  ORDER_STATUS_VALUES: Object.values(ORDER_STATUS),
  DEFAULT_LOW_STOCK_THRESHOLD,
};
