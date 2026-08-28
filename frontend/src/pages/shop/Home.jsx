import { Link } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { Spinner, ErrorBanner, EmptyState } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';

export default function ShopHome() {
  const { data, loading, error } = useFetch(() => shopProductsApi.list({ limit: 8 }), []);

  return (
    <div>
      <section className="animate-fade-rise bg-ink px-4 py-20 text-center sm:px-6">
        <h1 className="font-display mx-auto max-w-2xl text-4xl font-semibold text-plane sm:text-5xl">
          Things worth buying, found fast.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-ink-2/80 text-base text-neutral-300">
          Browse the full catalogue, or search in plain language — &quot;something for a rainy
          weekend under $50&quot; works.
        </p>
        <Link
          to="/products"
          className="hover-lift mt-8 inline-block rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand-strong"
        >
          Shop the catalogue
        </Link>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 className="font-display mb-6 text-2xl font-semibold text-ink">Featured</h2>

        {loading && <Spinner full />}
        {error && <ErrorBanner message={error} />}
        {data && data.data.length === 0 && (
          <EmptyState title="Nothing in the catalogue yet" hint="Check back soon." />
        )}

        {data && data.data.length > 0 && (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {data.data.map((product) => (
              <ProductCard key={product._id} product={product} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
