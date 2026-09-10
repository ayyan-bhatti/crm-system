import { useWishlist } from '../../context/WishlistContext';

/**
 * The heart toggle — shared between the catalogue card and the product page
 * so the two can never disagree about whether something is saved.
 *
 * `preventDefault` and `stopPropagation` matter wherever this sits over a
 * `<Link>` (the card): without them, tapping the heart also follows the card's
 * link to the product page, which is not what saving something for later is
 * supposed to do.
 *
 * SAVED IS NOT SIGNALLED BY COLOUR ALONE. The heart fills as well as changing
 * colour, and `aria-pressed` plus a label that names the action carries the
 * state to anyone who cannot see either.
 */
const VARIANTS = {
  // A small round overlay on a product card's photo. Deliberately quiet until
  // the pointer is on the tile — a grid of twelve red hearts reads as a
  // wishlist page rather than a catalogue.
  icon:
    'flex h-9 w-9 items-center justify-center rounded-full bg-surface/90 shadow-card backdrop-blur ' +
    'transition-[color,background-color,transform] hover:scale-105 hover:bg-surface',
  // A full-size button alongside "Add to cart" on the product page.
  button:
    'flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-md border border-rule ' +
    'bg-surface transition-colors hover:border-ink/25 hover:bg-sunken',
};

export default function WishlistButton({ product, className = '', variant = 'icon' }) {
  const { has, toggle } = useWishlist();
  const saved = has(product._id);

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={
        saved
          ? `Remove ${product.name} from your wishlist`
          : `Save ${product.name} to your wishlist`
      }
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle(product);
      }}
      className={`${VARIANTS[variant]} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane ${
        saved ? 'text-critical' : 'text-ink-2 hover:text-critical'
      } ${className}`}
    >
      <svg
        viewBox="0 0 20 20"
        className={variant === 'button' ? 'h-5 w-5' : 'h-[18px] w-[18px]'}
        fill={saved ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 17.3l-1.1-1C4.9 12.9 2.5 10.8 2.5 7.9 2.5 5.6 4.3 4 6.5 4c1.3 0 2.5.6 3.5 1.7C11 4.6 12.2 4 13.5 4c2.2 0 4 1.6 4 3.9 0 2.9-2.4 5-6.4 8.4l-1.1 1z" />
      </svg>
    </button>
  );
}
