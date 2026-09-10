import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { customersApi, usersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch, { useDebounced } from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import Can from '../../components/Can';
import {
  Button,
  ButtonLink,
  Card,
  CardSkeleton,
  DropdownMenu,
  ListEmptyState,
  MenuItem,
  Select,
  Table,
  TableSkeleton,
  ErrorBanner,
  PageHeader,
  Pagination,
  Spinner,
  StatusBadge,
} from '../../components/common';
import { CUSTOMER_STATUSES } from '../../constants';
import { btnPrimary, btnSecondary, humanize, input, link, td, th, formatDate } from '../../ui';

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

  const { data, loading, error, reload } = useFetch(
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

  // One extra column for the row-actions menu, and one more when the owner
  // column is on — the skeleton has to match or the rows lurch when they land.
  const columnCount = can.viewAllRecords ? 7 : 6;

  return (
    <div>
      <PageHeader
        eyebrow="Customers"
        title="Customers"
        subtitle="Every account you are tracking, with the rep who owns it and where it stands."
        action={
          <>
            {/*
              Admin only — see the note on `importCustomers` in
              usePermissions.js for why a bulk upload does not get the
              manager-queues-a-request treatment a single new customer does.
            */}
            <Can do="importCustomers">
              <ImportButton onImported={reload} />
            </Can>
            <ButtonLink to="/crm/customers/new">New customer</ButtonLink>
          </>
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
        <FilterBar
          onClear={isFiltered ? clearFilters : null}
          search={
            <SearchField
              placeholder="Search name, email or company"
              aria-label="Search customers"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setFilter('search', e.target.value);
              }}
            />
          }
        >
          <Select
            className="sm:w-44"
            value={status}
            aria-label="Filter by status"
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">All statuses</option>
            {CUSTOMER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </Select>

          <Can do="viewAllRecords">
            <Select
              className="sm:w-48"
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
            </Select>
          </Can>
        </FilterBar>

        {/* --- Results --------------------------------------------------- */}
        {loading ? (
          // A skeleton shaped like the table, not a spinner — the rows appear
          // in place instead of the layout jumping when the data lands.
          <TableSkeleton rows={6} columns={columnCount} />
        ) : !data?.data.length ? (
          <ListEmptyState
            filtered={isFiltered}
            entity="customers"
            onClear={clearFilters}
            action={<ButtonLink to="/crm/customers/new">New customer</ButtonLink>}
          />
        ) : (
          <>
            <Table caption="Customers, with their company, status and owner">
              <thead className="bg-sunken">
                <tr className="border-b border-hairline">
                  <th className={th}>Name</th>
                  <th className={th}>Company</th>
                  <th className={th}>City</th>
                  <th className={th}>Status</th>
                  {/* Always the rep themselves, so it says nothing to them. */}
                  {can.viewAllRecords && <th className={th}>Assigned to</th>}
                  <th className={th}>Added</th>
                  <th className={`${th} w-12 text-right`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.data.map((customer) => (
                  <tr key={customer._id} className="transition-colors hover:bg-sunken/60">
                    <td className={td}>
                      <div className="flex items-center gap-3">
                        <Avatar name={customer.name} />
                        <div className="min-w-0">
                          <Link to={`/crm/customers/${customer._id}`} className={link}>
                            {customer.name}
                          </Link>
                          <p className="truncate text-xs text-muted">{customer.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className={td}>{customer.company || '—'}</td>
                    <td className={td}>{customer.city || '—'}</td>
                    <td className={td}>
                      <StatusBadge value={customer.status} />
                    </td>
                    {can.viewAllRecords && (
                      <td className={td}>{customer.assignedTo?.name || 'Unassigned'}</td>
                    )}
                    <td className={`${td} whitespace-nowrap tabular`}>
                      {formatDate(customer.createdAt)}
                    </td>
                    <td className={`${td} text-right`}>
                      <RowMenu label={`Actions for ${customer.name}`}>
                        <MenuItem to={`/crm/customers/${customer._id}`}>Open customer</MenuItem>
                        <MenuItem to={`/crm/customers/${customer._id}/edit`}>Edit details</MenuItem>
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

/* ===========================================================================
 * Shared list furniture
 *
 * These live beside the screen that uses them rather than in the shared
 * component library, which is owned elsewhere and deliberately holds only the
 * pieces that are identical on both surfaces. An initials disc and a filter bar
 * are CRM-list furniture, so each list screen keeps its own compact copy.
 * ======================================================================== */

/** Up to two initials, first and last word — "Ada Lovelace" becomes "AL". */
function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * The initials disc beside a person's name.
 *
 * `aria-hidden`, deliberately: the name it abbreviates is right next to it, so
 * announcing "A L" before "Ada Lovelace" adds noise and no information.
 */
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

/**
 * The toolbar above a table: search on the left, filters on the right, and a
 * clear affordance that appears only once something is actually filtered.
 *
 * The clear control is conditional rather than permanently disabled because a
 * dead button on every screen is a control people stop seeing — and this one
 * matters precisely on the day somebody has forgotten a filter is set.
 */
function FilterBar({ search, children, onClear }) {
  return (
    <div className="flex flex-col gap-3 border-b border-hairline p-4 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1 lg:max-w-sm">{search}</div>
      <div className="flex flex-wrap items-center gap-3 lg:justify-end">
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

/**
 * "Import from Excel" — a toggled panel rather than a modal, matching the
 * app's existing pattern for an occasional action attached to a list screen
 * (see `FulfilmentSection` on the order detail page for the same shape).
 *
 * The expected sheet is Name / Email / Phone / Company / City / Address /
 * Status — the SAME columns `POST /api/customers` accepts one at a time, not
 * the marketing contacts export's merged/consent columns. See
 * services/customerImportService.js for the exact mapping and why a
 * duplicate email is skipped rather than merged or rejecting the whole file.
 */
function ImportButton({ onImported }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const fileInputRef = useRef(null);

  async function handleUpload(event) {
    event.preventDefault();
    if (!file) return;

    setError('');
    setResult(null);
    setUploading(true);

    try {
      const data = await customersApi.importFile(file);
      setResult(data);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      // The list on screen is now stale the moment ANY row was created.
      if (data.created.length > 0) onImported();
    } catch (err) {
      setError(errorMessage(err, 'Could not import that file'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="relative">
      <button type="button" className={btnSecondary} onClick={() => setOpen((v) => !v)}>
        {open ? 'Close' : 'Import from Excel'}
      </button>

      {open && (
        <Card className="absolute right-0 z-20 mt-2 w-[22rem] max-w-[calc(100vw-3rem)] p-4 shadow-pop">
          <p className="text-sm font-semibold text-ink">Import customers</p>
          <p className="mt-1 text-xs text-ink-2">
            An .xlsx with a header row: Name, Email, and optionally Phone, Company, City,
            Address, Status. A row whose email already belongs to a customer is skipped, not
            overwritten.
          </p>

          <form onSubmit={handleUpload} className="mt-3 space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              aria-label="Customer spreadsheet"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-xs text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-wash file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-ink hover:file:bg-rule"
            />

            <ErrorBanner message={error} />

            <button type="submit" className={`${btnPrimary} w-full`} disabled={!file || uploading}>
              {uploading ? <Spinner /> : 'Upload and import'}
            </button>
          </form>

          {result && <ImportResultSummary result={result} />}
        </Card>
      )}
    </div>
  );
}

/** What actually happened — every row accounted for as created, skipped, or failed. */
function ImportResultSummary({ result }) {
  const { created, skipped, failed, totalRows } = result;

  return (
    <div className="mt-3 space-y-2 border-t border-hairline pt-3 text-xs">
      <p className="font-medium text-ink">
        {created.length} of {totalRows} row{totalRows === 1 ? '' : 's'} created
        {skipped.length > 0 && `, ${skipped.length} skipped`}
        {failed.length > 0 && `, ${failed.length} failed`}.
      </p>

      {skipped.length > 0 && (
        <div>
          <p className="font-medium text-ink-2">Skipped (already in the CRM)</p>
          <ul className="mt-1 space-y-0.5 text-muted">
            {skipped.slice(0, 5).map((row) => (
              <li key={row.row}>
                Row {row.row}: {row.email}
              </li>
            ))}
            {skipped.length > 5 && <li>…and {skipped.length - 5} more</li>}
          </ul>
        </div>
      )}

      {failed.length > 0 && (
        <div>
          <p className="font-medium text-critical-ink">Could not import</p>
          <ul className="mt-1 space-y-0.5 text-muted">
            {failed.slice(0, 5).map((row) => (
              <li key={row.row}>
                Row {row.row}: {row.reason}
              </li>
            ))}
            {failed.length > 5 && <li>…and {failed.length - 5} more</li>}
          </ul>
        </div>
      )}
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
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="label-mono">Signals</p>
          <h2 className="mt-1 text-sm font-semibold text-ink">Churn risk, team-wide</h2>
        </div>
        {rollup.length > 0 && (
          <span className="rounded-full bg-warning-wash px-2.5 py-0.5 text-xs font-medium text-warning-ink">
            {rollup.length} at risk
          </span>
        )}
      </div>

      {loading && <CardSkeleton lines={2} />}
      <ErrorBanner message={error} />

      {data && rollup.length > 0 && (
        <>
          <p className="mt-2 text-sm text-ink-2">{data.data.narrative}</p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {rollup.map((entry) => (
              <li
                key={entry.customerId}
                className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-plane px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={entry.name} />
                  <span className="truncate text-ink-2">{entry.name}</span>
                </span>
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
