import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { shopCartApi } from '../api/shopResources';
import { useBuyerAuth } from './BuyerAuthContext';

/**
 * The shopping cart — client-side state for a guest, the server cart for a
 * signed-in buyer, and the merge between the two at the moment of login.
 *
 * WHY A GUEST'S CART NEVER TOUCHES THE SERVER
 *
 * There is nothing to protect and nothing to survive a device change for —
 * a guest has no account for the cart to be attached to. Keeping it in
 * `localStorage` means adding to cart works instantly, offline, with zero
 * backend involvement, which is the right cost for state nobody but this
 * browser will ever read.
 *
 * THE MERGE
 *
 * The moment `isSignedIn` flips true — a login, or a registration — whatever
 * was in the guest cart is folded into the buyer's server cart (quantities
 * add on a shared line, same as adding twice), then the local copy is
 * cleared. Someone who adds three things while browsing and only signs in at
 * checkout does not lose them.
 */

const STORAGE_KEY = 'simplecrm_shop_cart';
const CartContext = createContext(null);

function readLocalCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalCart(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // A private window or a full quota drops the write silently — the cart
    // simply doesn't persist across a reload, which is the same experience
    // as never having saved it. Nothing about adding an item should fail.
  }
}

export function CartProvider({ children }) {
  const { isSignedIn } = useBuyerAuth();
  const [items, setItems] = useState(() => readLocalCart());
  const [loading, setLoading] = useState(false);
  const merged = useRef(false);

  /*
   * Closes a real race between this context and `BuyerAuthContext`: the
   * moment a buyer's session check resolves, `isSignedIn` flips true here —
   * but the server cart is only fetched from the effect below, which cannot
   * run until AFTER this render has already committed. Left alone, that is
   * one full render where `isSignedIn` reads true while `items` is still
   * whatever the guest cart held (usually `[]`) and `loading` is still
   * `false` — long enough for a consumer's "cart is empty" guard (Checkout's
   * empty-cart redirect, most consequentially) to act on stale information
   * before the real cart has even been asked for.
   *
   * Setting `loading` HERE, during render, rather than only from the effect,
   * is the documented way to avoid that stale frame: a `setState` call made
   * while rendering, guarded on a comparison against the previous value, is
   * applied before this render commits, so the very first render that sees
   * `isSignedIn: true` already reports `loading: true` too. The merge/fetch
   * logic itself is untouched below — this only makes the "still working on
   * it" signal arrive on time.
   */
  const [prevIsSignedIn, setPrevIsSignedIn] = useState(isSignedIn);
  if (isSignedIn !== prevIsSignedIn) {
    setPrevIsSignedIn(isSignedIn);
    if (isSignedIn) setLoading(true);
  }

  const loadServerCart = useCallback(async () => {
    setLoading(true);
    try {
      const cart = await shopCartApi.get();
      setItems(cart.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      merged.current = false;
      setItems(readLocalCart());
      return;
    }

    if (merged.current) return;
    merged.current = true;

    const guestItems = readLocalCart();

    (async () => {
      if (guestItems.length) {
        await shopCartApi.merge(
          guestItems.map((line) => ({ product: line.product._id, quantity: line.quantity }))
        );
        writeLocalCart([]);
      }
      await loadServerCart();
    })();
  }, [isSignedIn, loadServerCart]);

  /** Add a line. `product` is the shape the product list/detail pages already have. */
  const addItem = useCallback(
    async (product, quantity = 1) => {
      if (isSignedIn) {
        const cart = await shopCartApi.addItem(product._id, quantity);
        setItems(cart.items);
        return;
      }

      setItems((current) => {
        const existing = current.find((line) => line.product._id === product._id);
        const next = existing
          ? current.map((line) =>
              line.product._id === product._id
                ? { ...line, quantity: line.quantity + quantity }
                : line
            )
          : [...current, { product, quantity }];

        writeLocalCart(next);
        return next;
      });
    },
    [isSignedIn]
  );

  const updateItem = useCallback(
    async (productId, quantity) => {
      if (isSignedIn) {
        const cart = await shopCartApi.updateItem(productId, quantity);
        setItems(cart.items);
        return;
      }

      setItems((current) => {
        const next = current.map((line) =>
          line.product._id === productId ? { ...line, quantity } : line
        );
        writeLocalCart(next);
        return next;
      });
    },
    [isSignedIn]
  );

  const removeItem = useCallback(
    async (productId) => {
      if (isSignedIn) {
        const cart = await shopCartApi.removeItem(productId);
        setItems(cart.items);
        return;
      }

      setItems((current) => {
        const next = current.filter((line) => line.product._id !== productId);
        writeLocalCart(next);
        return next;
      });
    },
    [isSignedIn]
  );

  const clear = useCallback(() => {
    setItems([]);
    if (!isSignedIn) writeLocalCart([]);
  }, [isSignedIn]);

  const total = useMemo(
    () =>
      Math.round(items.reduce((sum, line) => sum + line.product.price * line.quantity, 0) * 100) /
      100,
    [items]
  );

  const count = useMemo(() => items.reduce((sum, line) => sum + line.quantity, 0), [items]);

  const value = useMemo(
    () => ({ items, loading, total, count, addItem, updateItem, removeItem, clear }),
    [items, loading, total, count, addItem, updateItem, removeItem, clear]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used inside a <CartProvider>');
  return context;
}
