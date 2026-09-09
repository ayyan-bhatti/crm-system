import { useEffect, useState } from 'react';

const STORAGE_KEY = 'shop:recently-viewed';
const MAX_ENTRIES = 8;

/**
 * A per-browser "recently viewed" trail, kept in `localStorage` rather than
 * on the server — there is no buyer-agnostic way to store this for a guest,
 * and a signed-in buyer's browsing history is not something the rest of the
 * app needs to know about. A lightweight summary is stored (not the whole
 * product) so the strip can render without a second network round trip.
 */
export default function useRecentlyViewed(product) {
  const [entries, setEntries] = useState([]);

  // Record the product being viewed. Runs once per product id, not on every
  // render — the effect's own write would otherwise re-trigger itself.
  useEffect(() => {
    if (!product?._id) return;

    let stored = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      stored = [];
    }

    const entry = {
      _id: product._id,
      name: product.name,
      price: product.salePrice ?? product.price,
      imageUrl: product.imageUrl || (product.images || [])[0] || '',
    };

    const next = [entry, ...stored.filter((item) => item._id !== product._id)].slice(
      0,
      MAX_ENTRIES
    );

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full or unavailable (private browsing) — the strip simply
      // won't remember this visit, which is a fine degradation.
    }

    // Exclude the product currently being viewed from what the page shows.
    setEntries(next.filter((item) => item._id !== product._id));
  }, [
    product?._id,
    product?.name,
    product?.price,
    product?.salePrice,
    product?.imageUrl,
    product?.images,
  ]);

  return entries;
}
