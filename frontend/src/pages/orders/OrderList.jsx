import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ordersApi } from '../../api/resources';
import useFetch, { useDebounced } from '../../hooks/useFetch';
import {
  Button,
  ButtonLink,
  Card,
  DropdownMenu,
  ListEmptyState,
  MenuItem,
  Select,
  Table,
  TableSkeleton,
  ErrorBanner,
  PageHeader,
  Pagination,
  StatusBadge,
} from '../../components/common';
import { ORDER_STATUSES } from '../../constants';
import { formatDate, humanize, input, link, money, orderLabel, td, th } from '../../ui';
import UrgencyBadge from '../../components/UrgencyBadge';
import usePermissions from '../../hooks/usePermissions';

/** Order list, filterable by status and date range. */
export default function OrderList() {
  const { can } = usePermissions();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page')) || 1;
  const status = searchParams.get('status') || '';
  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const search = searchParams.get('search') || '';

  /*
   * Debounced, so typing an order number does not fire a request per keystroke.
   * The input is uncontrolled-ish for the same reason: `searchInput` updates
   * immediately for responsiveness while the URL and the query lag behind it.
   */
  const [searchInput, setSearchInput] = useState(search);
  const debouncedSearch = useDebounced(searchInput, 300);

  const { data, loading, error } = useFetch(
    () =>
      ordersApi.list({
        page,
        ...(status && { status }),
        ...(from && { from }),
        ...(to && { to }),
        ...(debouncedSearch && { search: debouncedSearch }),
      }),
    [page, status, from, to, debouncedSearch]
  );

  const isFiltered = Boolean(status || from || to || search);

  function setFilter(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setSearchParams(next);
  }

  function setPage(nextPage) {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(nextPage));
    setSearchParams(next);
  }

  function clearFilters() {
    setSearchInput('');
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  return (
    <div>
      <PageHeader
        eyebrow="Commerce"
        title="Orders"
        subtitle="Every sale across your accounts — what it was worth, and where the parcel is."
        /*
          Gated on `writeOrders`, which it never was.
          A sales rep cannot create an order — an order is a commercial
          commitment and a rep fulfils orders rather than agreeing them — but
          this button was shown to every role regardless. So a rep saw the one
          primary action on their main screen, pressed it, filled in a form, and
          was refused by the API at the end. A control you are not allowed to
          use should not be the most prominent thing on the page.
        */
        action={can.writeOrders ? <ButtonLink to="/crm/orders/new">New order</ButtonLink> : null}
      />

      <ErrorBanner message={error} />

      <Card>
        <FilterBar
          onClear={isFiltered ? clearFilters : null}
          search={
            /*
              Looking an order up by the number somebody quoted, which is the
              entire reason the number exists. The API is forgiving about the
              format — "142", "ord-142" and "ORD-000142" all find the same order —
              so the placeholder shows the canonical form without demanding it.
            */
            <SearchField
              placeholder="Order number, e.g. ORD-000142"
              aria-label="Search by order number"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setFilter('search', e.target.value);
              }}
            />
          }
        >
          <Select
            className="sm:w-40"
            value={status}
            aria-label="Filter by status"
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </Select>

          {/* The two halves of one range, labelled so neither date box is a
              mystery on its own. */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <span className="label-mono">From</span>
              <input
                type="date"
                className={`${input} w-auto tabular`}
                value={from}
                onChange={(e) => setFilter('from', e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <span className="label-mono">To</span>
              <input
                type="date"
                className={`${input} w-auto tabular`}
                value={to}
                onChange={(e) => setFilter('to', e.target.value)}
              />
            </label>
          </div>
        </FilterBar>

        {loading ? (
          <TableSkeleton rows={6} columns={8} />
        ) : !data?.data.length ? (
          <ListEmptyState filtered={isFiltered} entity="orders" onClear={clearFilters} />
        ) : (
          <>
            <Table caption="Orders, with customer, status, delivery stage and total">
              <thead className="bg-sunken">
                <tr className="border-b border-hairline">
                  <th className={th}>Order</th>
                  <th className={th}>Customer</th>
                  <th className={th}>Date</th>
                  <th className={`${th} text-right`}>Items</th>
                  <th className={th}>Placed by</th>
                  <th className={th}>Status</th>
                  {/*
                    Delivery is its own column rather than being folded into
                    Status. They answer different questions — "does this sale
                    count and has stock moved" versus "where is the parcel" —
                    and an order is routinely `pending` and `shipped` at the
                    same time, which one column cannot express.
                  */}
                  <th className={th}>Delivery</th>
                  <th className={`${th} text-right`}>Total</th>
                  <th className={`${th} w-12 text-right`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.data.map((order) => (
                  <tr key={order._id} className="transition-colors hover:bg-sunken/60">
                    {/* The number leads, because it is what someone quotes. */}
                    <td className={`${td} whitespace-nowrap`}>
                      <Link
                        to={`/crm/orders/${order._id}`}
                        className={`${link} font-mono text-xs tabular`}
                      >
                        {orderLabel(order)}
                      </Link>
                    </td>
                    <td className={td}>
                      <div className="flex items-center gap-3">
                        <Avatar name={order.customer?.name} />
                        <div className="min-w-0">
                          <Link to={`/crm/orders/${order._id}`} className={link}>
                            {order.customer?.name || 'Unknown customer'}
                          </Link>
                          {order.customer?.company && (
                            <p className="truncate text-xs text-muted">{order.customer.company}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={`${td} whitespace-nowrap tabular`}>
                      {formatDate(order.createdAt)}
                    </td>
                    <td className={`${td} text-right tabular`}>{order.items.length}</td>
                    <td className={td}>{order.createdBy?.name || '—'}</td>
                    <td className={td}>
                      <StatusBadge value={order.status} />
                    </td>
                    <td className={td}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge value={order.fulfilment || 'processing'} />
                        {/* Silent unless the promised date is tomorrow or
                            already gone — see UrgencyBadge for why a chip on
                            every row would defeat the point. */}
                        <UrgencyBadge order={order} />
                      </div>
                      {order.estimatedDeliveryAt && order.fulfilment !== 'delivered' && (
                        <span className="mt-1 block text-xs text-muted">
                          Est. {formatDate(order.estimatedDeliveryAt)}
                        </span>
                      )}
                    </td>
                    <td className={`${td} whitespace-nowrap text-right font-semibold text-ink tabular`}>
                      {money(order.total)}
                    </td>
                    <td className={`${td} text-right`}>
                      <RowMenu label={`Actions for order ${orderLabel(order)}`}>
                        <MenuItem to={`/crm/orders/${order._id}`}>Open order</MenuItem>
                        {can.writeOrders && (
                          <MenuItem to={`/crm/orders/${order._id}/edit`}>Edit order</MenuItem>
                        )}
                      </RowMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

/* --- List furniture, local to this screen ---------------------------------
 * See the note on the same helpers in CustomerList: CRM-list chrome stays
 * beside the list rather than in the shared component library.
 * ------------------------------------------------------------------------*/

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** The initials disc beside a person's name; hidden from screen readers,
 *  since the name it abbreviates is announced right after it. */
function Avatar({ name }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-wash text-[11px] font-semibold tracking-wide text-brand-ink"
    >
      {initialsOf(name)}
    </span>
  );
}

/** A search input with the magnifier inside it rather than beside it. */
function SearchField({ className = '', ...rest }) {
  return (
    <div className="relative">
      <svg
        viewBox="0 0 20 20"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 fill-muted"
        aria-hidden="true"
      >
        <path d="M9 2a7 7 0 105.2 11.66l3.07 3.07a1 1 0 001.42-1.42l-3.07-3.07A7 7 0 009 2zm0 2a5 5 0 110 10A5 5 0 019 4z" />
      </svg>
      <input type="search" className={`${input} pl-9 ${className}`} {...rest} />
    </div>
  );
}

/** Search left, filters right, and a clear affordance only once one is set. */
function FilterBar({ search, children, onClear }) {
  return (
    <div className="flex flex-col gap-3 border-b border-hairline p-4 xl:flex-row xl:items-center">
      <div className="min-w-0 flex-1 xl:max-w-sm">{search}</div>
      <div className="flex flex-wrap items-center gap-3 xl:justify-end">
        {children}
        {onClear && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

/** The "⋯" row-actions trigger, with the menu the caller supplies. */
function RowMenu({ label, children }) {
  return (
    <div className="flex justify-end">
      <DropdownMenu
        label={label}
        triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        trigger={
          <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
            <path d="M6 10a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm5.5 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm5.5 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
          </svg>
        }
      >
        {children}
      </DropdownMenu>
    </div>
  );
}
