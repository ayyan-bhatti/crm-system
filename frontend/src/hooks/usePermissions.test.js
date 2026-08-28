import { describe, expect, it } from 'vitest';
import { permissionsFor, PERMISSIONS, ACTIONS } from './usePermissions';

/**
 * The permission table itself.
 *
 * These tests are the readable statement of what each role may do. If someone
 * changes the table, one of these fails and says which role gained or lost
 * what — which is the point of having a table at all, rather than thirteen
 * role checks scattered across the pages.
 */

const admin = { _id: 'a1', role: 'admin' };
const manager = { _id: 'm1', role: 'manager' };
const rep = { _id: 'r1', role: 'sales_rep' };

/** Every action a role is allowed, as a sorted list. */
const allowed = (user) =>
  ACTIONS.filter((action) => permissionsFor(user).can[action]).sort();

describe('the permission table', () => {
  it('lets an admin do everything', () => {
    expect(allowed(admin)).toEqual([...ACTIONS].sort());
  });

  /**
   * The manager row is the one worth stating explicitly: full access to the
   * BUSINESS records, none to the people.
   */
  it('gives a manager every record permission and no user-management one', () => {
    const { can } = permissionsFor(manager);

    expect(can.viewAllRecords).toBe(true);
    expect(can.reassignRecords).toBe(true);
    expect(can.manageProducts).toBe(true);

    expect(can.manageUsers).toBe(false);
    expect(can.approveAccounts).toBe(false);
    expect(can.viewAuditLog).toBe(false);
    expect(can.viewInternals).toBe(false);
  });

  /** A sales rep may invite a colleague but manage nothing. */
  it('restricts a sales rep to their own records', () => {
    const { can } = permissionsFor(rep);

    expect(can.viewAllRecords).toBe(false);
    expect(can.reassignRecords).toBe(false);
    expect(can.manageProducts).toBe(false);
    expect(can.manageUsers).toBe(false);
    expect(can.approveAccounts).toBe(false);
  });

  /**
   * A buyer's own cancel/edit request has no colleague self-approval
   * conflict, unlike a manager's own customer edit — so a manager may decide
   * one where they may not decide the other. See the comment on this entry
   * in usePermissions.js for why it is a second entry rather than widening
   * `approveChanges`.
   */
  it('lets a manager decide a buyer-initiated request but not a colleague one', () => {
    const { can } = permissionsFor(manager);

    expect(can.approveBuyerRequest).toBe(true);
    expect(can.approveChanges).toBe(false);
  });

  it('gives an anonymous visitor nothing at all', () => {
    expect(allowed(null)).toEqual([]);
    expect(allowed({ role: 'not_a_real_role' })).toEqual([]);
  });

  /**
   * Each role must be a strict subset of the one above it. A manager who could
   * do something an admin could not would be a bug in the table rather than a
   * deliberate design, and this catches it without anyone having to notice.
   */
  it('nests the roles, so each is a subset of the one above', () => {
    const adminCan = new Set(allowed(admin));
    const managerCan = allowed(manager);
    const repCan = allowed(rep);

    expect(managerCan.every((action) => adminCan.has(action))).toBe(true);
    expect(repCan.every((action) => managerCan.includes(action))).toBe(true);
  });

  /** Roles are named, not free-form — a typo would silently grant nothing. */
  it('only references known roles', () => {
    const known = ['admin', 'manager', 'sales_rep'];

    for (const [action, roles] of Object.entries(PERMISSIONS)) {
      expect(roles.length, `${action} grants nobody anything`).toBeGreaterThan(0);
      for (const role of roles) expect(known).toContain(role);
    }
  });
});

describe('owns', () => {
  const record = (fields) => ({ _id: 'c1', ...fields });

  it('is true for a rep who is assigned the record', () => {
    expect(permissionsFor(rep).owns(record({ assignedTo: 'r1' }))).toBe(true);
  });

  it('is true for a rep who created it', () => {
    expect(permissionsFor(rep).owns(record({ createdBy: 'r1' }))).toBe(true);
  });

  it('is false for a rep with no connection to it', () => {
    expect(permissionsFor(rep).owns(record({ assignedTo: 'r2', createdBy: 'r2' }))).toBe(false);
  });

  /**
   * The API returns `assignedTo` populated on a detail response and as a bare
   * id elsewhere. A caller should not have to know which it is holding.
   */
  it('handles a populated reference as well as a bare id', () => {
    expect(permissionsFor(rep).owns(record({ assignedTo: { _id: 'r1', name: 'Rep' } }))).toBe(
      true
    );
  });

  /**
   * A manager is not a stranger to a record they can freely edit, so this
   * reports true rather than pretending otherwise.
   */
  it('is true for anyone with full record access', () => {
    expect(permissionsFor(manager).owns(record({ assignedTo: 'someone-else' }))).toBe(true);
    expect(permissionsFor(admin).owns(record({ assignedTo: 'someone-else' }))).toBe(true);
  });

  it('is false with no user or no record', () => {
    expect(permissionsFor(null).owns(record({ assignedTo: 'r1' }))).toBe(false);
    expect(permissionsFor(rep).owns(null)).toBe(false);
  });
});
