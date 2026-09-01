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
   * Reach the customer book at all.
   *
   * A sales rep cannot — not a filtered slice of it, none of it. Their job is
   * to fulfil the orders assigned to them, and this is the most commercially
   * sensitive collection in the system. What they DO get is the contact details
   * of the customer on an order assigned to them, which arrives with the order
   * rather than from here.
   *
   * Mirrors `canViewCustomers`, and the router-level `requireManagerOrAdmin` on
   * every customer route.
   */
  viewCustomers: [ADMIN, MANAGER],

  /**
   * Change the customer book directly.
   *
   * Admin only. A manager's create, edit or delete becomes a change request for
   * an admin to approve — so a manager still SEES these controls, and using
   * them queues a proposal rather than writing. Mirrors `canWriteCustomers`.
   */
  writeCustomers: [ADMIN],

  /**
   * Create an order and decide what is on it.
   *
   * Not a sales rep: an order is a commercial commitment, and a rep fulfils
   * orders rather than agreeing them. A manager may, and it queues for
   * approval. Mirrors `canWriteOrders`.
   */
  writeOrders: [ADMIN, MANAGER],

  /**
   * Decide on a proposed change to a customer or an order.
   *
   * Admin only, and deliberately not delegated: managers are where these
   * requests come from, and an approver who can approve their own request is
   * not an approver.
   */
  approveChanges: [ADMIN],

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

  /**
   * Decide a BUYER-initiated request — a storefront customer's own
   * cancellation or edit ask.
   *
   * Deliberately a second, narrower entry rather than widening
   * `approveChanges` to include managers. The two answer different
   * questions: `approveChanges` is "may this user decide a colleague's
   * request" (admin only — the self-approval rule that entry's own comment
   * explains), this one is "may this user decide a buyer's" (no colleague
   * involved, so no such conflict). Mirrors the per-request check in
   * `changeRequestController.js` — `[ADMIN, MANAGER]` at the route, but
   * `assertMayDecide` there still refuses a manager acting on anyone else's
   * request even when this is `true`, exactly as this table cannot express
   * "except your own colleagues' rows" and does not try to.
   */
  approveBuyerRequest: [ADMIN, MANAGER],

  /**
   * The internal CRM natural-language search box — the one that queries raw
   * customer/order/product records directly, as distinct from the storefront's
   * public product search (which is never gated by this table at all; see the
   * note below on buyer-facing actions).
   *
   * Admin only. A manager or sales rep could otherwise phrase their way to the
   * whole customer book in one sentence, which is exactly the access
   * `viewCustomers`/`writeCustomers` above take care to withhold or restrict.
   * Mirrors `requireAdmin` on `POST /api/ai-search`.
   */
  internalAiSearch: [ADMIN],

  /* -------------------------------------------------------------------------
   * MARKETING
   *
   * Mirrors the helpers of the same names in backend/src/middleware/roles.js.
   * ---------------------------------------------------------------------- */

  /**
   * Reach the marketing contacts screen.
   *
   * ALL THREE ROLES, which looks like it contradicts `viewCustomers` refusing
   * a sales rep the customer book — and does not, because the two screens show
   * different things and are scoped differently.
   *
   * The customer book is every customer with their notes, history and
   * commercial detail. Marketing contacts, for a rep, is the people whose
   * orders they are already fulfilling: a name, an address, a consent state.
   * They receive exactly that today, one record at a time, with every order
   * assigned to them. The server enforces the narrowing
   * (`contactService.visibleCustomerIds`); this entry only decides whether the
   * nav item appears.
   *
   * Gating the screen instead would leave a rep unable to message the customer
   * whose parcel they are holding — the one marketing action their job calls
   * for. Mirrors `canViewContacts`.
   */
  viewContacts: [ADMIN, MANAGER, SALES_REP],

  /**
   * Launch a bulk campaign.
   *
   * Not a sales rep, for the same reason as `writeOrders`: a campaign is a
   * commitment made in the business's name to many people at once. A manager
   * may, and a send that reaches beyond their own contacts queues for an admin
   * — a rule this table cannot express, exactly as it cannot express "except
   * your own colleagues' rows" for `approveBuyerRequest`. The server decides
   * it at dispatch from the resolved audience; the UI asks and reports.
   * Mirrors `canLaunchCampaigns` and `requireManagerOrAdmin` on /api/campaigns.
   */
  launchCampaigns: [ADMIN, MANAGER],

  /**
   * Decide a campaign waiting for approval. Admin only, same self-approval
   * reasoning as `approveChanges`. Mirrors `canApproveCampaigns`.
   */
  approveCampaigns: [ADMIN],

  /**
   * Export the contact book to a spreadsheet.
   *
   * ADMIN ONLY, and deliberately stricter than viewing the same rows. Reading
   * contacts a page at a time and downloading the whole filtered book as a
   * file are different acts: the first is looking something up, the second is
   * a copy of the customer list leaving the building. Mirrors
   * `canExportContacts` and the `requireRole(ADMIN)` on /api/contacts/export.
   */
  exportContacts: [ADMIN],

  /**
   * Change when and whether the post-sale automations run.
   *
   * Admin only — but note that READING the automation log is not gated at all,
   * on purpose. A stopped automation has no symptom other than silence, so the
   * more people who can see its last-run date, the shorter that silence is.
   * Mirrors `canConfigureAutomation`, and the split on /api/automation.
   */
  configureAutomation: [ADMIN],
};

/*
 * WHAT IS DELIBERATELY NOT IN THIS TABLE: any buyer-facing action
 * (browsing, the cart, requesting a cancellation). This table is resolved
 * from `useAuth()` — the STAFF session — and a buyer is never that session;
 * see `middleware/buyerAuth.js`'s own comment for why a buyer must never be
 * checked against the staff permission table at all, in either direction.
 * The storefront's own gating is "is a buyer signed in", asked of a
 * separate buyer auth context — there is no role matrix to maintain on that
 * side, since a buyer has exactly one relationship to their own cart and
 * order history: it is theirs, or they are not signed in.
 */

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
