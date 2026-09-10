import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useBuyerAuth } from '../context/BuyerAuthContext';
import { useCart } from '../context/CartContext';
import { useWishlist } from '../context/WishlistContext';
import { shopProductsApi, shopNewsletterApi, shopMessagesApi } from '../api/shopResources';
import { errorMessage } from '../api/client';
import CartDrawer from './CartDrawer';
import MegaMenu from './shop/MegaMenu';
import { Drawer, DropdownMenu, MenuItem } from './common';
import { ANNOUNCEMENT, FOOTER_COLUMNS, NEWSLETTER, TRUST_BADGES } from '../shopContent';
import { input } from '../ui';

/** Header navigation link — quiet, with the underline growing on hover. */
const shopNavLink =
  'relative text-sm font-medium text-ink-2 transition-colors hover:text-ink ' +
  'after:absolute after:-bottom-1 after:left-0 after:h-px after:w-0 after:bg-ink ' +
  'after:transition-all hover:after:w-full';

/** An icon control in the header's right-hand cluster. */
const shopIconLink =
  'relative rounded-md p-2.5 text-ink-2 transition-colors hover:bg-sunken hover:text-ink ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

const shopDrawerLink = 'block py-2.5 text-[15px] font-medium text-ink transition-colors hover:text-brand-ink';

/**
 * The count on a header icon.
 *
 * Deliberately a small filled dot rather than the number sitting inline: the
 * inline version changed the width of the control as the cart filled, so the
 * whole right-hand cluster shifted sideways while you were reaching for it.
 */
function CountDot({ value }) {
  return (
    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-on-brand">
      {value > 9 ? '9+' : value}
    </span>
  );
}

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
  const { count: wishlistCount } = useWishlist();
  const [cartOpen, setCartOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [categories, setCategories] = useState([]);
  const [messageCount, setMessageCount] = useState(0);
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

  /*
   * The notification badge count. Only fetched once signed in — there is no
   * notifications endpoint a guest could call, and `shopMessagesApi.list`
   * would 401 for one anyway. Swallowed on failure like the categories fetch
   * above: a badge that fails to load should render as "no badge", not break
   * the header.
   */
  useEffect(() => {
    if (!isSignedIn) {
      setMessageCount(0);
      return;
    }
    shopMessagesApi
      .list()
      .then((result) => setMessageCount(result.count || 0))
      .catch(() => {});
  }, [isSignedIn]);

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

      {/*
        LOGO LEFT, NAVIGATION CENTRE, ICONS RIGHT.

        The previous header put seven text links in the right-hand cluster —
        track order, my orders, a greeting, sign out, wishlist, cart, CRM —
        which is the arrangement a shop ends up with by adding one feature at a
        time and never re-reading the row. Everything that is about YOUR
        ACCOUNT now lives behind one account control, so the row carries three
        icons and the navigation gets the middle of the header to itself.
      */}
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:h-20 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="-ml-2 rounded-md p-2 text-ink-2 transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:hidden"
            aria-label="Open menu"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
              <path d="M3 5h14v2H3V5zm0 4.5h14v2H3v-2zM3 14h14v2H3v-2z" />
            </svg>
          </button>

          <Link to="/" className="font-display shrink-0 text-[22px] leading-none text-ink sm:text-[26px]">
            SimpleCRM
          </Link>

          <nav className="hidden flex-1 items-center justify-center gap-7 lg:flex">
            <MegaMenu categories={categories} />
            <Link to="/rooms" className={shopNavLink}>
              Rooms
            </Link>
            <Link to="/designers" className={shopNavLink}>
              Designers
            </Link>
            <Link to="/products?newArrival=true" className={shopNavLink}>
              New arrivals
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-0.5 lg:ml-0">
            <Link to="/wishlist" className={shopIconLink} aria-label={`Wishlist, ${wishlistCount} saved`}>
              <svg viewBox="0 0 20 20" className="h-[19px] w-[19px] fill-current" aria-hidden="true">
                <path d="M10 17.3l-1.1-1C4.9 12.9 2.5 10.8 2.5 7.9 2.5 5.6 4.3 4 6.5 4c1.3 0 2.5.6 3.5 1.7C11 4.6 12.2 4 13.5 4c2.2 0 4 1.6 4 3.9 0 2.9-2.4 5-6.4 8.4l-1.1 1z" />
              </svg>
              {wishlistCount > 0 && <CountDot value={wishlistCount} />}
            </Link>

            {isSignedIn ? (
              <DropdownMenu
                label="Your account"
                triggerClassName={shopIconLink}
                trigger={
                  <>
                    <svg viewBox="0 0 20 20" className="h-[19px] w-[19px] fill-current" aria-hidden="true">
                      <path d="M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 1.8c-3.4 0-6.2 1.8-6.2 4v1.4h12.4V15.8c0-2.2-2.8-4-6.2-4z" />
                    </svg>
                    {messageCount > 0 && <CountDot value={messageCount} />}
                  </>
                }
              >
                {(close) => (
                  <>
                    <p className="truncate border-b border-hairline px-3 pb-2 pt-1 text-sm font-medium text-ink">
                      Hey, {buyer.name.split(' ')[0]}
                    </p>
                    <MenuItem to="/account/orders" onClick={close}>
                      My orders
                    </MenuItem>
                    <MenuItem to="/account/notifications" onClick={close}>
                      Notifications{messageCount > 0 ? ` (${messageCount})` : ''}
                    </MenuItem>
                    <MenuItem to="/account/addresses" onClick={close}>
                      Addresses
                    </MenuItem>
                    <MenuItem to="/track" onClick={close}>
                      Track an order
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        close();
                        logout();
                      }}
                      className="border-t border-hairline"
                    >
                      Sign out
                    </MenuItem>
                  </>
                )}
              </DropdownMenu>
            ) : (
              <Link to="/login" className={shopIconLink} aria-label="Sign in">
                <svg viewBox="0 0 20 20" className="h-[19px] w-[19px] fill-current" aria-hidden="true">
                  <path d="M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm0 1.8c-3.4 0-6.2 1.8-6.2 4v1.4h12.4V15.8c0-2.2-2.8-4-6.2-4z" />
                </svg>
              </Link>
            )}

            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className={shopIconLink}
              aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}
            >
              <svg viewBox="0 0 20 20" className="h-[19px] w-[19px] fill-current" aria-hidden="true">
                <path d="M6 6V5a4 4 0 118 0v1h2.2a1 1 0 01.99 1.14l-1.2 8.4A2 2 0 0114 17.3H6a2 2 0 01-1.98-1.72l-1.2-8.4A1 1 0 013.8 6H6zm2 0h4V5a2 2 0 10-4 0v1z" />
              </svg>
              {count > 0 && <CountDot value={count} />}
            </button>
          </div>
        </div>
      </header>

      {/* The mobile navigation, in the shared drawer rather than a panel that
          pushes the page down as it opens. */}
      <Drawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} side="left" title="Menu">
        <div className="px-4 py-3">
          <Link to="/products" className={shopDrawerLink}>
            All products
          </Link>
          <Link to="/rooms" className={shopDrawerLink}>
            Rooms
          </Link>
          <Link to="/designers" className={shopDrawerLink}>
            Designers
          </Link>
          <Link to="/products?newArrival=true" className={shopDrawerLink}>
            New arrivals
          </Link>

          {categories.length > 0 && (
            <>
              <p className="label-mono mt-5 pb-1">Shop by category</p>
              {categories.map((category) => (
                <Link
                  key={category}
                  to={`/products?category=${encodeURIComponent(category)}`}
                  className="block py-2 text-sm text-ink-2 transition-colors hover:text-ink"
                >
                  {category}
                </Link>
              ))}
            </>
          )}

          <div className="mt-5 border-t border-hairline pt-3">
            {isSignedIn ? (
              <>
                <Link to="/account/orders" className={shopDrawerLink}>
                  My orders
                </Link>
                <Link to="/account/notifications" className={shopDrawerLink}>
                  Notifications{messageCount > 0 ? ` (${messageCount})` : ''}
                </Link>
                <Link to="/account/addresses" className={shopDrawerLink}>
                  Addresses
                </Link>
              </>
            ) : (
              <Link to="/login" className={shopDrawerLink}>
                Sign in
              </Link>
            )}
            <Link to="/wishlist" className={shopDrawerLink}>
              Wishlist{wishlistCount > 0 ? ` (${wishlistCount})` : ''}
            </Link>
            <Link to="/track" className={shopDrawerLink}>
              Track an order
            </Link>
          </div>
        </div>
      </Drawer>

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
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 md:grid-cols-4">
        <div className="md:col-span-2">
          <p className="font-display text-2xl text-ink">SimpleCRM</p>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-ink-2">
            Furniture and pieces for the home, made to last. Every order here becomes a real record
            a real person follows up.
          </p>
        </div>

        {FOOTER_COLUMNS.map((column) => (
          <div key={column.title}>
            <p className="label-mono pb-3">{column.title}</p>
            <ul className="space-y-2.5">
              {column.links.map((linkItem) => (
                <li key={linkItem.to}>
                  <Link to={linkItem.to} className="text-sm text-ink-2 transition-colors hover:text-ink">
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

      <div className="border-t border-hairline">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-muted sm:flex-row sm:px-6">
          <p>SimpleCRM — a demonstration storefront. No real goods are dispatched.</p>
          {/*
            The CRM's one entry point from the shop. It moved out of the
            header and down here on purpose: staff are a rounding error in
            this page's audience, and a link to an internal tool sitting
            beside the cart implies the site is for something it is not. Still
            one click from every page, which is all it needs to be.
          */}
          <Link to="/crm" className="font-medium transition-colors hover:text-ink-2">
            Staff sign in
          </Link>
        </div>
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
