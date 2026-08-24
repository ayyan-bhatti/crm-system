import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrderDetail from './OrderDetail';
import { renderWithProviders, fakeUser } from '../../test/utils';
import { authApi, ordersApi, usersApi } from '../../api/resources';

/**
 * The order detail screen: its identity, and who it belongs to.
 *
 * Two things are being pinned here.
 *
 * The ORDER NUMBER, because the whole point of adding one is that it appears
 * where a human looks. A number that exists in the database and not on the
 * screen has solved nothing — "what happened with 68f3a9…" is still the
 * sentence somebody has to say.
 *
 * The ASSIGNMENT CONTROL, because it is the half of the permission rule most
 * likely to be got wrong: everyone needs to SEE who an order belongs to (that
 * is the point of handing it over), and only a manager or admin may CHANGE it.
 * Hiding the whole panel from reps would be as wrong as showing them the
 * button.
 */

vi.mock('../../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  ordersApi: { get: vi.fn(), assign: vi.fn(), update: vi.fn(), remove: vi.fn() },
  usersApi: { assignable: vi.fn() },
}));

const SPECIALIST = { _id: 'u2', name: 'Bilal Ahmed', email: 'bilal@example.com', role: 'sales_rep' };

const order = (overrides = {}) => ({
  _id: '650000000000000000000001',
  orderNumber: 'ORD-000142',
  status: 'pending',
  total: 900,
  createdAt: '2026-08-01T10:00:00.000Z',
  completedAt: null,
  customer: { _id: 'c1', name: 'Karachi Traders', company: 'KT', assignedTo: { _id: 'u1', name: 'Owning Rep' } },
  createdBy: { _id: 'u1', name: 'Owning Rep', role: 'sales_rep' },
  assignedTo: null,
  items: [{ _id: 'i1', quantity: 2, priceAtOrder: 450, product: { _id: 'p1', name: 'Widget', sku: 'WID-1' } }],
  ...overrides,
});

const renderAs = (role, data = order()) => {
  authApi.me.mockResolvedValue(fakeUser({ role }));
  ordersApi.get.mockResolvedValue(data);

  return renderWithProviders(<OrderDetail />, {
    route: `/orders/${data._id}`,
    path: '/orders/:id',
    guarded: true,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  usersApi.assignable.mockResolvedValue([SPECIALIST]);
  ordersApi.assign.mockResolvedValue(order({ assignedTo: SPECIALIST }));
});

describe('the order number', () => {
  it('is the heading, so it is the first thing you can quote', async () => {
    renderAs('manager');

    expect(await screen.findByRole('heading', { name: 'ORD-000142' })).toBeInTheDocument();
  });

  /**
   * Orders created before order numbers existed have none. They must stay
   * usable — a short id is unlovely but readable, where a blank heading is a
   * page that looks broken.
   */
  it('falls back to a short id for an order that predates numbering', async () => {
    renderAs('manager', order({ orderNumber: null }));

    expect(await screen.findByRole('heading', { name: '#000001' })).toBeInTheDocument();
  });
});

describe('the assignment panel', () => {
  /** Everyone sees the state — that is the point of a hand-off. */
  it.each([['admin'], ['manager'], ['sales_rep']])('shows %s who the order belongs to', async (role) => {
    renderAs(role, order({ assignedTo: SPECIALIST }));

    expect(await screen.findByText('Bilal Ahmed')).toBeInTheDocument();
  });

  /**
   * Unassigned now genuinely means nobody, and the copy has to say so.
   *
   * It used to mean "follows whoever owns the customer", and this panel showed
   * that rep's name. Reps no longer have customers, so naming one would name a
   * person who cannot actually see the order — worse than saying nothing.
   */
  it('says plainly that nobody holds an unassigned order', async () => {
    renderAs('manager');

    expect(await screen.findByText(/not yet assigned/i)).toBeInTheDocument();
    expect(screen.getByText(/no rep can see this order/i)).toBeInTheDocument();
  });

  it.each([['admin'], ['manager']])('offers %s the reassign control', async (role) => {
    renderAs(role);

    expect(await screen.findByRole('button', { name: /reassign/i })).toBeInTheDocument();
  });

  /** A rep handing their own work to a colleague is somebody else's decision. */
  it('hides the reassign control from a sales rep', async () => {
    renderAs('sales_rep');

    expect(await screen.findByText(/assigned to/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reassign/i })).not.toBeInTheDocument();
  });

  it('reassigns through the dedicated endpoint', async () => {
    const user = userEvent.setup();
    renderAs('manager');

    await user.click(await screen.findByRole('button', { name: /reassign/i }));
    await user.type(await screen.findByPlaceholderText(/search colleagues/i), 'Bilal');
    await user.click(await screen.findByText('Bilal Ahmed'));

    await waitFor(() =>
      expect(ordersApi.assign).toHaveBeenCalledWith('650000000000000000000001', 'u2')
    );
  });

  /**
   * Clearing is a real operation, not a mistake to guard against: it returns
   * the order to following its customer once a temporary hand-off is over.
   */
  it('can clear an assignment, sending null', async () => {
    const user = userEvent.setup();
    renderAs('manager', order({ assignedTo: SPECIALIST }));

    await user.click(await screen.findByRole('button', { name: /reassign/i }));
    await user.click(await screen.findByRole('button', { name: /clear assignment/i }));

    await waitFor(() =>
      expect(ordersApi.assign).toHaveBeenCalledWith('650000000000000000000001', null)
    );
  });

  /** Nothing to clear on an order that already follows its customer. */
  it('offers no clear button when the order is already unassigned', async () => {
    const user = userEvent.setup();
    renderAs('manager');

    await user.click(await screen.findByRole('button', { name: /reassign/i }));

    expect(await screen.findByPlaceholderText(/search colleagues/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear assignment/i })).not.toBeInTheDocument();
  });

  it('reports a failure instead of appearing to succeed', async () => {
    const user = userEvent.setup();
    ordersApi.assign.mockRejectedValue({
      response: { data: { message: 'That account is not active, so it cannot be assigned work' } },
    });
    renderAs('manager');

    await user.click(await screen.findByRole('button', { name: /reassign/i }));
    await user.type(await screen.findByPlaceholderText(/search colleagues/i), 'Bilal');
    await user.click(await screen.findByText('Bilal Ahmed'));

    expect(await screen.findByText(/not active/i)).toBeInTheDocument();
  });
});
