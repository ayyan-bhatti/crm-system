import { Link } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { Spinner, ErrorBanner, EmptyState } from '../../components/common';

/**
 * Every designer/brand in the catalogue, with how many pieces they have —
 * real data from `GET /shop/products/brands`, not a hand-written list that
 * would drift the first time a product's brand changed in the CRM.
 */
export default function Designers() {
  const { data, loading, error } = useFetch(() => shopProductsApi.brands(), []);
  const designers = data || [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <p className="label-mono">Designers</p>
      <h1 className="font-display mt-1 mb-2 text-3xl font-semibold text-ink">
        The names behind the catalogue
      </h1>
      <p className="mb-8 max-w-xl text-sm text-ink-2">
        Every piece we sell comes from one of these studios. Browse by name if you already know
        whose work you like.
      </p>

      {loading && <Spinner full />}
      <ErrorBanner message={error} />

      {!loading && designers.length === 0 && (
        <EmptyState title="No designers yet" hint="Check back once the catalogue is stocked." />
      )}

      {designers.length > 0 && (
        <ul className="divide-y divide-hairline border-y border-hairline">
          {designers.map((designer) => (
            <li key={designer.name}>
              <Link
                to={`/products?brand=${encodeURIComponent(designer.name)}`}
                className="flex items-center justify-between gap-4 py-5 transition-colors hover:bg-plane"
              >
                <span className="font-display text-xl text-ink">{designer.name}</span>
                <span className="label-mono shrink-0">
                  {designer.count} piece{designer.count === 1 ? '' : 's'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
