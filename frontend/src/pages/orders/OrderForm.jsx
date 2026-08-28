import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { customersApi, ordersApi, productsApi, usersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../../components/common';
import { useToast } from '../../components/Toast';
import SearchSelect from '../../components/SearchSelect';
import { btnPrimary, btnSecondary, humanize, input, money, orderLabel } from '../../ui';

/**
 * Create or edit an order.
 *
 * WHAT IS EDITABLE, AND WHY IT IS NOT EVERYTHING.
 *
 * An order's ITEMS may only change while it is still `pending`. Once it is
 * completed the stock has moved and the money is real, and rewriting the lines
 * would silently change what was shipped and what was charged for it, leaving
 * the stock ledger describing an order that no longer exists. The API refuses
 * it; this form does not offer it, and says why rather than showing a dead
 * control.
 *
 * The CUSTOMER cannot be changed after creation at all. Moving an order to a
 * different customer is not an edit, it is a different order — the original
 * customer's history would silently lose a purchase they actually made.
 *
 * STATUS is changed from the detail page, not here, because completing or
 * cancelling moves stock. Keeping the one stock-moving action in one place is
 * worth more than the symmetry of having every field on the edit form.
 *
 * Stock is checked here for immediate feedback, but the server re-checks it on
 * submit — this is a convenience, not the guarantee.
 */
export default function OrderForm() {
  const navigate = useNavigate();
  // Creating navigates to the new order, so the confirmation outlives this page.
  const toast = useToast();
  const [searchParams] = useSearchParams();

  // Present on /orders/:id/edit, absent on /orders/new. One component serves
  // both, as the customer and product forms already do.
  const { id } = useParams();
  const isEdit = Boolean(id);

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

  /*
   * Who is going to work this order, asked here rather than on the detail page
   * afterwards.
   *
   * It used to be a second trip: place the order, find it, reassign it. Two
   * steps for one decision, and the decision is usually already made at the
   * moment the order is taken.
   *
   * Held as id AND record for the same reason the customer and product pickers
   * are — see the note above.
   */
  const [assignedTo, setAssignedTo] = useState('');
  const [selectedAssignee, setSelectedAssignee] = useState(null);

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

  /*
   * The order being edited.
   *
   * `error` is captured and surfaced rather than ignored — the same bug the
   * customer and product forms had: a failed load left a BLANK form that looked
   * ready, and saving it wrote empty values over a real record.
   */
  const {
    data: existing,
    loading: loadingExisting,
    error: loadError,
  } = useFetch(() => (isEdit ? ordersApi.get(id) : null), [id, isEdit]);

  useEffect(() => {
    if (!existing) return;

    setCustomerId(existing.customer?._id || '');
    setSelectedCustomer(existing.customer || null);

    /*
     * Each line carries its populated product as `selected`, which is what
     * makes the pickers show a name instead of an empty box. The price and
     * stock come with it, so the running total works before anyone touches a
     * search field.
     */
    setLines(
      (existing.items || []).map((item) => ({
        product: item.product?._id || '',
        quantity: item.quantity,
        selected: item.product || null,
      }))
    );

    setAssignedTo(existing.assignedTo?._id || '');
    setSelectedAssignee(existing.assignedTo || null);
  }, [existing]);

  // Items are only editable while the order is still pending; see the note at
  // the top. Locked is the safe default while the record is still loading.
  const itemsLocked = isEdit && existing?.status !== 'pending';

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
  const canSubmit =
    customerId && filledLines.length > 0 && !stockError && !submitting && !itemsLocked;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const items = filledLines.map((line) => ({
      product: line.product,
      quantity: Number(line.quantity),
    }));

    try {
      if (isEdit) {
        // Only the items are sent. The customer cannot move and the status is
        // changed from the detail page, so sending either would be asking the
        // API for something it is right to refuse.
        await ordersApi.update(id, { items });
        toast.success('Order updated.');
        navigate(`/crm/orders/${id}`, { replace: true });
      } else {
        const order = await ordersApi.create({
          customer: customerId,
          items,
          // Sent as null rather than omitted when nobody was chosen, so the
          // intent is explicit: this order is deliberately unassigned.
          assignedTo: assignedTo || null,
        });
        toast.success('Order created.');
        navigate(`/crm/orders/${order._id}`, { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err, isEdit ? 'Could not update order' : 'Could not create order'));
      setSubmitting(false);
    }
  }

  // A spinner rather than an empty form: a blank form that fills in a moment
  // later invites someone to start typing into fields about to be overwritten.
  if (isEdit && loadingExisting) return <Spinner full />;

  /*
   * A failed load is fatal for an edit, and must not degrade into a blank form.
   * That exact bug was fixed on the customer and product forms: the record
   * failed to load, the form rendered empty, and saving wrote the blanks over a
   * real record.
   */
  if (isEdit && loadError) return <ErrorBanner message={loadError} />;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={isEdit ? `Edit ${orderLabel(existing)}` : 'New order'}
        subtitle={
          isEdit
            ? 'Only the items can be changed, and only while the order is pending.'
            : 'Stock is reserved when the order is completed.'
        }
      />

      <Card className="p-6">
        <ErrorBanner message={error} onDismiss={() => setError('')} />

        {/*
          Said plainly rather than shown as disabled controls with no
          explanation. A form full of dead inputs is a puzzle; a sentence is an
          answer.
        */}
        {itemsLocked && (
          <div className="mb-4 rounded-md border border-warning/25 bg-warning-wash px-4 py-3 text-sm text-warning-ink">
            This order is {existing?.status}, so its items can no longer be changed — the stock
            has already moved. Create a new order instead.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/*
            The customer is fixed after creation. Moving an order to a different
            customer is not an edit, it is a different order — the original
            customer's history would silently lose a purchase they made.
          */}
          {isEdit ? (
            <Field label="Customer" hint="A customer cannot be changed after the order is placed.">
              <p className="text-sm text-ink">{existing?.customer?.name || 'Unknown customer'}</p>
            </Field>
          ) : (
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
          )}

          {/*
            WHO WILL WORK IT.

            Under the customer and above the items, because that is the order the
            decision is actually made in: who it is for, who is doing it, what
            they are getting.

            Only on creation. Changing it afterwards is reassignment, which lives
            on the detail page with its own audit entry — see the note on the
            assign route. Offering it here on an edit would be a second way to do
            the same thing, with different consequences.
          */}
          {!isEdit && (
            <Field
              label="Assign to"
              hint="Who will fulfil this order. Leave blank if you have not decided — nobody sees it until it is assigned."
            >
              <SearchSelect
                value={assignedTo}
                selected={selectedAssignee}
                onChange={(user) => {
                  setAssignedTo(user?._id || '');
                  setSelectedAssignee(user || null);
                }}
                fetchOptions={(search) => usersApi.assignable(search)}
                getOptionLabel={(user) => user.name}
                getOptionMeta={(user) => humanize(user.role)}
                placeholder="Search colleagues…"
                emptyMessage="No matching colleague"
              />
            </Field>
          )}

          {/*
            Outside the Field, not inside it.

            `Field` clones its single child to give it the label's id, so a
            second child throws — which took the whole form down rather than
            just this control. The clearing button is a sibling of the field
            rather than part of it, which is also what it is conceptually.
          */}
          {!isEdit && selectedAssignee && (
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                setAssignedTo('');
                setSelectedAssignee(null);
              }}
            >
              Leave unassigned
            </button>
          )}

          {/* --- Line items --------------------------------------------- */}
          <div>
            <p className="mb-2 text-sm font-medium text-ink-2">Items</p>
            <div className="space-y-2">
              {lines.map((line, index) => {
                const product = productById[line.product];

                return (
                  <div key={index} className="flex flex-wrap items-start gap-2">
                    <div className="min-w-[12rem] flex-1">
                      {itemsLocked ? (
                        <p className="pt-2 text-sm text-ink">
                          {line.selected?.name || 'Unknown product'}
                        </p>
                      ) : (
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
                      )}
                    </div>

                    <input
                      type="number"
                      min="1"
                      className={`${input} w-24`}
                      value={line.quantity}
                      disabled={itemsLocked}
                      aria-label={`Quantity for item ${index + 1}`}
                      onChange={(e) => updateLine(index, { quantity: e.target.value })}
                    />

                    <div className="w-24 pt-2 text-right text-sm text-ink-2">
                      {product ? money(product.price * (Number(line.quantity) || 0)) : '—'}
                    </div>

                    <button
                      type="button"
                      className="pt-2 text-sm text-muted hover:text-critical-ink disabled:opacity-40"
                      onClick={() => removeLine(index)}
                      disabled={lines.length === 1 || itemsLocked}
                      aria-label="Remove item"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>

            {!itemsLocked && (
              <button type="button" className={`${btnSecondary} mt-3`} onClick={addLine}>
                Add item
              </button>
            )}
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
              {submitting ? <Spinner /> : isEdit ? 'Save changes' : 'Create order'}
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
