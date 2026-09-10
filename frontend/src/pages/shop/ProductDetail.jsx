import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import useRecentlyViewed from '../../hooks/useRecentlyViewed';
import { shopProductsApi } from '../../api/shopResources';
import { useCart } from '../../context/CartContext';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../api/client';
import { Breadcrumb, Button, ErrorBanner, Skeleton } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import ProductImage from '../../components/shop/ProductImage';
import RatingStars from '../../components/shop/RatingStars';
import VariantPicker from '../../components/shop/VariantPicker';
import QuantityStepper from '../../components/shop/QuantityStepper';
import WishlistButton from '../../components/shop/WishlistButton';
import { money, galleryFor, priceRange } from '../../ui';

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

/**
 * The three questions a shopper asks after "do I want it" and before "will I
 * buy it". Kept together because they are answered together — a delivery
 * promise with no returns policy beside it raises the second question rather
 * than settling the first.
 */
const ASSURANCES = [
  ['Delivery', 'Free over $75, otherwise $6. Arrives in 3–5 days.'],
  ['Returns', '30 days, unused and in its original packaging.'],
  ['Support', 'Questions answered within one working day.'],
];

export default function ShopProductDetail() {
  const { id } = useParams();
  const { data: product, loading, error } = useFetch(() => shopProductsApi.get(id), [id]);
  const { data: recs } = useFetch(() => shopProductsApi.recommendations(id), [id]);
  const recentlyViewed = useRecentlyViewed(product);
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

  if (loading) return <DetailSkeleton />;
  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <ErrorBanner message={error} />
        <Link
          to="/products"
          className="text-sm font-medium text-ink underline decoration-rule underline-offset-4 hover:decoration-brand"
        >
          Back to the catalogue
        </Link>
      </div>
    );
  }
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
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <Breadcrumb
        items={[
          { label: 'Home', to: '/' },
          { label: 'Shop', to: '/products' },
          ...(product.category
            ? [
                {
                  label: product.category,
                  to: `/products?category=${encodeURIComponent(product.category)}`,
                },
              ]
            : []),
          { label: product.name },
        ]}
        className="mb-6 sm:mb-8"
      />

      <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16 xl:gap-20">
        {/* --- Gallery ------------------------------------------------------ */}
        <div className="lg:sticky lg:top-28 lg:self-start">
          <div className="overflow-hidden rounded-lg bg-sunken">
            <ProductImage
              product={product}
              src={images[activeImage]}
              alt={product.name}
              /* The page's own hero. Deferring it is deferring the moment the
                 page looks like anything, so it is the one image here that is
                 deliberately not lazy. */
              loading="eager"
              fetchPriority="high"
              className="aspect-[4/5] w-full object-cover"
            />
          </div>

          {/*
            Thumbnails only where there is genuinely more than one photograph.
            A single thumbnail under a single image is a control that does
            nothing, which reads as broken rather than minimal.
          */}
          {images.length > 1 && (
            <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
              {images.map((src, index) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setActiveImage(index)}
                  aria-label={`View image ${index + 1} of ${images.length}`}
                  aria-pressed={index === activeImage}
                  className={`h-20 w-16 shrink-0 overflow-hidden rounded-md bg-sunken ring-1 ring-inset transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                    index === activeImage
                      ? 'ring-2 ring-ink'
                      : 'ring-hairline hover:ring-rule'
                  }`}
                >
                  <ProductImage
                    product={product}
                    src={src}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* --- Buy box ------------------------------------------------------ */}
        <div className="animate-fade-rise lg:max-w-lg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {product.category && <p className="label-mono">{product.category}</p>}
            {product.brand && (
              <>
                <span className="h-3 w-px bg-rule" aria-hidden="true" />
                <p className="label-mono">{product.brand}</p>
              </>
            )}
          </div>

          <h1 className="font-display mt-3 text-[34px] leading-[1.08] text-ink sm:text-[42px]">
            {product.name}
          </h1>

          {product.rating?.count > 0 && (
            <RatingStars rating={product.rating} size="lg" className="mt-4" />
          )}

          <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            {product.salePrice ? (
              <>
                <span className="font-display text-[32px] leading-none text-brand-ink tabular">
                  {money(product.salePrice)}
                </span>
                <span className="text-lg text-muted line-through tabular">
                  {money(product.price)}
                </span>
                <span className="rounded-full bg-brand-wash px-2.5 py-1 text-xs font-semibold text-brand-ink">
                  Save {money(product.price - product.salePrice)}
                </span>
              </>
            ) : (
              <span className="font-display text-[32px] leading-none text-ink tabular">
                {money(price)}
              </span>
            )}
            {/* "from" only until a variant fixes the price. */}
            {range && !variant && (
              <span className="text-sm text-muted">
                from {money(range.min)} to {money(range.max)}
              </span>
            )}
          </div>

          <p className="mt-4 flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${
                product.inStock ? (product.lowStock ? 'bg-warning' : 'bg-good') : 'bg-critical'
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

          <p className="mt-6 text-[15px] leading-relaxed text-ink-2">{descriptionFor(product)}</p>

          {product.tags?.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-1.5">
              {product.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-hairline px-2.5 py-1 text-xs text-ink-2"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}

          {hasVariants && (
            <div className="mt-8 border-t border-hairline pt-8">
              <VariantPicker
                variants={product.variants}
                value={variantId}
                onChange={setVariantId}
              />
            </div>
          )}

          <div className="mt-8 border-t border-hairline pt-8">
            <QuantityStepper
              value={quantity}
              onChange={setQuantity}
              max={maxQty}
              disabled={!product.inStock}
            />

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {/*
                `loading` rather than a hand-swapped label, because the two
                things that must happen together when an add is in flight — the
                copy saying so, and the control refusing further clicks — drift
                apart the moment they are two separate expressions. Bound to one
                prop, a button that SAYS it is working cannot also still be
                submitting, so one impatient double-click cannot become two
                lines in a cart.
              */}
              <Button
                size="lg"
                className="min-w-44 flex-1 justify-center sm:flex-none"
                disabled={!canBuy || buying}
                loading={adding}
                loadingLabel="Adding…"
                onClick={handleAdd}
              >
                Add to cart
              </Button>

              <Button
                variant="secondary"
                size="lg"
                className="min-w-44 flex-1 justify-center sm:flex-none"
                disabled={!canBuy || adding}
                loading={buying}
                loadingLabel="Taking you to checkout…"
                onClick={handleBuyNow}
              >
                Buy now
              </Button>

              <WishlistButton product={product} variant="button" />
            </div>

            {/*
              Why the buttons are disabled, said out loud. A greyed-out control
              with no explanation is one of the most reliable ways a storefront
              loses a sale it could have made.
            */}
            {hasVariants && !variantId && product.inStock && (
              <p className="mt-3.5 text-sm text-muted">Choose a colour to continue.</p>
            )}
            {!product.inStock && (
              <p className="mt-3.5 text-sm text-muted">
                This is sold out at the moment. Everything else in{' '}
                {product.category ? (
                  <Link
                    to={`/products?category=${encodeURIComponent(product.category)}`}
                    className="font-medium text-ink underline decoration-rule underline-offset-4 hover:decoration-brand"
                  >
                    {product.category}
                  </Link>
                ) : (
                  'the catalogue'
                )}{' '}
                is still available.
              </p>
            )}
          </div>

          <dl className="mt-8 grid gap-5 border-t border-hairline pt-8 sm:grid-cols-3">
            {ASSURANCES.map(([term, detail]) => (
              <div key={term}>
                <dt className="label-mono">{term}</dt>
                <dd className="mt-1.5 text-xs leading-relaxed text-ink-2">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {recs && recs.data.length > 0 && (
        <section className="mt-20 border-t border-hairline pt-12 sm:mt-24">
          <div className="mb-8">
            <p className="label-mono">More like this</p>
            <h2 className="font-display mt-2 text-[28px] leading-tight text-ink">
              You might also like
            </h2>
            {recs.reason && <p className="mt-2 text-sm text-ink-2">{recs.reason}</p>}
          </div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-9 sm:grid-cols-4 lg:gap-x-6">
            {recs.data.map((p) => (
              <ProductCard key={p._id} product={p} />
            ))}
          </div>
        </section>
      )}

      {recentlyViewed.length > 0 && (
        <section className="mt-20 border-t border-hairline pt-12">
          <p className="label-mono">Your trail</p>
          <h2 className="font-display mb-8 mt-2 text-[28px] leading-tight text-ink">
            Recently viewed
          </h2>
          <ul className="flex gap-5 overflow-x-auto pb-2">
            {recentlyViewed.map((item) => (
              <li key={item._id} className="w-36 shrink-0 sm:w-40">
                <Link to={`/products/${item._id}`} className="group block">
                  <div className="overflow-hidden rounded-lg bg-sunken">
                    <ProductImage
                      product={item}
                      src={galleryFor(item)[0]}
                      alt=""
                      loading="lazy"
                      className="aspect-[4/5] w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
                    />
                  </div>
                  <p className="mt-2.5 truncate text-sm font-medium text-ink">{item.name}</p>
                  <p className="text-xs text-muted tabular">{money(item.price)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The loading state, shaped like the page it stands in for.
 *
 * A centred spinner here meant the header, the gallery and the buy box all
 * appeared at once out of an empty screen, and everything below the fold
 * jumped as the recommendations landed. Reserving the two columns keeps the
 * page still.
 */
function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <p role="status" className="sr-only">
        Loading product
      </p>
      <Skeleton className="mb-8 h-3 w-56" />
      <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16" aria-hidden="true">
        <Skeleton className="aspect-[4/5] w-full rounded-lg" />
        <div className="lg:max-w-lg">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-10 w-4/5" />
          <Skeleton className="mt-5 h-8 w-32" />
          <Skeleton className="mt-6 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-2/3" />
          <Skeleton className="mt-9 h-12 w-40" />
          <Skeleton className="mt-6 h-12 w-full" />
        </div>
      </div>
    </div>
  );
}
