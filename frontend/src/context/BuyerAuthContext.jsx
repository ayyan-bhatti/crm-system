import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { shopAuthApi } from '../api/shopResources';
import { onShopSessionExpired } from '../api/shopClient';

/**
 * The buyer-track equivalent of `AuthContext` — holds the signed-in buyer,
 * nothing else. See `shopClient.js` for why this is a wholly separate
 * context rather than a second mode of `AuthContext`: the two sessions must
 * never be able to interfere with each other, and that starts with not
 * sharing a React context any more than they share a cookie name.
 *
 * Deliberately simpler than `AuthContext`: no cross-tab session-adoption
 * machinery. That complexity exists on the staff side because a device
 * shared between colleagues switching accounts is a real, sensitive
 * scenario (the wrong person's data left on screen). A storefront browser
 * is overwhelmingly one shopper, and the guest-cart-merge-on-login flow
 * already handles the one legitimate multi-tab case (an incomplete cart
 * from before signing in) without needing cross-tab session sync at all.
 */
const BuyerAuthContext = createContext(null);

export function BuyerAuthProvider({ children }) {
  const [buyer, setBuyer] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    shopAuthApi
      .me()
      .then((nextBuyer) => {
        if (!cancelled) setBuyer(nextBuyer);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => onShopSessionExpired(() => setBuyer(null)), []);

  const logout = useCallback(async () => {
    try {
      await shopAuthApi.logout();
    } catch {
      // Still end the local session even if the network call failed.
    }
    setBuyer(null);
  }, []);

  const value = useMemo(
    () => ({
      buyer,
      loading,
      isSignedIn: Boolean(buyer),

      login: (email, password) =>
        shopAuthApi.login({ email, password }).then(({ buyer: nextBuyer }) => {
          setBuyer(nextBuyer);
          return nextBuyer;
        }),

      register: (payload) =>
        shopAuthApi.register(payload).then(({ buyer: nextBuyer }) => {
          setBuyer(nextBuyer);
          return nextBuyer;
        }),

      logout,
    }),
    [buyer, loading, logout]
  );

  return <BuyerAuthContext.Provider value={value}>{children}</BuyerAuthContext.Provider>;
}

export function useBuyerAuth() {
  const context = useContext(BuyerAuthContext);
  if (!context) throw new Error('useBuyerAuth must be used inside a <BuyerAuthProvider>');
  return context;
}
