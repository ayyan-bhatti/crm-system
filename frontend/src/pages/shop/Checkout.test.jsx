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
 * GUEST CHECKOUT IS GONE, at both ends. It was previously disabled on this
 * screen while the backend endpoint still accepted a guest payload; the
 * endpoint now runs `protectBuyer` and the permissive middleware has been
 * deleted, so there is no guest path left to reach. An unauthenticated visitor
 * is redirected straight to sign-in rather than shown a delivery-details form.
 */
vi.mock('../../api/shopResources', () => ({
  shopAuthApi: {
    me: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    addAddress: vi.fn(),
  },
  shopCartApi: {
    get: vi.fn(),
    addItem: vi.fn(),
    updateItem: vi.fn(),
    removeItem: vi.fn(),
    merge: vi.fn(),
  },
  shopCheckoutApi: { checkout: vi.fn(), session: vi.fn(), reconcile: vi.fn() },
}));

/**
 * `window.location.assign` is what hands the browser over to Stripe, and jsdom
 * refuses to implement navigation — calling the real one logs a "Not
 * implemented" error and does nothing observable. Replacing the whole location
 * object is the supported way to make that call assertable; `writable: true`
 * is required because `window.location` is otherwise non-configurable.
 */
const locationAssign = vi.fn();
Object.defineProperty(window, 'location', {
  writable: true,
  value: { ...window.location, assign: locationAssign, search: '' },
});

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
    /**
     * The address requirement is enforced by DISABLING the button, not by
     * letting the submission through and reporting an error afterwards. The
     * server also refuses — it no longer falls back to `addresses[0]`, which
     * used to silently post a parcel to whichever address happened to sort
     * first — so this is the front half of one rule rather than a second one.
     */
    it('cannot submit with zero saved addresses', async () => {
      shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza', addresses: [] });
      shopCartApi.get.mockResolvedValue({ items: [guestLine] });

      renderCheckout();

      expect(await screen.findByText(/no saved addresses/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /pay/i })).toBeDisabled();
      expect(shopCheckoutApi.checkout).not.toHaveBeenCalled();
      expect(screen.queryByText('CONFIRMATION PAGE')).not.toBeInTheDocument();
    });

    /**
     * The sequence the guard on `submitting` exists for: cart has items,
     * submission succeeds, the cart clears — and the redirect to
     * /products must NOT win the race against the navigate() to the
     * confirmation page that the same submission already triggered.
     */
    it('places a cash-on-delivery order and goes to the confirmation page, never back to the product grid', async () => {
      const user = userEvent.setup();
      shopAuthApi.me.mockResolvedValue({
        _id: 'b1',
        name: 'Amina Raza',
        addresses: [{ _id: 'addr-1', label: 'Home', address: '12 Mall Road', city: 'Lahore' }],
      });
      shopCartApi.get.mockResolvedValue({ items: [guestLine] });
      shopCheckoutApi.checkout.mockResolvedValue({
        mode: 'direct',
        data: { _id: 'order-2', status: 'pending', items: [], total: 20 },
      });

      renderCheckout();

      await screen.findByText('Home');
      // Card is the default, so cash on delivery has to be chosen explicitly.
      await user.click(screen.getByRole('radio', { name: /cash on delivery/i }));
      await user.click(screen.getByRole('button', { name: /place order/i }));

      await waitFor(() =>
        expect(shopCheckoutApi.checkout).toHaveBeenCalledWith(
          [{ product: 'p1', quantity: 1, variantId: null }],
          'addr-1',
          'cod'
        )
      );
      expect(await screen.findByText('CONFIRMATION PAGE')).toBeInTheDocument();
      expect(screen.queryByText('PRODUCTS PAGE')).not.toBeInTheDocument();
    });

    /**
     * THE CARD PATH CREATES NO ORDER AND MUST NOT CLEAR THE CART.
     *
     * The response carries a Stripe URL rather than an order, and the browser
     * is handed over to it. Clearing the cart here would be the natural-looking
     * thing to do and is wrong: nothing has been bought yet, so a buyer who
     * closes the tab at the card form has to come back to a full cart rather
     * than an empty one and a payment that never happened. The webhook clears
     * it, once, when the order genuinely exists.
     */
    it('hands the browser to Stripe on the card path, without creating an order or emptying the cart', async () => {
      const user = userEvent.setup();
      shopAuthApi.me.mockResolvedValue({
        _id: 'b1',
        name: 'Amina Raza',
        addresses: [{ _id: 'addr-1', label: 'Home', address: '12 Mall Road', city: 'Lahore' }],
      });
      shopCartApi.get.mockResolvedValue({ items: [guestLine] });
      shopCheckoutApi.checkout.mockResolvedValue({
        mode: 'stripe',
        data: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1' },
      });

      renderCheckout();

      await screen.findByText('Home');
      await user.click(screen.getByRole('button', { name: /^pay/i }));

      await waitFor(() =>
        expect(shopCheckoutApi.checkout).toHaveBeenCalledWith(
          [{ product: 'p1', quantity: 1, variantId: null }],
          'addr-1',
          'card'
        )
      );

      await waitFor(() =>
        expect(locationAssign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1')
      );

      expect(screen.queryByText('CONFIRMATION PAGE')).not.toBeInTheDocument();
    });

    /** Variant lines carry their variant id through to the server. */
    it('sends the chosen variant with each line', async () => {
      const user = userEvent.setup();
      shopAuthApi.me.mockResolvedValue({
        _id: 'b1',
        name: 'Amina Raza',
        addresses: [{ _id: 'addr-1', label: 'Home', address: '12 Mall Road', city: 'Lahore' }],
      });
      shopCartApi.get.mockResolvedValue({
        items: [
          {
            product: { _id: 'p1', name: 'Jacket', price: 20, imageUrl: '' },
            quantity: 2,
            variant: { variantId: 'v1', colorName: 'Midnight', colorHex: '#111827', size: 'M' },
          },
        ],
      });
      shopCheckoutApi.checkout.mockResolvedValue({
        mode: 'direct',
        data: { _id: 'order-3', status: 'pending', items: [], total: 40 },
      });

      renderCheckout();

      await screen.findByText('Home');
      // The chosen variant is visible on the summary line, not just in the payload.
      expect(screen.getByText('Midnight / M')).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: /cash on delivery/i }));
      await user.click(screen.getByRole('button', { name: /place order/i }));

      await waitFor(() =>
        expect(shopCheckoutApi.checkout).toHaveBeenCalledWith(
          [{ product: 'p1', quantity: 2, variantId: 'v1' }],
          'addr-1',
          'cod'
        )
      );
    });
  });
});
