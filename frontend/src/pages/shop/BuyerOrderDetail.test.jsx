import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BuyerOrderDetail from './BuyerOrderDetail';
import { BuyerAuthProvider } from '../../context/BuyerAuthContext';
import { ToastProvider } from '../../components/Toast';
import { shopAuthApi, shopOrdersApi } from '../../api/shopResources';

/**
 * The cancel / edit-request actions are only meaningful for a `pending`
 * order — once it is `completed` or `cancelled` there is nothing left to
 * request (see the backend's phase 3 note: only ever proposed against a
 * pending order). This is the UI half of that rule.
 */
vi.mock('../../api/shopResources', () => ({
  shopAuthApi: { me: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() },
  shopOrdersApi: {
    list: vi.fn(),
    get: vi.fn(),
    requestCancel: vi.fn(),
    requestEdit: vi.fn(),
    ask: vi.fn(),
  },
}));

function order(overrides = {}) {
  return {
    _id: 'order-1',
    orderNumber: 1001,
    status: 'pending',
    createdAt: '2026-08-01T00:00:00.000Z',
    total: 40,
    items: [
      {
        product: { _id: 'p1', name: 'Widget' },
        quantity: 2,
        priceAtOrder: 20,
      },
    ],
    ...overrides,
  };
}

function renderDetail(id = 'order-1') {
  return render(
    <MemoryRouter initialEntries={[`/account/orders/${id}`]}>
      <ToastProvider>
        <BuyerAuthProvider>
          <Routes>
            <Route path="/account/orders/:id" element={<BuyerOrderDetail />} />
            <Route path="/login" element={<p>LOGIN PAGE</p>} />
          </Routes>
        </BuyerAuthProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('BuyerOrderDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza' });
  });

  it('shows the cancel and edit-request actions for a pending order', async () => {
    shopOrdersApi.get.mockResolvedValue(order({ status: 'pending' }));

    renderDetail();

    expect(await screen.findByRole('button', { name: /request cancellation/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /request different quantities/i })
    ).toBeInTheDocument();
  });

  it.each(['completed', 'cancelled'])(
    'hides the cancel and edit-request actions for a %s order',
    async (status) => {
      shopOrdersApi.get.mockResolvedValue(order({ status }));

      renderDetail();

      expect(await screen.findByText(new RegExp(`already ${status}`, 'i'))).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /request cancellation/i })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /request different quantities/i })
      ).not.toBeInTheDocument();
    }
  );

  it('sends visitors with no session to sign in first', async () => {
    shopAuthApi.me.mockRejectedValue({ response: { status: 401, data: {} } });

    renderDetail();

    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
  });
});
