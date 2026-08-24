import { useState } from 'react';
import { Link } from 'react-router-dom';
import { changeRequestsApi } from '../api/resources';
import { errorMessage } from '../api/client';
import useFetch from '../hooks/useFetch';
import { useToast } from '../components/Toast';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner } from '../components/common';
import { btnPrimary, formatDate, humanize, input, link, money, td, th } from '../ui';

/**
 * Proposed changes to customers and orders, waiting on the administrator.
 *
 * WHY THIS IS ITS OWN SCREEN AND NOT A PANEL ON THE USERS PAGE.
 *
 * Account requests already have a queue there, and merging the two would put a
 * customer deletion in the same list as a colleague's signup. They are answered
 * by the same person and they are not the same decision: one is "should this
 * person have access", the other is "should this record change". An admin
 * skimming for the first would approve the second by momentum.
 *
 * WHAT THE SCREEN HAS TO MAKE OBVIOUS.
 *
 * Not that a change exists — that a change has NOT HAPPENED. Everything here is
 * waiting, and the proposer is waiting with it. So the emphasis is on what would
 * change and who asked, and the empty state says the queue is clear rather than
 * leaving a blank panel that reads as broken.
 */

/** A one-line summary of the payload, in the words of the thing being changed. */
function describeChange(request) {
  const { entity, action, payload = {} } = request;

  if (action === 'delete') return `Delete this ${entity}`;

  if (action === 'create' && entity === 'order') {
    const lines = Array.isArray(payload.items) ? payload.items.length : 0;
    return `Place a new order with ${lines} line${lines === 1 ? '' : 's'}`;
  }

  if (action === 'create') return `Add a new ${entity}`;

  /*
   * For an edit, list the fields rather than the values.
   *
   * The values are what an admin wants next, and they are shown expanded below
   * — but a row that reads "name, city" is scannable where one reading
   * "name: Karachi Textiles Ltd, city: Karachi, notes: called them on…" is not.
   */
  const fields = Object.keys(payload);
  if (!fields.length) return `Change this ${entity}`;

  return `Change ${fields.join(', ')}`;
}

/** Render one payload value in a way a human can check. */
function renderValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function Approvals() {
  const toast = useToast();
  const { data, loading, error, reload } = useFetch(() => changeRequestsApi.list(), []);

  // The row being acted on, so its buttons disable without freezing the queue.
  const [busyId, setBusyId] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [notes, setNotes] = useState({});

  async function decide(request, approved) {
    setBusyId(request._id);

    try {
      if (approved) {
        await changeRequestsApi.approve(request._id);
        toast.success('Approved, and the change has been made.');
      } else {
        await changeRequestsApi.reject(request._id, notes[request._id]);
        toast.success('Rejected. Nothing was changed.');
      }

      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not record that decision'));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Spinner full />;

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Changes to customers and orders that a manager has proposed. Nothing here has happened yet."
      />

      <ErrorBanner message={error} />

      {!data?.length ? (
        <Card>
          <EmptyState
            title="Nothing waiting"
            message="Proposed changes to customers and orders appear here. The queue is clear."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-hairline bg-plane">
                <tr>
                  <th className={th}>What</th>
                  <th className={th}>Record</th>
                  <th className={th}>Asked by</th>
                  <th className={th}>Waiting since</th>
                  <th className={`${th} text-right`}>Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.map((request) => {
                  const busy = busyId === request._id;
                  const isOpen = expanded === request._id;
                  const fields = Object.entries(request.payload || {});

                  return (
                    <>
                      <tr key={request._id} className="hover:bg-plane">
                        <td className={`${td} font-medium text-ink`}>
                          {describeChange(request)}
                          {fields.length > 0 && (
                            <button
                              type="button"
                              className={`${link} ml-2 text-xs`}
                              onClick={() => setExpanded(isOpen ? null : request._id)}
                            >
                              {isOpen ? 'Hide' : 'Show'} details
                            </button>
                          )}
                        </td>
                        <td className={td}>
                          {request.label || '—'}
                          <p className="text-xs text-muted">{humanize(request.entity)}</p>
                        </td>
                        <td className={td}>
                          {request.requestedBy?.name || '—'}
                          <p className="text-xs text-muted">
                            {humanize(request.requestedBy?.role || '')}
                          </p>
                        </td>
                        <td className={td}>{formatDate(request.createdAt)}</td>
                        <td className={`${td} text-right`}>
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              className={btnPrimary}
                              disabled={busy}
                              onClick={() => decide(request, true)}
                            >
                              {busy ? <Spinner /> : 'Approve'}
                            </button>
                            <button
                              type="button"
                              className="text-sm font-medium text-ink-2 hover:text-critical-ink hover:underline disabled:opacity-40"
                              disabled={busy}
                              onClick={() => decide(request, false)}
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr key={`${request._id}-detail`} className="bg-plane">
                          <td className={td} colSpan={5}>
                            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                              {fields.map(([field, value]) => (
                                <div key={field} className="flex gap-2">
                                  <dt className="shrink-0 font-medium text-muted">{field}</dt>
                                  <dd className="whitespace-pre-line text-ink">
                                    {field === 'total' ? money(value) : renderValue(value)}
                                  </dd>
                                </div>
                              ))}
                            </dl>

                            {/*
                              Offered rather than required. Forcing a reason
                              produces "no" and "asdf" in equal measure; leaving
                              it out entirely is how the same request comes back
                              next week.
                            */}
                            <input
                              type="text"
                              className={`${input} mt-4`}
                              placeholder="Reason for rejecting (optional, sent to nobody automatically)"
                              value={notes[request._id] || ''}
                              onChange={(e) =>
                                setNotes({ ...notes, [request._id]: e.target.value })
                              }
                            />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="mt-4 text-sm text-muted">
        Account requests are handled separately, on the{' '}
        <Link to="/users" className={link}>
          Users
        </Link>{' '}
        page.
      </p>
    </div>
  );
}
