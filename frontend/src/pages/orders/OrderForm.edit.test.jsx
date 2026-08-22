import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrderForm from './OrderForm';
import { renderWithProviders, fakeUser, apiError } from '../../test/utils';
import { authApi, ordersApi, customersApi, productsApi } from '../../api/resources';

/**
 * Editing an order.
 *
 * There was no edit screen at all: `PATCH /api/orders/:id` accepted item
 * changes on a pending order and nothing in the UI ever sent them, so a
 * mistyped quantity meant deleting the order and placing it again.
 *
 * The rules being pinned here are the ones that keep the stock ledger honest.
 * Items may only change while the order is PENDING, because once it is
 * completed the stock has moved and the money is real. The customer cannot
 * change at all — that is a different order, not an edit.
 */

vi.mock('../../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  ordersApi: { get: vi.fn(), update: vi.fn(), create: vi.fn() },
  customersApi: { get: vi.fn(), options: vi.fn() },
  productsApi: { options: vi.fn() },
}));

const WIDGET = { _id: 'p1', name: 'Widget', sku: 'WID-1', price: 100, stockQty: 50 };
const GADGET = { _id: 'p2', name: 'Gadget', sku: 'GAD-1', price: 250, stockQty: 20 };

const order = (overrides = {}) => ({
  _id: '650000000000000000000001',
  orderNumber: 'ORD-000142',
  status: 'pending',
  total: 200,
  createdAt: '2026-08-01T10:00:00.000Z',
  customer: { _id: 'c1', name: 'Karachi Traders', company: 'KT' },
  items: [{ _id: 'i1', quantity: 2, priceAtOrder: 100, product: WIDGET }],
  ...overrides,
});

const renderEdit = (data = order()) => {
  authApi.me.mockResolvedValue(fakeUser({ role: 'manager' }));
  ordersApi.get.mockResolvedValue(data);

  return renderWithProviders(<OrderForm />, {
    route: `/orders/${data._id}/edit`,
    path: '/orders/:id/edit',
    guarded: true,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  productsApi.options.mockResolvedValue([WIDGET, GADGET]);
  customersApi.options.mockResolvedValue([]);
  ordersApi.update.mockResolvedValue(order());
});

describe('editing a pending order', () => {
  it('prefills the existing items', async () => {
    renderEdit();

    // The picker shows its selection as the input's VALUE, not as text — which
    // is the whole reason the selected record is held in state rather than
    // derived from the current search results.
    expect(await screen.findByDisplayValue('Widget')).toBeInTheDocument();
    expect(screen.getByLabelText(/quantity for item 1/i)).toHaveValue(2);
  });

  it('names the order it is editing', async () => {
    renderEdit();

    expect(await screen.findByRole('heading', { name: /edit ORD-000142/i })).toBeInTheDocument();
  });

  /** The running total has to work before anyone touches a search box. */
  it('totals the prefilled lines without a further lookup', async () => {
    renderEdit();

    // Twice on purpose: once as the line total, once as the order total. Both
    // are correct, so assert on the count rather than pretending one exists.
    await screen.findByDisplayValue('Widget');
    expect(screen.getAllByText('$200.00')).toHaveLength(2);
  });

  it('persists a changed quantity through PATCH', async () => {
    const user = userEvent.setup();
    renderEdit();

    const quantity = await screen.findByLabelText(/quantity for item 1/i);
    await user.clear(quantity);
    await user.type(quantity, '5');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(ordersApi.update).toHaveBeenCalledWith('650000000000000000000001', {
        items: [{ product: 'p1', quantity: 5 }],
      })
    );
  });

  it('can add a line', async () => {
    const user = userEvent.setup();
    renderEdit();

    await user.click(await screen.findByRole('button', { name: /add item/i }));

    const pickers = screen.getAllByPlaceholderText(/search products/i);
    await user.type(pickers[pickers.length - 1], 'Gadget');
    await user.click(await screen.findByText(/GAD-1/));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(ordersApi.update).toHaveBeenCalled());
    expect(ordersApi.update.mock.calls[0][1].items).toHaveLength(2);
  });

  /**
   * Moving an order to a different customer is not an edit, it is a different
   * order — the original customer's history would silently lose a purchase.
   */
  it('shows the customer as fixed rather than as a picker', async () => {
    renderEdit();

    expect(await screen.findByText('Karachi Traders')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search customers/i)).not.toBeInTheDocument();
  });

  /** Never sends `customer` or `status` — the API is right to refuse both. */
  it('sends only the items', async () => {
    const user = userEvent.setup();
    renderEdit();

    await user.click(await screen.findByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(ordersApi.update).toHaveBeenCalled());
    expect(Object.keys(ordersApi.update.mock.calls[0][1])).toEqual(['items']);
  });
});

describe('editing an order that is no longer pending', () => {
  /**
   * Explained in a sentence rather than shown as dead controls. A form full of
   * disabled inputs is a puzzle; a sentence is an answer.
   */
  it.each([['completed'], ['cancelled']])('explains why a %s order is locked', async (status) => {
    renderEdit(order({ status }));

    expect(await screen.findByText(new RegExp(`this order is ${status}`, 'i'))).toBeInTheDocument();
    expect(screen.getByText(/stock has already moved/i)).toBeInTheDocument();
  });

  it('does not let it be saved', async () => {
    renderEdit(order({ status: 'completed' }));

    expect(await screen.findByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('offers no way to add or remove a line', async () => {
    renderEdit(order({ status: 'completed' }));

    expect(await screen.findByText('Widget')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add item/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove item/i })).toBeDisabled();
  });
});

describe('when the order cannot be loaded', () => {
  /**
   * The bug this guards against was found on the customer and product forms: a
   * failed load rendered a BLANK form that looked ready, and saving it wrote
   * empty values over a real record.
   */
  it('shows the error instead of an empty form', async () => {
    authApi.me.mockResolvedValue(fakeUser({ role: 'manager' }));
    ordersApi.get.mockRejectedValue(apiError(404, 'Order not found'));

    renderWithProviders(<OrderForm />, {
      route: '/orders/650000000000000000000001/edit',
      path: '/orders/:id/edit',
      guarded: true,
    });

    expect(await screen.findByText(/order not found/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
  });
});
