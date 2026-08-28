import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useBuyerAuth } from '../context/BuyerAuthContext';
import { useCart } from '../context/CartContext';
import CartDrawer from './CartDrawer';

/**
 * The storefront's shell — deliberately its OWN layout rather than a
 * reskinned `DashboardLayout`. The two audiences want different things from
 * a header: a shopper wants a logo, a search bar and a cart; a member of
 * staff wants a dense nav to a dozen internal sections. Forcing one
 * component to be both would mean permanent conditionals in the one piece
 * of chrome every page shares.
 */
export default function ShopLayout() {
  const { buyer, isSignedIn, logout } = useBuyerAuth();
  const { count } = useCart();
  const [cartOpen, setCartOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col bg-plane text-ink">
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link to="/shop" className="font-display text-xl font-semibold tracking-tight text-ink">
            SimpleCRM Shop
          </Link>

          <nav className="flex items-center gap-4 text-sm">
            <Link to="/shop/products" className="text-ink-2 hover:text-ink">
              Shop
            </Link>

            {isSignedIn ? (
              <>
                <Link to="/shop/account/orders" className="text-ink-2 hover:text-ink">
                  My orders
                </Link>
                <span className="hidden text-ink-2 sm:inline">Hi, {buyer.name.split(' ')[0]}</span>
                <button type="button" onClick={logout} className="text-ink-2 hover:text-ink">
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/shop/login" className="text-ink-2 hover:text-ink">
                Sign in
              </Link>
            )}

            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="relative flex items-center gap-1 rounded-lg border border-hairline px-3 py-1.5 text-ink hover:bg-neutral-wash"
              aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}
            >
              Cart
              {count > 0 && (
                <span className="ml-1 rounded-full bg-brand px-1.5 text-xs font-semibold text-white">
                  {count}
                </span>
              )}
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-hairline bg-surface py-8 text-center text-sm text-muted">
        SimpleCRM Shop — a demonstration storefront.
      </footer>

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </div>
  );
}
