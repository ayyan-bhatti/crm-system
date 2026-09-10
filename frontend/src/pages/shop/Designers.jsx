import { Link } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { Breadcrumb, EmptyState, ErrorBanner, Skeleton } from '../../components/common';

/**
 * Every designer/brand in the catalogue, with how many pieces they have —
 * real data from `GET /shop/products/brands`, not a hand-written list that
 * would drift the first time a product's brand changed in the CRM.
 *
 * AN INDEX, SET LIKE ONE. Names at editorial size on their own rules, with the
 * piece count as the only other thing on the line. The alternative — a grid of
 * cards, each with a box and a shadow — spends a card's worth of chrome on
 * what is fundamentally one word and one number, and makes twelve studios
 * take four screens instead of one.
 *
 * THE COUNT IS SHOWN BECAUSE IT IS THE ONE THING THAT MAKES THIS LIST
 * NAVIGABLE. "3 pieces" and "40 pieces" are different promises about what is
 * behind the link, and a shopper deciding where to start deserves to know
 * which is which before clicking.
 */
export default function Designers() {
  const { data, loading, error } = useFetch(() => shopProductsApi.brands(), []);
  const designers = data || [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <Breadcrumb items={[{ label: 'Home', to: '/' }, { label: 'Designers' }]} className="mb-6" />

      <header className="max-w-2xl">
        <p className="label-mono">Designers</p>
        <h1 className="font-display mt-2 text-[34px] leading-[1.05] text-ink sm:text-[52px]">
          The names behind the catalogue
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-ink-2">
          Every piece we sell comes from one of these studios. Browse by name if you already know
          whose work you like.
        </p>
      </header>

      <div className="mt-12 sm:mt-16">
        <ErrorBanner message={error} />

        {loading && (
          <>
            <p role="status" className="sr-only">
              Loading designers
            </p>
            <ul className="border-t border-hairline" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <li
                  key={index}
                  className="flex items-center justify-between gap-6 border-b border-hairline py-7"
                >
                  <Skeleton className="h-7 w-52" />
                  <Skeleton className="h-3 w-16" />
                </li>
              ))}
            </ul>
          </>
        )}

        {!loading && !error && designers.length === 0 && (
          <EmptyState
            title="No designers yet"
            hint="Once the catalogue is stocked, every studio behind it will be listed here."
            action={
              <Link
                to="/products"
                className="text-sm font-medium text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-brand"
              >
                Browse the catalogue
              </Link>
            }
          />
        )}

        {!loading && designers.length > 0 && (
          <>
            <p className="label-mono mb-4">
              {designers.length} {designers.length === 1 ? 'studio' : 'studios'}
            </p>

            <ul className="border-t border-hairline">
              {designers.map((designer) => (
                <li key={designer.name} className="border-b border-hairline">
                  <Link
                    to={`/products?brand=${encodeURIComponent(designer.name)}`}
                    className="group flex items-baseline justify-between gap-6 py-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:py-7"
                  >
                    <span className="font-display min-w-0 truncate text-[24px] leading-tight text-ink transition-colors group-hover:text-brand-ink sm:text-[30px]">
                      {designer.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="label-mono tabular">
                        {designer.count} {designer.count === 1 ? 'piece' : 'pieces'}
                      </span>
                      <span
                        aria-hidden="true"
                        className="text-ink transition-transform group-hover:translate-x-1"
                      >
                        →
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
