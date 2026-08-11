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
