import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TrackOrder from './TrackOrder';
import { trackingApi } from '../../api/shopResources';

/**
 * The public tracking page needs no session of any kind — no BuyerAuthProvider,
 * no ToastProvider, just the router. That absence is itself part of what this
 * page is for: a guest checkout has no account to sign into.
 */
vi.mock('../../api/shopResources', () => ({
  trackingApi: { track: vi.fn() },
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <TrackOrder />
    </MemoryRouter>
  );
}

describe('TrackOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    await user.type(screen.getByLabelText(/order number/i), 'ORD-000142');
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

    await user.type(screen.getByLabelText(/order number/i), 'ORD-999999');
    await user.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /track order/i }));

    expect(await screen.findByText(/no order matches/i)).toBeInTheDocument();
  });
});
