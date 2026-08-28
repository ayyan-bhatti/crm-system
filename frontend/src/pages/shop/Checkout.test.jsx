import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
 * staff side: the guard logic under test (the guest-form validation, the
 * "no saved addresses" block, the empty-cart redirect) all lives in the real
 * context/provider wiring, not in a stand-in.
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

/** A tiny router so navigation targets (confirmation vs. back to products) are observable. */
function renderCheckout() {
  return render(
    <MemoryRouter initialEntries={['/shop/checkout']}>
      <BuyerAuthProvider>
        <CartProvider>
          <Routes>
            <Route path="/shop/checkout" element={<Checkout />} />
            <Route path="/shop/products" element={<p>PRODUCTS PAGE</p>} />
            <Route
              path="/shop/order-confirmation/:id"
              element={<p>CONFIRMATION PAGE</p>}
            />
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

  it('redirects to the product grid when the cart is empty', async () => {
    shopAuthApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));

    renderCheckout();

    expect(await screen.findByText('PRODUCTS PAGE')).toBeInTheDocument();
  });

  describe('as a guest', () => {
    beforeEach(() => {
      shopAuthApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
      seedGuestCart([guestLine]);
    });

    it('shows the guest delivery-details form', async () => {
      renderCheckout();

      expect(await screen.findByLabelText(/^name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^address/i)).toBeInTheDocument();
    });

    it('blocks submission and shows field errors when required fields are empty', async () => {
      const user = userEvent.setup();
      renderCheckout();

      const submit = await screen.findByRole('button', { name: /place order/i });
      await user.click(submit);

      expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
      expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
      expect(screen.getByText('Enter a delivery address.')).toBeInTheDocument();
      expect(shopCheckoutApi.checkout).not.toHaveBeenCalled();
      // Still on checkout — no navigation happened.
      expect(screen.queryByText('PRODUCTS PAGE')).not.toBeInTheDocument();
      expect(screen.queryByText('CONFIRMATION PAGE')).not.toBeInTheDocument();
    });

    it('marks the required guest fields with aria-required', async () => {
      renderCheckout();

      expect(await screen.findByLabelText(/^name/i)).toHaveAttribute('aria-required', 'true');
      expect(screen.getByLabelText(/^email/i)).toHaveAttribute('aria-required', 'true');
      expect(screen.getByLabelText(/^address/i)).toHaveAttribute('aria-required', 'true');
      // Phone and city are optional.
      expect(screen.getByLabelText(/^phone/i)).not.toHaveAttribute('aria-required');
      expect(screen.getByLabelText(/^city/i)).not.toHaveAttribute('aria-required');
    });

    /**
     * The sequence the guard on `submitting` exists for: cart has items,
     * submission succeeds, the cart clears — and the redirect to
     * /shop/products must NOT win the race against the navigate() to the
     * confirmation page that the same submission already triggered.
     */
    it('goes to the order confirmation page on success, never back to the product grid', async () => {
      const user = userEvent.setup();
      shopCheckoutApi.checkout.mockResolvedValue({ _id: 'order-1', status: 'pending', items: [], total: 20 });

      renderCheckout();

      await user.type(await screen.findByLabelText(/^name/i), 'Amina Raza');
      await user.type(screen.getByLabelText(/^email/i), 'amina@example.com');
      await user.type(screen.getByLabelText(/^address/i), '12 Mall Road');
      await user.click(screen.getByRole('button', { name: /place order/i }));

      await waitFor(() => expect(shopCheckoutApi.checkout).toHaveBeenCalled());
      expect(await screen.findByText('CONFIRMATION PAGE')).toBeInTheDocument();
      expect(screen.queryByText('PRODUCTS PAGE')).not.toBeInTheDocument();

      // The guest cart was cleared as part of the same submission.
      expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
    });
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

    it('submits with a selected saved address', async () => {
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
          'addr-1'
        )
      );
      expect(await screen.findByText('CONFIRMATION PAGE')).toBeInTheDocument();
    });
  });
});
