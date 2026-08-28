import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { CartProvider, useCart } from './CartContext';
import { shopCartApi } from '../api/shopResources';

/**
 * The cart — a guest's localStorage-backed state, the server cart for a
 * signed-in buyer, and the merge between the two the moment `isSignedIn`
 * flips true.
 *
 * `useBuyerAuth` is mocked directly rather than rendered through a real
 * `BuyerAuthProvider`, so a test can flip `isSignedIn` on demand without
 * driving a real sign-in through the (also-mocked) auth API. `mockAuthState`
 * is a plain, reassignable object read by the mock on every render, which is
 * what lets `rerender()` simulate "the buyer just signed in".
 */
vi.mock('../api/shopResources', () => ({
  shopCartApi: {
    get: vi.fn(),
    addItem: vi.fn(),
    updateItem: vi.fn(),
    removeItem: vi.fn(),
    merge: vi.fn(),
  },
}));

let mockAuthState = { isSignedIn: false };
vi.mock('./BuyerAuthContext', () => ({
  useBuyerAuth: () => mockAuthState,
}));

const STORAGE_KEY = 'simplecrm_shop_cart';

function product(overrides = {}) {
  return { _id: 'p1', name: 'Widget', price: 10, imageUrl: '', ...overrides };
}

function setup() {
  return renderHook(() => useCart(), { wrapper: CartProvider });
}

describe('CartContext — guest cart', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuthState = { isSignedIn: false };
    vi.clearAllMocks();
  });

  it('starts empty when nothing is in localStorage', () => {
    const { result } = setup();
    expect(result.current.items).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.total).toBe(0);
  });

  it('adds an item without calling the server, and persists it to localStorage', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.addItem(product(), 2);
    });

    expect(result.current.items).toEqual([{ product: product(), quantity: 2 }]);
    expect(result.current.count).toBe(2);
    expect(result.current.total).toBe(20);
    expect(shopCartApi.addItem).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual([
      { product: product(), quantity: 2 },
    ]);
  });

  it('adding the same product twice merges quantities on one line rather than duplicating it', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.addItem(product(), 1);
    });
    await act(async () => {
      await result.current.addItem(product(), 3);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].quantity).toBe(4);
  });

  it('updates a line quantity locally', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.addItem(product(), 1);
    });

    await act(async () => {
      await result.current.updateItem('p1', 5);
    });

    expect(result.current.items[0].quantity).toBe(5);
    expect(shopCartApi.updateItem).not.toHaveBeenCalled();
  });

  it('removes a line locally and updates localStorage', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.addItem(product(), 1);
    });

    await act(async () => {
      await result.current.removeItem('p1');
    });

    expect(result.current.items).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual([]);
    expect(shopCartApi.removeItem).not.toHaveBeenCalled();
  });

  it('clear() empties the cart and localStorage', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.addItem(product(), 1);
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.items).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
  });
});

describe('CartContext — signed-in buyer', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuthState = { isSignedIn: true };
    vi.clearAllMocks();
    shopCartApi.get.mockResolvedValue({ items: [] });
  });

  it('reads and writes through the server API, not localStorage', async () => {
    shopCartApi.addItem.mockResolvedValue({ items: [{ product: product(), quantity: 1 }] });
    const { result } = setup();

    await waitFor(() => expect(shopCartApi.get).toHaveBeenCalled());

    await act(async () => {
      await result.current.addItem(product(), 1);
    });

    expect(shopCartApi.addItem).toHaveBeenCalledWith('p1', 1);
    expect(result.current.items).toEqual([{ product: product(), quantity: 1 }]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('CartContext — guest-to-buyer merge on sign-in', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuthState = { isSignedIn: false };
    vi.clearAllMocks();
  });

  it('merges the guest cart into the server cart exactly once, then clears localStorage', async () => {
    const guestLine = { product: product({ _id: 'g1', name: 'Guest item' }), quantity: 3 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([guestLine]));

    const serverCart = { items: [guestLine] };
    shopCartApi.merge.mockResolvedValue(serverCart);
    shopCartApi.get.mockResolvedValue(serverCart);

    const { result, rerender } = setup();

    // Still a guest: the local cart is what's shown, and nothing has been
    // sent to the server yet.
    expect(result.current.items).toEqual([guestLine]);
    expect(shopCartApi.merge).not.toHaveBeenCalled();

    // The buyer signs in.
    mockAuthState = { isSignedIn: true };
    rerender();

    await waitFor(() => expect(shopCartApi.merge).toHaveBeenCalledTimes(1));
    expect(shopCartApi.merge).toHaveBeenCalledWith([{ product: 'g1', quantity: 3 }]);

    await waitFor(() => expect(result.current.items).toEqual(serverCart.items));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
    expect(shopCartApi.get).toHaveBeenCalledTimes(1);

    // Further re-renders while still signed in must NOT merge again — this
    // is the trickiest part of the whole flow: the merge is a one-time,
    // per-sign-in event, not something that re-fires on every render.
    rerender();
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shopCartApi.merge).toHaveBeenCalledTimes(1);
    expect(shopCartApi.get).toHaveBeenCalledTimes(1);
  });

  it('skips the merge call entirely when the guest cart was empty, but still loads the server cart', async () => {
    const serverCart = { items: [{ product: product(), quantity: 1 }] };
    shopCartApi.get.mockResolvedValue(serverCart);

    const { result, rerender } = setup();

    mockAuthState = { isSignedIn: true };
    rerender();

    await waitFor(() => expect(result.current.items).toEqual(serverCart.items));
    expect(shopCartApi.merge).not.toHaveBeenCalled();
  });

  it('merges again on a second, later sign-in (sign out, then back in)', async () => {
    const guestLine = { product: product({ _id: 'g1' }), quantity: 1 };
    shopCartApi.merge.mockResolvedValue({ items: [guestLine] });
    shopCartApi.get.mockResolvedValue({ items: [guestLine] });

    localStorage.setItem(STORAGE_KEY, JSON.stringify([guestLine]));
    const { rerender } = setup();

    mockAuthState = { isSignedIn: true };
    rerender();
    await waitFor(() => expect(shopCartApi.merge).toHaveBeenCalledTimes(1));

    // Sign back out, add something new as a guest, sign in again.
    mockAuthState = { isSignedIn: false };
    rerender();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([guestLine]));

    mockAuthState = { isSignedIn: true };
    rerender();

    await waitFor(() => expect(shopCartApi.merge).toHaveBeenCalledTimes(2));
  });
});
