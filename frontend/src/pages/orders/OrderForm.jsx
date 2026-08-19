import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { customersApi, ordersApi, productsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../../components/common';
import SearchSelect from '../../components/SearchSelect';
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
  const preselectedCustomerId = searchParams.get('customer') || '';
  const [customerId, setCustomerId] = useState(preselectedCustomerId);

  /*
   * The SELECTED records are held here, not looked up from the picker's current
   * results.
   *
   * This is the whole reason the pickers work. A search for "wid" returns
   * twenty products; the one already chosen on another line is very likely not
   * among them. A component that derived its label from the visible options
   * would blank out every existing selection the moment anyone typed.
   *
   * It also removes a whole class of request: the price and stock needed to
   * total the order come back with the option that was picked, so no line ever
   * needs a follow-up fetch.
   */
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [lines, setLines] = useState([{ product: '', quantity: 1, selected: null }]);

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * Arriving from a customer's page gives us an id but no name. One request
   * fetches the record so the picker can show who is selected rather than an
   * empty box that is nonetheless valid — confusing in exactly the flow that
   * is supposed to be the convenient one.
   */
  const { data: preselected } = useFetch(
    () => (preselectedCustomerId ? customersApi.get(preselectedCustomerId) : null),
    [preselectedCustomerId]
  );

  useEffect(() => {
    if (preselected) setSelectedCustomer(preselected);
  }, [preselected]);

  // Built from what the user has actually picked, so it holds every product on
  // the form regardless of what the search box currently shows.
  const productById = Object.fromEntries(
    lines.filter((line) => line.selected).map((line) => [line.selected._id, line.selected])
  );

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((prev) => [...prev, { product: '', quantity: 1, selected: null }]);
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
          <Field label="Customer" hint="Start typing to search by name, company or email.">
            <SearchSelect
              required
              value={customerId}
              selected={selectedCustomer}
              onChange={(customer) => {
                setCustomerId(customer._id);
                setSelectedCustomer(customer);
              }}
              fetchOptions={(search) => customersApi.options(search)}
              getOptionLabel={(customer) => customer.name}
              getOptionMeta={(customer) => customer.company || customer.email}
              placeholder="Search customers…"
              emptyMessage="No customers match that search"
            />
          </Field>

          {/* --- Line items --------------------------------------------- */}
          <div>
            <p className="mb-2 text-sm font-medium text-ink-2">Items</p>
            <div className="space-y-2">
              {lines.map((line, index) => {
                const product = productById[line.product];

                return (
                  <div key={index} className="flex flex-wrap items-start gap-2">
                    <div className="min-w-[12rem] flex-1">
                      <SearchSelect
                        value={line.product}
                        selected={line.selected}
                        onChange={(picked) =>
                          updateLine(index, { product: picked._id, selected: picked })
                        }
                        fetchOptions={(search) => productsApi.options(search)}
                        getOptionLabel={(p) => p.name}
                        getOptionMeta={(p) => `${p.sku} · ${money(p.price)} · ${p.stockQty} in stock`}
                        placeholder="Search products…"
                        emptyMessage="No products match that search"
                      />
                    </div>

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
