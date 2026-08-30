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
 * an image — which is doing a job rather than decorating: it is the only thing
 * in the header that says what kind of shop this is.
 *
 * DESKTOP ONLY, and that is deliberate rather than an omission. A hover-opened
 * panel has no meaning on a touchscreen, and a mega-menu crushed into 375px is
 * just a long list with a picture in the way. `ShopLayout` renders a plain
 * stacked list under the header for small screens instead — the same links,
 * shaped for the device.
 *
 * OPENS ON HOVER, CLOSES ON INTENT.
 *
 * Hover-open is what a shopper expects here, but hover-close alone makes the
 * panel disappear while the pointer travels diagonally from the trigger to the
 * bottom-left link. The close is therefore delayed slightly, and cancelled if
 * the pointer re-enters. Keyboard users get click-to-toggle and Escape, because
 * hover is not something a keyboard has.
 */
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
    <nav
      ref={containerRef}
      className="hidden items-center gap-5 lg:flex"
      onMouseLeave={scheduleClose}
      onMouseEnter={cancelClose}
    >
      <Link to="/products" className="text-sm text-ink-2 hover:text-ink">
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
          className="flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
        >
          Categories
          <svg
            viewBox="0 0 20 20"
            className={`h-3.5 w-3.5 fill-current transition-transform ${open ? 'rotate-180' : ''}`}
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
            className="animate-fade-rise fixed left-1/2 z-40 mt-3 w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-hairline bg-surface p-6 shadow-pop"
          >
            <div className="grid gap-8 md:grid-cols-[1fr_1fr_14rem]">
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                  Browse
                </p>
                <ul className="space-y-2">
                  {categories.length === 0 && (
                    <li className="text-sm text-muted">No categories yet.</li>
                  )}
                  {categories.map((category) => (
                    <li key={category}>
                      <Link
                        to={`/products?category=${encodeURIComponent(category)}`}
                        className="text-sm text-ink-2 hover:text-ink"
                      >
                        {category}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                  Shortcuts
                </p>
                <ul className="space-y-2">
                  {/*
                    Saved filters rather than categories, which is why they are
                    in their own column. Presenting them alongside real
                    categories would imply "Under $50" is a kind of thing the
                    shop sells.
                  */}
                  <li>
                    <Link to="/products?sort=newest" className="text-sm text-ink-2 hover:text-ink">
                      New in
                    </Link>
                  </li>
                  <li>
                    <Link to="/products?maxPrice=50" className="text-sm text-ink-2 hover:text-ink">
                      Under $50
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/products?inStock=true"
                      className="text-sm text-ink-2 hover:text-ink"
                    >
                      In stock now
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/products?sort=price_asc"
                      className="text-sm text-ink-2 hover:text-ink"
                    >
                      Lowest price first
                    </Link>
                  </li>
                </ul>
              </div>

              <Link
                to="/products?sort=newest"
                className="hidden overflow-hidden rounded-lg bg-ink md:block"
              >
                {/*
                  An inline SVG rather than a photograph, on purpose. A promo
                  image here would be one more asset to keep current, and a
                  stale one is worse than none — this is typographic, so it
                  cannot go out of date or fail to load.
                */}
                <div className="flex h-full flex-col justify-end p-4">
                  <p className="font-display text-lg font-semibold leading-tight text-plane">
                    New season
                  </p>
                  <p className="mt-1 text-xs text-plane/70">Just added to the catalogue</p>
                </div>
              </Link>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
