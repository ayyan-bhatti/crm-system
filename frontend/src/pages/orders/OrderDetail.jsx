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
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  formatDate,
  humanize,
  link,
  money,
  orderLabel,
  td,
  th,
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
      navigate('/orders', { replace: true });
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
              <Link to={`/customers/${order.customer._id}`} className={`${link} text-sm`}>
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
                    <Link to={`/products/${item.product._id}`} className={link}>
                      {item.product.name}
                    </Link>
                  ) : (
                    <span className="text-muted">Deleted product</span>
                  )}
                  {item.product?.sku && <p className="text-xs text-muted">{item.product.sku}</p>}
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
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const assignee = order.assignedTo;

  async function assign(userId) {
    setSaving(true);

    try {
      await ordersApi.assign(order._id, userId);
      toast.success(
        userId ? 'Order reassigned.' : 'Assignment cleared — the order follows its customer again.'
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

          {assignee ? (
            <>
              <p className="mt-1 text-sm font-medium text-ink">{assignee.name}</p>
              <p className="text-xs text-muted">{humanize(assignee.role)}</p>
            </>
          ) : (
            /*
             * Unassigned is not "nobody" — it means the order follows whoever
             * owns the customer, which is the normal case. Saying "Unassigned"
             * alone would read as an oversight and invite someone to "fix" it.
             */
            <>
              <p className="mt-1 text-sm text-ink">
                {order.customer?.assignedTo?.name || 'Follows the customer'}
              </p>
              <p className="text-xs text-muted">
                No specific rep — this order follows whoever owns the account
              </p>
            </>
          )}
        </div>

        <Can do="reassignRecords">
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
                {saving ? <Spinner /> : 'Clear assignment — let it follow the customer'}
              </button>
            )}
          </div>
        )}
      </Can>
    </Card>
  );
}
