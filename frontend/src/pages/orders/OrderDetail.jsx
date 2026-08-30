import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ordersApi, usersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import {
  Card,
  ErrorBanner,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../../components/common';
import Can from '../../components/Can';
import SearchSelect from '../../components/SearchSelect';
import ActivityTimeline from '../../components/ActivityTimeline';
import DraftMessageCard from '../../components/DraftMessageCard';
import DeliveryTimeline from '../../components/DeliveryTimeline';
import { Field } from '../../components/common';
import usePermissions from '../../hooks/usePermissions';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  formatDate,
  FULFILMENT_STEPS,
  humanize,
  input,
  link,
  money,
  orderLabel,
  PAYMENT_METHOD_LABELS,
  td,
  th,
  variantLabel,
} from '../../ui';

/**
 * A single order, plus the status controls.
 *
 * The two status actions are the only place in the UI that moves stock, which
 * is why they are here rather than buried in a form:
 *   Complete  — decrements stock for every line
 *   Cancel    — restores it, if it had been taken
 */
export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  /*
   * Feedback goes through the toast system rather than a banner on this page.
   *
   * Deleting an order navigates away, and a message rendered by this component
   * would disappear with it — the user would be returned to the list with no
   * confirmation that anything happened. A toast lives above the routes and
   * survives the navigation that caused it.
   */
  const toast = useToast();
  const { can } = usePermissions();
  const [busy, setBusy] = useState(false);

  const { data: order, loading, error, reload } = useFetch(() => ordersApi.get(id), [id]);

  async function changeStatus(status) {
    const messages = {
      completed: 'Complete this order? Stock will be deducted for every item.',
      cancelled: 'Cancel this order? Any deducted stock will be returned.',
    };

    if (!window.confirm(messages[status])) return;

    setBusy(true);

    try {
      await ordersApi.update(id, { status });
      toast.success(
        status === 'completed' ? 'Order completed and stock updated.' : 'Order cancelled.'
      );
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the order'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this order? This cannot be undone.')) return;

    setBusy(true);

    try {
      await ordersApi.remove(id);
      // Raised BEFORE navigating: the toast outlives this component, so the
      // user arrives at the list already knowing the delete succeeded.
      toast.success('Order deleted.');
      navigate('/crm/orders', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the order'));
      setBusy(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!order) return null;

  const isPending = order.status === 'pending';
  const isCompleted = order.status === 'completed';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={orderLabel(order)}
        subtitle={formatDate(order.createdAt)}
        action={
          <div className="flex flex-wrap gap-2">
            {isPending && (
              <button
                type="button"
                className={btnPrimary}
                onClick={() => changeStatus('completed')}
                disabled={busy}
              >
                Complete order
              </button>
            )}
            {(isPending || isCompleted) && (
              <button
                type="button"
                className={btnSecondary}
                onClick={() => changeStatus('cancelled')}
                disabled={busy}
              >
                Cancel order
              </button>
            )}
            {/*
              Only while pending. Once completed or cancelled the API refuses
              item changes, so offering the link would lead to a form that can
              show the order and change nothing — worse than no link at all.
            */}
            {isPending && (
              <Link to={`/crm/orders/${order._id}/edit`} className={btnSecondary}>
                Edit items
              </Link>
            )}
            <button type="button" className={btnDanger} onClick={handleDelete} disabled={busy}>
              Delete
            </button>
          </div>
        }
      />


      <AssignmentPanel order={order} onChanged={reload} />

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Customer</p>
            {order.customer ? (
              <Link to={`/crm/customers/${order.customer._id}`} className={`${link} text-sm`}>
                {order.customer.name}
              </Link>
            ) : (
              <p className="text-sm text-muted">Unknown</p>
            )}
            {order.customer?.company && (
              <p className="text-xs text-muted">{order.customer.company}</p>
            )}
          </div>

          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Status</p>
            <div className="mt-1">
              <StatusBadge value={order.status} />
            </div>
            {order.completedAt && (
              <p className="mt-1 text-xs text-muted">
                Completed {formatDate(order.completedAt)}
              </p>
            )}
            {/* Only ever set on a storefront order — an internal sale has no payment method to report. */}
            {order.paymentMethod && (
              <p className="mt-1 text-xs text-muted">
                Paying by {PAYMENT_METHOD_LABELS[order.paymentMethod] || order.paymentMethod}
              </p>
            )}
            {/*
              WHETHER MONEY HAS ACTUALLY MOVED, which is a different question
              from how it was meant to. A card order is genuinely paid before
              anyone picks it; a cash-on-delivery order is genuinely unpaid
              until the courier collects. Whoever is about to dispatch a parcel
              needs to know which of those they are looking at.
            */}
            {order.payment?.status && order.payment.status !== 'unpaid' && (
              <div className="mt-1.5">
                <StatusBadge value={order.payment.status} />
              </div>
            )}
          </div>
        </div>

        <table className="w-full">
          <thead className="border-y border-hairline bg-plane">
            <tr>
              <th className={th}>Product</th>
              <th className={`${th} text-right`}>Unit price</th>
              <th className={`${th} text-right`}>Qty</th>
              <th className={`${th} text-right`}>Line total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {order.items.map((item, index) => (
              <tr key={index}>
                <td className={td}>
                  {item.product ? (
                    <Link to={`/crm/products/${item.product._id}`} className={link}>
                      {item.product.name}
                    </Link>
                  ) : (
                    <span className="text-muted">Deleted product</span>
                  )}
                  {item.product?.sku && <p className="text-xs text-muted">{item.product.sku}</p>}
                  {/*
                    Which colour and size actually went out. Read from the
                    SNAPSHOT on the line rather than looked up on the product,
                    so it stays correct after the variant is renamed or
                    discontinued — see the note on the order item schema.
                  */}
                  {item.variant && (
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-2">
                      {item.variant.colorHex && (
                        <span
                          aria-hidden="true"
                          className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-ink/15"
                          style={{ backgroundColor: item.variant.colorHex }}
                        />
                      )}
                      {variantLabel(item.variant)}
                    </p>
                  )}
                </td>
                {/*
                  priceAtOrder, not the product's current price — this is what
                  the customer was actually charged at the time.
                */}
                <td className={`${td} text-right`}>{money(item.priceAtOrder)}</td>
                <td className={`${td} text-right`}>{item.quantity}</td>
                <td className={`${td} text-right`}>{money(item.priceAtOrder * item.quantity)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline">
              <td className={td} colSpan={3}>
                <span className="font-medium text-ink-2">Total</span>
              </td>
              <td className={`${td} text-right text-base font-semibold text-ink`}>
                {money(order.total)}
              </td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-4 text-xs text-muted">
          Placed by {order.createdBy?.name || 'unknown'} on {formatDate(order.createdAt)}. Prices
          shown are those recorded at the time of the order.
        </p>
      </Card>

      {/*
        The follow-up drafter, aimed at THIS order's customer.

        Gated on `viewCustomers` because the endpoint behind it lives on the
        customer router, which is manager-and-admin only — a rep offered this
        button would get a 403 for a customer they are correctly barred from.
        Also needs a populated customer: an order whose customer was deleted
        has nobody to write to.
      */}
      {can.viewCustomers && order.customer?._id && (
        <DraftMessageCard
          customerId={order.customer._id}
          subtitle={`To ${order.customer.name}, about this order`}
        />
      )}

      {/*
       * Last on the page on purpose. The order itself — what was sold, to
       * whom, who holds it — is the fact; the notes are the story around it,
       * and reading the story first is how people end up acting on a comment
       * about an order that has since been cancelled.
       */}
      <ActivityTimeline entity="order" id={order._id} title="Order notes" />
    </div>
  );
}

/**
 * Who is responsible for this order.
 *
 * WHY THIS IS ITS OWN BLOCK RATHER THAN A FIELD IN AN EDIT FORM.
 *
 * Reassigning is not editing. Editing an order changes what was sold;
 * reassigning changes who is accountable for it, which is attached to
 * commission and to who fields the call when something goes wrong. They also
 * have different permissions — a rep may edit their own order and may not hand
 * it to someone else — so folding the control into the edit form would mean
 * enabling and disabling one field inside it, which is exactly where rules like
 * this go wrong quietly.
 *
 * EVERYONE SEES THE STATE; ONLY MANAGERS AND ADMINS SEE THE CONTROL.
 *
 * A rep needs to know an order was handed to a colleague — that is the whole
 * point of the hand-off — so the panel is not hidden wholesale. What is hidden
 * is the ability to change it, per the API rule.
 */
function AssignmentPanel({ order, onChanged }) {
  const toast = useToast();
  const { can } = usePermissions();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  // The rep's transfer request. Separate state from the manager's picker
  // because they submit to different endpoints and mean different things.
  const [transferTo, setTransferTo] = useState(null);
  const [transferReason, setTransferReason] = useState('');

  /*
   * Keyed on the NAME, not on the object.
   *
   * `assignedTo` is an id until the API populates it, and an id is truthy — so
   * a branch on the object alone rendered `assignee.name` as `undefined` and
   * produced an "ASSIGNED TO" heading above two empty lines. That is worse than
   * either true answer: the screen exists to say who holds this order, and it
   * said nothing at all while looking like it had.
   *
   * The API is fixed and tested (every order response shares one populate
   * spec), so this is a second line rather than the remedy. Checking the field
   * actually being displayed means the worst future outcome is a wrong message
   * instead of a blank one.
   */
  const assignee = order.assignedTo;
  const assigneeName = assignee?.name;

  async function requestTransfer() {
    setSaving(true);

    try {
      const result = await ordersApi.requestTransfer(
        order._id,
        transferTo._id,
        transferReason
      );

      toast.success(result.message || 'Transfer requested.');
      setEditing(false);
      setTransferTo(null);
      setTransferReason('');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not request the transfer'));
    } finally {
      setSaving(false);
    }
  }

  async function assign(userId) {
    setSaving(true);

    try {
      await ordersApi.assign(order._id, userId);
      toast.success(
        userId ? 'Order reassigned.' : 'Assignment cleared. No rep holds this order now.'
      );
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not reassign the order'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Assigned to</p>

          {assigneeName ? (
            <>
              <p className="mt-1 text-sm font-medium text-ink">{assigneeName}</p>
              <p className="text-xs text-muted">{humanize(assignee.role)}</p>
            </>
          ) : (
            /*
             * Unassigned now genuinely means nobody, and the copy says so.
             *
             * It used to mean "follows whoever owns the customer", and this
             * block used to show that rep's name. Sales reps no longer have
             * customers, so an unassigned order is in nobody's list — saying
             * otherwise would name a person who cannot actually see it.
             */
            <>
              <p className="mt-1 text-sm text-ink">Not yet assigned</p>
              <p className="text-xs text-muted">
                No rep can see this order until somebody is given it
              </p>
            </>
          )}
        </div>

        <Can
          do="reassignRecords"
          /*
           * The rep holding the order gets a different control, not nothing.
           *
           * They cannot reassign — that would let them push a difficult account
           * onto a colleague, which is a staffing decision somebody else should
           * make. But they are the person who knows they are on leave next week.
           * So the fallback is "ask", and it goes to the admin.
           */
          fallback={
            editing ? (
              <button
                type="button"
                className={btnSecondary}
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
            ) : (
              <button type="button" className={btnSecondary} onClick={() => setEditing(true)}>
                Request transfer
              </button>
            )
          }
        >
          {editing ? (
            <button
              type="button"
              className={btnSecondary}
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
          ) : (
            <button type="button" className={btnSecondary} onClick={() => setEditing(true)}>
              Reassign
            </button>
          )}
        </Can>
      </div>

      {/*
        The rep's version of the picker: same control, different verb and a
        reason field, because the person approving it needs to know why.
      */}
      {editing && !can.reassignRecords && (
        <div className="mt-4 space-y-3 border-t border-hairline pt-4">
          <p className="text-sm text-ink-2">
            Ask for this order to be handed to a colleague. It stays with you until an
            administrator agrees.
          </p>

          <SearchSelect
            id="order-transfer-to"
            value={transferTo?._id || ''}
            selected={transferTo}
            fetchOptions={(query) => usersApi.assignable(query)}
            getOptionLabel={(user) => user.name}
            getOptionMeta={(user) => humanize(user.role)}
            placeholder="Search colleagues…"
            emptyMessage="No matching colleague"
            onChange={(user) => setTransferTo(user)}
          />

          <input
            type="text"
            className={input}
            aria-label="Reason for the transfer"
            placeholder="Why? (optional, but it is what the approver reads)"
            value={transferReason}
            onChange={(e) => setTransferReason(e.target.value)}
          />

          <button
            type="button"
            className={`${btnPrimary} w-full`}
            disabled={saving || !transferTo}
            onClick={requestTransfer}
          >
            {saving ? <Spinner /> : 'Send request'}
          </button>
        </div>
      )}

      <Can do="reassignRecords">
        {editing && (
          <div className="mt-4 space-y-3 border-t border-hairline pt-4">
            <SearchSelect
              id="order-assignee"
              value={assignee?._id || ''}
              selected={assignee || null}
              /*
               * The same picker used for customers and products on the order
               * form. Reusing it means the keyboard behaviour, the debounce and
               * the empty state are the ones people already know here.
               */
              fetchOptions={(query) => usersApi.assignable(query)}
              getOptionLabel={(user) => user.name}
              getOptionMeta={(user) => humanize(user.role)}
              placeholder="Search colleagues…"
              emptyMessage="No matching colleague"
              onChange={(user) => user && assign(user._id)}
            />

            {assignee && (
              <button
                type="button"
                className={`${btnSecondary} w-full`}
                onClick={() => assign(null)}
                disabled={saving}
              >
                {saving ? <Spinner /> : 'Clear assignment'}
              </button>
            )}
          </div>
        )}
      </Can>

      {/*
        DELIVERY LIVES IN THE SAME CARD AS ASSIGNMENT, DELIBERATELY.

        The brief asked for these to read as one panel rather than two
        disconnected sections, and the reason holds up: "who is accountable for
        this order" and "where has it got to" are the two halves of one
        question, and the person answering the second is usually the person
        named in the first. Splitting them across two cards means the rep
        updating a shipment has to look somewhere else to check the order is
        even theirs.
      */}
      <FulfilmentSection order={order} onChanged={onChanged} />
    </Card>
  );
}

/**
 * Where the parcel is, and the form for moving it along.
 *
 * WHY THERE IS NO PERMISSION CHECK HERE
 *
 * The rule is about the RECORD, not the role: admin and manager see every
 * order, a rep sees the ones assigned to them, and the server enforces exactly
 * that. Anyone who can open this page can therefore update the order they are
 * looking at. Adding a `<Can>` around it would have to duplicate a
 * record-scoped rule as a role-scoped one, and the two would disagree the first
 * time either changed.
 */
function FulfilmentSection({ order, onChanged }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fulfilment, setFulfilment] = useState(order.fulfilment || 'processing');
  const [estimate, setEstimate] = useState(
    order.estimatedDeliveryAt ? order.estimatedDeliveryAt.slice(0, 10) : ''
  );
  const [fieldError, setFieldError] = useState('');

  const cancelled = order.status === 'cancelled';

  /*
   * The estimate becomes REQUIRED from `shipped` onwards — matching the server,
   * which refuses the transition without one. Computed from the position in the
   * sequence rather than by comparing against the literal string `shipped`, so
   * jumping straight to `out_for_delivery` cannot slip past the rule.
   */
  const shippedIndex = FULFILMENT_STEPS.findIndex((s) => s.value === 'shipped');
  const chosenIndex = FULFILMENT_STEPS.findIndex((s) => s.value === fulfilment);
  const estimateRequired = chosenIndex >= shippedIndex;

  /**
   * A sensible default for the estimate: five days out.
   *
   * Offered rather than imposed — the field is still editable and still has to
   * be confirmed. The point is that the common case ("it went out today,
   * arrives in the usual window") does not require anyone to open a calendar
   * and count.
   */
  function suggestDate() {
    const date = new Date();
    date.setDate(date.getDate() + 5);
    setEstimate(date.toISOString().slice(0, 10));
    setFieldError('');
  }

  async function save(event) {
    event.preventDefault();
    setFieldError('');

    if (estimateRequired && !estimate) {
      setFieldError('Set the date before marking this shipped — the customer sees it.');
      return;
    }

    setSaving(true);
    try {
      await ordersApi.updateFulfilment(order._id, fulfilment, estimate || undefined);
      toast.success('Delivery status updated.');
      setOpen(false);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the delivery status'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Delivery</p>
          <div className="mt-1.5">
            <StatusBadge value={order.fulfilment || 'processing'} />
          </div>
          {order.estimatedDeliveryAt && !order.deliveredAt && (
            <p className="mt-1 text-xs text-muted">
              Customer is told: {formatDate(order.estimatedDeliveryAt)}
            </p>
          )}
        </div>

        {!cancelled && (
          <button
            type="button"
            className={btnSecondary}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? 'Cancel' : 'Update delivery'}
          </button>
        )}
      </div>

      <div className="mt-4">
        <DeliveryTimeline order={order} />
      </div>

      {/*
        `noValidate` on the form below MATTERS, and its absence was a real bug.

        `Field` puts a native `required` on the control, and the delivery
        estimate is a `type="date"` input. With native validation left on, an
        empty required date makes the BROWSER block submission and show its own
        bubble — so `onSubmit` never fires, this component's own validation
        never runs, and the specific, actionable message ("set the date before
        marking this shipped — the customer sees it") is never displayed. What
        the user gets instead is a generic browser tooltip that says nothing
        about why the date matters.

        Every other form in this app carries `noValidate` for the same reason:
        the inline errors are ours, styled, wired to `aria-describedby`, and
        able to explain themselves. Caught by an end-to-end test that clicked
        save and found no error message at all.
      */}
      {open && !cancelled && (
        <form
          onSubmit={save}
          noValidate
          className="mt-4 space-y-4 border-t border-hairline pt-4"
        >
          <Field
            label="Delivery status"
            required
            hint="What the customer sees on their order tracking page."
          >
            <select
              className={input}
              value={fulfilment}
              onChange={(e) => setFulfilment(e.target.value)}
            >
              {FULFILMENT_STEPS.map((step) => (
                <option key={step.value} value={step.value}>
                  {step.label}
                </option>
              ))}
            </select>
          </Field>

          <div>
            <Field
              label="Estimated delivery date"
              type="date"
              required={estimateRequired}
              error={fieldError}
              hint={
                estimateRequired
                  ? 'Required once an order has shipped — shown to the customer on their order tracking page.'
                  : 'Optional until the order ships. Shown to the customer once set.'
              }
              value={estimate}
              onChange={(e) => {
                setEstimate(e.target.value);
                setFieldError('');
              }}
            />
            <button
              type="button"
              onClick={suggestDate}
              className="mt-1.5 text-xs font-medium text-brand hover:underline"
            >
              Use the usual 5 days
            </button>
          </div>

          <button type="submit" className={btnPrimary} disabled={saving}>
            {saving ? <Spinner /> : 'Save delivery status'}
          </button>
        </form>
      )}
    </div>
  );
}
