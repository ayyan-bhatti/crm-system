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
import ProductImage from '../../components/shop/ProductImage';
import VariantPicker from '../../components/shop/VariantPicker';
import QuantityStepper from '../../components/shop/QuantityStepper';
import { money, btnPrimary, btnSecondary, galleryFor, priceRange } from '../../ui';

/**
 * What a shop says about a product when nobody wrote a description.
 *
 * A DESCRIPTION IS NOT OPTIONAL FURNITURE — it is most of what a product page
 * is for, and this one rendered nothing at all when the field was empty. That
 * is the state every product created through the CRM starts in, so the shop's
 * newest items were reliably its emptiest pages: a name, a price, and a wall of
 * whitespace where the reason to buy it should be.
 *
 * This does not invent claims about the product. It says the true thing — that
 * the details have not been written yet — and then fills the space with facts
 * the shop genuinely knows and the shopper genuinely wants: what it is, what it
 * costs, how it ships, and what happens if they change their mind. That is a
 * far better page than a blank one, and it does not lie to do it.
 */
function descriptionFor(product) {
  if (product.description?.trim()) return product.description.trim();
  return `We haven't written a full description for this one yet. It is part of our ${
    product.category || 'general'
  } range and is covered by the same delivery and returns terms as everything else in the shop — if you need specifics before ordering, get in touch and we will get you an answer.`;
}

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

  const variant = product?.variants?.find((v) => v._id === variantId) || null;

  /*
   * The ceiling is the CHOSEN VARIANT's, falling back to the product's.
   *
   * These genuinely differ — 6 Midnight and 3 Sand under a product total of 9 —
   * so reading the product-level number after a colour is picked would offer a
   * quantity that colour cannot fill. Clamping here rather than only in the
   * stepper matters because the ceiling drops when the shopper switches from a
   * well-stocked colour to a thin one, and a quantity chosen under the old
   * ceiling must not survive that switch.
   */
  const maxQty = Math.max(1, variant ? variant.maxOrderQty || 1 : product?.maxOrderQty || 1);

  useEffect(() => {
    setQuantity((current) => Math.min(current, maxQty));
  }, [maxQty]);

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!product) return null;

  const images = galleryFor(product);
  const hasVariants = (product.variants || []).length > 0;
  const range = priceRange(product);
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
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="grid gap-8 md:grid-cols-2 lg:gap-14">
        {/* --- Gallery ------------------------------------------------------ */}
        <div className="md:sticky md:top-24 md:self-start">
          <div className="overflow-hidden rounded-2xl border border-hairline bg-neutral-wash">
            <ProductImage
              product={product}
              src={images[activeImage]}
              alt={product.name}
              loading="eager"
              className="aspect-square w-full object-cover"
            />
          </div>

          {/*
            Thumbnails only where there is genuinely more than one photograph.
            A single thumbnail under a single image is a control that does
            nothing, which reads as broken rather than minimal.
          */}
          {images.length > 1 && (
            <div className="mt-3 flex gap-2.5 overflow-x-auto pb-1">
              {images.map((src, index) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setActiveImage(index)}
                  aria-label={`View image ${index + 1} of ${images.length}`}
                  aria-pressed={index === activeImage}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg ring-1 ring-inset transition-all ${
                    index === activeImage
                      ? 'ring-2 ring-brand'
                      : 'ring-hairline hover:ring-rule'
                  }`}
                >
                  <ProductImage
                    product={product}
                    src={src}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* --- Buy box ------------------------------------------------------ */}
        <div className="animate-fade-rise">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
            {product.category}
          </p>
          <h1 className="font-display mt-1.5 text-3xl font-semibold leading-tight text-ink sm:text-4xl">
            {product.name}
          </h1>

          <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-semibold text-ink tabular">{money(price)}</span>
            {/* "from" only until a variant fixes the price. */}
            {range && !variant && (
              <span className="text-sm text-muted">
                from {money(range.min)} to {money(range.max)}
              </span>
            )}
          </div>

          <p className="mt-3 flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${
                product.inStock
                  ? product.lowStock
                    ? 'bg-warning'
                    : 'bg-good'
                  : 'bg-critical'
              }`}
            />
            {product.inStock ? (
              product.lowStock ? (
                <span className="font-medium text-warning-ink">Low stock — only a few left</span>
              ) : (
                <span className="text-good-ink">In stock, ready to ship</span>
              )
            ) : (
              <span className="text-critical-ink">Out of stock</span>
            )}
          </p>

          <p className="mt-5 text-sm leading-relaxed text-ink-2">{descriptionFor(product)}</p>

          {hasVariants && (
            <div className="mt-7 border-t border-hairline pt-6">
              <VariantPicker
                variants={product.variants}
                value={variantId}
                onChange={setVariantId}
              />
            </div>
          )}

          <div className="mt-7 border-t border-hairline pt-6">
            <QuantityStepper
              value={quantity}
              onChange={setQuantity}
              max={maxQty}
              disabled={!product.inStock}
            />

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                className={`${btnPrimary} hover-lift min-w-40 flex-1 justify-center py-2.5 sm:flex-none`}
                disabled={!canBuy || adding || buying}
                onClick={handleBuyNow}
              >
                {buying ? <Spinner /> : 'Buy now'}
              </button>

              <button
                type="button"
                className={`${btnSecondary} hover-lift min-w-40 flex-1 justify-center py-2.5 sm:flex-none`}
                disabled={!canBuy || adding || buying}
                onClick={handleAdd}
              >
                {adding ? <Spinner /> : 'Add to cart'}
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
            {!product.inStock && (
              <p className="mt-3 text-sm text-muted">
                This is sold out at the moment. Everything else in {product.category} is still
                available.
              </p>
            )}
          </div>

          {/*
            The three questions a shopper asks after "do I want it" and before
            "will I buy it". They were answered nowhere on this page, which left
            the buy box ending in a wall of whitespace and the shopper guessing
            at delivery and returns — the two things most likely to stop a sale.
          */}
          <dl className="mt-7 grid gap-3 border-t border-hairline pt-6 text-sm sm:grid-cols-3">
            {[
              ['Delivery', 'Free over $75, otherwise $6. Arrives in 3–5 days.'],
              ['Returns', '30 days, unused and in its original packaging.'],
              ['Support', 'Questions answered within one working day.'],
            ].map(([term, detail]) => (
              <div key={term}>
                <dt className="font-medium text-ink">{term}</dt>
                <dd className="mt-0.5 text-xs leading-relaxed text-muted">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {recs && recs.data.length > 0 && (
        <section className="mt-16 border-t border-hairline pt-10">
          <h2 className="font-display mb-2 text-xl font-semibold text-ink">You might also like</h2>
          {recs.reason && <p className="mb-5 text-sm text-muted">{recs.reason}</p>}
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
