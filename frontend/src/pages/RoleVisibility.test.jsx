import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import ProductList from './products/ProductList';
import CustomerList from './customers/CustomerList';
import DashboardLayout from '../components/DashboardLayout';
import { renderWithProviders, fakeUser } from '../test/utils';
import { authApi, productsApi, customersApi, usersApi } from '../api/resources';

/**
 * The same screen, seen by each role.
 *
 * WHY THESE ARE IN ONE FILE RATHER THAN SPREAD ACROSS THE PAGE TESTS.
 *
 * The bug this guards against is not "one button was visible to the wrong
 * person". It is that permission logic was written out by hand on each page,
 * slightly differently each time, so some pages were gated and some were simply
 * forgotten. A per-page test would have passed on the pages that had checks and
 * never been written for the pages that did not.
 *
 * Asserting role-by-role on the SAME screen is what makes an omission visible:
 * if a control is not gated, all three roles see it, and the difference these
 * tests demand does not appear.
 */

vi.mock('../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  productsApi: { list: vi.fn(), categories: vi.fn() },
  customersApi: { list: vi.fn() },
  usersApi: { assignable: vi.fn() },
  aiSearchApi: { search: vi.fn() },
  internalApi: { aiStatus: vi.fn() },
}));

const ROLES = ['admin', 'manager', 'sales_rep'];

/** Render `ui` as the given role, with the session already resolved. */
function renderAs(role, ui, route = '/') {
  authApi.me.mockResolvedValue(fakeUser({ role }));
  return renderWithProviders(ui, { route, guarded: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  productsApi.list.mockResolvedValue({ data: [], page: 1, pages: 1, total: 0 });
  productsApi.categories.mockResolvedValue([]);
  customersApi.list.mockResolvedValue({ data: [], page: 1, pages: 1, total: 0 });
  usersApi.assignable.mockResolvedValue([
    { _id: 'r1', name: 'Rep One', role: 'sales_rep' },
    { _id: 'r2', name: 'Rep Two', role: 'sales_rep' },
  ]);
});

describe('Products list', () => {
  it.each([['admin'], ['manager']])('offers %s the create control', async (role) => {
    renderAs(role, <ProductList />, '/products');

    expect(await screen.findByRole('link', { name: /new product/i })).toBeInTheDocument();
  });

  /**
   * Products are read-only for a sales rep. The button is hidden rather than
   * disabled: the API refuses the call, so offering it and then rejecting it
   * teaches people that errors are normal.
   */
  it('hides the create control from a sales rep', async () => {
    renderAs('sales_rep', <ProductList />, '/products');

    expect(await screen.findByRole('heading', { name: /products/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /new product/i })).not.toBeInTheDocument();
  });
});

describe('Customers list', () => {
  /**
   * A rep sees only their own customers, so filtering by owner can only ever be
   * a no-op for them — and populating the dropdown meant every rep pulling down
   * the name of every other rep to fill it.
   */
  it('offers a manager the assigned-rep filter', async () => {
    renderAs('manager', <CustomerList />, '/customers');

    expect(await screen.findByLabelText(/filter by assigned rep/i)).toBeInTheDocument();
  });

  it('hides the assigned-rep filter from a sales rep', async () => {
    renderAs('sales_rep', <CustomerList />, '/customers');

    expect(await screen.findByRole('heading', { name: /customers/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/filter by assigned rep/i)).not.toBeInTheDocument();
  });

  it('does not fetch the colleague list for a sales rep', async () => {
    renderAs('sales_rep', <CustomerList />, '/customers');

    expect(await screen.findByRole('heading', { name: /customers/i })).toBeInTheDocument();
    expect(usersApi.assignable).not.toHaveBeenCalled();
  });

  it('does fetch it for a manager, who can act on it', async () => {
    renderAs('manager', <CustomerList />, '/customers');

    expect(await screen.findByLabelText(/filter by assigned rep/i)).toBeInTheDocument();

    // waitFor, not a bare assertion: the control renders from the permission,
    // while the fetch happens in an effect. Assuming the effect has already
    // flushed because the control is on screen is an ordering assumption, and
    // it is exactly the kind that holds until the machine is busy.
    await waitFor(() => expect(usersApi.assignable).toHaveBeenCalled());
  });

  it('hides the assigned-to column from a sales rep', async () => {
    renderAs('sales_rep', <CustomerList />, '/customers');

    expect(await screen.findByRole('heading', { name: /customers/i })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /assigned to/i })).not.toBeInTheDocument();
  });
});

describe('Navigation', () => {
  /*
   * The layout renders a desktop sidebar AND a mobile bar, so every nav link
   * appears twice in the DOM. Counting matches rather than demanding exactly
   * one keeps these tests about visibility instead of about the breakpoint
   * strategy — which is not what they are guarding.
   */
  const navLinks = (name) => screen.queryAllByRole('link', { name });

  /** Admin-only areas. A manager runs the business, not the people. */
  it('shows Users and Audit log to an admin', async () => {
    renderAs('admin', <DashboardLayout />);

    await screen.findAllByRole('link', { name: /customers/i });
    expect(navLinks(/^users$/i).length).toBeGreaterThan(0);
    expect(navLinks(/audit log/i).length).toBeGreaterThan(0);
  });

  it.each([['manager'], ['sales_rep']])('hides them from %s', async (role) => {
    renderAs(role, <DashboardLayout />);

    // Anchored on Orders, which every role has. Customers used to serve as the
    // anchor and no longer can — a sales rep does not get that section at all.
    await screen.findAllByRole('link', { name: /orders/i });
    expect(navLinks(/^users$/i)).toHaveLength(0);
    expect(navLinks(/audit log/i)).toHaveLength(0);
    expect(navLinks(/approvals/i)).toHaveLength(0);
  });

  /** Everyone gets the working parts of the app. */
  it.each(ROLES.map((r) => [r]))('shows the core sections to %s', async (role) => {
    renderAs(role, <DashboardLayout />);

    await screen.findAllByRole('link', { name: /orders/i });
    expect(navLinks(/products/i).length).toBeGreaterThan(0);
  });

  /**
   * THE CUSTOMER SECTION IS NOT THERE FOR A SALES REP.
   *
   * Nav is where an absence is least confusing: a missing section reads as "not
   * my job", where a section that opens and then fills with 403s reads as
   * broken. So the section is removed rather than left to fail on arrival.
   */
  it.each([['admin'], ['manager']])('shows Customers to %s', async (role) => {
    renderAs(role, <DashboardLayout />);

    expect((await screen.findAllByRole('link', { name: /customers/i })).length).toBeGreaterThan(
      0
    );
  });

  it('hides Customers from a sales rep entirely', async () => {
    renderAs('sales_rep', <DashboardLayout />);

    await screen.findAllByRole('link', { name: /orders/i });
    expect(navLinks(/customers/i)).toHaveLength(0);
  });

  /** The approvals queue is the admin's, and only the admin's. */
  it('shows Approvals to an admin only', async () => {
    renderAs('admin', <DashboardLayout />);

    expect((await screen.findAllByRole('link', { name: /approvals/i })).length).toBeGreaterThan(
      0
    );
  });
});
