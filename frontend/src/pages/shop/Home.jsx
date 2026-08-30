import { useState } from 'react';
import { Link } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { Spinner, ErrorBanner, EmptyState } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import QuickViewModal from '../../components/shop/QuickViewModal';
import { HERO, PROMOS } from '../../shopContent';

/**
 * The storefront's front page: hero, a featured grid, and two promotional
 * panels.
 *
 * ALL THE COPY IS IMPORTED FROM `shopContent.js` rather than written inline,
 * and that is the whole of the "configurable content" decision for this round —
 * see the long note at the top of that file for why a real CMS was deliberately
 * not built here, and what would have to change if one is wanted later.
 */
export default function ShopHome() {
  const { data, loading, error } = useFetch(
    () => shopProductsApi.list({ limit: 8, sort: 'newest' }),
    []
  );
  const [quickView, setQuickView] = useState(null);

  return (
    <div>
      <Hero />

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-ink">New in</h2>
            <p className="mt-1 text-sm text-ink-2">The most recent additions to the catalogue.</p>
          </div>
          <Link
            to="/products"
            className="shrink-0 text-sm font-medium text-ink underline-offset-4 hover:underline"
          >
            See all
          </Link>
        </div>

        {loading && <Spinner full />}
        {error && <ErrorBanner message={error} />}
        {data && data.data.length === 0 && (
          <EmptyState title="Nothing in the catalogue yet" hint="Check back soon." />
        )}

        {data && data.data.length > 0 && (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {data.data.map((product) => (
              <ProductCard key={product._id} product={product} onQuickView={setQuickView} />
            ))}
          </div>
        )}
      </section>

      <section className="mx-auto grid max-w-7xl gap-5 px-4 pb-16 sm:px-6 md:grid-cols-2">
        {PROMOS.map((promo) => (
          <PromoPanel key={promo.headline} promo={promo} />
        ))}
      </section>

      {quickView && (
        <QuickViewModal product={quickView} onClose={() => setQuickView(null)} />
      )}
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-ink">
      {/*
        A generated gradient rather than a photograph. A hero image is the
        heaviest thing on the heaviest page, and a stock photo of nothing in
        particular is worse than typography that loads instantly — see the same
        reasoning behind the generated product placeholders in ui.js.
      */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(60rem 30rem at 15% -10%, var(--color-brand), transparent 60%), ' +
            'radial-gradient(40rem 24rem at 90% 110%, var(--color-series-2, #1f9d78), transparent 55%)',
        }}
      />

      <div className="animate-fade-rise relative mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-plane/70">
          {HERO.eyebrow}
        </p>
        <h1 className="font-display mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] text-plane sm:text-6xl">
          {HERO.headline}
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-plane/75">{HERO.body}</p>

        <div className="mt-9 flex flex-wrap gap-3">
          <Link
            to={HERO.primaryCta.to}
            className="hover-lift rounded-lg bg-plane px-6 py-3 text-sm font-semibold text-ink transition-colors hover:bg-white"
          >
            {HERO.primaryCta.label}
          </Link>
          <Link
            to={HERO.secondaryCta.to}
            className="rounded-lg border border-plane/30 px-6 py-3 text-sm font-semibold text-plane transition-colors hover:bg-plane/10"
          >
            {HERO.secondaryCta.label}
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * A promotional panel, linking to a real category filter.
 *
 * The link is built from `promo.category` rather than being a hardcoded product
 * id, so a panel keeps working after the catalogue changes — a promo pointing
 * at a deleted product is a 404 with marketing copy on top of it.
 */
function PromoPanel({ promo }) {
  const dark = promo.tone === 'ink';

  return (
    <Link
      to={`/products?category=${encodeURIComponent(promo.category)}`}
      className={`hover-lift group flex min-h-56 flex-col justify-end rounded-2xl border p-8 transition-colors ${
        dark
          ? 'border-ink bg-ink text-plane hover:bg-ink/95'
          : 'border-hairline bg-surface text-ink hover:bg-neutral-wash/50'
      }`}
    >
      <p
        className={`text-xs font-semibold uppercase tracking-[0.18em] ${
          dark ? 'text-plane/60' : 'text-muted'
        }`}
      >
        {promo.eyebrow}
      </p>
      <h3 className="font-display mt-3 max-w-sm text-2xl font-semibold leading-snug">
        {promo.headline}
      </h3>
      <p className={`mt-2 max-w-sm text-sm ${dark ? 'text-plane/70' : 'text-ink-2'}`}>
        {promo.body}
      </p>
      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold">
        {promo.cta}
        <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </span>
    </Link>
  );
}
