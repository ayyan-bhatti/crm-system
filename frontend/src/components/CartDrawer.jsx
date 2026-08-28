import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { useToast } from './Toast';
import { errorMessage } from '../api/client';
import { money } from '../ui';

/**
 * The cart drawer — a slide-in panel rather than a full-page cart for the
 * common case of "check what's in it, adjust a quantity, move on".
 */
export default function CartDrawer({ open, onClose }) {
  const { items, total, updateItem, removeItem } = useCart();
  const toast = useToast();
  const [busyId, setBusyId] = useState(null);

  async function changeQuantity(productId, quantity) {
    if (quantity < 1) return;
    setBusyId(productId);
    try {
      await updateItem(productId, quantity);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the cart'));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(productId) {
    setBusyId(productId);
    try {
      await removeItem(productId);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the cart'));
    } finally {
      setBusyId(null);
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
            <p className="mt-8 text-center text-sm text-muted">Your cart is empty.</p>
          ) : (
            <ul className="space-y-4">
              {items.map((line) => (
                <li key={line.product._id} className="flex gap-3">
                  <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-neutral-wash">
                    {line.product.imageUrl && (
                      <img
                        src={line.product.imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{line.product.name}</p>
                    <p className="text-xs text-muted">{money(line.product.price)}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        type="button"
                        className="h-6 w-6 rounded border border-hairline text-ink-2 hover:bg-neutral-wash disabled:opacity-50"
                        disabled={busyId === line.product._id}
                        onClick={() => changeQuantity(line.product._id, line.quantity - 1)}
                        aria-label={`Decrease quantity of ${line.product.name}`}
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-sm tabular">{line.quantity}</span>
                      <button
                        type="button"
                        className="h-6 w-6 rounded border border-hairline text-ink-2 hover:bg-neutral-wash disabled:opacity-50"
                        disabled={busyId === line.product._id}
                        onClick={() => changeQuantity(line.product._id, line.quantity + 1)}
                        aria-label={`Increase quantity of ${line.product.name}`}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="ml-auto text-xs text-muted hover:text-critical-ink"
                        disabled={busyId === line.product._id}
                        onClick={() => remove(line.product._id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-hairline p-4">
          <div className="mb-3 flex items-center justify-between text-sm font-medium text-ink">
            <span>Total</span>
            <span className="tabular">{money(total)}</span>
          </div>
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
