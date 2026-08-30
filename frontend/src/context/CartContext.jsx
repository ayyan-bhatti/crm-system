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
 * This is unchanged by checkout now requiring an account. Browsing and filling
 * a cart are still completely open; only the act of buying moved behind a
 * sign-in, and the cart is what carries a visitor's intent across that line.
 *
 * THE MERGE
 *
 * The moment `isSignedIn` flips true — a login, or a registration — whatever
 * was in the guest cart is folded into the buyer's server cart (quantities
 * add on a shared line, same as adding twice), then the local copy is
 * cleared. Someone who adds three things while browsing and only signs in at
 * checkout does not lose them.
 *
 * A LINE IS A PRODUCT **AND** A VARIANT.
 *
 * Two colours of one shirt are two independent lines, so every lookup goes
 * through `lineKey` rather than comparing product ids. Using the product alone
 * would make "remove the blue one" impossible to express, and would silently
 * merge two different things into one quantity.
 */

const STORAGE_KEY = 'simplecrm_shop_cart';
const CartContext = createContext(null);

/**
 * The identity of a cart line.
 *
 * Exported because the drawer and the checkout summary both need a stable React
 * key, and a key derived differently in three places is a key that eventually
 * disagrees with itself.
 */
export function lineKey(productId, variantId) {
  return `${productId}::${variantId || ''}`;
}

function keyOfLine(line) {
  return lineKey(line.product._id, line.variant?.variantId);
}

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
          guestItems.map((line) => ({
            product: line.product._id,
            quantity: line.quantity,
            variantId: line.variant?.variantId || null,
          }))
        );
        writeLocalCart([]);
      }
      await loadServerCart();
    })();
  }, [isSignedIn, loadServerCart]);

  /**
   * Add a line.
   *
   * `product` is the shape the product list/detail pages already have;
   * `variant` is the chosen one from `product.variants`, or null for a product
   * that has none. The variant is stored in the SNAPSHOT shape the server uses
   * on an order line (`colorName`/`colorHex`), so a guest cart in localStorage
   * and a server cart present identically to every consumer — the drawer does
   * not need to know which kind of cart it is rendering.
   */
  const addItem = useCallback(
    async (product, quantity = 1, variant = null) => {
      const variantId = variant?._id || variant?.variantId || null;

      if (isSignedIn) {
        const cart = await shopCartApi.addItem(product._id, quantity, variantId);
        setItems(cart.items);
        return;
      }

      const snapshot = variant
        ? {
            variantId,
            colorName: variant.colorName || variant.color?.name || '',
            colorHex: variant.colorHex || variant.color?.hex || '',
            size: variant.size || '',
          }
        : null;

      // The variant's own price when it overrides, so a guest's running total
      // matches what checkout will charge.
      const unitPrice = variant?.price ?? product.price;

      setItems((current) => {
        const key = lineKey(product._id, variantId);
        const existing = current.find((line) => keyOfLine(line) === key);

        const next = existing
          ? current.map((line) =>
              keyOfLine(line) === key ? { ...line, quantity: line.quantity + quantity } : line
            )
          : [
              ...current,
              { product: { ...product, price: unitPrice }, quantity, variant: snapshot },
            ];

        writeLocalCart(next);
        return next;
      });
    },
    [isSignedIn]
  );

  const updateItem = useCallback(
    async (productId, quantity, variantId = null) => {
      if (isSignedIn) {
        const cart = await shopCartApi.updateItem(productId, quantity, variantId);
        setItems(cart.items);
        return;
      }

      setItems((current) => {
        const key = lineKey(productId, variantId);
        const next = current.map((line) =>
          keyOfLine(line) === key ? { ...line, quantity } : line
        );
        writeLocalCart(next);
        return next;
      });
    },
    [isSignedIn]
  );

  const removeItem = useCallback(
    async (productId, variantId = null) => {
      if (isSignedIn) {
        const cart = await shopCartApi.removeItem(productId, variantId);
        setItems(cart.items);
        return;
      }

      setItems((current) => {
        const key = lineKey(productId, variantId);
        const next = current.filter((line) => keyOfLine(line) !== key);
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
