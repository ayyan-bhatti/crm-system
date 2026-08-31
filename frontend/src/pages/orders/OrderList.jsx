import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ordersApi } from '../../api/resources';
import useFetch, { useDebounced } from '../../hooks/useFetch';
import {
  Card,
  ListEmptyState,
  TableSkeleton,
  ErrorBanner,
  PageHeader,
  Pagination,
  StatusBadge,
} from '../../components/common';
import { ORDER_STATUSES } from '../../constants';
import { btnPrimary, formatDate, input, link, money, orderLabel, td, th } from '../../ui';
import UrgencyBadge from '../../components/UrgencyBadge';

/** Order list, filterable by status and date range. */
export default function OrderList() {
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

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Sales across your accounts."
        action={
          <Link to="/crm/orders/new" className={btnPrimary}>
            New order
          </Link>
        }
      />

      <ErrorBanner message={error} />

      <Card>
        <div className="grid gap-3 border-b border-hairline p-4 sm:grid-cols-4">
          {/*
            Looking an order up by the number somebody quoted, which is the
            entire reason the number exists. The API is forgiving about the
            format — "142", "ord-142" and "ORD-000142" all find the same order —
            so the placeholder shows the canonical form without demanding it.
          */}
          <input
            type="search"
            className={input}
            placeholder="Order number, e.g. ORD-000142"
            aria-label="Search by order number"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setFilter('search', e.target.value);
            }}
          />

          <select className={input} value={status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-sm text-ink-2">
            From
            <input
              type="date"
              className={input}
              value={from}
              onChange={(e) => setFilter('from', e.target.value)}
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-ink-2">
            To
            <input
              type="date"
              className={input}
              value={to}
              onChange={(e) => setFilter('to', e.target.value)}
            />
          </label>
        </div>

        {loading ? (
          <TableSkeleton rows={6} columns={5} />
        ) : !data?.data.length ? (
          <ListEmptyState
            filtered={Boolean(status || from || to || search)}
            entity="orders"
            onClear={() => setSearchParams(new URLSearchParams(), { replace: true })}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th}>Order</th>
                    <th className={th}>Customer</th>
                    <th className={th}>Date</th>
                    <th className={th}>Items</th>
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {data.data.map((order) => (
                    <tr key={order._id} className="hover:bg-plane">
                      {/* The number leads, because it is what someone quotes. */}
                      <td className={`${td} whitespace-nowrap font-mono text-xs`}>
                        <Link to={`/crm/orders/${order._id}`} className={link}>
                          {orderLabel(order)}
                        </Link>
                      </td>
                      <td className={td}>
                        <Link to={`/crm/orders/${order._id}`} className={link}>
                          {order.customer?.name || 'Unknown customer'}
                        </Link>
                        {order.customer?.company && (
                          <p className="text-xs text-muted">{order.customer.company}</p>
                        )}
                      </td>
                      <td className={td}>{formatDate(order.createdAt)}</td>
                      <td className={td}>{order.items.length}</td>
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
                      <td className={`${td} text-right font-medium`}>{money(order.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
