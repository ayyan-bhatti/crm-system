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
  CUSTOMER_STATUS,
  CUSTOMER_STATUS_VALUES: Object.values(CUSTOMER_STATUS),
  ORDER_STATUS,
  ORDER_STATUS_VALUES: Object.values(ORDER_STATUS),
  DEFAULT_LOW_STOCK_THRESHOLD,
};
