import { useEffect, useState } from 'react';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { Spinner, ErrorBanner, EmptyState, Pagination } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import { productsApi } from '../../api/resources';
import { input, btnSecondary } from '../../ui';

/**
 * The full catalogue, with a category filter and a natural-language search
 * box. Search and the category/page filters are mutually exclusive views —
 * running a search question against a category-and-page grid at once would
 * mean deciding which one wins, so submitting a search clears the filters
 * instead of trying to combine two different query shapes.
 */
export default function ProductGrid() {
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    // Categories come from the internal, staff-facing endpoint, which is
    // public-safe already — it returns only distinct category names, the
    // same list the storefront filter needs, with nothing internal in it.
    productsApi.categories().then(setCategories).catch(() => {});
  }, []);

  const { data, loading, error } = useFetch(() => {
    if (activeQuery) return shopProductsApi.search(activeQuery);
    return shopProductsApi.list({ page, limit: 12, category: category || undefined });
  }, [activeQuery, page, category]);

  function submitSearch(e) {
    e.preventDefault();
    setActiveQuery(query.trim());
    setPage(1);
  }

  function clearSearch() {
    setQuery('');
    setActiveQuery('');
  }

  const products = data?.data || [];
  const pagination = data?.pagination;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display mb-6 text-3xl font-semibold text-ink">Shop</h1>

      <form onSubmit={submitSearch} className="mb-6 flex gap-2">
        <input
          type="search"
          className={`${input} flex-1`}
          placeholder="Try: something for a rainy weekend under $50"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search products"
        />
        <button type="submit" className={btnSecondary}>
          Search
        </button>
        {activeQuery && (
          <button type="button" className={btnSecondary} onClick={clearSearch}>
            Clear
          </button>
        )}
      </form>

      {!activeQuery && categories.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setCategory('');
              setPage(1);
            }}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              category === '' ? 'bg-brand text-white' : 'bg-neutral-wash text-ink-2'
            }`}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setCategory(c);
                setPage(1);
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                category === c ? 'bg-brand text-white' : 'bg-neutral-wash text-ink-2'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {activeQuery && data && (
        <p className="mb-4 text-sm text-muted">
          {data.mode === 'ai'
            ? `Results for "${activeQuery}"`
            : `Showing matches for "${activeQuery}"${data.reason ? ` — ${data.reason}` : ''}`}
        </p>
      )}

      {loading && <Spinner full />}
      {error && <ErrorBanner message={error} />}

      {data && products.length === 0 && (
        <EmptyState title="No products found" hint="Try a different search or category." />
      )}

      {products.length > 0 && (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {products.map((product) => (
            <ProductCard key={product._id} product={product} />
          ))}
        </div>
      )}

      {!activeQuery && pagination && pagination.pages > 1 && (
        <div className="mt-8">
          <Pagination
            page={pagination.page}
            pages={pagination.pages}
            total={pagination.total}
            onChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
