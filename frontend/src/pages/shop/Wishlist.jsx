import { Link } from 'react-router-dom';
import { useWishlist } from '../../context/WishlistContext';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { Breadcrumb, ButtonLink, EmptyState, Skeleton } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';

/**
 * The buyer's saved-for-later list. Available to a guest too, unlike
 * BuyerOrders — a wishlist is meaningful before there is any reason to have an
 * account, which is exactly why it works from `localStorage` for anyone who has
 * not signed in. See `WishlistContext` for the guest/server split.
 *
 * THE STANDFIRST TELLS THE TRUTH ABOUT WHERE THE LIST LIVES, and which truth
 * it tells depends on whether there is a session. "Saved on this device" is
 * accurate for a guest and actively misleading for a signed-in buyer, whose
 * list is on the server and does follow them between browsers. A line that is
 * wrong half the time is worse than no line, because the half it is wrong for
 * is the half being asked to trust it.
 */
export default function Wishlist() {
  const { items, loading } = useWishlist();
  const { isSignedIn } = useBuyerAuth();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <Breadcrumb items={[{ label: 'Home', to: '/' }, { label: 'Wishlist' }]} className="mb-6" />

      <header className="max-w-2xl">
        <p className="label-mono">Saved</p>
        <h1 className="font-display mt-2 text-[34px] leading-[1.05] text-ink sm:text-[48px]">
          Your wishlist
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-ink-2">
          {isSignedIn
            ? 'Saved to your account, so it follows you to any browser you sign in from.'
            : 'Saved on this device. Sign in to keep it across your other devices too.'}
        </p>
      </header>

      <div className="mt-10 border-t border-hairline pt-10 sm:mt-12">
        {loading && (
          <>
            <p role="status" className="sr-only">
              Loading your wishlist
            </p>
            <div
              className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:grid-cols-4 lg:gap-x-6"
              aria-hidden="true"
            >
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index}>
                  <Skeleton className="aspect-[4/5] w-full rounded-lg" />
                  <Skeleton className="mt-3.5 h-4 w-3/4" />
                  <Skeleton className="mt-2 h-4 w-20" />
                </div>
              ))}
            </div>
          </>
        )}

        {!loading && items.length === 0 && (
          <EmptyState
            title="Nothing saved yet"
            hint="Tap the heart on anything you like the look of — it will show up here, and it will still be here next time."
            action={<ButtonLink to="/products">Browse the catalogue</ButtonLink>}
          />
        )}

        {!loading && items.length > 0 && (
          <>
            <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-sm text-ink-2 tabular">
                {items.length} {items.length === 1 ? 'piece' : 'pieces'} saved
              </p>
              <Link
                to="/products"
                className="text-sm font-medium text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-brand"
              >
                Keep browsing
              </Link>
            </div>

            <div className="stagger-children grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-3 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-12">
              {items.map((product) => (
                <ProductCard key={product._id} product={product} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
