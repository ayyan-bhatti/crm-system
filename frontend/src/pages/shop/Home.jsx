import { useState } from 'react';
import { Link } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { Spinner, ErrorBanner, EmptyState, ButtonLink } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import QuickViewModal from '../../components/shop/QuickViewModal';
import { CATEGORY_DISCOVERY, HERO, PROMOS } from '../../shopContent';

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
  const { data: featured } = useFetch(
    () => shopProductsApi.list({ limit: 4, featured: 'true' }),
    []
  );
  const [quickView, setQuickView] = useState(null);

  return (
    <div>
      <Hero />

      <CategoryDiscovery />

      {featured && featured.data.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 pt-14 sm:px-6">
          <div className="mb-6">
            <p className="label-mono">Featured</p>
            <h2 className="font-display mt-1 text-[28px] leading-tight text-ink">
              Chosen by the buying team
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {featured.data.map((product) => (
              <ProductCard key={product._id} product={product} onQuickView={setQuickView} />
            ))}
          </div>
        </section>
      )}

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="label-mono">Latest</p>
            <h2 className="font-display mt-1 text-[28px] leading-tight text-ink">New in</h2>
            <p className="mt-1.5 text-sm text-ink-2">The most recent additions to the catalogue.</p>
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

/** "What are you looking for?" — a hover-interactive grid of real categories. */
function CategoryDiscovery() {
  return (
    <section className="mx-auto max-w-7xl px-4 pt-14 sm:px-6">
      <div className="mb-6">
        <p className="label-mono">Browse</p>
        <h2 className="font-display mt-1 text-[28px] leading-tight text-ink">
          What are you looking for?
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {CATEGORY_DISCOVERY.map((entry) => (
          <Link
            key={entry.name}
            to={`/products?category=${encodeURIComponent(entry.name)}`}
            className="group relative aspect-[4/5] overflow-hidden rounded-xl bg-neutral-wash"
          >
            <img
              src={`https://images.unsplash.com/photo-${entry.image}?w=500&q=75&auto=format&fit=crop`}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {/*
              A scrim that reaches further up and lands darker than it looks
              like it needs to. The previous one faded to nothing almost
              immediately, which was fine over the dark bedroom tile and left
              the label barely readable over the pale lighting and rug shots —
              and a caption's contrast cannot depend on which photograph
              happens to sit behind it.
            */}
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent"
            />
            <span className="absolute inset-x-0 bottom-0 p-4 font-display text-[19px] text-white drop-shadow-sm">
              {entry.name}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * The hero: copy on the left, photograph on the right.
 *
 * A SPLIT RATHER THAN TEXT OVER A FULL-BLEED IMAGE, and the reason is
 * legibility rather than taste. Type set over a photograph needs a scrim
 * heavy enough to guarantee contrast against whatever happens to be behind
 * each line, and a scrim heavy enough to do that reliably has already ruined
 * the photograph it is protecting. Splitting the two means the headline sits
 * on a known background at a known contrast, and the image is never dimmed.
 *
 * It also lets the picture be the product. This was previously a generated
 * gradient on the argument that a stock photo is worse than instant
 * typography — true of a generic app, wrong of a furniture shop, where the
 * first thing a visitor wants from the front page is to see the furniture.
 */
function Hero() {
  return (
    <section className="border-b border-hairline bg-plane">
      <div className="mx-auto grid max-w-7xl items-stretch gap-0 lg:grid-cols-2">
        <div className="animate-fade-rise flex flex-col justify-center px-4 py-16 sm:px-6 sm:py-24 lg:py-28 lg:pr-14">
          <p className="label-mono">{HERO.eyebrow}</p>
          <h1 className="font-display mt-5 text-[40px] leading-[1.05] text-ink sm:text-[56px]">
            {HERO.headline}
          </h1>
          <p className="mt-6 max-w-md text-base leading-relaxed text-ink-2">{HERO.body}</p>

          <div className="mt-9 flex flex-wrap gap-3">
            <ButtonLink to={HERO.primaryCta.to} size="lg">
              {HERO.primaryCta.label}
            </ButtonLink>
            <ButtonLink to={HERO.secondaryCta.to} variant="secondary" size="lg">
              {HERO.secondaryCta.label}
            </ButtonLink>
          </div>
        </div>

        <div className="relative min-h-[280px] sm:min-h-[380px] lg:min-h-[560px]">
          <img
            src={HERO.image}
            alt={HERO.imageAlt}
            /* The one image on the site that must NOT be lazy — it is the
               largest contentful paint, and deferring it is deferring the
               moment the page looks like anything. */
            loading="eager"
            fetchPriority="high"
            className="absolute inset-0 h-full w-full object-cover"
          />
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
