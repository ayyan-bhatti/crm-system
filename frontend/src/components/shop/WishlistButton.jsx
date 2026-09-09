import { useWishlist } from '../../context/WishlistContext';

/**
 * The heart toggle — shared between the catalogue card and the product page
 * so the two can never disagree about whether something is saved.
 *
 * `stopPropagation` matters wherever this sits inside a `<Link>` (the card):
 * without it, tapping the heart also follows the card's link to the product
 * page, which is not what saving something for later is supposed to do.
 */
const VARIANTS = {
  // A small round overlay on a product card's photo.
  icon: 'flex h-8 w-8 items-center justify-center rounded-full bg-surface/90 shadow-card backdrop-blur',
  // A full-size button alongside "Add to cart" on the product page.
  button:
    'flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-lg border border-hairline bg-surface hover:border-rule',
};

export default function WishlistButton({ product, className = '', variant = 'icon' }) {
  const { has, toggle } = useWishlist();
  const saved = has(product._id);

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={saved ? `Remove ${product.name} from your wishlist` : `Save ${product.name} to your wishlist`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle(product);
      }}
      className={`${VARIANTS[variant]} text-ink-2 transition-colors hover:text-critical-ink ${
        saved ? 'text-critical-ink' : ''
      } ${className}`}
    >
      <svg
        viewBox="0 0 20 20"
        className="h-4 w-4"
        fill={saved ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.6}
        aria-hidden="true"
      >
        <path d="M10 17.3l-1.1-1C4.9 12.9 2.5 10.8 2.5 7.9 2.5 5.6 4.3 4 6.5 4c1.3 0 2.5.6 3.5 1.7C11 4.6 12.2 4 13.5 4c2.2 0 4 1.6 4 3.9 0 2.9-2.4 5-6.4 8.4l-1.1 1z" />
      </svg>
    </button>
  );
}
