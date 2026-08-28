import { Link } from 'react-router-dom';
import { customersApi, dashboardApi, productsApi } from '../api/resources';
import useFetch from '../hooks/useFetch';
import usePermissions from '../hooks/usePermissions';
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
  CardSkeleton,
  ErrorBanner,
  Spinner,
  StatusBadge,
  EmptyState,
  Skeleton,
} from '../components/common';
import { useAuth } from '../context/AuthContext';
import { money, formatDate, humanize, link, td, th, token } from '../ui';

/**
 * The landing page — THREE genuinely different screens, not one screen with
 * different numbers in it.
 *
 * WHY THEY ARE SEPARATE COMPONENTS.
 *
 * The three roles are not looking at the same business from different
 * heights; they are doing different jobs. An admin is answering "how is the
 * company doing and what needs my authority". A manager is answering "what
 * does the floor need from me today". A sales rep is answering "what do I
 * personally have to move before I go home". Rendering one layout and hiding
 * pieces of it produced exactly the failure this replaced: a rep looking at a
 * "Customers: 0" tile, because they have no customer book at all, and a
 * revenue chart of a number that was never theirs to influence.
 *
 * A widget a role cannot act on is not shown to them as an empty tile — it is
 * absent, and the server does not even compute it (see `roleExtras` in
 * dashboardController).
 */
export default function Dashboard() {
  const { user } = useAuth();
  const { can, isAdmin, isManager } = usePermissions();
  const { data, loading, error } = useFetch(() => dashboardApi.summary(), []);

  if (loading) return <DashboardSkeleton />;

  if (error && !data) {
    return (
      <div className="space-y-6">
        <Greeting user={user} subtitle="" />
        <ErrorBanner message={error} />
      </div>
    );
  }

  if (!data) return null;

  if (isAdmin) return <AdminDashboard data={data} user={user} can={can} />;
  if (isManager) return <ManagerDashboard data={data} user={user} />;
  return <RepDashboard data={data} user={user} />;
}

/* ---------------------------------------------------------------------------
 * Admin — the whole business, plus the things only an admin has authority over.
 * -------------------------------------------------------------------------*/

function AdminDashboard({ data, user, can }) {
  return (
    <div className="space-y-6">
      <Greeting user={user} subtitle="The whole business at a glance." />

      {/* Org-wide money and volume. The densest of the three screens, because
          the admin is the only role that sees every figure in it. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Revenue"
          value={money(data.totalRevenue)}
          hint={`${data.completedOrders} completed orders`}
          spark={data.monthly}
          sparkKey="revenue"
        />
        <StatTile
          label="Customers"
          value={data.totalCustomers}
          hint={`${data.customersByStatus.active} active`}
          to="/crm/customers"
          spark={data.monthly}
          sparkKey="newCustomers"
        />
        <StatTile
          label="Pending orders"
          value={data.ordersByStatus.pending}
          hint={`${data.unassignedOrders ?? 0} not yet assigned`}
          to="/crm/orders?status=pending"
          spark={data.monthly}
          sparkKey="orders"
        />
        <StatTile
          label="Low stock"
          value={data.lowStockProducts}
          hint="At or below threshold"
          to="/crm/products?lowStock=true"
          tone={data.lowStockProducts > 0 ? 'critical' : 'default'}
        />
      </div>

      {/* The admin's authority row: the two queues only they can clear, and
          the shortcut to the account management that is theirs alone. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <ActionTile
          label="Approvals waiting"
          value={data.pendingApprovals ?? 0}
          hint="Proposed changes needing a decision"
          to="/crm/approvals"
          urgent={(data.pendingApprovals ?? 0) > 0}
        />
        <ActionTile
          label="Accounts pending"
          value={data.pendingAccounts ?? 0}
          hint="Sign-ups awaiting approval"
          to="/crm/users"
          urgent={(data.pendingAccounts ?? 0) > 0}
        />
        <ActionTile
          label="Active users"
          value={data.totalUsers ?? 0}
          hint="Invite or manage colleagues"
          to="/crm/users"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Revenue trend"
          subtitle="Completed orders per month, company-wide"
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
          subtitle="Every order in the system"
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
            <EmptyState
              title="No completed orders yet"
              hint="Revenue appears once orders are completed."
            />
          )}
        </ChartCard>

        <ChartCard
          title="Customers by status"
          subtitle="The whole book"
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

      {/* Admin only — see hooks/usePermissions and the route's own requireAdmin. */}
      {can.internalAiSearch && <AiSearchBar />}

      <div className="grid gap-4 lg:grid-cols-2">
        <DigestCard title="Weekly digest" subtitle="Company-wide" />
        <ChurnCard scope="Company-wide" />
      </div>

      <RecentOrders orders={data.recentOrders} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Manager — the operating floor. Same visual language as admin, scoped down:
 * no user management, no account figures, no org-administration widgets.
 * -------------------------------------------------------------------------*/

function ManagerDashboard({ data, user }) {
  return (
    <div className="space-y-6">
      <Greeting user={user} subtitle="What the floor needs from you today." />

      {/* Three tiles, not four. Operations, not org administration. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Revenue"
          value={money(data.totalRevenue)}
          hint={`${data.completedOrders} completed orders`}
          spark={data.monthly}
          sparkKey="revenue"
        />
        <StatTile
          label="Pending orders"
          value={data.ordersByStatus.pending}
          hint={`${data.unassignedOrders ?? 0} not yet assigned`}
          to="/crm/orders?status=pending"
          spark={data.monthly}
          sparkKey="orders"
          tone={(data.unassignedOrders ?? 0) > 0 ? 'critical' : 'default'}
        />
        <ActionTile
          label="Approvals waiting"
          value={data.pendingApprovals ?? 0}
          hint="Buyer requests you can decide"
          to="/crm/approvals"
          urgent={(data.pendingApprovals ?? 0) > 0}
        />
      </div>

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
          subtitle="Across the team"
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

      {/* The manager's three AI cards: how the team did, who is at risk, and
          what needs restocking. All three are things a manager acts on. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <DigestCard title="Team performance this week" subtitle="Your team" />
        <ChurnCard scope="Your team" />
      </div>

      <ReorderCard />

      <RecentOrders orders={data.recentOrders} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Sales rep — the simplest of the three. A short list of what needs doing.
 * -------------------------------------------------------------------------*/

/**
 * Deliberately NOT a grid of tiles.
 *
 * A rep has no revenue figure, no customer book and no team, so a tile layout
 * would be three empty boxes and one real one. This is a work queue instead:
 * the orders assigned to them that are still pending, oldest first, each one
 * a link to the screen where they can actually move it.
 */
function RepDashboard({ data, user }) {
  const orders = data.myPendingOrders || [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Greeting
        user={user}
        subtitle={
          data.myPendingCount
            ? `You have ${data.myPendingCount} order${
                data.myPendingCount === 1 ? '' : 's'
              } waiting on you.`
            : 'Nothing is waiting on you right now.'
        }
      />

      <Card>
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Your orders to action</h2>
          <Link to="/crm/orders" className="text-sm font-medium text-brand hover:underline">
            All your orders
          </Link>
        </div>

        {orders.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            hint="Orders assigned to you appear here while they are pending."
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {orders.map((order) => (
              <li key={order._id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <Link to={`/crm/orders/${order._id}`} className={link}>
                    {order.customer?.name || 'Unknown customer'}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    Placed {formatDate(order.createdAt)}
                    {order.customer?.phone ? ` · ${order.customer.phone}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StatusBadge value={order.status} />
                  <span className="text-sm font-semibold text-ink tabular">
                    {money(order.total)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Stock is company-wide and a rep genuinely needs it — they are
          fulfilling orders made of these products, and an out-of-stock line
          is their problem to raise. This is the one company-wide figure on
          this screen, and it is here because it blocks their own work. */}
      {data.lowStockProducts > 0 && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-ink">Stock to watch</h2>
          <p className="mt-1 text-sm text-ink-2">
            {data.lowStockProducts} product{data.lowStockProducts === 1 ? ' is' : 's are'} at or
            below their reorder level, which may affect orders you are fulfilling.
          </p>
          <Link
            to="/crm/products?lowStock=true"
            className="mt-3 inline-block text-sm font-medium text-brand hover:underline"
          >
            See which
          </Link>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Shared pieces.
 * -------------------------------------------------------------------------*/

function Greeting({ user, subtitle }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Welcome back, {user.name.split(' ')[0]}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      <p className="text-xs text-muted">
        {humanize(user.role)} ·{' '}
        {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
      </p>
    </div>
  );
}

function RecentOrders({ orders }) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">Recent orders</h2>
        <Link to="/crm/orders" className="text-sm font-medium text-brand hover:underline">
          View all
        </Link>
      </div>

      {orders.length === 0 ? (
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
              {orders.map((order) => (
                <tr key={order._id} className="transition-colors hover:bg-plane">
                  <td className={td}>
                    <Link to={`/crm/orders/${order._id}`} className={link}>
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
  );
}

function DigestCard({ title, subtitle }) {
  const { data, loading, error } = useFetch(() => dashboardApi.digest(), []);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {data && <ModeBadge mode={data.mode} />}
      </div>
      {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}

      {loading && <CardSkeleton lines={2} />}
      <ErrorBanner message={error} />

      {data && (
        <>
          <p className="mt-2 text-sm text-ink-2">{data.narrative}</p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="font-medium uppercase tracking-wide text-muted">Revenue</dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink">
                {money(data.figures.revenue)}
              </dd>
            </div>
            <div>
              <dt className="font-medium uppercase tracking-wide text-muted">Orders</dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink">{data.figures.orders}</dd>
            </div>
          </dl>
        </>
      )}
    </Card>
  );
}

/**
 * The churn roll-up, on both the admin and manager dashboards.
 *
 * Response shape matches `CustomerList`'s card exactly — `data.data.rollup`
 * and `data.data.narrative` — because it is the same endpoint. Worth stating
 * because the nesting is easy to get wrong: `churnRollup()` resolves to the
 * whole envelope, not to `.data`.
 */
function ChurnCard({ scope }) {
  const { data, loading, error } = useFetch(() => customersApi.churnRollup(), []);
  const rollup = data?.data?.rollup || [];

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Customers at risk</h2>
        {data && <ModeBadge mode={data.mode} />}
      </div>
      <p className="mt-0.5 text-xs text-muted">{scope}</p>

      {loading && <CardSkeleton lines={2} />}
      <ErrorBanner message={error} />

      {data && rollup.length === 0 && (
        <p className="mt-2 text-sm text-ink-2">No customers are showing churn risk right now.</p>
      )}

      {data && rollup.length > 0 && (
        <>
          <p className="mt-2 text-sm text-ink-2">{data.data.narrative}</p>
          <ul className="mt-3 space-y-1.5 text-sm">
            {rollup.slice(0, 5).map((entry) => (
              <li key={entry.customerId} className="flex items-center justify-between gap-3">
                <Link to={`/crm/customers/${entry.customerId}`} className={link}>
                  {entry.name}
                </Link>
                <span className="shrink-0 text-xs text-muted">{humanize(entry.label)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** Reorder suggestions, on the manager dashboard — a stock decision they own. */
function ReorderCard() {
  const { data, loading, error } = useFetch(() => productsApi.reorderSuggestions(), []);
  const suggestions = data?.data || [];

  if (!loading && !error && data && suggestions.length === 0) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Worth reordering</h2>
        {data && <ModeBadge mode={data.mode} />}
      </div>
      <p className="mt-0.5 text-xs text-muted">Low stock and still selling</p>

      {loading && <CardSkeleton lines={2} />}
      <ErrorBanner message={error} />

      {suggestions.length > 0 && (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {suggestions.map((item) => (
            <li key={item.productId} className="rounded-lg border border-hairline p-3 text-sm">
              <Link to={`/crm/products/${item.productId}`} className={link}>
                {item.name}
              </Link>
              <p className="mt-0.5 text-xs text-ink-2">{item.justification}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The AI-vs-fallback indicator every AI surface in this app carries.
 *
 * Without it a fallback answer and a model-written one look identical, which
 * is how a deployment sat with no API key indefinitely — see AiSearchBar's
 * own note on the same problem.
 */
function ModeBadge({ mode }) {
  const isAi = mode === 'ai';
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
        isAi ? 'bg-good-wash text-good-ink' : 'bg-warning-wash text-warning-ink'
      }`}
    >
      {isAi ? 'AI' : 'Fallback'}
    </span>
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
 * One of the headline figures.
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
 * A queue tile: a count of things waiting on THIS person, and a way in.
 *
 * Visually distinct from `StatTile` on purpose — a statistic is something you
 * read, and this is something you clear. The accent border when it is
 * non-zero is what makes an admin's outstanding approvals impossible to walk
 * past, and its absence at zero is what stops the screen crying wolf.
 */
function ActionTile({ label, value, hint, to, urgent = false }) {
  return (
    <Link to={to} className="block">
      <Card
        className={`group h-full p-5 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift ${
          urgent ? 'border-brand/50 bg-brand-wash/30' : 'hover:border-rule'
        }`}
      >
        <p className="text-sm font-medium text-ink-2">{label}</p>
        <p
          data-stat={label}
          className={`mt-2 text-[28px] font-semibold leading-none ${
            urgent ? 'text-brand-ink' : 'text-ink'
          }`}
        >
          {value}
        </p>
        {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
      </Card>
    </Link>
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
