import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { customersApi, ordersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  Breadcrumb,
  ButtonLink,
  Card,
  DropdownMenu,
  EmptyState,
  ErrorBanner,
  MenuItem,
  PageHeader,
  Spinner,
  StatusBadge,
  Table,
} from '../../components/common';
import CustomerSummaryCard from '../../components/CustomerSummaryCard';
import ActivityTimeline from '../../components/ActivityTimeline';
import DraftMessageCard from '../../components/DraftMessageCard';
import { btnSecondary, formatDate, link, money, td, th } from '../../ui';

/**
 * A single customer, their details, and every order placed for them.
 *
 * THE SHAPE OF THE PAGE, AND WHY IT IS TWO COLUMNS.
 *
 * The wide column carries the record itself — who this account is and what they
 * have bought. The narrow one carries everything that is ABOUT the record
 * rather than part of it: the computed summary, the AI drafter, the notes
 * anyone has left. That split is what stops a fetched-in-a-moment AI panel
 * pushing the contact details somebody actually came for below the fold.
 */
export default function CustomerDetail() {
  const { can } = usePermissions();
  const { id } = useParams();
  const navigate = useNavigate();
  // Deleting navigates back to the list, so the confirmation has to outlive
  // this component — see the note in components/Toast.
  const toast = useToast();
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);

  const { data: customer, loading, error } = useFetch(() => customersApi.get(id), [id]);

  // Orders for this customer come from the orders endpoint with a filter, so
  // the API needs no special nested route.
  const { data: orders } = useFetch(() => ordersApi.list({ customer: id, limit: 50 }), [id]);

  async function handleDelete() {
    const ok = await confirm('Delete this customer? This cannot be undone.', {
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;

    setDeleting(true);

    try {
      await customersApi.remove(id);
      toast.success(`${customer.name} deleted.`);
      navigate('/crm/customers', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete customer'));
      setDeleting(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!customer) return null;

  const orderRows = orders?.data || [];

  return (
    <div>
      <Breadcrumb
        className="mb-3"
        items={[
          { label: 'Customers', to: '/crm/customers' },
          { label: customer.name },
        ]}
      />

      <PageHeader
        eyebrow="Customer"
        title={customer.name}
        subtitle={
          [customer.company, customer.city, customer.email].filter(Boolean).join(' · ') || undefined
        }
        action={
          <>
            {/* Same gate as the order list's button — see the note there. */}
            {can.writeOrders && (
              <ButtonLink variant="secondary" to={`/crm/orders/new?customer=${customer._id}`}>
                New order
              </ButtonLink>
            )}
            <ButtonLink to={`/crm/customers/${customer._id}/edit`}>Edit</ButtonLink>

            {/*
              The destructive action lives behind a menu rather than beside the
              two everyday ones. A Delete button sitting a thumb's width from
              Edit is a design that eventually deletes something.
            */}
            <DropdownMenu
              label="More customer actions"
              triggerClassName={btnSecondary}
              trigger={
                <>
                  <span className="sr-only">More actions</span>
                  <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
                    <path d="M10 6a1.6 1.6 0 110-3.2A1.6 1.6 0 0110 6zm0 5.6a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2zm0 5.6a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2z" />
                  </svg>
                </>
              }
            >
              {(close) => (
                <MenuItem
                  className="text-critical-ink hover:bg-critical-wash hover:text-critical-ink"
                  onClick={() => {
                    close();
                    handleDelete();
                  }}
                >
                  {deleting ? 'Deleting…' : 'Delete customer'}
                </MenuItem>
              )}
            </DropdownMenu>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)] lg:items-start">
        {/* --- The record itself ------------------------------------------ */}
        <div className="space-y-6">
          <Card className="p-5">
            <PanelHeading eyebrow="Contact" title="Details" />

            <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Fact label="Status">
                <StatusBadge value={customer.status} />
              </Fact>
              <Fact label="Email">
                {customer.email ? (
                  <a className={link} href={`mailto:${customer.email}`}>
                    {customer.email}
                  </a>
                ) : (
                  '—'
                )}
              </Fact>
              <Fact label="Phone">
                {customer.phone ? (
                  <a className={link} href={`tel:${customer.phone}`}>
                    {customer.phone}
                  </a>
                ) : (
                  '—'
                )}
              </Fact>
              <Fact label="Company">{customer.company || '—'}</Fact>
              <Fact label="City">{customer.city || '—'}</Fact>
              <Fact label="Assigned to">{customer.assignedTo?.name || 'Unassigned'}</Fact>
              <Fact label="Added by">{customer.createdBy?.name || '—'}</Fact>
              <Fact label="Added">{formatDate(customer.createdAt)}</Fact>
              {/*
                `whitespace-pre-line` so the line breaks somebody typed into the
                address are the line breaks that show. An address collapsed onto
                one line is technically the same string and unreadable as a
                delivery instruction.
              */}
              <Fact label="Address" className="sm:col-span-2">
                <span className="whitespace-pre-line">{customer.address || '—'}</span>
              </Fact>
            </dl>

            {customer.notes && (
              <div className="mt-5 border-t border-hairline pt-4">
                <p className="label-mono">Notes</p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                  {customer.notes}
                </p>
              </div>
            )}
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-4">
              <PanelHeading eyebrow="Commerce" title="Orders" />
              {orderRows.length > 0 && (
                <p className="text-sm text-muted">
                  <span className="tabular font-medium text-ink-2">{orderRows.length}</span>{' '}
                  {orderRows.length === 1 ? 'order' : 'orders'}
                </p>
              )}
            </div>

            {!orderRows.length ? (
              <EmptyState
                title="No orders yet"
                hint="Every order placed for this customer will be listed here."
                /* The third copy of this link, and it needed the same gate: an
                   empty state whose only call to action is forbidden is worse
                   than one with no action at all. */
                action={
                  can.writeOrders ? (
                    <ButtonLink to={`/crm/orders/new?customer=${customer._id}`}>
                      Create the first order
                    </ButtonLink>
                  ) : null
                }
              />
            ) : (
              <Table caption={`Orders for ${customer.name}`}>
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>Items</th>
                    <th className={th}>Status</th>
                    <th className={`${th} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {orderRows.map((order) => (
                    <tr key={order._id} className="transition-colors hover:bg-plane">
                      <td className={td}>
                        <Link to={`/crm/orders/${order._id}`} className={link}>
                          {formatDate(order.createdAt)}
                        </Link>
                      </td>
                      <td className={`${td} tabular`}>{order.items.length}</td>
                      <td className={td}>
                        <StatusBadge value={order.status} />
                      </td>
                      <td className={`${td} tabular text-right font-medium text-ink`}>
                        {money(order.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        {/* --- Everything that is about the record ------------------------ */}
        <aside className="space-y-6">
          {/* Loads independently of the details, so a slow AI call never
              delays the record the user actually navigated to. */}
          <CustomerSummaryCard customerId={customer._id} />

          {/* On demand, not auto-fetched: unlike the summary above, every draft
              is a fresh paid model call, and nobody wants one generated on every
              page visit before they have decided to write to this customer. */}
          <DraftMessageCard customerId={customer._id} />

          {/*
           * The timeline sits alongside the record rather than under it,
           * because it is read for the same reason the orders are: to work out
           * where this account stands before picking up the phone.
           */}
          <ActivityTimeline entity="customer" id={customer._id} title="Account notes" />
        </aside>
      </div>
    </div>
  );
}

/** The eyebrow-plus-heading pair every panel on this screen opens with. */
function PanelHeading({ eyebrow, title }) {
  return (
    <div className="min-w-0">
      <p className="label-mono">{eyebrow}</p>
      <h2 className="mt-1 text-base font-semibold text-ink">{title}</h2>
    </div>
  );
}

/**
 * One key/value pair, as real definition-list semantics.
 *
 * `<dt>`/`<dd>` rather than two divs because that is what this content is: a
 * screen reader announces "Phone, 0300 1234567" from the markup alone, where a
 * pair of styled divs announces two unrelated strings.
 */
function Fact({ label, children, className = '' }) {
  return (
    <div className={className}>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}
