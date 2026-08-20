import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { productsApi } from '../../api/resources';
import useFetch, { useDebounced } from '../../hooks/useFetch';
import {
  Card,
  ListEmptyState,
  TableSkeleton,
  ErrorBanner,
  PageHeader,
  Pagination,
} from '../../components/common';
import { RoleGate } from '../../components/ProtectedRoute';
import { PRODUCT_WRITE_ROLES } from '../../constants';
import { btnPrimary, input, link, money, td, th } from '../../ui';

/**
 * Product list with category, low-stock and text filters.
 *
 * The "New product" button is wrapped in a RoleGate: sales reps have read-only
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

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle="Inventory and stock levels."
        action={
          <RoleGate roles={PRODUCT_WRITE_ROLES}>
            <Link to="/products/new" className={btnPrimary}>
              New product
            </Link>
          </RoleGate>
        }
      />

      <ErrorBanner message={error} />

      <Card>
        <div className="grid gap-3 border-b border-hairline p-4 sm:grid-cols-3">
          <input
            className={input}
            placeholder="Search name or SKU"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setFilter('search', e.target.value);
            }}
          />

          <select
            className={input}
            value={category}
            onChange={(e) => setFilter('category', e.target.value)}
          >
            <option value="">All categories</option>
            {(categories || []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-hairline"
              checked={lowStock}
              onChange={(e) => setFilter('lowStock', e.target.checked ? 'true' : '')}
            />
            Low stock only
          </label>
        </div>

        {loading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : !data?.data.length ? (
          // Distinguishes "no products at all" from "none match your filters" —
          // see the note on ListEmptyState.
          <ListEmptyState
            filtered={Boolean(category || lowStock || search)}
            entity="products"
            onClear={() => {
              setSearchInput('');
              setSearchParams(new URLSearchParams(), { replace: true });
            }}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th}>Product</th>
                    <th className={th}>Category</th>
                    <th className={`${th} text-right`}>Price</th>
                    <th className={`${th} text-right`}>Stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {data.data.map((product) => (
                    <tr key={product._id} className="hover:bg-plane">
                      <td className={td}>
                        <Link to={`/products/${product._id}`} className={link}>
                          {product.name}
                        </Link>
                        <p className="text-xs text-muted">{product.sku}</p>
                      </td>
                      <td className={td}>{product.category}</td>
                      <td className={`${td} text-right`}>{money(product.price)}</td>
                      <td className={`${td} text-right`}>
                        <span className={product.isLowStock ? 'font-medium text-critical-ink' : ''}>
                          {product.stockQty}
                        </span>
                        {product.isLowStock && (
                          <span className="ml-2 rounded-full bg-critical-wash px-2 py-0.5 text-xs font-medium text-critical-ink">
                            Low
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
