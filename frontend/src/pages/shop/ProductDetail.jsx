import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { useCart } from '../../context/CartContext';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../api/client';
import { Spinner, ErrorBanner } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import VariantPicker from '../../components/shop/VariantPicker';
import { money, btnPrimary, btnSecondary, galleryFor, priceRange } from '../../ui';

export default function ShopProductDetail() {
  const { id } = useParams();
  const { data: product, loading, error } = useFetch(() => shopProductsApi.get(id), [id]);
  const { data: recs } = useFetch(() => shopProductsApi.recommendations(id), [id]);
  const { addItem } = useCart();
  const { isSignedIn } = useBuyerAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [quantity, setQuantity] = useState(1);
  const [variantId, setVariantId] = useState(null);
  const [activeImage, setActiveImage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [buying, setBuying] = useState(false);

  /*
   * Reset the choices when the product changes.
   *
   * Navigating between two products — from a recommendation, say — reuses this
   * component. Without this, a variant id from the PREVIOUS product survives
   * into the new one, where it matches nothing: the picker shows no selection
   * while "Add to cart" is enabled, and the add is then rejected by the server
   * with a message about a colour the shopper never chose.
   */
  useEffect(() => {
    setVariantId(null);
    setQuantity(1);
    setActiveImage(0);
  }, [id]);

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!product) return null;

  const images = galleryFor(product);
  const hasVariants = (product.variants || []).length > 0;
  const variant = product.variants?.find((v) => v._id === variantId) || null;
  const range = priceRange(product);

  // The variant's price once one is chosen, otherwise the product's own.
  const price = variant?.price ?? product.price;

  // A product with variants cannot be added until one is picked — the server
  // enforces the same rule, so this is the UI half of one decision, not a
  // second one that could drift.
  const canBuy = product.inStock && (!hasVariants || Boolean(variantId));

  async function handleAdd() {
    setAdding(true);
    try {
      await addItem(product, quantity, variant);
      toast.success(`Added ${quantity} to your cart.`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not add to cart'));
    } finally {
      setAdding(false);
    }
  }

  /**
   * Buy now: add the item, then head straight for checkout rather than
   * leaving the shopper to find the cart drawer themselves.
   *
   * An unsigned visitor's item is safe either way — it is in the guest cart in
   * localStorage — and `/checkout` itself is what sends them to `/login` with
   * `state.from` set, so they land back on checkout, not on the shop home, once
   * they have signed in or created an account. That round trip is now mandatory
   * rather than optional: there is no guest checkout.
   */
  async function handleBuyNow() {
    setBuying(true);
    try {
      await addItem(product, quantity, variant);
      navigate(isSignedIn ? '/checkout' : '/login', {
        state: isSignedIn ? undefined : { from: '/checkout' },
      });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not start checkout'));
    } finally {
      setBuying(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="grid gap-10 md:grid-cols-2">
        <div>
          <div className="aspect-square overflow-hidden rounded-xl bg-neutral-wash">
            <img
              src={images[activeImage]}
              alt={product.name}
              className="h-full w-full object-cover"
            />
          </div>

          {/*
            Thumbnails only where there is genuinely more than one photograph.
            A single thumbnail under a single image is a control that does
            nothing, which reads as broken rather than minimal.
          */}
          {images.length > 1 && (
            <div className="mt-3 flex gap-2.5">
              {images.map((src, index) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setActiveImage(index)}
                  aria-label={`View image ${index + 1} of ${images.length}`}
                  aria-pressed={index === activeImage}
                  className={`h-16 w-16 overflow-hidden rounded-lg ring-1 ring-inset transition-all ${
                    index === activeImage
                      ? 'ring-2 ring-brand'
                      : 'ring-hairline hover:ring-rule'
                  }`}
                >
                  <img src={src} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="animate-fade-rise">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {product.category}
          </p>
          <h1 className="font-display mt-1 text-3xl font-semibold text-ink">{product.name}</h1>

          <p className="mt-3 text-2xl font-semibold text-ink tabular">
            {money(price)}
            {/* "from" only until a variant fixes the price. */}
            {range && !variant && (
              <span className="ml-2 text-sm font-normal text-muted">
                from {money(range.min)} to {money(range.max)}
              </span>
            )}
          </p>

          {product.description && (
            <p className="mt-4 text-sm leading-relaxed text-ink-2">{product.description}</p>
          )}

          <p className="mt-4 text-sm">
            {product.inStock ? (
              product.lowStock ? (
                <span className="font-medium text-warning-ink">Low stock — only a few left</span>
              ) : (
                <span className="text-good-ink">In stock</span>
              )
            ) : (
              <span className="text-critical-ink">Out of stock</span>
            )}
          </p>

          {hasVariants && (
            <div className="mt-6">
              <VariantPicker
                variants={product.variants}
                value={variantId}
                onChange={setVariantId}
              />
            </div>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <label htmlFor="qty" className="sr-only">
              Quantity
            </label>
            <select
              id="qty"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className="rounded-lg border border-hairline bg-raised px-3 py-2 text-sm"
              disabled={!product.inStock}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>

            <button
              type="button"
              className={`${btnSecondary} hover-lift`}
              disabled={!canBuy || adding || buying}
              onClick={handleAdd}
            >
              {adding ? <Spinner /> : 'Add to cart'}
            </button>

            <button
              type="button"
              className={`${btnPrimary} hover-lift`}
              disabled={!canBuy || adding || buying}
              onClick={handleBuyNow}
            >
              {buying ? <Spinner /> : 'Buy now'}
            </button>
          </div>

          {/*
            Why the buttons are disabled, said out loud. A greyed-out control
            with no explanation is one of the most reliable ways a storefront
            loses a sale it could have made.
          */}
          {hasVariants && !variantId && product.inStock && (
            <p className="mt-3 text-sm text-muted">Choose a colour to continue.</p>
          )}
        </div>
      </div>

      {recs && recs.data.length > 0 && (
        <section className="mt-16">
          <h2 className="font-display mb-2 text-xl font-semibold text-ink">You might also like</h2>
          {recs.reason && <p className="mb-4 text-sm text-muted">{recs.reason}</p>}
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {recs.data.map((p) => (
              <ProductCard key={p._id} product={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
