import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BuyerOrders from './BuyerOrders';
import { BuyerAuthProvider } from '../../context/BuyerAuthContext';
import { shopAuthApi, shopOrdersApi } from '../../api/shopResources';

/**
 * The order-status assistant used to bake the order it was answering about
 * straight into a sentence — a real order id, un-clickable, un-styled, with
 * nothing on screen a user could act on. It now comes back as a structured
 * `references` array (see orderAssistantService.js), and this is the
 * rendering half: a real, clickable order row rather than text.
 */
vi.mock('../../api/shopResources', () => ({
  shopAuthApi: { me: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() },
  shopOrdersApi: { list: vi.fn(), ask: vi.fn() },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/account/orders']}>
      <BuyerAuthProvider>
        <Routes>
          <Route path="/account/orders" element={<BuyerOrders />} />
          <Route path="/account/orders/:id" element={<p>ORDER DETAIL PAGE</p>} />
        </Routes>
      </BuyerAuthProvider>
    </MemoryRouter>
  );
}

describe('BuyerOrders — ask about your orders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza' });
    shopOrdersApi.list.mockResolvedValue({ data: [], pagination: null });
  });

  it('renders the referenced order as a real, clickable row rather than text alone', async () => {
    const user = userEvent.setup();
    shopOrdersApi.ask.mockResolvedValue({
      answer: 'Your order ORD-000142 has shipped.',
      references: [
        {
          orderId: 'order-1',
          orderNumber: 'ORD-000142',
          status: 'completed',
          fulfilment: 'shipped',
          total: 40,
          createdAt: '2026-08-01T00:00:00.000Z',
          estimatedDeliveryAt: null,
        },
      ],
    });

    renderPage();

    await user.type(
      await screen.findByLabelText(/ask about your orders/i),
      'has my order shipped'
    );
    await user.click(screen.getByRole('button', { name: /^ask$/i }));

    expect(await screen.findByText('Your order ORD-000142 has shipped.')).toBeInTheDocument();

    const orderLink = await screen.findByRole('link', { name: /ORD-000142/i });
    expect(orderLink).toHaveAttribute('href', '/account/orders/order-1');

    await user.click(orderLink);
    expect(await screen.findByText('ORDER DETAIL PAGE')).toBeInTheDocument();
  });

  it('renders no reference row when the answer is not about a specific order', async () => {
    const user = userEvent.setup();
    shopOrdersApi.ask.mockResolvedValue({
      answer: "You don't have any orders yet.",
      references: [],
    });

    renderPage();

    await user.type(await screen.findByLabelText(/ask about your orders/i), 'anything');
    await user.click(screen.getByRole('button', { name: /^ask$/i }));

    expect(await screen.findByText("You don't have any orders yet.")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /ORD-/i })).not.toBeInTheDocument();
  });
});
