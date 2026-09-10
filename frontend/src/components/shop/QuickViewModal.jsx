import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import VariantPicker from './VariantPicker';
import { useCart } from '../../context/CartContext';
import { useToast } from '../Toast';
import { errorMessage } from '../../api/client';
import { Button, Modal } from '../common';
import RatingStars from './RatingStars';
import { btnSecondary, galleryFor, money } from '../../ui';
import ProductImage from './ProductImage';

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
 *
 * BUILT ON THE SHARED `Modal`, WHICH IS WHY THIS FILE IS SHORT.
 *
 * It used to hand-roll Escape-to-close and a body scroll lock and get the other
 * half of the job wrong: focus stayed on the grid behind it, Tab walked out of
 * the dialog into the page underneath, and closing left focus on `<body>`
 * rather than on the tile that opened it. `Modal` does all four, once, for
 * every overlay in the app — see `useOverlay` in components/common.jsx.
 */
export default function QuickViewModal({ product, onClose }) {
  const { addItem } = useCart();
  const toast = useToast();
  const [variantId, setVariantId] = useState(null);
  const [adding, setAdding] = useState(false);

  // A different product in the same dialog is a different choice. Without this
  // a variant id from the previous tile survives into the next one, where it
  // matches nothing the shopper can see.
  useEffect(() => setVariantId(null), [product?._id]);

  if (!product) return null;

  const hasVariants = (product.variants || []).length > 0;
  const variant = product.variants?.find((v) => v._id === variantId) || null;
  const price = variant?.price ?? product.salePrice ?? product.price;
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
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={
        <span className="font-display block text-[26px] font-normal leading-tight">
          {product.name}
        </span>
      }
    >
      <div className="grid gap-8 sm:grid-cols-2">
        <div className="overflow-hidden rounded-lg bg-sunken">
          <ProductImage
            product={product}
            src={galleryFor(product)[0]}
            alt={product.name}
            className="aspect-[4/5] w-full object-cover"
          />
        </div>

        <div className="flex min-w-0 flex-col">
          {product.brand ? (
            <p className="label-mono">{product.brand}</p>
          ) : (
            product.category && <p className="label-mono">{product.category}</p>
          )}

          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-display text-[28px] leading-none text-ink tabular">
              {money(price)}
            </span>
            {!variant && product.salePrice && (
              <span className="text-sm text-muted line-through tabular">
                {money(product.price)}
              </span>
            )}
          </div>

          {product.rating?.count > 0 && <RatingStars rating={product.rating} className="mt-3" />}

          {product.description && (
            <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-ink-2">
              {product.description}
            </p>
          )}

          {hasVariants && (
            <div className="mt-6 border-t border-hairline pt-6">
              <VariantPicker
                variants={product.variants}
                value={variantId}
                onChange={setVariantId}
              />
            </div>
          )}

          <div className="mt-7 space-y-2.5">
            <Button
              className="w-full"
              size="lg"
              disabled={!canAdd}
              loading={adding}
              loadingLabel="Adding…"
              onClick={handleAdd}
            >
              Add to cart
            </Button>

            {/*
              The reason the button is disabled, said out loud. A greyed-out
              control with no explanation is the single most common way a
              storefront loses a sale it could have made.
            */}
            {hasVariants && !variantId && product.inStock && (
              <p className="text-center text-xs text-muted">Choose a colour to continue.</p>
            )}
            {!product.inStock && (
              <p className="text-center text-xs text-muted">
                Sold out for now — the rest of {product.category || 'the range'} is still
                available.
              </p>
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
    </Modal>
  );
}
