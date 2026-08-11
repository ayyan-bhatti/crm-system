import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { customersApi, ordersApi, productsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../../components/common';
import { btnPrimary, btnSecondary, input, money } from '../../ui';

/**
 * Create an order.
 *
 * There is no edit screen: once an order is completed or cancelled the API
 * rejects item changes, and a pending order's status is changed from the detail
 * page. That keeps the stock rules in one place rather than spread across a
 * form that could put an order into a state the backend would refuse.
 *
 * Stock is checked here for immediate feedback, but the server re-checks it on
 * submit — this is a convenience, not the guarantee.
 */
export default function OrderForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Pre-selected when arriving from a customer's page.
  const [customerId, setCustomerId] = useState(searchParams.get('customer') || '');
  const [lines, setLines] = useState([{ product: '', quantity: 1 }]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // limit=100 keeps both pickers to a single request; a real deployment with
  // thousands of records would want a searchable async select instead.
  const { data: customers } = useFetch(() => customersApi.list({ limit: 100 }), []);
  const { data: products } = useFetch(() => productsApi.list({ limit: 100 }), []);

  const productById = Object.fromEntries((products?.data || []).map((p) => [p._id, p]));

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((prev) => [...prev, { product: '', quantity: 1 }]);
  }

  function removeLine(index) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  const total = lines.reduce((sum, line) => {
    const product = productById[line.product];
    return sum + (product ? product.price * (Number(line.quantity) || 0) : 0);
  }, 0);

  /**
   * Client-side stock check, mirroring the server's rule of merging duplicate
   * lines for the same product before comparing against stock.
   */
  function stockProblem() {
    const wanted = new Map();
    for (const line of lines) {
      if (!line.product) continue;
      wanted.set(line.product, (wanted.get(line.product) || 0) + (Number(line.quantity) || 0));
    }

    for (const [productId, quantity] of wanted) {
      const product = productById[productId];
      if (product && quantity > product.stockQty) {
        return `Not enough stock for ${product.name}: asking for ${quantity}, ${product.stockQty} available.`;
      }
    }
    return '';
  }

  const stockError = stockProblem();
  const filledLines = lines.filter((line) => line.product && Number(line.quantity) > 0);
  const canSubmit = customerId && filledLines.length > 0 && !stockError && !submitting;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const order = await ordersApi.create({
        customer: customerId,
        items: filledLines.map((line) => ({
          product: line.product,
          quantity: Number(line.quantity),
        })),
      });
      navigate(`/orders/${order._id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not create order'));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New order" subtitle="Stock is reserved when the order is completed." />

      <Card className="p-6">
        <ErrorBanner message={error} onDismiss={() => setError('')} />

        <form onSubmit={handleSubmit} className="space-y-5">
          <Field label="Customer">
            <select
              className={input}
              required
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">Select a customer…</option>
              {(customers?.data || []).map((customer) => (
                <option key={customer._id} value={customer._id}>
                  {customer.name}
                  {customer.company ? ` — ${customer.company}` : ''}
                </option>
              ))}
            </select>
          </Field>

          {/* --- Line items --------------------------------------------- */}
          <div>
            <p className="mb-2 text-sm font-medium text-ink-2">Items</p>
            <div className="space-y-2">
              {lines.map((line, index) => {
                const product = productById[line.product];

                return (
                  <div key={index} className="flex flex-wrap items-start gap-2">
                    <select
                      className={`${input} flex-1 min-w-48`}
                      value={line.product}
                      onChange={(e) => updateLine(index, { product: e.target.value })}
                    >
                      <option value="">Select a product…</option>
                      {(products?.data || []).map((p) => (
                        <option key={p._id} value={p._id}>
                          {p.name} ({p.sku}) — {money(p.price)} · {p.stockQty} in stock
                        </option>
                      ))}
                    </select>

                    <input
                      type="number"
                      min="1"
                      className={`${input} w-24`}
                      value={line.quantity}
                      onChange={(e) => updateLine(index, { quantity: e.target.value })}
                    />

                    <div className="w-24 pt-2 text-right text-sm text-ink-2">
                      {product ? money(product.price * (Number(line.quantity) || 0)) : '—'}
                    </div>

                    <button
                      type="button"
                      className="pt-2 text-sm text-muted hover:text-critical-ink disabled:opacity-40"
                      onClick={() => removeLine(index)}
                      disabled={lines.length === 1}
                      aria-label="Remove item"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>

            <button type="button" className={`${btnSecondary} mt-3`} onClick={addLine}>
              Add item
            </button>
          </div>

          {stockError && (
            <div className="rounded-md border border-warning/25 bg-warning-wash px-4 py-3 text-sm text-warning-ink">
              {stockError}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-hairline pt-4">
            <span className="text-sm text-muted">Order total</span>
            <span className="text-lg font-semibold text-ink">{money(total)}</span>
          </div>

          <div className="flex gap-3">
            <button type="submit" className={btnPrimary} disabled={!canSubmit}>
              {submitting ? <Spinner /> : 'Create order'}
            </button>
            <button type="button" className={btnSecondary} onClick={() => navigate(-1)}>
              Cancel
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
