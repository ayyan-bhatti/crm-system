import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { customersApi, usersApi } from '../../api/resources';
import useFetch, { useDebounced } from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import Can from '../../components/Can';
import {
  Card,
  CardSkeleton,
  ListEmptyState,
  TableSkeleton,
  ErrorBanner,
  PageHeader,
  Pagination,
  StatusBadge,
} from '../../components/common';
import { CUSTOMER_STATUSES } from '../../constants';
import { btnPrimary, humanize, input, link, td, th, formatDate } from '../../ui';

/**
 * Customer list with search and filters.
 *
 * Filter state lives in the URL rather than in component state, so a filtered
 * view can be bookmarked, shared, or survive a refresh — and the dashboard can
 * link straight to a pre-filtered list.
 */
export default function CustomerList() {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page')) || 1;
  const status = searchParams.get('status') || '';
  const assignedTo = searchParams.get('assignedTo') || '';

  // The search box is local state and debounced; only the settled value goes
  // into the URL and triggers a request.
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '');
  const search = useDebounced(searchInput, 300);

  const { data, loading, error } = useFetch(
    () =>
      customersApi.list({
        page,
        ...(status && { status }),
        ...(assignedTo && { assignedTo }),
        ...(search && { search }),
      }),
    [page, status, assignedTo, search]
  );

  // For the "assigned to" dropdown. Available to every role.
  const { can } = usePermissions();

  /*
   * The colleague list is fetched only for roles that can use it.
   *
   * A sales rep sees exactly their own customers, so an "assigned to" filter
   * can only ever be a no-op for them — and populating it meant every rep
   * pulling down the name of every other rep to fill a dropdown that does
   * nothing. Not a serious leak, but there is no reason for it to happen.
   */
  const { data: users } = useFetch(
    () => (can.viewAllRecords ? usersApi.assignable() : Promise.resolve([])),
    [can.viewAllRecords]
  );

  /*
   * Whether the empty result is empty BECAUSE of a filter.
   *
   * "No customers" and "no customers matching this search" are different
   * situations. Showing the first when the second is true tells the user the
   * database is empty and they stop looking — when in fact they have a filter
   * applied that they may have forgotten setting.
   */
  const isFiltered = Boolean(status || assignedTo || search);

  function clearFilters() {
    setSearchInput('');
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  /** Update one filter, resetting to page 1 since the result set changed. */
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
        title="Customers"
        subtitle="Everyone you are tracking."
        action={
          <Link to="/crm/customers/new" className={btnPrimary}>
            New customer
          </Link>
        }
      />

      <ErrorBanner message={error} />

      {/*
        No extra role gate needed here — reaching this page at all already
        requires `viewCustomers` ([ADMIN, MANAGER]), the same set the backend
        requires for churn-rollup. Lives on this page rather than the
        dashboard because a churn call is made while looking at the customer
        book, not from a landing page nobody opened for that reason.
      */}
      <ChurnRollupCard />

      <Card>
        {/* --- Filters --------------------------------------------------- */}
        <div className="grid gap-3 border-b border-hairline p-4 sm:grid-cols-3">
          <input
            className={input}
            placeholder="Search name, email or company"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setFilter('search', e.target.value);
            }}
          />

          <select className={input} value={status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {CUSTOMER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <Can do="viewAllRecords">
            <select
              className={input}
              value={assignedTo}
              onChange={(e) => setFilter('assignedTo', e.target.value)}
              aria-label="Filter by assigned rep"
            >
              <option value="">Anyone</option>
              {(users || []).map((user) => (
                <option key={user._id} value={user._id}>
                  {user.name}
                </option>
              ))}
            </select>
          </Can>
        </div>

        {/* --- Results --------------------------------------------------- */}
        {loading ? (
          // A skeleton shaped like the table, not a spinner — the rows appear
          // in place instead of the layout jumping when the data lands.
          <TableSkeleton rows={6} columns={5} />
        ) : !data?.data.length ? (
          <ListEmptyState
            filtered={isFiltered}
            entity="customers"
            onClear={clearFilters}
            action={
              <Link to="/crm/customers/new" className={btnPrimary}>
                New customer
              </Link>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th}>Name</th>
                    <th className={th}>Company</th>
                    <th className={th}>City</th>
                    <th className={th}>Status</th>
                    {/* Always the rep themselves, so it says nothing to them. */}
                    {can.viewAllRecords && <th className={th}>Assigned to</th>}
                    <th className={th}>Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {data.data.map((customer) => (
                    <tr key={customer._id} className="hover:bg-plane">
                      <td className={td}>
                        <Link to={`/crm/customers/${customer._id}`} className={link}>
                          {customer.name}
                        </Link>
                        <p className="text-xs text-muted">{customer.email}</p>
                      </td>
                      <td className={td}>{customer.company || '—'}</td>
                      <td className={td}>{customer.city || '—'}</td>
                      <td className={td}>
                        <StatusBadge value={customer.status} />
                      </td>
                      {can.viewAllRecords && (
                        <td className={td}>{customer.assignedTo?.name || 'Unassigned'}</td>
                      )}
                      <td className={td}>{formatDate(customer.createdAt)}</td>
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

/**
 * Churn-risk customers rolled up team-wide, with an AI narrative over the
 * same flags `CustomerSummaryCard` computes per-account. See
 * `customersApi.churnRollup` and the `mode` its response carries.
 */
function ChurnRollupCard() {
  const { data, loading, error } = useFetch(() => customersApi.churnRollup(), []);
  const rollup = data?.data?.rollup || [];

  if (!loading && !error && data && rollup.length === 0) return null;

  return (
    <Card className="mb-4 p-5">
      <h2 className="text-sm font-semibold text-ink">Churn risk, team-wide</h2>

      {loading && <CardSkeleton lines={2} />}
      <ErrorBanner message={error} />

      {data && rollup.length > 0 && (
        <>
          <p className="mt-2 text-sm text-ink-2">{data.data.narrative}</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {rollup.map((entry) => (
              <li
                key={entry.customerId}
                className="flex items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-2 text-sm"
              >
                <span className="text-ink-2">{entry.name}</span>
                <span className="shrink-0 text-xs font-medium text-muted">
                  {humanize(entry.label)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
