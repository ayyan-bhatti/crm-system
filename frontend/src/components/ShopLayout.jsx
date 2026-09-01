import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useBuyerAuth } from '../context/BuyerAuthContext';
import { useCart } from '../context/CartContext';
import { shopProductsApi, shopNewsletterApi } from '../api/shopResources';
import { errorMessage } from '../api/client';
import CartDrawer from './CartDrawer';
import MegaMenu from './shop/MegaMenu';
import { ANNOUNCEMENT, FOOTER_COLUMNS, NEWSLETTER, TRUST_BADGES } from '../shopContent';
import { input } from '../ui';

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [categories, setCategories] = useState([]);
  const location = useLocation();

  useEffect(() => {
    /*
     * The PUBLIC categories endpoint. This used to call the internal,
     * staff-only one, which answered 401 for every visitor without a CRM
     * session — and the failure was swallowed, so the category navigation
     * simply rendered nothing and looked like a design choice.
     */
    shopProductsApi.categories().then(setCategories).catch(() => {});
  }, []);

  // Any navigation closes the mobile drawer. Without this it stays open over
  // the page it just navigated to, which on a phone looks like the tap failed.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, location.search]);

  return (
    <div className="flex min-h-full flex-col bg-plane text-ink">
      {/*
        The announcement bar. Above the header rather than inside it, and it
        scrolls away with the page while the header sticks — it is an
        advertisement, and pinning it would spend permanent vertical space on a
        line nobody needs twice.
      */}
      <div className="bg-ink px-4 py-2 text-center text-xs font-medium tracking-wide text-plane/90">
        {ANNOUNCEMENT}
      </div>

      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileNavOpen((open) => !open)}
            className="-ml-1 rounded-lg p-2 text-ink-2 hover:bg-neutral-wash lg:hidden"
            aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileNavOpen}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
              {mobileNavOpen ? (
                <path d="M5.3 4.3a1 1 0 011.4 0L10 7.6l3.3-3.3a1 1 0 111.4 1.4L11.4 9l3.3 3.3a1 1 0 01-1.4 1.4L10 10.4l-3.3 3.3a1 1 0 01-1.4-1.4L8.6 9 5.3 5.7a1 1 0 010-1.4z" />
              ) : (
                <path d="M3 5.5A1 1 0 014 4.5h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4.5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm1 3.5a1 1 0 100 2h12a1 1 0 100-2H4z" />
              )}
            </svg>
          </button>

          <Link
            to="/"
            className="font-display shrink-0 text-xl font-semibold tracking-tight text-ink"
          >
            SimpleCRM Shop
          </Link>

          <MegaMenu categories={categories} />

          <nav className="ml-auto flex items-center gap-4 text-sm">
            {/* No sign-in required — a guest checkout has no account to sign into. */}
            <Link to="/track" className="hidden text-ink-2 hover:text-ink sm:inline">
              Track order
            </Link>

            {isSignedIn ? (
              <>
                <Link to="/account/orders" className="hidden text-ink-2 hover:text-ink sm:inline">
                  My orders
                </Link>
                <span className="hidden text-ink-2 lg:inline">
                  Hi, {buyer.name.split(' ')[0]}
                </span>
                <button type="button" onClick={logout} className="text-ink-2 hover:text-ink">
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className="text-ink-2 hover:text-ink">
                Sign in
              </Link>
            )}

            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="relative flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-ink hover:bg-neutral-wash"
              aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
                <path d="M6 6V5a4 4 0 118 0v1h2.2a1 1 0 01.99 1.14l-1.2 8.4A2 2 0 0114 17.3H6a2 2 0 01-1.98-1.72l-1.2-8.4A1 1 0 013.8 6H6zm2 0h4V5a2 2 0 10-4 0v1z" />
              </svg>
              <span className="hidden sm:inline">Cart</span>
              {count > 0 && (
                <span className="rounded-full bg-brand px-1.5 text-xs font-semibold text-white">
                  {count}
                </span>
              )}
            </button>

            {/*
              The CRM's one entry point from the storefront — deliberately
              small and last in the row. Staff are a tiny fraction of this
              header's audience, and this link is how they reach their own
              sign-in without the shop's front door ever implying that is
              what the site is for.
            */}
            <Link
              to="/crm"
              className="hidden border-l border-hairline pl-4 text-xs font-medium text-muted hover:text-ink-2 sm:inline"
            >
              CRM
            </Link>
          </nav>
        </div>

        {mobileNavOpen && (
          <div className="border-t border-hairline bg-surface px-4 py-3 lg:hidden">
            <Link to="/products" className="block py-2 text-sm font-medium text-ink">
              All products
            </Link>
            {categories.map((category) => (
              <Link
                key={category}
                to={`/products?category=${encodeURIComponent(category)}`}
                className="block py-2 text-sm text-ink-2"
              >
                {category}
              </Link>
            ))}
            <div className="mt-2 border-t border-hairline pt-2">
              {isSignedIn && (
                <Link to="/account/orders" className="block py-2 text-sm text-ink-2">
                  My orders
                </Link>
              )}
              <Link to="/track" className="block py-2 text-sm text-ink-2">
                Track order
              </Link>
              <Link to="/crm" className="block py-2 text-xs text-muted">
                Staff CRM
              </Link>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <TrustStrip />
      <Footer />

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </div>
  );
}

/** The reassurance row above the footer. Copy lives in shopContent.js. */
function TrustStrip() {
  const icons = {
    lock: 'M10 2a4 4 0 00-4 4v2H5a1 1 0 00-1 1v7a1 1 0 001 1h10a1 1 0 001-1V9a1 1 0 00-1-1h-1V6a4 4 0 00-4-4zm2 6H8V6a2 2 0 114 0v2z',
    truck:
      'M2 5a1 1 0 011-1h8a1 1 0 011 1v1h2.4a1 1 0 01.8.4l2.1 2.8a1 1 0 01.2.6V14a1 1 0 01-1 1h-1a2.5 2.5 0 01-5 0H8.5a2.5 2.5 0 01-5 0H3a1 1 0 01-1-1V5zm12 3v2h3l-1.5-2H14z',
    chat: 'M2 5a2 2 0 012-2h12a2 2 0 012 2v7a2 2 0 01-2 2H8.4l-3.7 3a.6.6 0 01-1-.5V14H4a2 2 0 01-2-2V5z',
  };

  return (
    <section className="border-t border-hairline bg-surface">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-10 sm:px-6 md:grid-cols-3">
        {TRUST_BADGES.map((badge) => (
          <div key={badge.title} className="flex gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-wash">
              <svg viewBox="0 0 20 20" className="h-4 w-4 fill-brand-ink" aria-hidden="true">
                <path d={icons[badge.icon]} />
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">{badge.title}</p>
              <p className="mt-0.5 text-sm text-ink-2">{badge.body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-hairline bg-plane">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4">
        <div className="md:col-span-2">
          <p className="font-display text-lg font-semibold text-ink">SimpleCRM Shop</p>
          <p className="mt-2 max-w-sm text-sm text-ink-2">
            A demonstration storefront built on the SimpleCRM platform. Every order here becomes a
            real record a real person follows up.
          </p>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <div key={column.title}>
            <p className="text-sm font-semibold text-ink">{column.title}</p>
            <ul className="mt-3 space-y-2">
              {column.links.map((linkItem) => (
                <li key={linkItem.to}>
                  <Link to={linkItem.to} className="text-sm text-ink-2 hover:text-ink">
                    {linkItem.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-hairline">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
          <NewsletterForm />
        </div>
      </div>

      <div className="border-t border-hairline px-4 py-6 text-center text-xs text-muted sm:px-6">
        SimpleCRM Shop — a demonstration storefront. No real goods are dispatched.
      </div>
    </footer>
  );
}

/**
 * The newsletter capture.
 *
 * Its own component with its own state, rather than lifted into the footer,
 * because it is the only interactive thing down there and every other part of
 * the footer is static — keeping its state local means a submission does not
 * re-render the whole footer, and the form is testable on its own.
 */
function NewsletterForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);
    setSubmitting(true);

    try {
      await shopNewsletterApi.subscribe(email);
      setStatus({ ok: true, message: 'Thanks — we have your address.' });
      setEmail('');
    } catch (err) {
      setStatus({ ok: false, message: errorMessage(err, 'Could not save your address') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
      <div className="max-w-sm">
        <p className="text-sm font-semibold text-ink">{NEWSLETTER.title}</p>
        <p className="mt-1 text-sm text-ink-2">{NEWSLETTER.body}</p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-md" noValidate>
        <div className="flex gap-2">
          <label htmlFor="newsletter-email" className="sr-only">
            Email address
          </label>
          <input
            id="newsletter-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={`${input} flex-1`}
            aria-describedby="newsletter-disclaimer"
          />
          <button
            type="submit"
            disabled={submitting}
            className="shrink-0 rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-plane transition-colors hover:bg-ink/90 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Sign up'}
          </button>
        </div>

        <p id="newsletter-disclaimer" className="mt-2 text-xs text-muted">
          {NEWSLETTER.disclaimer}
        </p>

        {status && (
          <p
            role="status"
            className={`mt-2 text-xs font-medium ${
              status.ok ? 'text-good-ink' : 'text-critical-ink'
            }`}
          >
            {status.message}
          </p>
        )}
      </form>
    </div>
  );
}
