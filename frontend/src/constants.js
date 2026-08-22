/**
 * Enum values, mirrored from backend/src/config/constants.js.
 *
 * Duplicated deliberately: the frontend is a separate deployable and should not
 * import from the server's source tree. They are small, stable lists — if one
 * ever changes, both files change together.
 */

export const ROLES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  SALES_REP: 'sales_rep',
};

export const ROLE_VALUES = Object.values(ROLES);

export const CUSTOMER_STATUSES = ['lead', 'active', 'inactive'];

export const ORDER_STATUSES = ['pending', 'completed', 'cancelled'];

/** Roles allowed to create, edit and delete products. Sales reps are read-only. */
export const PRODUCT_WRITE_ROLES = [ROLES.ADMIN, ROLES.MANAGER];

/**
 * Roles with unrestricted access to every customer and order, rather than only
 * their own. These are also the roles allowed to reassign a customer.
 * Mirrors `hasFullRecordAccess` in backend/src/middleware/roles.js.
 */
export const FULL_ACCESS_ROLES = [ROLES.ADMIN, ROLES.MANAGER];

/**
 * Roles somebody may request for themselves when signing up.
 *
 * Admin is absent deliberately, and mirrors REQUESTABLE_ROLES on the server: a
 * request comes from an anonymous member of the public, and offering admin as a
 * selectable option would put a tired administrator between a stranger and full
 * control. The API refuses it outright rather than downgrading it, so this list
 * is the UI half of a rule enforced in both places.
 */
export const REQUESTABLE_ROLES = [ROLES.MANAGER, ROLES.SALES_REP];

/** Account statuses, mirrored from the backend. */
export const USER_STATUSES = ['pending', 'active', 'rejected', 'deactivated'];
