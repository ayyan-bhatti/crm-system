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
  /*
   * A line is (product, VARIANT, quantity). The variant was missing entirely,
   * and its absence is what made every variant product unorderable from the
   * CRM — see the note on `variantOptions` below.
   */
  const [lines, setLines] = useState([
    { product: '', quantity: 1, selected: null, variantId: '' },
  ]);

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
        // The order line stores a variant SNAPSHOT (colorName/colorHex/size)
        // so it survives the variant being renamed, but it keeps the id too —
        // which is what lets an edit re-select the right one in the picker.
        variantId: item.variant?.variantId ? String(item.variant.variantId) : '',
      }))
    );

    setAssignedTo(existing.assignedTo?._id || '');
    setSelectedAssignee(existing.assignedTo || null);
  }, [existing]);

  // Items are only editable while the order is still pending; see the note at
  // the top. Locked is the safe default while the record is still loading.
  const itemsLocked = isEdit && existing?.status !== 'pending';

  /*
   * The product-by-id lookup that used to live here is gone. It existed to get
   * from a line's product id back to the record, which was fine while a line's
   * identity WAS its product — and stopped being true when variants arrived.
   * Two lines can now carry the same product and different colours, with
   * different stock and possibly different prices, so everything that matters
   * is read from the line itself (`line.selected` plus `line.variantId`) rather
   * than from a map keyed on something no longer unique.
   */

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addLine() {
    setLines((prev) => [...prev, { product: '', quantity: 1, selected: null, variantId: '' }]);
  }

  /**
   * The variants a line's chosen product is sold in, or [] for a plain product.
   *
   * A product with variants CANNOT be ordered without one — the API refuses it,
   * because stock is held per colour and a line with no colour has no stock to
   * come out of. The form previously had no idea variants existed (the option
   * projection did not return them), so it offered such a product, sent a line
   * without a variant, and surfaced the server's refusal as if the page were
   * broken. Every variant product in the catalogue was unorderable from the CRM.
   */
  function variantsFor(line) {
    return line.selected?.variants || [];
  }

  /** The specific variant chosen on a line, if any. */
  function chosenVariant(line) {
    return variantsFor(line).find((v) => String(v._id) === String(line.variantId)) || null;
  }

  /** What a line costs each — the variant's override where it has one. */
  function unitPrice(line) {
    const variant = chosenVariant(line);
    return variant?.priceOverride ?? line.selected?.price ?? 0;
  }

  /** Stock available to a line: the variant's, or the product's. */
  function availableStock(line) {
    const variant = chosenVariant(line);
    return variant ? variant.stockQty : (line.selected?.stockQty ?? 0);
  }

  /** "Midnight / M", for the picker and the stock messages. */
  function variantName(variant) {
    return [variant?.color?.name, variant?.size].filter(Boolean).join(' / ');
  }

  function removeLine(index) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  const total = lines.reduce(
    (sum, line) => sum + (line.selected ? unitPrice(line) * (Number(line.quantity) || 0) : 0),
    0
  );

  /**
   * Client-side stock check, mirroring the server's rule of merging duplicate
   * lines before comparing against stock.
   *
   * MERGED ON (PRODUCT, VARIANT), NOT ON PRODUCT — the same key the server
   * uses. Two lines of the same jacket in different colours draw on different
   * stock and must not be added together; two lines of the SAME colour must.
   * Keying on the product alone would reject a perfectly fillable order (six
   * Midnight plus six Sand, against six of each) and let an unfillable one
   * through unnoticed on a product with a small variant and a large total.
   */
  function stockProblem() {
    const wanted = new Map();
    for (const line of lines) {
      if (!line.product) continue;
      const key = `${line.product}::${line.variantId || ''}`;
      const entry = wanted.get(key) || { line, quantity: 0 };
      entry.quantity += Number(line.quantity) || 0;
      wanted.set(key, entry);
    }

    for (const { line, quantity } of wanted.values()) {
      if (!line.selected) continue;
      // A variant product with nothing chosen has no stock to check yet; the
      // "choose a colour" rule below is what blocks it.
      if (variantsFor(line).length && !line.variantId) continue;

      const stock = availableStock(line);
      if (quantity > stock) {
        const variant = chosenVariant(line);
        const what = variant ? `${line.selected.name} (${variantName(variant)})` : line.selected.name;
        return `Not enough stock for ${what}: asking for ${quantity}, ${stock} available.`;
      }
    }
    return '';
  }

  /**
   * A product sold in colours needs one picked. Stated as its own check so the
   * message names the product rather than leaving a disabled button unexplained.
   */
  function variantProblem() {
    const missing = lines.find(
      (line) => line.selected && variantsFor(line).length > 0 && !line.variantId
    );
    return missing
      ? `Choose a colour for ${missing.selected.name} — it is sold in specific colours.`
      : '';
  }

  const stockError = stockProblem();
  const variantError = variantProblem();
  const filledLines = lines.filter((line) => line.product && Number(line.quantity) > 0);
  const canSubmit =
    customerId &&
    filledLines.length > 0 &&
    !stockError &&
    !variantError &&
    !submitting &&
    !itemsLocked;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const items = filledLines.map((line) => ({
      product: line.product,
      quantity: Number(line.quantity),
      // null rather than omitted for a plain product: the API distinguishes
      // "no variant, because this product has none" from "variant missing",
      // and refuses a variant on a product that has none.
      variantId: line.variantId || null,
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

            {/* Column headings, so the three narrow inputs are not three
                unlabelled boxes. Hidden on mobile, where the row stacks and
                each control is beside its own label instead. */}
            <div className="mb-1.5 hidden grid-cols-[minmax(0,1fr)_5rem_6rem_auto] gap-2 px-0.5 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
              <span>Product</span>
              <span>Qty</span>
              <span className="text-right">Amount</span>
              <span className="w-[4.5rem]" />
            </div>

            <div className="space-y-2">
              {lines.map((line, index) => {
                const variants = variantsFor(line);
                const variant = chosenVariant(line);

                return (
                  /*
                    A GRID, not `flex flex-wrap`.
                    Wrapping collapsed the row into a vertical stack the moment
                    the product name was long or the sidebar was open — product,
                    colour, quantity and amount each on their own full-width
                    line, with no column headings to say what any of them were.
                    A grid keeps the columns aligned down the list, which is the
                    whole reason a line-items table is a table.
                  */
                  <div
                    key={index}
                    className="grid grid-cols-1 items-start gap-2 rounded-lg border border-hairline p-2.5 sm:grid-cols-[minmax(0,1fr)_5rem_6rem_auto] sm:border-0 sm:p-0"
                  >
                    <div className="min-w-0">
                      {itemsLocked ? (
                        <p className="pt-2 text-sm text-ink">
                          {line.selected?.name || 'Unknown product'}
                          {variant && (
                            <span className="block text-xs text-muted">{variantName(variant)}</span>
                          )}
                        </p>
                      ) : (
                        <>
                          <SearchSelect
                            value={line.product}
                            selected={line.selected}
                            /*
                              Choosing a different product CLEARS the variant.
                              A variant id belongs to one product; carried over,
                              it matches nothing on the new one, and the line
                              looks complete while the server rejects it for a
                              colour nobody picked.
                            */
                            onChange={(picked) =>
                              updateLine(index, {
                                product: picked._id,
                                selected: picked,
                                variantId:
                                  picked.variants?.length === 1
                                    ? String(picked.variants[0]._id)
                                    : '',
                              })
                            }
                            fetchOptions={(search) => productsApi.options(search)}
                            getOptionLabel={(p) => p.name}
                            getOptionMeta={(p) =>
                              `${p.sku} · ${money(p.price)} · ${
                                p.variants?.length
                                  ? `${p.variants.length} colours`
                                  : `${p.stockQty} in stock`
                              }`
                            }
                            placeholder="Search products…"
                            emptyMessage="No products match that search"
                          />

                          {/* Only where the product genuinely has colours. */}
                          {variants.length > 0 && (
                            <div className="mt-1.5">
                              <label className="sr-only" htmlFor={`variant-${index}`}>
                                Colour and size for item {index + 1}
                              </label>
                              <select
                                id={`variant-${index}`}
                                className={`${input} w-full`}
                                value={line.variantId}
                                onChange={(e) => updateLine(index, { variantId: e.target.value })}
                              >
                                <option value="">Choose a colour…</option>
                                {variants.map((v) => (
                                  <option
                                    key={v._id}
                                    value={v._id}
                                    /* Shown and disabled rather than hidden:
                                       "out of stock" and "not made" are
                                       different facts. */
                                    disabled={v.stockQty === 0}
                                  >
                                    {variantName(v)}
                                    {v.stockQty === 0
                                      ? ' — out of stock'
                                      : ` — ${v.stockQty} in stock`}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    <input
                      type="number"
                      min="1"
                      className={`${input} w-full`}
                      value={line.quantity}
                      disabled={itemsLocked}
                      aria-label={`Quantity for item ${index + 1}`}
                      onChange={(e) => updateLine(index, { quantity: e.target.value })}
                    />

                    <div className="pt-2 text-right text-sm tabular text-ink-2">
                      {line.selected
                        ? money(unitPrice(line) * (Number(line.quantity) || 0))
                        : '—'}
                    </div>

                    <button
                      type="button"
                      className="justify-self-start pt-2 text-sm text-muted transition-colors hover:text-critical-ink disabled:opacity-40 sm:justify-self-auto"
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

          {/*
            Said out loud rather than left as a disabled button. This is the
            exact message the server would have returned — the difference is
            that it arrives before the submit rather than after it, and names
            the product so it is actionable.
          */}
          {variantError && (
            <div className="rounded-md border border-warning/25 bg-warning-wash px-4 py-3 text-sm text-warning-ink">
              {variantError}
            </div>
          )}

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
