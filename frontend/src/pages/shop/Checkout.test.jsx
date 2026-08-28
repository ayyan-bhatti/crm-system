import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Checkout from './Checkout';
import { BuyerAuthProvider } from '../../context/BuyerAuthContext';
import { CartProvider } from '../../context/CartContext';
import { shopAuthApi, shopCartApi, shopCheckoutApi } from '../../api/shopResources';
import { apiError } from '../../test/utils';

/**
 * Checkout.
 *
 * Only `api/shopResources` is mocked — the real `BuyerAuthProvider` and
 * `CartProvider` are mounted, same reasoning as `renderWithProviders` on the
 * staff side: the guard logic under test (the sign-in requirement, the "no
 * saved addresses" block, the empty-cart redirect) all lives in the real
 * context/provider wiring, not in a stand-in.
 *
 * Guest checkout was removed from this screen (the backend endpoint still
 * accepts a guest payload — see the note at the top of Checkout.jsx — it is
 * just unreachable from here now): an unauthenticated visitor is redirected
 * straight to sign-in rather than shown a delivery-details form, so there is
 * no more "as a guest" form-filling coverage here.
 */
vi.mock('../../api/shopResources', () => ({
  shopAuthApi: { me: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn() },
  shopCartApi: {
    get: vi.fn(),
    addItem: vi.fn(),
    updateItem: vi.fn(),
    removeItem: vi.fn(),
    merge: vi.fn(),
  },
  shopCheckoutApi: { checkout: vi.fn() },
}));

const STORAGE_KEY = 'simplecrm_shop_cart';

function seedGuestCart(lines) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
}

const guestLine = {
  product: { _id: 'p1', name: 'Widget', price: 20, imageUrl: '' },
  quantity: 1,
};

/** Renders where the "/login" redirect landed, including the `state.from` it carried. */
function LoginRouteProbe() {
  const location = useLocation();
  return <p>LOGIN PAGE (from: {location.state?.from ?? 'none'})</p>;
}

/** A tiny router so navigation targets (login, confirmation vs. back to products) are observable. */
function renderCheckout() {
  return render(
    <MemoryRouter initialEntries={['/checkout']}>
      <BuyerAuthProvider>
        <CartProvider>
          <Routes>
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/products" element={<p>PRODUCTS PAGE</p>} />
            <Route path="/order-confirmation/:id" element={<p>CONFIRMATION PAGE</p>} />
            <Route path="/login" element={<LoginRouteProbe />} />
          </Routes>
        </CartProvider>
      </BuyerAuthProvider>
    </MemoryRouter>
  );
}

describe('Checkout', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  /**
   * Replaces the old guest-form coverage: reaching this page without a buyer
   * session no longer renders a delivery-details form at all, it redirects.
   * `state.from` is what lets the login page send the buyer back here once
   * they've signed in — see Checkout.jsx and CartContext's guest-cart merge.
   */
  it('sends an unauthenticated visitor to sign in, remembering checkout as the way back', async () => {
    shopAuthApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    seedGuestCart([guestLine]);

    renderCheckout();

    expect(await screen.findByText('LOGIN PAGE (from: /checkout)')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^name/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /place order/i })).not.toBeInTheDocument();
  });

  it('redirects to the product grid when a signed-in buyer’s cart is empty', async () => {
    shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza', addresses: [] });
    shopCartApi.get.mockResolvedValue({ items: [] });

    renderCheckout();

    expect(await screen.findByText('PRODUCTS PAGE')).toBeInTheDocument();
  });

  describe('as a signed-in buyer', () => {
    it('cannot submit with zero saved addresses', async () => {
      const user = userEvent.setup();
      shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza', addresses: [] });
      shopCartApi.get.mockResolvedValue({ items: [guestLine] });

      renderCheckout();

      expect(await screen.findByText(/no saved addresses/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /place order/i }));

      expect(await screen.findByText(/add a delivery address before checking out/i)).toBeInTheDocument();
      expect(shopCheckoutApi.checkout).not.toHaveBeenCalled();
      expect(screen.queryByText('CONFIRMATION PAGE')).not.toBeInTheDocument();
    });

    /**
     * The sequence the guard on `submitting` exists for: cart has items,
     * submission succeeds, the cart clears — and the redirect to
     * /products must NOT win the race against the navigate() to the
     * confirmation page that the same submission already triggered.
     */
    it('submits with a selected saved address and goes to the order confirmation page, never back to the product grid', async () => {
      const user = userEvent.setup();
      shopAuthApi.me.mockResolvedValue({
        _id: 'b1',
        name: 'Amina Raza',
        addresses: [{ _id: 'addr-1', label: 'Home', address: '12 Mall Road' }],
      });
      shopCartApi.get.mockResolvedValue({ items: [guestLine] });
      shopCheckoutApi.checkout.mockResolvedValue({ _id: 'order-2', status: 'pending', items: [], total: 20 });

      renderCheckout();

      await screen.findByText('Home');
      await user.click(screen.getByRole('button', { name: /place order/i }));

      await waitFor(() =>
        expect(shopCheckoutApi.checkout).toHaveBeenCalledWith(
          [{ product: 'p1', quantity: 1 }],
          undefined,
          'addr-1',
          'cod'
        )
      );
      expect(await screen.findByText('CONFIRMATION PAGE')).toBeInTheDocument();
      expect(screen.queryByText('PRODUCTS PAGE')).not.toBeInTheDocument();
    });
  });
});
