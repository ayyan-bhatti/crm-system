import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import {
  Breadcrumb,
  Button,
  Drawer,
  EmptyState,
  ErrorBanner,
  Pagination,
  Select,
  Skeleton,
} from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import QuickViewModal from '../../components/shop/QuickViewModal';
import { input } from '../../ui';

/**
 * The full catalogue, with filters, sorting and a natural-language search box.
 *
 * FILTER STATE LIVES IN THE URL, NOT IN `useState`.
 *
 * This is the substantive behavioural decision on this screen, and it buys
 * three things that local state cannot: a filtered view is a link somebody can
 * send, the browser's back button undoes a filter instead of leaving the page,
 * and the header's mega-menu can drive this screen simply by linking to it
 * (`/products?category=Furniture`) rather than needing a shared store. The last
 * one is why the mega-menu works at all.
 *
 * Search and the filters remain mutually exclusive views — running a question
 * against a filtered grid would mean deciding which one wins, so submitting a
 * search clears the filters rather than trying to combine two query shapes.
 *
 * THE FILTER CONTROLS ARE DEFINED ONCE AND RENDERED TWICE — in a rail on
 * desktop and in a `Drawer` on a phone. A phone is not a narrow desktop: a
 * sidebar that collapses to the top of the page pushes the products the
 * shopper came for below the fold, and hiding the filters entirely is how a
 * catalogue becomes unusable on the device most of it is browsed from. One
 * `Filters` component with an `idPrefix` keeps the two copies honest and stops
 * the duplicated `<label for>` ids that make a screen reader announce the
 * wrong field.
 */
export default function ProductGrid() {
  const [params, setParams] = useSearchParams();
  const [categories, setCategories] = useState([]);
  const [colours, setColours] = useState([]);
  const [quickView, setQuickView] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const category = params.get('category') || '';
  const brand = params.get('brand') || '';
  const colour = params.get('color') || '';
  const minPrice = params.get('minPrice') || '';
  const maxPrice = params.get('maxPrice') || '';
  const inStockOnly = params.get('inStock') === 'true';
  const newArrivalOnly = params.get('newArrival') === 'true';
  const sort = params.get('sort') || 'name';
  const page = Number(params.get('page')) || 1;
  const activeQuery = params.get('q') || '';

  const [queryText, setQueryText] = useState(activeQuery);

  // The box follows the URL, so a back-button navigation out of a search
  // clears the input rather than leaving stale text above unfiltered results.
  // The mobile filter drawer closes with it: searching replaces the filtered
  // view entirely, and a drawer left half-open would spring back the moment
  // the search was cleared.
  useEffect(() => {
    setQueryText(activeQuery);
    setFiltersOpen(false);
  }, [activeQuery]);

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
      brand: brand || undefined,
      color: colour || undefined,
      minPrice: minPrice || undefined,
      maxPrice: maxPrice || undefined,
      inStock: inStockOnly ? 'true' : undefined,
      newArrival: newArrivalOnly ? 'true' : undefined,
      sort,
    });
  }, [
    activeQuery,
    page,
    category,
    brand,
    colour,
    minPrice,
    maxPrice,
    inStockOnly,
    newArrivalOnly,
    sort,
  ]);

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
    category || brand || colour || minPrice || maxPrice || inStockOnly || newArrivalOnly || activeQuery
  );

  /*
   * A page title that says what's actually being shown, rather than always
   * "Shop" — a designer's page and the new-arrivals link both route through
   * this same grid, and a heading that never changes makes either look like
   * it landed somewhere generic rather than on the thing that was clicked.
   */
  const heading = brand
    ? brand
    : newArrivalOnly
      ? 'New Arrivals'
      : category && !category.includes(',')
        ? category
        : 'Shop';

  const eyebrow = brand ? 'Designer' : newArrivalOnly ? 'Latest' : category ? 'Category' : 'Catalogue';

  const standfirst = brand
    ? `Everything in the catalogue from ${brand}.`
    : newArrivalOnly
      ? 'The most recent pieces to reach the shop.'
      : category && !category.includes(',')
        ? `Every ${category.toLowerCase()} we currently stock.`
        : 'A small, carefully chosen catalogue — filter it down to what you are actually after.';

  // The result count, for a heading that is honest about how much there is.
  const resultCount = activeQuery ? products.length : pagination?.total;

  const filterProps = {
    categories,
    colours,
    category,
    colour,
    minPrice,
    maxPrice,
    inStockOnly,
    newArrivalOnly,
    setParam,
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <Breadcrumb
        items={[
          { label: 'Home', to: '/' },
          ...(heading === 'Shop' ? [] : [{ label: 'Shop', to: '/products' }]),
          { label: heading },
        ]}
        className="mb-6"
      />

      <header className="max-w-2xl">
        <p className="label-mono">{eyebrow}</p>
        <h1 className="font-display mt-2 text-[34px] leading-[1.05] text-ink sm:text-[44px]">
          {heading}
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">{standfirst}</p>
      </header>

      {/*
        The search box is a full-width band under the header rather than a
        control in the toolbar. It takes a whole sentence ("something for a
        rainy weekend under $50"), and a field that accepts a sentence has to
        look wide enough to hold one.
      */}
      <form onSubmit={submitSearch} className="mt-8 flex flex-wrap gap-2 border-t border-hairline pt-8">
        <input
          type="search"
          className={`${input} min-w-0 flex-1 sm:min-w-80`}
          placeholder="Try: something for a rainy weekend under $50"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          aria-label="Search products"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {filtersApplied && (
          <Button type="button" variant="ghost" onClick={clearAll}>
            Clear
          </Button>
        )}
      </form>

      <div className="mt-8 grid gap-10 lg:grid-cols-[15rem_1fr] lg:gap-14">
        {/*
          The filter rail is hidden entirely during a search rather than being
          shown disabled. A greyed-out control invites the shopper to work out
          why; a control that is not there while a search is running matches the
          "these are two different views" rule the search itself follows.
        */}
        {!activeQuery && (
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <div className="mb-5 flex items-baseline justify-between border-b border-hairline pb-3">
                <h2 className="label-mono">Filter</h2>
                {filtersApplied && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-xs font-medium text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-brand"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <Filters idPrefix="rail" {...filterProps} />
            </div>
          </aside>
        )}

        <div className={activeQuery ? 'lg:col-span-2' : 'min-w-0'}>
          {!activeQuery && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
              <p className="text-sm text-ink-2 tabular">
                {loading && resultCount === undefined
                  ? 'Loading…'
                  : resultCount !== undefined
                    ? `${resultCount} ${resultCount === 1 ? 'piece' : 'pieces'}`
                    : ''}
              </p>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="lg:hidden"
                  onClick={() => setFiltersOpen(true)}
                  icon={
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                      <path d="M3 5h14v2H3V5zm3 4.5h8v2H6v-2zM8.5 14h3v2h-3v-2z" />
                    </svg>
                  }
                >
                  Filter
                </Button>

                <label htmlFor="sort" className="sr-only">
                  Sort products
                </label>
                <Select
                  id="sort"
                  value={sort}
                  onChange={(e) => setParam('sort', e.target.value)}
                  className="w-auto py-2 text-[13px]"
                >
                  <option value="name">Sort: Name</option>
                  <option value="newest">Sort: Newest</option>
                  <option value="price_asc">Sort: Price, low to high</option>
                  <option value="price_desc">Sort: Price, high to low</option>
                </Select>
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
            <div className="mb-6 border-b border-hairline pb-4 text-sm text-ink-2">
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
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <span>Searched for:</span>
                  {data.terms.map((term) => (
                    <span
                      key={term}
                      className="rounded-sm bg-sunken px-1.5 py-0.5 font-medium text-ink-2"
                    >
                      {term}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}

          <ErrorBanner message={error} />

          {/*
            A SKELETON GRID, NOT A SPINNER. A centred spinner throws the
            products away and replaces them with a dot, so the page height
            collapses and everything below jumps when the results land. Tiles
            shaped like the tiles that are coming keep the layout still and say
            how much is on its way.
          */}
          {loading && (
            <div
              className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:gap-x-6"
              aria-hidden="true"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index}>
                  <Skeleton className="aspect-[4/5] w-full rounded-lg" />
                  <Skeleton className="mt-3.5 h-3 w-16" />
                  <Skeleton className="mt-2 h-4 w-3/4" />
                  <Skeleton className="mt-2 h-4 w-20" />
                </div>
              ))}
            </div>
          )}
          {loading && (
            <p role="status" className="sr-only">
              Loading products
            </p>
          )}

          {/*
            Two different empty states behind one heading. "There is nothing in
            this shop" and "nothing here matches what you asked for" call for
            completely different next moves, and showing the first when the
            second is true tells the shopper to leave.
          */}
          {!loading && !error && data && products.length === 0 && (
            <EmptyState
              title="No products found"
              hint={
                filtersApplied
                  ? 'Nothing matches this combination. Try widening the filters, or clear them to see the whole catalogue.'
                  : 'The catalogue is empty at the moment. Check back soon.'
              }
              action={
                filtersApplied ? (
                  <Button type="button" variant="secondary" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          )}

          {!loading && products.length > 0 && (
            <div className="stagger-children grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:gap-x-6 lg:gap-y-12">
              {products.map((product) => (
                <ProductCard key={product._id} product={product} onQuickView={setQuickView} />
              ))}
            </div>
          )}

          {!activeQuery && pagination && pagination.pages > 1 && (
            <div className="mt-12 border-t border-hairline">
              <Pagination
                page={pagination.page}
                pages={pagination.pages}
                total={pagination.total}
                onChange={(next) => {
                  const updated = new URLSearchParams(params);
                  updated.set('page', String(next));
                  setParams(updated);
                  // Page 2 starting halfway down page 1 is the commonest
                  // "where did the products go" moment in a catalogue.
                  window.scrollTo?.({ top: 0, behavior: 'smooth' });
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* The same filters, shaped for a phone. */}
      <Drawer
        open={filtersOpen && !activeQuery}
        onClose={() => setFiltersOpen(false)}
        side="left"
        title="Filter"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={clearAll}>
              Clear all
            </Button>
            <Button className="flex-1" onClick={() => setFiltersOpen(false)}>
              {resultCount === undefined
                ? 'Show results'
                : `Show ${resultCount} ${resultCount === 1 ? 'piece' : 'pieces'}`}
            </Button>
          </div>
        }
      >
        <div className="px-5 py-5">
          <Filters idPrefix="drawer" {...filterProps} />
        </div>
      </Drawer>

      {quickView && <QuickViewModal product={quickView} onClose={() => setQuickView(null)} />}
    </div>
  );
}

/**
 * Every filter control, rendered identically in the desktop rail and the
 * mobile drawer.
 *
 * `idPrefix` exists because the two copies are both in the document at once on
 * a large phone rotated to landscape, and two inputs sharing an `id` means the
 * `<label for>` of the second one points at the first — so tapping the label
 * focuses a field the reader cannot see. It is a one-word prop that removes a
 * whole class of bug.
 */
function Filters({
  idPrefix,
  categories,
  colours,
  category,
  colour,
  minPrice,
  maxPrice,
  inStockOnly,
  newArrivalOnly,
  setParam,
}) {
  return (
    <div className="space-y-8">
      <FilterGroup title="Category">
        <ul className="space-y-1">
          <li>
            <FilterRow
              label="Everything"
              active={category === ''}
              onClick={() => setParam('category', '')}
            />
          </li>
          {categories.map((entry) => (
            <li key={entry}>
              <FilterRow
                label={entry}
                active={category === entry}
                onClick={() => setParam('category', category === entry ? '' : entry)}
              />
            </li>
          ))}
        </ul>
      </FilterGroup>

      {colours.length > 0 && (
        <FilterGroup title="Colour">
          <ul className="flex flex-wrap gap-2">
            {colours.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  onClick={() => setParam('color', colour === entry.name ? '' : entry.name)}
                  aria-pressed={colour === entry.name}
                  className={`flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane ${
                    colour === entry.name
                      ? 'border-ink bg-ink text-plane'
                      : 'border-hairline text-ink-2 hover:border-rule hover:text-ink'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full ring-1 ring-inset ring-ink/20"
                    style={{ backgroundColor: entry.hex }}
                  />
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        </FilterGroup>
      )}

      <FilterGroup title="Price">
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`${idPrefix}-minPrice`}>
            Minimum price
          </label>
          <input
            id={`${idPrefix}-minPrice`}
            type="number"
            min="0"
            inputMode="decimal"
            placeholder="Min"
            defaultValue={minPrice}
            onBlur={(e) => setParam('minPrice', e.target.value)}
            className={`${input} w-full`}
          />
          <span className="text-xs text-muted">to</span>
          <label className="sr-only" htmlFor={`${idPrefix}-maxPrice`}>
            Maximum price
          </label>
          <input
            id={`${idPrefix}-maxPrice`}
            type="number"
            min="0"
            inputMode="decimal"
            placeholder="Max"
            defaultValue={maxPrice}
            onBlur={(e) => setParam('maxPrice', e.target.value)}
            className={`${input} w-full`}
          />
        </div>
        <p className="mt-2 text-xs text-muted">In dollars. Leave either side blank.</p>
      </FilterGroup>

      <FilterGroup title="Availability">
        <div className="space-y-2.5">
          <label
            htmlFor={`${idPrefix}-inStock`}
            className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-2"
          >
            <input
              id={`${idPrefix}-inStock`}
              type="checkbox"
              checked={inStockOnly}
              onChange={(e) => setParam('inStock', e.target.checked ? 'true' : '')}
              className="h-4 w-4 rounded-sm border-rule accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane"
            />
            In stock only
          </label>

          <label
            htmlFor={`${idPrefix}-newArrival`}
            className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-2"
          >
            <input
              id={`${idPrefix}-newArrival`}
              type="checkbox"
              checked={newArrivalOnly}
              onChange={(e) => setParam('newArrival', e.target.checked ? 'true' : '')}
              className="h-4 w-4 rounded-sm border-rule accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane"
            />
            New arrivals only
          </label>
        </div>
      </FilterGroup>
    </div>
  );
}

function FilterGroup({ title, children }) {
  return (
    <section>
      <h3 className="label-mono mb-3">{title}</h3>
      {children}
    </section>
  );
}

/**
 * One filter option as a row rather than a pill.
 *
 * Pills were the previous shape and they scanned badly: a wrapped cloud of
 * fifteen rounded rectangles has no reading order, and the selected one is
 * found by hunting for a colour. A left-aligned column reads top to bottom,
 * which is what a list of categories is.
 */
function FilterRow({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`-mx-2 flex w-[calc(100%+1rem)] items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
        active ? 'font-semibold text-ink' : 'text-ink-2 hover:text-ink'
      }`}
    >
      {label}
      {active && (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
      )}
    </button>
  );
}
