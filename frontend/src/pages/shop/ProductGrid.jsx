import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { Spinner, ErrorBanner, EmptyState, Pagination } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import QuickViewModal from '../../components/shop/QuickViewModal';
import { input, btnSecondary } from '../../ui';

/**
 * The full catalogue, with filters, sorting and a natural-language search box.
 *
 * FILTER STATE LIVES IN THE URL, NOT IN `useState`.
 *
 * This is the substantive change from the earlier version, and it buys three
 * things that local state cannot: a filtered view is a link somebody can send,
 * the browser's back button undoes a filter instead of leaving the page, and
 * the header's mega-menu can drive this screen simply by linking to it
 * (`/products?category=Furniture`) rather than needing a shared store. The last
 * one is why the mega-menu works at all.
 *
 * Search and the filters remain mutually exclusive views — running a question
 * against a filtered grid would mean deciding which one wins, so submitting a
 * search clears the filters rather than trying to combine two query shapes.
 */
export default function ProductGrid() {
  const [params, setParams] = useSearchParams();
  const [categories, setCategories] = useState([]);
  const [colours, setColours] = useState([]);
  const [quickView, setQuickView] = useState(null);

  const category = params.get('category') || '';
  const colour = params.get('color') || '';
  const minPrice = params.get('minPrice') || '';
  const maxPrice = params.get('maxPrice') || '';
  const inStockOnly = params.get('inStock') === 'true';
  const sort = params.get('sort') || 'name';
  const page = Number(params.get('page')) || 1;
  const activeQuery = params.get('q') || '';

  const [queryText, setQueryText] = useState(activeQuery);

  // The box follows the URL, so a back-button navigation out of a search
  // clears the input rather than leaving stale text above unfiltered results.
  useEffect(() => setQueryText(activeQuery), [activeQuery]);

  useEffect(() => {
    // Both of these are PUBLIC endpoints. The category list used to come from
    // the internal, staff-only one, which 401'd for every actual shopper.
    shopProductsApi.categories().then(setCategories).catch(() => {});
    shopProductsApi.colours().then(setColours).catch(() => {});
  }, []);

  const { data, loading, error } = useFetch(() => {
    if (activeQuery) return shopProductsApi.search(activeQuery);
    return shopProductsApi.list({
      page,
      limit: 12,
      category: category || undefined,
      color: colour || undefined,
      minPrice: minPrice || undefined,
      maxPrice: maxPrice || undefined,
      inStock: inStockOnly ? 'true' : undefined,
      sort,
    });
  }, [activeQuery, page, category, colour, minPrice, maxPrice, inStockOnly, sort]);

  /**
   * Write one filter into the URL, dropping the page.
   *
   * Resetting to page 1 is not a nicety: narrowing a filter while on page 4 of
   * the old result set lands on a page that no longer exists, and the grid
   * comes back empty for a filter that has plenty of matches.
   */
  function setParam(key, value) {
    const next = new URLSearchParams(params);
    if (value === '' || value === null || value === undefined) next.delete(key);
    else next.set(key, value);
    next.delete('page');
    next.delete('q');
    setParams(next);
  }

  function submitSearch(event) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (queryText.trim()) next.set('q', queryText.trim());
    setParams(next);
  }

  function clearAll() {
    setParams(new URLSearchParams());
  }

  const products = data?.data || [];
  const pagination = data?.pagination;
  const filtersApplied = Boolean(
    category || colour || minPrice || maxPrice || inStockOnly || activeQuery
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="font-display mb-6 text-3xl font-semibold text-ink">Shop</h1>

      <form onSubmit={submitSearch} className="mb-6 flex gap-2">
        <input
          type="search"
          className={`${input} flex-1`}
          placeholder="Try: something for a rainy weekend under $50"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          aria-label="Search products"
        />
        <button type="submit" className={btnSecondary}>
          Search
        </button>
        {filtersApplied && (
          <button type="button" className={btnSecondary} onClick={clearAll}>
            Clear
          </button>
        )}
      </form>

      <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
        {/*
          The filter rail is hidden entirely during a search rather than being
          shown disabled. A greyed-out control invites the shopper to work out
          why; a control that is not there while a search is running matches the
          "these are two different views" rule the search itself follows.
        */}
        {!activeQuery && (
          <aside className="space-y-6">
            <FilterGroup title="Category">
              <FilterPill
                label="All"
                active={category === ''}
                onClick={() => setParam('category', '')}
              />
              {categories.map((entry) => (
                <FilterPill
                  key={entry}
                  label={entry}
                  active={category === entry}
                  onClick={() => setParam('category', category === entry ? '' : entry)}
                />
              ))}
            </FilterGroup>

            {colours.length > 0 && (
              <FilterGroup title="Colour">
                {colours.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => setParam('color', colour === entry.name ? '' : entry.name)}
                    aria-pressed={colour === entry.name}
                    className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                      colour === entry.name
                        ? 'border-brand bg-brand-wash text-brand-ink'
                        : 'border-hairline text-ink-2 hover:border-rule'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 rounded-full ring-1 ring-inset ring-ink/15"
                      style={{ backgroundColor: entry.hex }}
                    />
                    {entry.name}
                  </button>
                ))}
              </FilterGroup>
            )}

            <FilterGroup title="Price" stacked>
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor="minPrice">
                  Minimum price
                </label>
                <input
                  id="minPrice"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  placeholder="Min"
                  defaultValue={minPrice}
                  onBlur={(e) => setParam('minPrice', e.target.value)}
                  className={`${input} w-full`}
                />
                <span className="text-xs text-muted">to</span>
                <label className="sr-only" htmlFor="maxPrice">
                  Maximum price
                </label>
                <input
                  id="maxPrice"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  placeholder="Max"
                  defaultValue={maxPrice}
                  onBlur={(e) => setParam('maxPrice', e.target.value)}
                  className={`${input} w-full`}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted">In dollars. Leave either side blank.</p>
            </FilterGroup>

            <FilterGroup title="Availability" stacked>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input
                  type="checkbox"
                  checked={inStockOnly}
                  onChange={(e) => setParam('inStock', e.target.checked ? 'true' : '')}
                  className="h-4 w-4 rounded border-hairline"
                />
                In stock only
              </label>
            </FilterGroup>
          </aside>
        )}

        <div className={activeQuery ? 'lg:col-span-2' : ''}>
          {!activeQuery && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                {pagination ? `${pagination.total} product${pagination.total === 1 ? '' : 's'}` : ''}
              </p>
              <div className="flex items-center gap-2">
                <label htmlFor="sort" className="text-sm text-ink-2">
                  Sort
                </label>
                <select
                  id="sort"
                  value={sort}
                  onChange={(e) => setParam('sort', e.target.value)}
                  className={`${input} w-auto`}
                >
                  <option value="name">Name</option>
                  <option value="newest">Newest</option>
                  <option value="price_asc">Price: low to high</option>
                  <option value="price_desc">Price: high to low</option>
                </select>
              </div>
            </div>
          )}

          {/*
            `!loading` and the `mode` check are both load-bearing.

            `useFetch` keeps the PREVIOUS response in `data` while the next
            request is in flight, and the previous response here is the plain
            product LIST — which has no `mode` field at all. Without these
            guards, submitting a search rendered "Showing keyword matches for
            X" above the stale, unfiltered catalogue for as long as the request
            took: a confident, specific claim about results that were not
            results, and not for X. Caught by an end-to-end test that read the
            line, believed it, and then failed on the terms below it.
          */}
          {activeQuery && !loading && data?.mode && (
            <div className="mb-4 text-sm text-muted">
              <p>
                {data.mode === 'ai'
                  ? `Results for "${activeQuery}"`
                  : `Showing keyword matches for "${activeQuery}"`}
              </p>
              {/*
                The fallback strips filler words, so the words it actually
                searched for are rarely the words that were typed. Showing them
                is the difference between "no results" and "no results *for
                this*" — the same reason the internal AI search bar shows them.
              */}
              {data.mode !== 'ai' && data.terms?.length > 0 && (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                  <span>Searched for:</span>
                  {data.terms.map((term) => (
                    <span
                      key={term}
                      className="rounded bg-neutral-wash px-1.5 py-0.5 font-medium text-ink-2"
                    >
                      {term}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}

          {loading && <Spinner full />}
          {error && <ErrorBanner message={error} />}

          {!loading && data && products.length === 0 && (
            <EmptyState
              title="No products found"
              hint={
                filtersApplied
                  ? 'Try widening the filters, or clear them to see everything.'
                  : 'Nothing in the catalogue yet.'
              }
              action={
                filtersApplied ? (
                  <button type="button" className={btnSecondary} onClick={clearAll}>
                    Clear filters
                  </button>
                ) : null
              }
            />
          )}

          {!loading && products.length > 0 && (
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
              {products.map((product) => (
                <ProductCard key={product._id} product={product} onQuickView={setQuickView} />
              ))}
            </div>
          )}

          {!activeQuery && pagination && pagination.pages > 1 && (
            <div className="mt-8">
              <Pagination
                page={pagination.page}
                pages={pagination.pages}
                total={pagination.total}
                onChange={(next) => {
                  const updated = new URLSearchParams(params);
                  updated.set('page', String(next));
                  setParams(updated);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {quickView && <QuickViewModal product={quickView} onClose={() => setQuickView(null)} />}
    </div>
  );
}

function FilterGroup({ title, children, stacked = false }) {
  return (
    <div>
      <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted">{title}</p>
      <div className={stacked ? '' : 'flex flex-wrap gap-2'}>{children}</div>
    </div>
  );
}

function FilterPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-brand text-white' : 'bg-neutral-wash text-ink-2 hover:bg-rule/40'
      }`}
    >
      {label}
    </button>
  );
}
