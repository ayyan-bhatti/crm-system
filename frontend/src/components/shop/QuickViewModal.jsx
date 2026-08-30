import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import VariantPicker from './VariantPicker';
import { useCart } from '../../context/CartContext';
import { useToast } from '../Toast';
import { errorMessage } from '../../api/client';
import { Spinner } from '../common';
import { btnPrimary, btnSecondary, galleryFor, money } from '../../ui';

/**
 * Product details in a dialog, without leaving the grid.
 *
 * DELIBERATELY A SUBSET OF THE PRODUCT PAGE, not a copy of it. It answers "what
 * is this and can I have it in blue" — image, price, description, variant
 * picker, add to cart — and stops there. Recommendations, the full gallery and
 * the long copy stay on the real page, with a link to it. A modal that
 * reproduces an entire page is a page rendered in a box too small for it.
 *
 * The product passed in is the one from the grid, which already carries
 * everything shown here, so opening this makes NO request. That is the point of
 * quick view; fetching would make it slower than the navigation it replaces.
 */
export default function QuickViewModal({ product, onClose }) {
  const { addItem } = useCart();
  const toast = useToast();
  const [variantId, setVariantId] = useState(null);
  const [adding, setAdding] = useState(false);

  const hasVariants = (product?.variants || []).length > 0;
  const variant = product?.variants?.find((v) => v._id === variantId) || null;

  /*
   * Escape closes it, and the body stops scrolling behind it.
   *
   * Both are what makes this a dialog rather than a div that looks like one.
   * Without the scroll lock, a wheel over the backdrop scrolls the grid
   * underneath, which is disorienting on a laptop and actively broken on a
   * phone, where the page behind can end up somewhere else entirely by the time
   * the modal closes.
   */
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }

    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  if (!product) return null;

  const price = variant?.price ?? product.price;
  const canAdd = product.inStock && (!hasVariants || Boolean(variantId));

  async function handleAdd() {
    setAdding(true);
    try {
      await addItem(product, 1, variant);
      toast.success(`${product.name} added to your cart.`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not add to cart'));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close quick view"
        onClick={onClose}
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Quick view: ${product.name}`}
        className="animate-fade-rise relative max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-surface shadow-pop sm:rounded-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full bg-surface/90 p-2 text-ink-2 hover:bg-neutral-wash"
        >
          ✕
        </button>

        <div className="grid gap-6 p-5 sm:grid-cols-2 sm:p-6">
          <div className="aspect-square overflow-hidden rounded-xl bg-neutral-wash">
            <img
              src={galleryFor(product)[0]}
              alt=""
              className="h-full w-full object-cover"
            />
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              {product.category}
            </p>
            <h2 className="font-display mt-1 text-2xl font-semibold text-ink">{product.name}</h2>
            <p className="mt-2 text-xl font-semibold text-ink tabular">{money(price)}</p>

            {product.description && (
              <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-ink-2">
                {product.description}
              </p>
            )}

            {hasVariants && (
              <div className="mt-5">
                <VariantPicker
                  variants={product.variants}
                  value={variantId}
                  onChange={setVariantId}
                />
              </div>
            )}

            <div className="mt-6 space-y-2">
              <button
                type="button"
                className={`${btnPrimary} w-full`}
                disabled={!canAdd || adding}
                onClick={handleAdd}
              >
                {adding ? <Spinner /> : 'Add to cart'}
              </button>

              {/*
                The reason the button is disabled, said out loud. A greyed-out
                control with no explanation is the single most common way a
                storefront loses a sale it could have made.
              */}
              {hasVariants && !variantId && product.inStock && (
                <p className="text-center text-xs text-muted">Choose a colour to continue.</p>
              )}

              <Link
                to={`/products/${product._id}`}
                onClick={onClose}
                className={`${btnSecondary} w-full`}
              >
                See full details
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
