import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart, lineKey } from '../context/CartContext';
import { useToast } from './Toast';
import { errorMessage } from '../api/client';
import { Drawer } from './common';
import { money, variantLabel, galleryFor } from '../ui';
import ProductImage from './shop/ProductImage';

/**
 * The cart drawer — a slide-in panel rather than a full-page cart for the
 * common case of "check what's in it, adjust a quantity, move on".
 *
 * EVERY LOOKUP IS BY LINE, NOT BY PRODUCT. Two colours of one shirt are two
 * rows here, so `busyKey` and every mutation are keyed on `lineKey(product,
 * variant)`. Keying on the product id alone would grey out both rows while one
 * was updating, and "remove" would take the wrong one.
 *
 * BUILT ON THE SHARED `Drawer`. The hand-rolled version was a permanently
 * mounted `<aside>` translated off-screen with `aria-hidden`, which is the
 * arrangement that quietly leaks a tabbable, invisible cart into every page:
 * `aria-hidden` hides it from a screen reader but does nothing about the Tab
 * key, so a keyboard user tabbing through the shop fell into a panel they
 * could not see. `Drawer` unmounts when closed and handles Escape, the focus
 * trap, the body scroll lock and focus restore — see `useOverlay` in
 * components/common.jsx.
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

  const empty = items.length === 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      /*
       * "Shopping cart" rather than "Your cart", and the difference is not
       * cosmetic: this string is the dialog's accessible name, which is how
       * both a screen reader and the end-to-end suite identify the panel.
       */
      title="Shopping cart"
      /*
       * The summary goes through `Drawer`'s `footer` slot rather than being
       * the last thing in the scrolling list, so the subtotal and the checkout
       * button stay pinned to the bottom of the panel however long the cart
       * gets. It is omitted entirely when the cart is empty — a dead
       * "Checkout" bar is a control that exists only to be refused.
       */
      footer={
        empty ? null : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-ink">Subtotal</span>
              <span className="font-display text-[22px] leading-none text-ink tabular">
                {money(total)}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Delivery and any taxes are calculated at checkout.
            </p>
            <Link
              to="/checkout"
              onClick={onClose}
              className="mt-4 block w-full rounded-md bg-brand px-4 py-3 text-center text-sm font-semibold text-on-brand transition-colors hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane"
            >
              Checkout
            </Link>
          </>
        )
      }
    >
      {empty ? (
        <div className="px-6 py-16 text-center">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sunken">
            <svg viewBox="0 0 20 20" className="h-5 w-5 fill-muted" aria-hidden="true">
              <path d="M6 6V5a4 4 0 118 0v1h2.2a1 1 0 01.99 1.14l-1.2 8.4A2 2 0 0114 17.3H6a2 2 0 01-1.98-1.72l-1.2-8.4A1 1 0 013.8 6H6zm2 0h4V5a2 2 0 10-4 0v1z" />
            </svg>
          </span>
          <p className="font-display text-xl leading-tight text-ink">Your cart is empty</p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-ink-2">
            Nothing saved for checkout yet. The catalogue is a good place to start.
          </p>
          <Link
            to="/products"
            onClick={onClose}
            className="mt-5 inline-block text-sm font-semibold text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-brand"
          >
            Start shopping
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-hairline">
          {items.map((line) => {
            const key = lineKey(line.product._id, line.variant?.variantId);
            const busy = busyKey === key;
            const label = variantLabel(line.variant);
            const named = `${line.product.name}${label ? `, ${label}` : ''}`;

            return (
              <li key={key} className={`flex gap-4 px-5 py-5 ${busy ? 'opacity-60' : ''}`}>
                <Link
                  to={`/products/${line.product._id}`}
                  onClick={onClose}
                  aria-hidden="true"
                  tabIndex={-1}
                  className="h-20 w-16 shrink-0 overflow-hidden rounded-md bg-sunken"
                >
                  <ProductImage
                    product={line.product}
                    src={galleryFor(line.product)[0]}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </Link>

                <div className="min-w-0 flex-1">
                  <Link
                    to={`/products/${line.product._id}`}
                    onClick={onClose}
                    className="block truncate text-sm font-medium text-ink transition-colors hover:text-brand-ink"
                  >
                    {line.product.name}
                  </Link>

                  {label && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-2">
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

                  <p className="mt-1 text-xs text-muted tabular">{money(line.product.price)}</p>

                  {/*
                    A line whose product or colour has been discontinued while
                    it sat here. Shown rather than silently dropped — a total
                    that changes for no visible reason is worse than a line the
                    shopper has to remove themselves.
                  */}
                  {!line.product.inStock && (
                    <p className="mt-1 text-xs font-medium text-critical-ink">
                      No longer available
                    </p>
                  )}

                  <div className="mt-3 flex items-center gap-3">
                    <div className="inline-flex items-stretch overflow-hidden rounded-md border border-hairline">
                      <button
                        type="button"
                        className="w-7 py-1 text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:cursor-not-allowed disabled:text-rule"
                        disabled={busy || line.quantity <= 1}
                        onClick={() => changeQuantity(line, line.quantity - 1)}
                        aria-label={`Decrease quantity of ${named}`}
                      >
                        −
                      </button>
                      <span className="w-8 border-x border-hairline py-1 text-center text-sm font-medium text-ink tabular">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        className="w-7 py-1 text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:cursor-not-allowed disabled:text-rule"
                        disabled={busy}
                        onClick={() => changeQuantity(line, line.quantity + 1)}
                        aria-label={`Increase quantity of ${named}`}
                      >
                        +
                      </button>
                    </div>

                    <button
                      type="button"
                      className="ml-auto text-xs font-medium text-muted underline decoration-transparent underline-offset-4 transition-colors hover:text-critical-ink hover:decoration-current disabled:cursor-not-allowed"
                      disabled={busy}
                      onClick={() => remove(line)}
                      aria-label={`Remove ${named} from your cart`}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <p className="shrink-0 text-sm font-semibold text-ink tabular">
                  {money(line.product.price * line.quantity)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
