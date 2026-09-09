import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { shopWishlistApi } from '../api/shopResources';
import { useBuyerAuth } from './BuyerAuthContext';

/**
 * The wishlist — client-side state for a guest, the server list for a
 * signed-in buyer, merged the moment they sign in. Deliberately the same
 * shape of decision as `CartContext`, simplified: a wishlist has no
 * quantity and no variant, so a line is just a product.
 */

const STORAGE_KEY = 'simplecrm_shop_wishlist';
const WishlistContext = createContext(null);

function readLocalWishlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalWishlist(products) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(products));
  } catch {
    // A private window or a full quota drops the write silently — same
    // degradation as the cart's local store.
  }
}

export function WishlistProvider({ children }) {
  const { isSignedIn } = useBuyerAuth();
  const [items, setItems] = useState(() => readLocalWishlist());
  const [loading, setLoading] = useState(false);
  const merged = useRef(false);

  const loadServerWishlist = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await shopWishlistApi.get());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      merged.current = false;
      setItems(readLocalWishlist());
      return;
    }

    if (merged.current) return;
    merged.current = true;

    const guestItems = readLocalWishlist();

    (async () => {
      if (guestItems.length) {
        await shopWishlistApi.merge(guestItems.map((p) => p._id));
        writeLocalWishlist([]);
      }
      await loadServerWishlist();
    })();
  }, [isSignedIn, loadServerWishlist]);

  const has = useCallback((productId) => items.some((p) => p._id === productId), [items]);

  const add = useCallback(
    async (product) => {
      if (isSignedIn) {
        setItems(await shopWishlistApi.add(product._id));
        return;
      }
      setItems((current) => {
        if (current.some((p) => p._id === product._id)) return current;
        const next = [product, ...current];
        writeLocalWishlist(next);
        return next;
      });
    },
    [isSignedIn]
  );

  const remove = useCallback(
    async (productId) => {
      if (isSignedIn) {
        setItems(await shopWishlistApi.remove(productId));
        return;
      }
      setItems((current) => {
        const next = current.filter((p) => p._id !== productId);
        writeLocalWishlist(next);
        return next;
      });
    },
    [isSignedIn]
  );

  const toggle = useCallback(
    (product) => (has(product._id) ? remove(product._id) : add(product)),
    [has, add, remove]
  );

  const value = useMemo(
    () => ({ items, loading, count: items.length, has, add, remove, toggle }),
    [items, loading, has, add, remove, toggle]
  );

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist() {
  const context = useContext(WishlistContext);
  if (!context) throw new Error('useWishlist must be used inside a <WishlistProvider>');
  return context;
}
