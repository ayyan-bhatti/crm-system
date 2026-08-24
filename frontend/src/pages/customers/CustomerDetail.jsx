import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { customersApi, ordersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import {
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../../components/common';
import CustomerSummaryCard from '../../components/CustomerSummaryCard';
import { btnDanger, btnPrimary, btnSecondary, formatDate, link, money, td, th } from '../../ui';

/** A single customer, their details, and every order placed for them. */
export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Deleting navigates back to the list, so the confirmation has to outlive
  // this component — see the note in components/Toast.
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);

  const { data: customer, loading, error } = useFetch(() => customersApi.get(id), [id]);

  // Orders for this customer come from the orders endpoint with a filter, so
  // the API needs no special nested route.
  const { data: orders } = useFetch(() => ordersApi.list({ customer: id, limit: 50 }), [id]);

  async function handleDelete() {
    // A native confirm is enough here — a custom modal would be more polish
    // than this screen needs.
    if (!window.confirm('Delete this customer? This cannot be undone.')) return;

    setDeleting(true);

    try {
      await customersApi.remove(id);
      toast.success(`${customer.name} deleted.`);
      navigate('/customers', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete customer'));
      setDeleting(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!customer) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.name}
        subtitle={[customer.company, customer.city].filter(Boolean).join(' · ') || undefined}
        action={
          <div className="flex gap-2">
            <Link to={`/orders/new?customer=${customer._id}`} className={btnSecondary}>
              New order
            </Link>
            <Link to={`/customers/${customer._id}/edit`} className={btnPrimary}>
              Edit
            </Link>
            <button type="button" className={btnDanger} onClick={handleDelete} disabled={deleting}>
              {deleting ? <Spinner /> : 'Delete'}
            </button>
          </div>
        }
      />

      {/* Loads independently of the details below, so a slow AI call never
          delays the record the user actually navigated to. */}
      <CustomerSummaryCard customerId={customer._id} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-1">
          <h2 className="mb-4 text-base font-semibold text-ink">Details</h2>
          <dl className="space-y-3 text-sm">
            <Detail label="Status">
              <StatusBadge value={customer.status} />
            </Detail>
            <Detail label="Email">{customer.email}</Detail>
            <Detail label="Phone">{customer.phone || '—'}</Detail>
            <Detail label="Company">{customer.company || '—'}</Detail>
            <Detail label="City">{customer.city || '—'}</Detail>
            {/*
              `whitespace-pre-line` so the line breaks somebody typed into the
              address are the line breaks that show. An address collapsed onto
              one line is technically the same string and unreadable as a
              delivery instruction.
            */}
            <Detail label="Address">
              <span className="whitespace-pre-line">{customer.address || '—'}</span>
            </Detail>
            <Detail label="Assigned to">{customer.assignedTo?.name || 'Unassigned'}</Detail>
            <Detail label="Added by">{customer.createdBy?.name || '—'}</Detail>
            <Detail label="Added">{formatDate(customer.createdAt)}</Detail>
          </dl>

          {customer.notes && (
            <div className="mt-5 border-t border-hairline pt-4">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                Notes
              </p>
              <p className="whitespace-pre-wrap text-sm text-ink-2">{customer.notes}</p>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <div className="border-b border-hairline px-4 py-3">
            <h2 className="text-base font-semibold text-ink">Orders</h2>
          </div>

          {!orders?.data.length ? (
            <EmptyState
              title="No orders yet"
              action={
                <Link to={`/orders/new?customer=${customer._id}`} className={btnPrimary}>
                  Create the first order
                </Link>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>Items</th>
                    <th className={th}>Status</th>
                    <th className={`${th} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {orders.data.map((order) => (
                    <tr key={order._id} className="hover:bg-plane">
                      <td className={td}>
                        <Link to={`/orders/${order._id}`} className={link}>
                          {formatDate(order.createdAt)}
                        </Link>
                      </td>
                      <td className={td}>{order.items.length}</td>
                      <td className={td}>
                        <StatusBadge value={order.status} />
                      </td>
                      <td className={`${td} text-right font-medium`}>{money(order.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Detail({ label, children }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}
