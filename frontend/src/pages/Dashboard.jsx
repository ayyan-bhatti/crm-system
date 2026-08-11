import { Link } from 'react-router-dom';
import { dashboardApi } from '../api/resources';
import useFetch from '../hooks/useFetch';
import AiSearchBar from '../components/AiSearchBar';
import {
  ChartCard,
  DataTable,
  RevenueTrend,
  StatusDonut,
  CategoryBar,
  Sparkline,
} from '../components/charts';
import {
  Card,
  ErrorBanner,
  Spinner,
  StatusBadge,
  EmptyState,
  Skeleton,
} from '../components/common';
import { useAuth } from '../context/AuthContext';
import { money, moneyCompact, formatDate, link, td, th, token } from '../ui';

/**
 * The landing page: four headline figures, a revenue trend, two breakdowns,
 * revenue by category, natural-language search, and recent orders.
 *
 * Everything comes from a single GET /api/dashboard/summary, already scoped to
 * the signed-in user's role — a sales rep sees their own numbers without the
 * frontend asking for anything different.
 */
export default function Dashboard() {
  const { user } = useAuth();
  const { data, loading, error } = useFetch(() => dashboardApi.summary(), []);

  if (loading) return <DashboardSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Welcome back, {user.name.split(' ')[0]}
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            Here is what is happening across your accounts.
          </p>
        </div>
        <p className="text-xs text-muted">
          Last 6 months · updated {new Date().toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
          })}
        </p>
      </div>

      <ErrorBanner message={error} />

      {data && (
        <>
          {/* --- KPI row --------------------------------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Customers"
              value={data.totalCustomers}
              hint={`${data.customersByStatus.active} active`}
              to="/customers"
              spark={data.monthly}
              sparkKey="newCustomers"
            />
            <StatTile
              label="Revenue"
              value={money(data.totalRevenue)}
              hint={`${data.completedOrders} completed orders`}
              spark={data.monthly}
              sparkKey="revenue"
            />
            <StatTile
              label="Low stock"
              value={data.lowStockProducts}
              hint="At or below threshold"
              to="/products?lowStock=true"
              tone={data.lowStockProducts > 0 ? 'critical' : 'default'}
            />
            <StatTile
              label="Pending orders"
              value={data.ordersByStatus.pending}
              hint="Awaiting completion"
              to="/orders?status=pending"
              spark={data.monthly}
              sparkKey="orders"
            />
          </div>

          {/* --- Trend + order mix ---------------------------------------- */}
          <div className="grid gap-4 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              title="Revenue trend"
              subtitle="Completed orders per month"
              table={
                <DataTable
                  columns={[
                    { key: 'label', label: 'Month' },
                    { key: 'revenue', label: 'Revenue', format: money },
                    { key: 'orders', label: 'Orders' },
                  ]}
                  rows={data.monthly}
                />
              }
            >
              <RevenueTrend data={data.monthly} />
            </ChartCard>

            <ChartCard
              title="Order status"
              subtitle="Across all orders you can see"
              table={
                <DataTable
                  columns={[
                    { key: 'name', label: 'Status' },
                    { key: 'value', label: 'Orders' },
                  ]}
                  rows={orderStatusData(data)}
                />
              }
            >
              <StatusDonut
                data={orderStatusData(data)}
                total={Object.values(data.ordersByStatus).reduce((a, b) => a + b, 0)}
                totalLabel="Orders"
              />
            </ChartCard>
          </div>

          {/* --- Category revenue + customer mix -------------------------- */}
          <div className="grid gap-4 lg:grid-cols-3">
            <ChartCard
              className="lg:col-span-2"
              title="Revenue by category"
              subtitle="Completed orders, top categories"
              table={
                <DataTable
                  columns={[
                    { key: 'category', label: 'Category' },
                    { key: 'revenue', label: 'Revenue', format: money },
                    { key: 'units', label: 'Units' },
                  ]}
                  rows={data.revenueByCategory}
                />
              }
            >
              {data.revenueByCategory.length ? (
                <CategoryBar data={data.revenueByCategory} />
              ) : (
                <EmptyState title="No completed orders yet" hint="Revenue appears once orders are completed." />
              )}
            </ChartCard>

            <ChartCard
              title="Customers by status"
              subtitle="Your pipeline at a glance"
              table={
                <DataTable
                  columns={[
                    { key: 'name', label: 'Status' },
                    { key: 'value', label: 'Customers' },
                  ]}
                  rows={customerStatusData(data)}
                />
              }
            >
              <StatusDonut
                data={customerStatusData(data)}
                total={data.totalCustomers}
                totalLabel="Customers"
              />
            </ChartCard>
          </div>

          <AiSearchBar />

          {/* --- Recent orders --------------------------------------------- */}
          <Card>
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">Recent orders</h2>
              <Link to="/orders" className="text-sm font-medium text-brand hover:underline">
                View all
              </Link>
            </div>

            {data.recentOrders.length === 0 ? (
              <EmptyState title="No orders yet" hint="Orders will appear here once created." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-plane/60">
                    <tr className="border-b border-hairline">
                      <th className={th}>Customer</th>
                      <th className={th}>Date</th>
                      <th className={th}>Status</th>
                      <th className={`${th} text-right`}>Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {data.recentOrders.map((order) => (
                      <tr key={order._id} className="transition-colors hover:bg-plane">
                        <td className={td}>
                          <Link to={`/orders/${order._id}`} className={link}>
                            {order.customer?.name || 'Unknown customer'}
                          </Link>
                        </td>
                        <td className={td}>{formatDate(order.createdAt)}</td>
                        <td className={td}>
                          <StatusBadge value={order.status} />
                        </td>
                        <td className={`${td} text-right font-semibold text-ink tabular`}>
                          {money(order.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Order status uses the reserved status colours, because here the colour
 * genuinely means good / waiting / bad. Every segment carries its label and
 * count in the legend, so the meaning never rests on hue.
 */
function orderStatusData(data) {
  return [
    { name: 'Completed', value: data.ordersByStatus.completed, fill: token('--color-good') },
    { name: 'Pending', value: data.ordersByStatus.pending, fill: token('--color-warning') },
    { name: 'Cancelled', value: data.ordersByStatus.cancelled, fill: token('--color-critical') },
  ];
}

/**
 * Customer status is identity, not judgement — a lead is not "bad" — so this
 * uses the categorical slots in their fixed order rather than status colours.
 */
function customerStatusData(data) {
  return [
    { name: 'Active', value: data.customersByStatus.active, fill: token('--color-series-1') },
    { name: 'Lead', value: data.customersByStatus.lead, fill: token('--color-series-2') },
    { name: 'Inactive', value: data.customersByStatus.inactive, fill: token('--color-series-3') },
  ];
}

/**
 * One of the four headline figures.
 *
 * The value uses the font's proportional figures rather than tabular ones —
 * equal-width digits make a large number like "121" look gappy at display size.
 * Tabular figures are for columns that align vertically, not for this.
 */
function StatTile({ label, value, hint, to, tone = 'default', spark, sparkKey }) {
  const body = (
    <Card
      className={`group h-full p-5 transition-all duration-150 ${
        to ? 'hover:-translate-y-0.5 hover:border-rule hover:shadow-lift' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-ink-2">{label}</p>
        {to && (
          <svg
            viewBox="0 0 20 20"
            className="h-4 w-4 shrink-0 fill-muted opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          >
            <path d="M7.05 4.55a1 1 0 000 1.4L11.1 10l-4.05 4.05a1 1 0 101.4 1.4l4.76-4.75a1 1 0 000-1.4L8.45 4.55a1 1 0 00-1.4 0z" />
          </svg>
        )}
      </div>

      {/* data-stat is a stable hook for tests, so they don't couple to styling. */}
      <p
        data-stat={label}
        className={`mt-2 text-[28px] font-semibold leading-none ${
          tone === 'critical' ? 'text-critical' : 'text-ink'
        }`}
      >
        {value}
      </p>

      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}

      {spark && sparkKey && (
        <div className="-mx-1 mt-3">
          <Sparkline data={spark} dataKey={sparkKey} />
        </div>
      )}
    </Card>
  );

  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * A skeleton in the shape of the real dashboard.
 *
 * A spinner in the middle of an empty page makes the whole layout appear at
 * once and shove content around; this holds the shape so nothing jumps.
 */
function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[142px]" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-[340px] lg:col-span-2" />
        <Skeleton className="h-[340px]" />
      </div>
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> Loading your dashboard…
      </div>
    </div>
  );
}
