import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { customersApi, usersApi } from '../../api/resources';
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
import { CUSTOMER_STATUSES } from '../../constants';
import { btnPrimary, input, link, td, th, formatDate } from '../../ui';

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
  const { data: users } = useFetch(() => usersApi.assignable(), []);

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
          <Link to="/customers/new" className={btnPrimary}>
            New customer
          </Link>
        }
      />

      <ErrorBanner message={error} />

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

          <select
            className={input}
            value={assignedTo}
            onChange={(e) => setFilter('assignedTo', e.target.value)}
          >
            <option value="">Anyone</option>
            {(users || []).map((user) => (
              <option key={user._id} value={user._id}>
                {user.name}
              </option>
            ))}
          </select>
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
              <Link to="/customers/new" className={btnPrimary}>
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
                    <th className={th}>Assigned to</th>
                    <th className={th}>Added</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {data.data.map((customer) => (
                    <tr key={customer._id} className="hover:bg-plane">
                      <td className={td}>
                        <Link to={`/customers/${customer._id}`} className={link}>
                          {customer.name}
                        </Link>
                        <p className="text-xs text-muted">{customer.email}</p>
                      </td>
                      <td className={td}>{customer.company || '—'}</td>
                      <td className={td}>{customer.city || '—'}</td>
                      <td className={td}>
                        <StatusBadge value={customer.status} />
                      </td>
                      <td className={td}>{customer.assignedTo?.name || 'Unassigned'}</td>
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
