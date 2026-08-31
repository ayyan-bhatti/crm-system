import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart, lineKey } from '../context/CartContext';
import { useToast } from './Toast';
import { errorMessage } from '../api/client';
import { money, variantLabel, galleryFor } from '../ui';
import ProductImage from './shop/ProductImage';

/**
 * The cart drawer — a slide-in panel rather than a full-page cart for the
 * common case of "check what's in it, adjust a quantity, move on".
 *
 * EVERY LOOKUP IS BY LINE, NOT BY PRODUCT. Two colours of one shirt are two
 * rows here, so `busyId` and every mutation are keyed on `lineKey(product,
 * variant)`. Keying on the product id alone would grey out both rows while one
 * was updating, and "remove" would take the wrong one.
 */
export default function CartDrawer({ open, onClose }) {
  const { items, total, updateItem, removeItem } = useCart();
  const toast = useToast();
  const [busyKey, setBusyKey] = useState(null);

  async function changeQuantity(line, quantity) {
    if (quantity < 1) return;
    const key = lineKey(line.product._id, line.variant?.variantId);
    setBusyKey(key);
    try {
      await updateItem(line.product._id, quantity, line.variant?.variantId);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the cart'));
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(line) {
    const key = lineKey(line.product._id, line.variant?.variantId);
    setBusyKey(key);
    try {
      await removeItem(line.product._id, line.variant?.variantId);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the cart'));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close cart"
          className="fixed inset-0 z-40 bg-ink/30"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-sm flex-col bg-surface shadow-pop transition-transform duration-[220ms] ease-[var(--motion-ease)] ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        aria-hidden={!open}
        role="dialog"
        aria-modal="true"
        aria-label="Shopping cart"
      >
        <div className="flex items-center justify-between border-b border-hairline p-4">
          <h2 className="text-lg font-semibold text-ink">Your cart</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-2 hover:bg-neutral-wash"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="mt-10 text-center">
              <p className="text-sm text-muted">Your cart is empty.</p>
              <Link
                to="/products"
                onClick={onClose}
                className="mt-3 inline-block text-sm font-medium text-brand hover:underline"
              >
                Start shopping
              </Link>
            </div>
          ) : (
            <ul className="space-y-4">
              {items.map((line) => {
                const key = lineKey(line.product._id, line.variant?.variantId);
                const busy = busyKey === key;
                const label = variantLabel(line.variant);

                return (
                  <li key={key} className="flex gap-3">
                    <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-neutral-wash">
                      <ProductImage
                        product={line.product}
                        src={galleryFor(line.product)[0]}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{line.product.name}</p>

                      {label && (
                        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-2">
                          {line.variant.colorHex && (
                            <span
                              aria-hidden="true"
                              className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-ink/15"
                              style={{ backgroundColor: line.variant.colorHex }}
                            />
                          )}
                          {label}
                        </p>
                      )}

                      <p className="text-xs text-muted">{money(line.product.price)}</p>

                      {/*
                        A line whose product or colour has been discontinued
                        while it sat here. Shown rather than silently dropped —
                        a total that changes for no visible reason is worse than
                        a line the shopper has to remove themselves.
                      */}
                      {!line.product.inStock && (
                        <p className="mt-0.5 text-xs font-medium text-critical-ink">
                          No longer available
                        </p>
                      )}

                      <div className="mt-1 flex items-center gap-2">
                        <button
                          type="button"
                          className="h-6 w-6 rounded border border-hairline text-ink-2 hover:bg-neutral-wash disabled:opacity-50"
                          disabled={busy || line.quantity <= 1}
                          onClick={() => changeQuantity(line, line.quantity - 1)}
                          aria-label={`Decrease quantity of ${line.product.name}${
                            label ? `, ${label}` : ''
                          }`}
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-sm tabular">{line.quantity}</span>
                        <button
                          type="button"
                          className="h-6 w-6 rounded border border-hairline text-ink-2 hover:bg-neutral-wash disabled:opacity-50"
                          disabled={busy}
                          onClick={() => changeQuantity(line, line.quantity + 1)}
                          aria-label={`Increase quantity of ${line.product.name}${
                            label ? `, ${label}` : ''
                          }`}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="ml-auto text-xs text-muted hover:text-critical-ink"
                          disabled={busy}
                          onClick={() => remove(line)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-hairline p-4">
          <div className="mb-1 flex items-center justify-between text-sm font-medium text-ink">
            <span>Subtotal</span>
            <span className="tabular">{money(total)}</span>
          </div>
          <p className="mb-3 text-xs text-muted">Delivery is calculated at checkout.</p>
          <Link
            to="/checkout"
            onClick={onClose}
            aria-disabled={items.length === 0}
            className={`block w-full rounded-lg py-2.5 text-center text-sm font-semibold text-white transition-colors ${
              items.length === 0
                ? 'pointer-events-none bg-neutral-wash text-muted'
                : 'bg-brand hover:bg-brand-strong'
            }`}
          >
            Checkout
          </Link>
        </div>
      </aside>
    </>
  );
}
