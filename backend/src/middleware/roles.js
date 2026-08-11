const ApiError = require('../utils/ApiError');
const { ROLES } = require('../config/constants');

/**
 * Role-based authorisation.
 *
 * The permission model for SimpleCRM:
 *
 *   admin      full access, including user management
 *   manager    full CRUD on customers / products / orders; no user management
 *   sales_rep  CRUD on customers and orders they created or are assigned to;
 *              read-only access to products
 *
 * Two of those rules are "coarse" — they depend only on the role and the route,
 * so they are enforced here as middleware. The third (sales_rep record
 * ownership) depends on the specific document being touched, so it is enforced
 * in the controllers via `canAccessCustomer` / `canAccessOrder` below.
 */

/**
 * Allow the request only if `req.user.role` is in the allowed list.
 * Must run after `protect`.
 *
 *   router.delete('/:id', protect, requireRole(ROLES.ADMIN), remove);
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized());
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        ApiError.forbidden(
          `Your role (${req.user.role}) is not permitted to perform this action`
        )
      );
    }
    return next();
  };
}

/** Admin or manager — i.e. anyone with unrestricted access to CRM records. */
const requireManagerOrAdmin = requireRole(ROLES.ADMIN, ROLES.MANAGER);

/** Convenience predicates used inside controllers. */
const isAdmin = (user) => user.role === ROLES.ADMIN;
const isSalesRep = (user) => user.role === ROLES.SALES_REP;
/** Admins and managers see and edit every record. */
const hasFullRecordAccess = (user) =>
  user.role === ROLES.ADMIN || user.role === ROLES.MANAGER;

/**
 * Can this user read/modify this customer?
 * Sales reps are limited to customers they created or are assigned to.
 */
function canAccessCustomer(user, customer) {
  if (hasFullRecordAccess(user)) return true;

  const userId = user._id.toString();
  // These refs may be populated documents or raw ObjectIds depending on the
  // query, so normalise before comparing.
  const assignedTo = customer.assignedTo?._id || customer.assignedTo;
  const createdBy = customer.createdBy?._id || customer.createdBy;

  return (
    (assignedTo && assignedTo.toString() === userId) ||
    (createdBy && createdBy.toString() === userId)
  );
}

/**
 * Can this user read/modify this order?
 * Sales reps are limited to orders they created, or orders belonging to a
 * customer assigned to them.
 */
function canAccessOrder(user, order, customer = null) {
  if (hasFullRecordAccess(user)) return true;

  const userId = user._id.toString();
  const createdBy = order.createdBy?._id || order.createdBy;
  if (createdBy && createdBy.toString() === userId) return true;

  // The order's customer, either passed in or already populated on the order.
  const linkedCustomer = customer || (order.customer?.assignedTo ? order.customer : null);
  if (linkedCustomer) return canAccessCustomer(user, linkedCustomer);

  return false;
}

module.exports = {
  requireRole,
  requireManagerOrAdmin,
  isAdmin,
  isSalesRep,
  hasFullRecordAccess,
  canAccessCustomer,
  canAccessOrder,
};
