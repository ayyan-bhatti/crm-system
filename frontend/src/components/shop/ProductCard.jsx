import { useState } from 'react';
import { Link } from 'react-router-dom';
import ColourSwatches from './ColourSwatches';
import RatingStars from './RatingStars';
import WishlistButton from './WishlistButton';
import { money, galleryFor, priceRange } from '../../ui';
import ProductImage from './ProductImage';

/**
 * One tile in the catalogue grid — the most-repeated object on the site.
 *
 * IMAGE-FIRST, WITH NO CARD AROUND IT.
 *
 * The tile used to be a bordered, shadowed, lifting card: a box drawn around a
 * photograph, competing with it. An editorial catalogue does the opposite —
 * the picture sits directly on the page ground and the type sits under it, so
 * a grid of twelve reads as twelve photographs rather than twelve boxes. The
 * only chrome left is the `bg-sunken` frame BEHIND the image, which exists so
 * the row does not reflow while photographs load in at different speeds.
 *
 * TWO LINKS, ONE OF THEM HIDDEN FROM ASSISTIVE TECHNOLOGY.
 *
 * The photograph and the caption both navigate to the product, but a link
 * whose only content is an `alt=""` image has no accessible name at all, so
 * the image link is `aria-hidden` and untabbable and the caption link carries
 * the product's name. That is one link per product in the accessibility tree
 * and two hit targets for a pointer, which is the right way round.
 *
 * The overlay controls — badge, wishlist heart, quick view — are SIBLINGS of
 * the image link rather than children of it. A `<button>` inside an `<a>` is
 * invalid HTML that browsers resolve inconsistently: the click may activate
 * the button, follow the link, or both.
 */
export default function ProductCard({ product, onQuickView }) {
  const [hovered, setHovered] = useState(false);
  const images = galleryFor(product);
  const range = priceRange(product);
  const href = `/products/${product._id}`;

  // The hover swap only happens where there genuinely is a second photograph.
  // A "swap" back to the same image reads as a flicker, not an affordance.
  const secondary = images.length > 1 ? images[1] : null;
  const soldOut = !product.inStock;

  return (
    <article
      className="group relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* --- The photograph, and everything that floats over it ------------ */}
      <div className="relative">
        <Link
          to={href}
          aria-hidden="true"
          tabIndex={-1}
          className="block overflow-hidden rounded-lg bg-sunken focus-visible:outline-none"
        >
          {/*
            4:5 rather than square. Furniture is taller than it is wide far
            more often than the reverse, and the extra height is what stops a
            wardrobe or a floor lamp being cropped into an abstraction.
          */}
          <div className="relative aspect-[4/5] overflow-hidden bg-sunken">
            <ProductImage
              product={product}
              src={images[0]}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-700 ease-[var(--motion-ease)] ${
                hovered && secondary ? 'opacity-0' : 'opacity-100'
              } ${hovered && !secondary ? 'scale-[1.03]' : 'scale-100'} ${
                soldOut ? 'opacity-55' : ''
              }`}
            />
            {secondary && (
              <ProductImage
                product={product}
                src={secondary}
                alt=""
                aria-hidden="true"
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-[var(--motion-ease)] ${
                  hovered ? 'opacity-100' : 'opacity-0'
                }`}
              />
            )}
          </div>
        </Link>

        <ProductBadge product={product} />

        <WishlistButton product={product} className="absolute right-2.5 top-2.5" />

        {/*
          Hidden from keyboard and screen-reader users on purpose: it is a
          shortcut to a SUBSET of the product page, and the caption's own link
          already goes to all of it, so exposing a second route to less
          information adds noise rather than access.
        */}
        {onQuickView && product.inStock && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => onQuickView(product)}
            className="pointer-events-none absolute inset-x-2.5 bottom-2.5 rounded-md border border-hairline bg-surface/95 py-2.5 text-xs font-semibold tracking-wide text-ink opacity-0 backdrop-blur transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100"
          >
            Quick view
          </button>
        )}
      </div>

      {/* --- The caption --------------------------------------------------- */}
      <Link
        to={href}
        className="mt-3.5 block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 focus-visible:ring-offset-plane"
      >
        {product.brand && <p className="label-mono truncate">{product.brand}</p>}

        <h3 className="mt-1 truncate text-[15px] font-medium leading-snug text-ink">
          {product.name}
        </h3>

        {product.rating?.count > 0 && <RatingStars rating={product.rating} className="mt-1.5" />}

        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {product.salePrice ? (
            <>
              <span className="text-[15px] font-semibold text-brand-ink tabular">
                {money(product.salePrice)}
              </span>
              <span className="text-[13px] font-normal text-muted line-through tabular">
                {money(product.price)}
              </span>
            </>
          ) : (
            /*
             * "from $95" only where colours genuinely differ in price. On a
             * product with one price it would be a hedge that makes the shop
             * look like it is hiding something.
             */
            <span className="text-[15px] font-semibold text-ink tabular">
              {range ? `from ${money(range.min)}` : money(product.price)}
            </span>
          )}
        </div>
      </Link>

      {product.variants?.length > 0 && (
        <div className="mt-2.5">
          <ColourSwatches variants={product.variants} />
        </div>
      )}
    </article>
  );
}

/**
 * At most ONE badge, chosen by priority.
 *
 * Stacking "New" and "Low stock" and "Sale" on one tile is how a grid becomes
 * unreadable, and the badges then stop meaning anything because every card has
 * one. The order below is by urgency to the shopper: a thing they cannot buy
 * at all outranks a thing about to run out, which outranks a thing that is
 * merely new.
 */
function ProductBadge({ product }) {
  const isNew =
    product.createdAt &&
    Date.now() - new Date(product.createdAt).getTime() < 14 * 24 * 60 * 60 * 1000;

  let badge = null;
  if (!product.inStock) badge = { label: 'Sold out', className: 'bg-ink text-plane' };
  else if (product.lowStock)
    badge = { label: 'Low stock', className: 'bg-warning-wash text-warning-ink' };
  else if (product.salePrice) badge = { label: 'Sale', className: 'bg-brand text-on-brand' };
  else if (isNew) badge = { label: 'New', className: 'bg-surface text-ink' };

  if (!badge) return null;

  return (
    <span
      className={`absolute left-2.5 top-2.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}
