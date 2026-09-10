import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Category navigation that opens into a panel, not a dropdown list.
 *
 * WHY A PANEL RATHER THAN A `<select>` OR A COLUMN OF LINKS
 *
 * A shop's categories are a browsing surface, not a form control. The panel has
 * room for the categories laid out in columns, a few useful cross-cuts ("New
 * in", "Under $50") that are really saved filters rather than categories, and
 * an editorial tile — which is doing a job rather than decorating: it is the
 * only thing in the header that says what kind of shop this is.
 *
 * DESKTOP ONLY, and that is deliberate rather than an omission. A hover-opened
 * panel has no meaning on a touchscreen, and a mega-menu crushed into 375px is
 * just a long list with a picture in the way. `ShopLayout` renders a plain
 * stacked list in a drawer for small screens instead — the same links, shaped
 * for the device.
 *
 * A `<div>` RATHER THAN A `<nav>` at the root, because `ShopLayout` already
 * renders this inside its own `<nav>`. Two nested navigation landmarks is one
 * landmark's worth of meaning and two entries in a screen reader's landmark
 * list, which makes the real one harder to find rather than easier.
 *
 * OPENS ON HOVER, CLOSES ON INTENT.
 *
 * Hover-open is what a shopper expects here, but hover-close alone makes the
 * panel disappear while the pointer travels diagonally from the trigger to the
 * bottom-left link. The close is therefore delayed slightly, and cancelled if
 * the pointer re-enters. Keyboard users get click-to-toggle and Escape, because
 * hover is not something a keyboard has.
 */

/** One link inside the panel. Quiet until hovered, like the rest of the shell. */
const panelLink =
  'block py-1 text-sm text-ink-2 transition-colors hover:text-ink ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

const SHORTCUTS = [
  { label: 'New in', to: '/products?sort=newest' },
  { label: 'Under $50', to: '/products?maxPrice=50' },
  { label: 'In stock now', to: '/products?inStock=true' },
  { label: 'Lowest price first', to: '/products?sort=price_asc' },
];

export default function MegaMenu({ categories = [] }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(null);
  const containerRef = useRef(null);

  function scheduleClose() {
    clearTimeout(closeTimer.current);
    // Long enough to cross the gap between the trigger and the panel, short
    // enough that a genuine "move away" feels immediate.
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  }

  function cancelClose() {
    clearTimeout(closeTimer.current);
  }

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!open) return undefined;

    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    // A click anywhere else closes it — including on a link inside the panel,
    // which would otherwise navigate and leave the panel hanging open over the
    // new page.
    function onClick(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    }

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="hidden items-center gap-7 lg:flex"
      onMouseLeave={scheduleClose}
      onMouseEnter={cancelClose}
    >
      <Link
        to="/products"
        className="text-sm font-medium text-ink-2 transition-colors hover:text-ink"
      >
        Shop
      </Link>

      <div className="relative">
        <button
          type="button"
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="true"
          className="flex items-center gap-1.5 rounded-sm text-sm font-medium text-ink-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
          Categories
          <svg
            viewBox="0 0 20 20"
            className={`h-3.5 w-3.5 fill-current transition-transform duration-200 ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          >
            <path d="M5.3 7.3a1 1 0 011.4 0L10 10.6l3.3-3.3a1 1 0 111.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z" />
          </svg>
        </button>

        {open && (
          <div
            /*
             * Anchored to the viewport width rather than to the trigger, which
             * is what makes it a mega-menu rather than a wide dropdown: it
             * spans the header, so the columns line up with the page beneath.
             */
            className="animate-fade-rise fixed left-1/2 z-40 mt-5 w-[min(60rem,calc(100vw-3rem))] -translate-x-1/2 border border-hairline bg-surface shadow-pop"
          >
            <div className="grid gap-10 p-8 md:grid-cols-[1.2fr_1fr_16rem]">
              <div>
                <p className="label-mono mb-4">Browse</p>
                {categories.length === 0 ? (
                  <p className="text-sm text-muted">No categories yet.</p>
                ) : (
                  <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5">
                    {categories.map((category) => (
                      <li key={category}>
                        <Link
                          to={`/products?category=${encodeURIComponent(category)}`}
                          className={panelLink}
                        >
                          {category}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="label-mono mb-4">Shortcuts</p>
                {/*
                  Saved filters rather than categories, which is why they are in
                  their own column. Presenting them alongside real categories
                  would imply "Under $50" is a kind of thing the shop sells.
                */}
                <ul className="space-y-0.5">
                  {SHORTCUTS.map((shortcut) => (
                    <li key={shortcut.to}>
                      <Link to={shortcut.to} className={panelLink}>
                        {shortcut.label}
                      </Link>
                    </li>
                  ))}
                  <li className="pt-3">
                    <Link
                      to="/rooms"
                      className="text-sm font-medium text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-brand"
                    >
                      Shop by room
                    </Link>
                  </li>
                </ul>
              </div>

              {/*
                Typographic rather than photographic, on purpose. A promo image
                here would be one more asset to keep current, and a stale one is
                worse than none — this cannot go out of date or fail to load.
              */}
              <Link
                to="/products?newArrival=true"
                className="group hidden flex-col justify-end bg-ink p-6 transition-colors hover:bg-ink/95 md:flex"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-plane/55">
                  Just landed
                </p>
                <p className="font-display mt-3 text-[26px] leading-tight text-plane">
                  New season
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-plane">
                  See what&apos;s new
                  <span
                    aria-hidden="true"
                    className="transition-transform group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </span>
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
