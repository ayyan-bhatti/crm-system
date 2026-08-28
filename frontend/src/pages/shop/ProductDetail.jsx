import { useState } from 'react';
import { useParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopProductsApi } from '../../api/shopResources';
import { useCart } from '../../context/CartContext';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../api/client';
import { Spinner, ErrorBanner } from '../../components/common';
import ProductCard from '../../components/shop/ProductCard';
import { money, btnPrimary } from '../../ui';

export default function ShopProductDetail() {
  const { id } = useParams();
  const { data: product, loading, error } = useFetch(() => shopProductsApi.get(id), [id]);
  const { data: recs } = useFetch(() => shopProductsApi.recommendations(id), [id]);
  const { addItem } = useCart();
  const toast = useToast();
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    setAdding(true);
    try {
      await addItem(product, quantity);
      toast.success(`Added ${quantity} to your cart.`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not add to cart'));
    } finally {
      setAdding(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!product) return null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="grid gap-10 md:grid-cols-2">
        <div className="aspect-square overflow-hidden rounded-xl bg-neutral-wash">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted">
              No image available
            </div>
          )}
        </div>

        <div className="animate-fade-rise">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {product.category}
          </p>
          <h1 className="font-display mt-1 text-3xl font-semibold text-ink">{product.name}</h1>
          <p className="mt-3 text-2xl font-semibold text-ink tabular">{money(product.price)}</p>

          {product.description && (
            <p className="mt-4 text-sm leading-relaxed text-ink-2">{product.description}</p>
          )}

          <p className="mt-4 text-sm">
            {product.inStock ? (
              <span className="text-good-ink">In stock</span>
            ) : (
              <span className="text-critical-ink">Out of stock</span>
            )}
          </p>

          <div className="mt-6 flex items-center gap-3">
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
              className={`${btnPrimary} hover-lift`}
              disabled={!product.inStock || adding}
              onClick={handleAdd}
            >
              {adding ? <Spinner /> : 'Add to cart'}
            </button>
          </div>
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
