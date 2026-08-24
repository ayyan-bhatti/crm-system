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

/**
 * Sees every customer and order rather than a subset.
 *
 * Admins and managers both do. Note what this does NOT grant: a manager sees
 * every customer and may change none of them — reading and writing are
 * separate questions and are answered by separate helpers below.
 */
const hasFullRecordAccess = (user) =>
  user.role === ROLES.ADMIN || user.role === ROLES.MANAGER;

/**
 * THE CUSTOMER RULES.
 *
 * A sales rep has no access to the customer book at all — not a filtered view
 * of it, none of it. The reasoning is that a rep's job here is to fulfil orders
 * assigned to them, and the customer list is the most commercially sensitive
 * thing in the system: names, addresses and buying history for the whole
 * business. Being able to see "only my customers" still means being able to
 * export a slice of it.
 *
 * What a rep CAN see is the contact details of the customer on an order
 * assigned to them, which they need in order to deliver it. That is served by
 * the order endpoints, not by these, and it is a deliberately narrow hole: one
 * customer at a time, only while an order for them is open, only for the rep
 * holding it.
 */
const canViewCustomers = (user) => hasFullRecordAccess(user);

/**
 * Only an admin may change the customer book.
 *
 * A manager may look and may PROPOSE a change, which an admin approves — see
 * services/changeRequestService. Splitting it this way is what makes "managers
 * run the business, admins own the record" true rather than aspirational.
 */
const canWriteCustomers = (user) => isAdmin(user);

/**
 * Can this user read/modify this customer?
 *
 * Now simply "does this user have the customer book", because the per-record
 * ownership rule it used to apply only ever narrowed a sales rep's view — and
 * a sales rep no longer has one.
 */
function canAccessCustomer(user, _customer) {
  return canViewCustomers(user);
}

/**
 * Can this user read/modify this order?
 *
 * A sales rep gets exactly the orders ASSIGNED to them. Not orders they
 * created (they cannot create any) and not orders belonging to "their"
 * customers (they have none) — assignment is now the whole of a rep's scope,
 * which makes it a single fact to reason about rather than three overlapping
 * ones.
 */
function canAccessOrder(user, order) {
  if (hasFullRecordAccess(user)) return true;

  const assignedTo = order.assignedTo?._id || order.assignedTo;

  return Boolean(assignedTo) && assignedTo.toString() === user._id.toString();
}

/**
 * May this user create orders and change what is on them?
 *
 * Not a sales rep. A rep moves an order they hold FORWARD — completed or
 * cancelled — and that is a different act from deciding what was sold: it is
 * the step the assignment exists to let them take. See `canAdvanceOrder`.
 */
const canWriteOrders = (user) => hasFullRecordAccess(user);

/**
 * May this user move this order's status forward?
 *
 * The assigned rep may, on their own order, and this is the one write a rep
 * has. Withholding it would leave them able to see work and unable to do it,
 * which is not a permission model, it is a waiting room.
 */
function canAdvanceOrder(user, order) {
  return canAccessOrder(user, order);
}

module.exports = {
  requireRole,
  requireManagerOrAdmin,
  requireAdmin: requireRole(ROLES.ADMIN),
  isAdmin,
  isSalesRep,
  hasFullRecordAccess,
  canViewCustomers,
  canWriteCustomers,
  canWriteOrders,
  canAdvanceOrder,
  canAccessCustomer,
  canAccessOrder,
};
