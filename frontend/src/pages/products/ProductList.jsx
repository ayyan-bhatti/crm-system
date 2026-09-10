import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { productsApi } from '../../api/resources';
import useFetch, { useDebounced } from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import {
  Button,
  Card,
  CardSkeleton,
  Checkbox,
  DropdownMenu,
  ListEmptyState,
  MenuItem,
  Select,
  Table,
  TableSkeleton,
  ErrorBanner,
  PageHeader,
  Pagination,
} from '../../components/common';
import Can from '../../components/Can';
import { btnPrimary, input, link, money, td, th } from '../../ui';

/**
 * Product list with category, low-stock and text filters.
 *
 * The "New product" button is wrapped in <Can do="manageProducts">: sales reps have read-only
 * access to products, so offering them a button the API would reject with a 403
 * would just be a trap.
 */
export default function ProductList() {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page')) || 1;
  const category = searchParams.get('category') || '';
  const lowStock = searchParams.get('lowStock') === 'true';

  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '');
  const search = useDebounced(searchInput, 300);

  const { data, loading, error } = useFetch(
    () =>
      productsApi.list({
        page,
        ...(category && { category }),
        ...(lowStock && { lowStock: 'true' }),
        ...(search && { search }),
      }),
    [page, category, lowStock, search]
  );

  const { data: categories } = useFetch(() => productsApi.categories(), []);
  const { can } = usePermissions();

  const isFiltered = Boolean(category || lowStock || search);

  function setFilter(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setSearchParams(next);
  }

  function setPage(nextPage) {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(nextPage));
    setSearchParams(next);
  }

  function clearFilters() {
    setSearchInput('');
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  return (
    <div>
      <PageHeader
        eyebrow="Commerce"
        title="Products"
        subtitle="The catalogue, with the stock level behind every listing."
        action={
          <Can do="manageProducts">
            <Link to="/crm/products/new" className={btnPrimary}>
              New product
            </Link>
          </Can>
        }
      />

      <ErrorBanner message={error} />

      {/*
        Manager/admin only, mirroring `requireManagerOrAdmin` on
        GET /products/reorder-suggestions — a sales rep has full read access
        to the product list itself, just not to this stock-planning call.
        Lives here rather than on the dashboard because a reorder decision is
        made while looking at stock levels, not from a landing page.
      */}
      {can.viewAllRecords && <ReorderSuggestionsCard />}

      <Card>
        <FilterBar
          onClear={isFiltered ? clearFilters : null}
          search={
            <SearchField
              placeholder="Search name or SKU"
              aria-label="Search products"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setFilter('search', e.target.value);
              }}
            />
          }
        >
          <Select
            className="sm:w-48"
            value={category}
            aria-label="Filter by category"
            onChange={(e) => setFilter('category', e.target.value)}
          >
            <option value="">All categories</option>
            {(categories || []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>

          <Checkbox
            label="Low stock only"
            className="whitespace-nowrap py-2"
            checked={lowStock}
            onChange={(e) => setFilter('lowStock', e.target.checked ? 'true' : '')}
          />
        </FilterBar>

        {loading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : !data?.data.length ? (
          // Distinguishes "no products at all" from "none match your filters" —
          // see the note on ListEmptyState.
          <ListEmptyState filtered={isFiltered} entity="products" onClear={clearFilters} />
        ) : (
          <>
            <Table caption="Products, with category, price and stock on hand">
              <thead className="bg-sunken">
                <tr className="border-b border-hairline">
                  <th className={th}>Product</th>
                  <th className={th}>Category</th>
                  <th className={`${th} text-right`}>Price</th>
                  <th className={`${th} text-right`}>Stock</th>
                  <th className={`${th} w-12 text-right`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.data.map((product) => (
                  <tr key={product._id} className="transition-colors hover:bg-sunken/60">
                    <td className={td}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link to={`/crm/products/${product._id}`} className={link}>
                          {product.name}
                        </Link>
                        {product.featured && <Tag tone="brand">Featured</Tag>}
                        {product.isActive === false && <Tag tone="neutral">Inactive</Tag>}
                      </div>
                      <p className="label-mono mt-1">
                        {product.sku}
                        {product.brand ? ` · ${product.brand}` : ''}
                      </p>
                    </td>
                    <td className={td}>{product.category}</td>
                    <td className={`${td} whitespace-nowrap text-right tabular`}>
                      {money(product.price)}
                    </td>
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <span
                        className={`tabular ${
                          product.isLowStock ? 'font-semibold text-critical-ink' : ''
                        }`}
                      >
                        {product.stockQty}
                      </span>
                      {product.isLowStock && (
                        <span className="ml-2 rounded-full bg-critical-wash px-2 py-0.5 text-xs font-medium text-critical-ink">
                          Low
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-right`}>
                      <RowMenu label={`Actions for ${product.name}`}>
                        <MenuItem to={`/crm/products/${product._id}`}>Open product</MenuItem>
                        {can.manageProducts && (
                          <MenuItem to={`/crm/products/${product._id}/edit`}>Edit product</MenuItem>
                        )}
                      </RowMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

/* --- List furniture, local to this screen ---------------------------------
 * See the note on the same helpers in CustomerList: CRM-list chrome stays
 * beside the list rather than in the shared library.
 * ------------------------------------------------------------------------*/

/** A small inline marker on a product name — featured, inactive. */
function Tag({ tone, children }) {
  const tones = {
    brand: 'bg-brand-wash text-brand-ink',
    neutral: 'bg-neutral-wash text-neutral-ink',
  };

  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** A search input with the magnifier inside it rather than beside it. */
function SearchField({ className = '', ...rest }) {
  return (
    <div className="relative">
      <svg
        viewBox="0 0 20 20"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 fill-muted"
        aria-hidden="true"
      >
        <path d="M9 2a7 7 0 105.2 11.66l3.07 3.07a1 1 0 001.42-1.42l-3.07-3.07A7 7 0 009 2zm0 2a5 5 0 110 10A5 5 0 019 4z" />
      </svg>
      <input type="search" className={`${input} pl-9 ${className}`} {...rest} />
    </div>
  );
}

/** Search left, filters right, and a clear affordance only once one is set. */
function FilterBar({ search, children, onClear }) {
  return (
    <div className="flex flex-col gap-3 border-b border-hairline p-4 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1 lg:max-w-sm">{search}</div>
      <div className="flex flex-wrap items-center gap-3 lg:justify-end">
        {children}
        {onClear && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

/** The "⋯" row-actions trigger, with the menu the caller supplies. */
function RowMenu({ label, children }) {
  return (
    <div className="flex justify-end">
      <DropdownMenu
        label={label}
        triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        trigger={
          <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
            <path d="M6 10a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm5.5 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm5.5 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
          </svg>
        }
      >
        {children}
      </DropdownMenu>
    </div>
  );
}

/**
 * Low-stock products that are actually selling, each with an AI-written
 * justification — figures computed server-side, the sentence generated from
 * them. See `productsApi.reorderSuggestions` and the `mode` it returns.
 */
function ReorderSuggestionsCard() {
  const { data, loading, error } = useFetch(() => productsApi.reorderSuggestions(), []);
  const suggestions = data?.data || [];

  if (!loading && !error && data && suggestions.length === 0) return null;

  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="label-mono">Stock planning</p>
          <h2 className="mt-1 text-sm font-semibold text-ink">Reorder suggestions</h2>
        </div>
        {suggestions.length > 0 && (
          <span className="rounded-full bg-warning-wash px-2.5 py-0.5 text-xs font-medium text-warning-ink">
            {suggestions.length} to review
          </span>
        )}
      </div>

      {loading && <CardSkeleton lines={2} />}
      <ErrorBanner message={error} />

      {suggestions.length > 0 && (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {suggestions.map((item) => (
            <li
              key={item.productId}
              className="rounded-md border border-hairline bg-plane p-3 text-sm"
            >
              <p className="font-semibold text-ink">{item.name}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-2">{item.justification}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
