import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TrackOrder from './TrackOrder';
import { BuyerAuthProvider } from '../../context/BuyerAuthContext';
import { trackingApi, shopAuthApi } from '../../api/shopResources';

/**
 * The public tracking page works for a GUEST with no session at all — but it
 * now also has to behave differently for a signed-in buyer (see TrackOrder.jsx),
 * so it needs `BuyerAuthProvider` in the tree to know which case it is in.
 */
vi.mock('../../api/shopResources', () => ({
  trackingApi: { track: vi.fn() },
  shopAuthApi: { me: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() },
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <BuyerAuthProvider>
        <TrackOrder />
      </BuyerAuthProvider>
    </MemoryRouter>
  );
}

describe('TrackOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Guest by default — most of this suite is about the unauthenticated
    // lookup form, which is the case that exists today.
    shopAuthApi.me.mockRejectedValue({ response: { status: 401, data: {} } });
  });

  it('looks up the order by number and email, and shows the result', async () => {
    const user = userEvent.setup();
    trackingApi.track.mockResolvedValue({
      orderNumber: 'ORD-000142',
      fulfilment: 'shipped',
      createdAt: '2026-08-01T00:00:00.000Z',
      estimatedDeliveryAt: '2026-09-05T00:00:00.000Z',
      shippedAt: '2026-08-30T00:00:00.000Z',
      deliveredAt: null,
      itemCount: 2,
      courier: 'dhl',
      trackingNumber: 'JD0141',
    });

    renderPage();

    await user.type(await screen.findByLabelText(/order number/i), 'ORD-000142');
    await user.type(screen.getByLabelText(/email/i), 'reader@karachitraders.example');
    await user.click(screen.getByRole('button', { name: /track order/i }));

    expect(trackingApi.track).toHaveBeenCalledWith('ORD-000142', 'reader@karachitraders.example');
    expect(await screen.findByText('ORD-000142')).toBeInTheDocument();
    expect(screen.getByText(/2 items/i)).toBeInTheDocument();
    expect(screen.getByText(/Shipped with DHL/i)).toBeInTheDocument();
  });

  it('shows the same message the server sends back for a miss, without guessing which field was wrong', async () => {
    const user = userEvent.setup();
    trackingApi.track.mockRejectedValue({
      response: {
        status: 404,
        data: { message: 'No order matches that order number and email. Double-check both and try again.' },
      },
    });

    renderPage();

    await user.type(await screen.findByLabelText(/order number/i), 'ORD-999999');
    await user.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /track order/i }));

    expect(await screen.findByText(/no order matches/i)).toBeInTheDocument();
  });

  it('points a signed-in buyer at their own order history instead of asking for their email', async () => {
    shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza' });

    renderPage();

    expect(await screen.findByText(/go to your orders/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/order number/i)).not.toBeInTheDocument();
  });
});
