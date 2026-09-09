import { Link } from 'react-router-dom';
import { useWishlist } from '../../context/WishlistContext';
import { Card, EmptyState, Spinner } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import { link } from '../../ui';

/**
 * The buyer's saved-for-later list. Available to a guest too, unlike
 * BuyerOrders — a wishlist is meaningful before there is any reason to have
 * an account, which is exactly why it works from `localStorage` for anyone
 * who has not signed in. See `WishlistContext` for the guest/server split.
 */
export default function Wishlist() {
  const { items, loading } = useWishlist();

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display mb-2 text-3xl font-semibold text-ink">Your wishlist</h1>
      <p className="mb-6 text-sm text-ink-2">
        Saved on this device. Sign in to keep it across your other devices too.
      </p>

      {loading && <Spinner full />}

      {!loading && items.length === 0 && (
        <Card>
          <EmptyState
            title="Nothing saved yet"
            hint="Tap the heart on anything you like the look of — it will show up here."
            action={
              <Link to="/products" className={link}>
                Browse the catalogue
              </Link>
            }
          />
        </Card>
      )}

      {!loading && items.length > 0 && (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((product) => (
            <ProductCard key={product._id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
