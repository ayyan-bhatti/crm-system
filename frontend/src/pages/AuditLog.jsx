import { Fragment, useState } from 'react';
import { auditApi } from '../api/resources';
import useFetch from '../hooks/useFetch';
import {
  Button,
  Card,
  CardSkeleton,
  ErrorBanner,
  ListEmptyState,
  PageHeader,
  Pagination,
  Select,
  Table,
  TableSkeleton,
} from '../components/common';
import { formatDate, humanize, td, th } from '../ui';

/**
 * Admin-only view of the audit trail.
 *
 * The screen is built around the three questions an audit log is actually
 * opened to answer — who did this, what did it look like before, and what
 * happened in this window — so the filters are entity, action and date, and
 * each row expands to the field-level diff rather than to two raw documents.
 *
 * Showing the *changes* rather than the before/after blobs is the whole design
 * decision here. "status: lead → active" is readable at a glance; two JSON
 * objects to compare by eye is technically the same information and practically
 * useless.
 */

const ENTITIES = ['customer', 'product', 'order', 'user'];
const ACTIONS = ['create', 'update', 'delete', 'export', 'import', 'login', 'login_failed', 'logout'];

/** Colour by action, so a page of entries is scannable without reading it. */
const ACTION_STYLES = {
  create: 'bg-good-wash text-good-ink',
  update: 'bg-brand-wash text-brand-ink',
  delete: 'bg-critical-wash text-critical-ink',
  export: 'bg-neutral-wash text-neutral-ink',
  import: 'bg-good-wash text-good-ink',
  login: 'bg-neutral-wash text-neutral-ink',
  login_failed: 'bg-critical-wash text-critical-ink',
  logout: 'bg-neutral-wash text-neutral-ink',
};

function ActionBadge({ action }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        ACTION_STYLES[action] || 'bg-neutral-wash text-neutral-ink'
      }`}
    >
      {/* A dot plus the word, like every other pill in the app: identity is
          never carried by colour alone. */}
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {humanize(action)}
    </span>
  );
}

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Initials disc; hidden from screen readers since the name follows it. */
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

/**
 * Render one changed value.
 *
 * Objects and arrays are stringified rather than rendered structurally: a
 * change to an order's `items` is genuinely a nested value, and a compact JSON
 * string is more honest than a half-rendered tree that hides part of it.
 */
function Value({ value }) {
  if (value === null || value === undefined || value === '') {
    return <span className="italic text-muted">empty</span>;
  }
  if (typeof value === 'object') {
    return <code className="text-xs">{JSON.stringify(value)}</code>;
  }
  return <span>{String(value)}</span>;
}

function ChangeList({ log }) {
  if (log.action === 'create') {
    return <p className="text-sm text-ink-2">Record created.</p>;
  }
  if (log.action === 'delete') {
    return (
      <div className="text-sm text-ink-2">
        <p className="mb-2">Record deleted. Its final state:</p>
        <pre className="overflow-x-auto rounded-md border border-hairline bg-surface p-3 text-xs">
          {JSON.stringify(log.before, null, 2)}
        </pre>
      </div>
    );
  }
  /*
   * These five never carry a before/after diff — none of them changes a
   * record, so "no field values changed" would be technically true and
   * genuinely confusing. See models/AuditLog.js for why they exist in this
   * collection at all despite not being writes.
   */
  if (log.action === 'login') {
    return <p className="text-sm text-ink-2">Signed in.</p>;
  }
  if (log.action === 'login_failed') {
    return <p className="text-sm text-critical-ink">A sign-in attempt used the wrong password.</p>;
  }
  if (log.action === 'logout') {
    return <p className="text-sm text-ink-2">Signed out.</p>;
  }
  if (log.action === 'export') {
    return <p className="text-sm text-ink-2">{log.note || 'Data exported.'}</p>;
  }
  if (log.action === 'import') {
    return <p className="text-sm text-ink-2">{log.note || 'Data imported.'}</p>;
  }
  if (!log.changes?.length) {
    return <p className="text-sm text-muted">No field values changed.</p>;
  }

  return (
    <ul className="space-y-1.5 text-sm">
      {log.changes.map((change) => (
        <li key={change.field} className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-ink">{humanize(change.field)}</span>
          <span className="text-ink-2">
            <Value value={change.from} />
          </span>
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          <span className="font-medium text-ink">
            <Value value={change.to} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function AuditLog() {
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  // Which row is expanded. One at a time — the diffs are tall, and several open
  // at once turns the page into a wall.
  const [expanded, setExpanded] = useState(null);

  const { data, loading, error } = useFetch(
    () => auditApi.list({ page, limit: 25, entity: entity || undefined, action: action || undefined }),
    [page, entity, action]
  );

  const isFiltered = Boolean(entity || action);

  /** Any filter change invalidates the current page number. */
  function changeFilter(setter) {
    return (event) => {
      setter(event.target.value);
      setPage(1);
      setExpanded(null);
    };
  }

  function clearFilters() {
    setEntity('');
    setAction('');
    setPage(1);
    setExpanded(null);
  }

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Audit log"
        subtitle="Every change made to customers, products, orders and users — who made it, and what it was before."
      />

      <ErrorBanner message={error} />

      <AuditDigestCard entity={entity} action={action} />

      <Card>
        {/* The filters sit inside the card with the table they narrow, rather
            than in a panel of their own — a control and the thing it changes
            belong in the same box. */}
        <div className="flex flex-col gap-3 border-b border-hairline p-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 flex-wrap items-center gap-3">
            <label className="min-w-[9rem] flex-1 sm:flex-none">
              <span className="label-mono mb-1.5 block">Record type</span>
              <Select className="sm:w-44" value={entity} onChange={changeFilter(setEntity)}>
                <option value="">All types</option>
                {ENTITIES.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </Select>
            </label>

            <label className="min-w-[9rem] flex-1 sm:flex-none">
              <span className="label-mono mb-1.5 block">Action</span>
              <Select className="sm:w-44" value={action} onChange={changeFilter(setAction)}>
                <option value="">All actions</option>
                {ACTIONS.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          {isFiltered && (
            <Button variant="ghost" size="sm" className="self-start sm:self-end" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>

        {loading ? (
          // A skeleton shaped like the table, matching the other three lists —
          // the rows land in place instead of the layout jumping.
          <TableSkeleton rows={6} columns={5} />
        ) : !data?.data?.length ? (
          /*
           * Filter-aware, like the other lists. This page HAS entity and action
           * filters, so a flat "no activity recorded" would tell an admin the
           * log is empty when they have simply narrowed it to a type nothing
           * has been written to yet.
           */
          <ListEmptyState
            filtered={isFiltered}
            entity="audit entries"
            onClear={clearFilters}
          />
        ) : (
          <Table caption="Audit entries: when, who, what action, and on which record">
            <thead className="bg-sunken">
              <tr className="border-b border-hairline">
                <th className={th}>When</th>
                <th className={th}>Who</th>
                <th className={th}>Action</th>
                <th className={th}>Record</th>
                <th className={`${th} text-right`}>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {data.data.map((log) => {
                const open = expanded === log._id;

                return (
                  <Fragment key={log._id}>
                    <tr className={`transition-colors ${open ? 'bg-sunken/60' : 'hover:bg-sunken/60'}`}>
                      <td className={`${td} whitespace-nowrap tabular`}>
                        {formatDate(log.createdAt)}
                      </td>
                      <td className={td}>
                        <div className="flex items-center gap-3">
                          {/* The snapshotted name, not a lookup — it still reads
                              correctly after the account is deleted. */}
                          <Avatar name={log.actor?.name} />
                          <div className="min-w-0">
                            <p className="font-medium text-ink">{log.actor?.name || 'Unknown'}</p>
                            <p className="truncate text-xs text-muted">
                              {humanize(log.actor?.role || '')}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className={td}>
                        <ActionBadge action={log.action} />
                      </td>
                      <td className={td}>
                        <span className="font-medium text-ink">{humanize(log.entity)}</span>
                        {log.entityLabel && (
                          <span className="ml-1.5 text-ink-2">{log.entityLabel}</span>
                        )}
                      </td>
                      <td className={`${td} text-right`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : log._id)}
                        >
                          {open ? 'Hide' : 'Details'}
                        </Button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-plane">
                        <td colSpan={5} className="px-4 py-4">
                          <ChangeList log={log} />
                          <p className="mt-3 text-xs text-muted">
                            {log.method} {log.path} · from {log.ip || 'unknown address'}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}

        {data?.pages > 1 && (
          <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
        )}
      </Card>
    </div>
  );
}

/**
 * A plain-English summary of the range currently on screen.
 *
 * Re-fetches whenever the filters change, and passes those same filters to the
 * endpoint — the digest and the table below it always describe the same rows.
 * Deliberately NOT paged: it summarises the whole filtered range, not the 25
 * entries on this page, which is the question someone actually has when they
 * narrow an audit log to "deletions this week".
 */
function AuditDigestCard({ entity, action }) {
  const { data, loading, error } = useFetch(
    () => auditApi.digest({ entity: entity || undefined, action: action || undefined }),
    [entity, action]
  );

  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="label-mono">Summary</p>
          <h2 className="mt-1 text-sm font-semibold text-ink">What happened in this range</h2>
        </div>
        {data && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              data.mode === 'ai' ? 'bg-good-wash text-good-ink' : 'bg-warning-wash text-warning-ink'
            }`}
          >
            {data.mode === 'ai' ? 'AI summary' : 'Counted summary'}
          </span>
        )}
      </div>

      {loading && <CardSkeleton lines={2} />}
      <ErrorBanner message={error} />

      {data && <p className="mt-2 text-sm text-ink-2">{data.narrative}</p>}
    </Card>
  );
}
