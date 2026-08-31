import { useState } from 'react';
import { Link } from 'react-router-dom';
import ColourSwatches from './ColourSwatches';
import { money, galleryFor, priceRange } from '../../ui';
import ProductImage from './ProductImage';

/**
 * One tile in the catalogue grid.
 *
 * WHY THE QUICK VIEW BUTTON IS NOT INSIDE THE LINK
 *
 * The whole card is a `<Link>`, which is right — the entire tile should be
 * clickable. But a `<button>` nested inside an `<a>` is invalid HTML, and
 * browsers resolve it inconsistently: the click may activate the button, follow
 * the link, or both. So the button is a SIBLING, positioned over the card, and
 * the card's link sits beneath it. Nothing about the layout gives that away,
 * which is why it is written down.
 */
export default function ProductCard({ product, onQuickView }) {
  const [hovered, setHovered] = useState(false);
  const images = galleryFor(product);
  const range = priceRange(product);

  // The hover swap only happens where there genuinely is a second photograph.
  // A "swap" back to the same image reads as a flicker, not an affordance.
  const secondary = images.length > 1 ? images[1] : null;

  return (
    <div
      className="group relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link
        to={`/products/${product._id}`}
        className="hover-lift block overflow-hidden rounded-xl border border-hairline bg-surface"
      >
        <div className="relative aspect-square overflow-hidden bg-neutral-wash">
          <ProductImage
            product={product}
            src={images[0]}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-500 ${
              hovered && secondary ? 'opacity-0' : 'opacity-100'
            } ${hovered && !secondary ? 'scale-[1.04]' : 'scale-100'}`}
          />
          {secondary && (
            <ProductImage
              product={product}
              src={secondary}
              alt=""
              aria-hidden="true"
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
                hovered ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}

          <ProductBadge product={product} />

          {!product.inStock && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface/60">
              <span className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-plane">
                Sold out
              </span>
            </div>
          )}
        </div>

        <div className="p-3">
          <p className="truncate text-sm font-medium text-ink">{product.name}</p>

          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-ink tabular">
              {/*
               * "from $95" only where colours genuinely differ in price. On a
               * product with one price it would be a hedge that makes the shop
               * look like it is hiding something.
               */}
              {range ? `from ${money(range.min)}` : money(product.price)}
            </span>
            <ColourSwatches variants={product.variants} />
          </div>
        </div>
      </Link>

      {/*
        Sibling, not child — see the note at the top. Hidden from keyboard and
        screen-reader users on purpose: it is a shortcut to a subset of the
        product page, and the card's own link already goes to all of it, so
        exposing a second route to less information adds noise rather than
        access.
      */}
      {onQuickView && product.inStock && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => onQuickView(product)}
          className="pointer-events-none absolute inset-x-3 bottom-[4.5rem] rounded-lg bg-surface/95 py-2 text-xs font-semibold text-ink opacity-0 shadow-card backdrop-blur transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100"
        >
          Quick view
        </button>
      )}
    </div>
  );
}

/**
 * At most ONE badge, chosen by priority.
 *
 * Stacking "New" and "Low stock" and "Sale" on one tile is how a grid becomes
 * unreadable, and the badges then stop meaning anything because every card has
 * one. The order below is by urgency to the shopper: a thing about to run out
 * matters more than a thing that is new.
 */
function ProductBadge({ product }) {
  if (!product.inStock) return null;

  const isNew =
    product.createdAt &&
    Date.now() - new Date(product.createdAt).getTime() < 14 * 24 * 60 * 60 * 1000;

  let badge = null;
  if (product.lowStock) badge = { label: 'Low stock', className: 'bg-warning-wash text-warning-ink' };
  else if (isNew) badge = { label: 'New', className: 'bg-ink text-plane' };

  if (!badge) return null;

  return (
    <span
      className={`absolute left-2.5 top-2.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}
