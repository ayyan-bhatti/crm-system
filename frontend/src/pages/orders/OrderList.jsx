import { Link, useSearchParams } from 'react-router-dom';
import { ordersApi } from '../../api/resources';
import useFetch from '../../hooks/useFetch';
import {
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Pagination,
  Spinner,
  StatusBadge,
} from '../../components/common';
import { ORDER_STATUSES } from '../../constants';
import { btnPrimary, formatDate, input, link, money, td, th } from '../../ui';

/** Order list, filterable by status and date range. */
export default function OrderList() {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page')) || 1;
  const status = searchParams.get('status') || '';
  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';

  const { data, loading, error } = useFetch(
    () =>
      ordersApi.list({
        page,
        ...(status && { status }),
        ...(from && { from }),
        ...(to && { to }),
      }),
    [page, status, from, to]
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
          <Link to="/orders/new" className={btnPrimary}>
            New order
          </Link>
        }
      />

      <ErrorBanner message={error} />

      <Card>
        <div className="grid gap-3 border-b border-hairline p-4 sm:grid-cols-3">
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
          <Spinner full />
        ) : !data?.data.length ? (
          <EmptyState
            title="No orders found"
            hint="Try clearing the filters."
            action={
              <Link to="/orders/new" className={btnPrimary}>
                New order
              </Link>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th}>Customer</th>
                    <th className={th}>Date</th>
                    <th className={th}>Items</th>
                    <th className={th}>Placed by</th>
                    <th className={th}>Status</th>
                    <th className={`${th} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {data.data.map((order) => (
                    <tr key={order._id} className="hover:bg-plane">
                      <td className={td}>
                        <Link to={`/orders/${order._id}`} className={link}>
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
