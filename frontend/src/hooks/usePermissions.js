import { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { ROLES } from '../constants';

/**
 * What the signed-in user is allowed to do — one place, named by ACTION.
 *
 * WHY THIS REPLACED SCATTERED ROLE CHECKS.
 *
 * Permission logic used to be spelled three different ways across the app:
 * `FULL_ACCESS_ROLES.includes(user.role)` in one file, `<RoleGate roles={...}>`
 * in another, `roles.includes(user.role)` in a third. Thirteen checks in total,
 * and the gaps were exactly where you would expect: the customer and order
 * detail pages had none at all, so a sales rep was shown a Delete button on
 * every record and a "reassign" control the API would refuse.
 *
 * Three separate problems came out of that, and this file exists for all three:
 *
 *   1. Nothing listed what a role could do. Answering "what does a manager
 *      see?" meant grepping for the word "manager" and hoping.
 *   2. Adding a screen meant re-deriving the rules, and re-deriving them
 *      slightly differently, which is how the detail pages ended up bare.
 *   3. Checks were written in terms of ROLES, so every new role would have
 *      meant editing every call site.
 *
 * PERMISSIONS ARE NAMED BY ACTION, NOT BY ROLE.
 *
 * `can.reassignRecords` rather than `isManagerOrAdmin`. The role list is an
 * implementation detail of the permission, and keeping it here means a change
 * to who may reassign is one edit, in one file, that cannot be applied
 * inconsistently.
 *
 * THIS IS UI CONVENIENCE, NOT SECURITY.
 *
 * Nothing here protects anything. Every rule below is enforced independently by
 * the API, which is the only place that counts — a hidden button is hidden from
 * someone using the app, not from someone using curl. What it buys is honesty:
 * a user is not offered actions that will be refused, and does not learn to
 * read a 403 as normal.
 *
 * The mapping deliberately MIRRORS the backend rather than inventing policy.
 * Each entry names the server-side rule it shadows, so a drift between them is
 * visible here rather than being discovered by a user hitting a wall.
 */

const { ADMIN, MANAGER, SALES_REP } = ROLES;

/**
 * The permission table. The single source of truth for UI visibility.
 *
 * Read it as: "these roles may do this thing".
 */
export const PERMISSIONS = {
  /**
   * See every customer and order, rather than only their own.
   * Mirrors `hasFullRecordAccess` in backend/src/middleware/roles.js.
   */
  viewAllRecords: [ADMIN, MANAGER],

  /**
   * Reassign a customer or order to a different sales rep.
   * Mirrors the explicit check in customerController's updateCustomer.
   */
  reassignRecords: [ADMIN, MANAGER],

  /**
   * Create, edit and delete products. Sales reps are read-only.
   * Mirrors `requireManagerOrAdmin` on the product write routes.
   */
  manageProducts: [ADMIN, MANAGER],

  /** Invite a colleague. Mirrors `requireManagerOrAdmin` on /users/invite. */
  inviteUsers: [ADMIN, MANAGER],

  /**
   * The user-management screen: roles, deactivation, deletion.
   * Mirrors `requireRole(ADMIN)` on the rest of /api/users.
   */
  manageUsers: [ADMIN],

  /** Approve or reject a pending account request. Admin only, by design. */
  approveAccounts: [ADMIN],

  /** The audit trail. Mirrors `requireRole(ADMIN)` on /api/audit-logs. */
  viewAuditLog: [ADMIN],

  /**
   * Operational internals: metrics, AI status, AI spend.
   * Mirrors `requireRole(ADMIN)` on /api/internal.
   */
  viewInternals: [ADMIN],
};

/** Every action name, so a typo in `<Can do="...">` can be caught rather than silently denying. */
export const ACTIONS = Object.keys(PERMISSIONS);

/**
 * Resolve a user's permissions. Exported separately from the hook so tests and
 * non-component code can use it without a React tree.
 *
 * @param {object|null} user
 */
export function permissionsFor(user) {
  const role = user?.role ?? null;

  const can = {};
  for (const [action, roles] of Object.entries(PERMISSIONS)) {
    can[action] = Boolean(role) && roles.includes(role);
  }

  return {
    role,
    can,

    // Convenience flags for the few places that genuinely mean "this role"
    // rather than "this capability" — showing someone their own job title, for
    // instance. Not for gating actions; use `can` for that.
    isAdmin: role === ADMIN,
    isManager: role === MANAGER,
    isSalesRep: role === SALES_REP,

    /**
     * Whether this user personally owns a record.
     *
     * Only meaningful for a sales rep: anyone with `viewAllRecords` sees
     * everything regardless, so this returns true for them rather than
     * pretending a manager is a stranger to a record they can freely edit.
     *
     * Handles both a populated object and a bare id, because the API returns
     * `assignedTo` populated on a detail response and as an id elsewhere, and a
     * caller should not have to know which.
     */
    owns(record) {
      if (!user || !record) return false;
      if (PERMISSIONS.viewAllRecords.includes(role)) return true;

      const idOf = (value) => (value && typeof value === 'object' ? value._id : value);
      const mine = String(user._id);

      return [record.assignedTo, record.createdBy].some(
        (value) => value != null && String(idOf(value)) === mine
      );
    },
  };
}

/**
 * The hook. Memoised on the user so a permissions object is not rebuilt on
 * every render, which would defeat memoisation in anything consuming it.
 */
export default function usePermissions() {
  const { user } = useAuth();
  return useMemo(() => permissionsFor(user), [user]);
}
