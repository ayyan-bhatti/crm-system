import { Fragment, useState } from 'react';
import { auditApi } from '../api/resources';
import useFetch from '../hooks/useFetch';
import {
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Pagination,
  Spinner,
} from '../components/common';
import { formatDate, humanize, input, td, th } from '../ui';

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
const ACTIONS = ['create', 'update', 'delete'];

/** Colour by action, so a page of entries is scannable without reading it. */
const ACTION_STYLES = {
  create: 'bg-good-wash text-good-ink',
  update: 'bg-brand-wash text-brand-ink',
  delete: 'bg-critical-wash text-critical-ink',
};

function ActionBadge({ action }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
        ACTION_STYLES[action] || 'bg-neutral-wash text-neutral-ink'
      }`}
    >
      {action}
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
    return <span className="text-muted italic">empty</span>;
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
        <pre className="overflow-x-auto rounded-lg bg-neutral-wash p-3 text-xs">
          {JSON.stringify(log.before, null, 2)}
        </pre>
      </div>
    );
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

  /** Any filter change invalidates the current page number. */
  function changeFilter(setter) {
    return (event) => {
      setter(event.target.value);
      setPage(1);
      setExpanded(null);
    };
  }

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Every change made to customers, products, orders and users — who made it, and what it was before."
      />

      <ErrorBanner message={error} />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap gap-3">
          <label className="flex-1 min-w-[10rem]">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Record type</span>
            <select className={input} value={entity} onChange={changeFilter(setEntity)}>
              <option value="">All types</option>
              {ENTITIES.map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex-1 min-w-[10rem]">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Action</span>
            <select className={input} value={action} onChange={changeFilter(setAction)}>
              <option value="">All actions</option>
              {ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <Card>
        {loading ? (
          <div className="py-14">
            <Spinner full />
          </div>
        ) : !data?.data?.length ? (
          <EmptyState
            title="No activity recorded"
            hint="Changes to customers, products, orders and users will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Who</th>
                  <th className={th}>Action</th>
                  <th className={th}>Record</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.data.map((log) => (
                  <Fragment key={log._id}>
                    <tr>
                      <td className={`${td} whitespace-nowrap`}>{formatDate(log.createdAt)}</td>
                      <td className={td}>
                        {/* The snapshotted name, not a lookup — it still reads
                            correctly after the account is deleted. */}
                        <span className="font-medium text-ink">{log.actor?.name || 'Unknown'}</span>
                        <span className="ml-1.5 text-xs text-muted">
                          {humanize(log.actor?.role || '')}
                        </span>
                      </td>
                      <td className={td}>
                        <ActionBadge action={log.action} />
                      </td>
                      <td className={td}>
                        <span className="text-ink">{humanize(log.entity)}</span>
                        {log.entityLabel && (
                          <span className="ml-1.5 text-ink-2">{log.entityLabel}</span>
                        )}
                      </td>
                      <td className={`${td} text-right`}>
                        <button
                          type="button"
                          className="text-sm font-medium text-brand hover:underline"
                          onClick={() => setExpanded(expanded === log._id ? null : log._id)}
                        >
                          {expanded === log._id ? 'Hide' : 'Details'}
                        </button>
                      </td>
                    </tr>
                    {expanded === log._id && (
                      <tr>
                        <td colSpan={5} className="bg-plane px-4 py-4">
                          <ChangeList log={log} />
                          <p className="mt-3 text-xs text-muted">
                            {log.method} {log.path} · from {log.ip || 'unknown address'}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data?.pages > 1 && (
          <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
        )}
      </Card>
    </div>
  );
}
