import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { customersApi, productsApi } from '../api/resources';
import usePermissions from '../hooks/usePermissions';
import { NAV_ITEMS } from './DashboardLayout';

/**
 * The CRM's Cmd/Ctrl+K command palette — a navigation layer, not new backend
 * work. Every route it jumps to already exists; this is a faster way to reach
 * one than clicking through the sidebar, plus a couple of quick actions.
 *
 * Three sources of results, always shown together rather than as tabs:
 *
 *   - static navigation (the same NAV_ITEMS the sidebar renders, so the two
 *     can never list a different set of pages)
 *   - quick actions (currently just "Create order" — gated on `writeOrders`,
 *     same rule the Orders page's own button already uses)
 *   - a live customer/product search, once the caller has typed something,
 *     through the same `/options` endpoints the picker components already
 *     use — so a sales rep with no customer access searches nothing rather
 *     than the palette becoming a second place that rule has to be enforced
 *
 * Debounced (200ms) and stale-response-safe (a request tagged with a query
 * that no longer matches the input is dropped on arrival) — the same two
 * rules `SearchSelect` already established for exactly this kind of picker.
 */

const DEBOUNCE_MS = 200;
const OPEN_EVENT = 'crm:open-command-palette';

/** Open the palette from anywhere without prop-drilling its state. */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const requestId = useRef(0);
  const navigate = useNavigate();
  const { can } = usePermissions();

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCustomers([]);
    setProducts([]);
    setActiveIndex(0);
  }, []);

  // The global shortcut. Works from anywhere in the CRM shell, not only when
  // a particular field has focus — that's the entire point of a palette.
  useEffect(() => {
    function handleKeyDown(event) {
      const isTypingTarget = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
        document.activeElement?.tagName
      );

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
        return;
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        close();
        return;
      }
      // Ignore everything else while a normal input elsewhere has focus and
      // the palette is closed — this listener must not steal keystrokes from
      // an ordinary form field.
      void isTypingTarget;
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, close]);

  // The sidebar's own "Search…" trigger opens the same instance rather than
  // duplicating the palette's state.
  useEffect(() => {
    function handleOpenEvent() {
      setOpen(true);
    }
    window.addEventListener(OPEN_EVENT, handleOpenEvent);
    return () => window.removeEventListener(OPEN_EVENT, handleOpenEvent);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Live search, only once the caller has typed something and only against
  // whatever this user is actually allowed to read.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setCustomers([]);
      setProducts([]);
      return undefined;
    }

    const thisRequest = ++requestId.current;
    const timer = setTimeout(async () => {
      const [customerResults, productResults] = await Promise.all([
        can.viewCustomers ? customersApi.options(trimmed).catch(() => []) : Promise.resolve([]),
        productsApi.options(trimmed).catch(() => []),
      ]);

      // A slower, now-stale response landing after a faster later one would
      // otherwise overwrite the results the current query actually asked for.
      if (thisRequest !== requestId.current) return;
      setCustomers(customerResults);
      setProducts(productResults);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, can.viewCustomers]);

  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.requires || can[item.requires]),
    [can]
  );

  const quickActions = useMemo(() => {
    const actions = [];
    if (can.writeOrders) {
      actions.push({ id: 'new-order', label: 'Create order', to: '/crm/orders/new' });
    }
    return actions;
  }, [can]);

  const trimmed = query.trim();
  const filteredNav = trimmed
    ? navItems.filter((item) => item.label.toLowerCase().includes(trimmed.toLowerCase()))
    : navItems;
  const filteredActions = trimmed
    ? quickActions.filter((a) => a.label.toLowerCase().includes(trimmed.toLowerCase()))
    : quickActions;

  // One flat list so arrow-key navigation and Enter don't need to know which
  // section a highlighted row came from.
  const results = [
    ...filteredActions.map((a) => ({ kind: 'action', key: a.id, label: a.label, to: a.to })),
    ...filteredNav.map((n) => ({ kind: 'nav', key: n.to, label: n.label, to: n.to })),
    ...customers.map((c) => ({
      kind: 'customer',
      key: `c-${c._id}`,
      label: c.name,
      sub: c.email,
      to: `/crm/customers/${c._id}`,
    })),
    ...products.map((p) => ({
      kind: 'product',
      key: `p-${p._id}`,
      label: p.name,
      sub: p.sku,
      to: `/crm/products/${p._id}`,
    })),
  ];

  function select(index) {
    const result = results[index];
    if (!result) return;
    close();
    navigate(result.to);
  }

  function handleKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      select(activeIndex);
    }
  }

  if (!open) return null;

  const sectionLabel = { action: 'Actions', nav: 'Go to', customer: 'Customers', product: 'Products' };
  let lastKind = null;

  return (
    <div
      className="animate-backdrop-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="crm-glow animate-palette-in w-full max-w-lg overflow-hidden rounded-xl border border-hairline bg-surface"
        style={{ boxShadow: 'var(--shadow-pop)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-current text-muted" aria-hidden="true">
            <path d="M13 8a5 5 0 11-10 0 5 5 0 0110 0zm-1.6 4.6L15 16.2l-1.4 1.4-3.6-3.6 1.4-1.4z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-autocomplete="list"
            aria-label="Search pages, customers, products"
            className="w-full bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
            placeholder="Search pages, customers, products…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="kbd-chip">Esc</kbd>
        </div>

        <ul id="command-palette-listbox" role="listbox" className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted">No matches.</li>
          )}
          {results.map((result, index) => {
            const showHeader = result.kind !== lastKind;
            lastKind = result.kind;
            return (
              <li key={result.key}>
                {showHeader && (
                  <p className="mt-2 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted first:mt-0">
                    {sectionLabel[result.kind]}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    index === activeIndex ? 'bg-brand-wash text-ink' : 'text-ink-2 hover:bg-neutral-wash'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(e) => {
                    // mousedown, not click: click fires after the palette's
                    // own backdrop-click handler could already have closed it.
                    e.preventDefault();
                    select(index);
                  }}
                >
                  <span className="truncate font-medium">{result.label}</span>
                  {result.sub && <span className="shrink-0 truncate text-xs text-muted">{result.sub}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
