import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { changeRequestsApi } from '../api/resources';
import { errorMessage } from '../api/client';
import useFetch from '../hooks/useFetch';
import { useToast } from '../components/Toast';
import {
  Breadcrumb,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  Spinner,
  Table,
} from '../components/common';
import { formatDate, humanize, link, money, td, th } from '../ui';

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

  // Keyed by request id: an on-demand AI sentence over that one request's
  // diff, fetched only when someone asks for it — the list can be long, and
  // nobody wants a model call fired for every row on every page load.
  const [summaries, setSummaries] = useState({});
  const [summarizingId, setSummarizingId] = useState(null);

  async function summarize(request) {
    setSummarizingId(request._id);
    try {
      const result = await changeRequestsApi.summary(request._id);
      setSummaries((s) => ({ ...s, [request._id]: result }));
      setExpanded(request._id);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not summarize this request'));
    } finally {
      setSummarizingId(null);
    }
  }

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

  const requests = data || [];

  return (
    <div>
      <Breadcrumb
        className="mb-3"
        items={[{ label: 'Workspace', to: '/crm' }, { label: 'Approvals' }]}
      />

      <PageHeader
        eyebrow="Administration"
        title="Approvals"
        subtitle="Changes to customers and orders that a manager has proposed. Nothing here has happened yet."
      />

      <ErrorBanner message={error} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)] lg:items-start">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-4">
            <div>
              <p className="label-mono">Queue</p>
              <h2 className="mt-1 text-base font-semibold text-ink">Waiting on you</h2>
            </div>
            {requests.length > 0 && (
              <p className="text-sm text-muted">
                <span className="tabular font-medium text-ink-2">{requests.length}</span>{' '}
                {requests.length === 1 ? 'request' : 'requests'}
              </p>
            )}
          </div>

          {!requests.length ? (
            <EmptyState
              title="Nothing waiting"
              hint="Proposed changes to customers and orders appear here. The queue is clear."
            />
          ) : (
            <Table caption="Change requests waiting for a decision">
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
                {requests.map((request) => {
                  const busy = busyId === request._id;
                  const isOpen = expanded === request._id;
                  const fields = Object.entries(request.payload || {});
                  const summary = summaries[request._id];

                  return (
                    /*
                      `Fragment` with a key rather than `<>`, which cannot take
                      one — the two rows belong to the same request and React
                      needs to be told so, or it warns on every render and
                      re-creates the expanded row whenever the list changes.
                    */
                    <Fragment key={request._id}>
                      <tr className="transition-colors hover:bg-plane">
                        <td className={`${td} font-medium text-ink`}>
                          {describeChange(request)}
                          <span className="mt-1 flex flex-wrap gap-3">
                            {fields.length > 0 && (
                              <button
                                type="button"
                                className={`${link} text-xs`}
                                aria-expanded={isOpen}
                                onClick={() => setExpanded(isOpen ? null : request._id)}
                              >
                                {isOpen ? 'Hide' : 'Show'} details
                              </button>
                            )}
                            <button
                              type="button"
                              className={`${link} text-xs disabled:opacity-50`}
                              disabled={summarizingId === request._id}
                              onClick={() => summarize(request)}
                            >
                              {summarizingId === request._id
                                ? 'Summarizing…'
                                : summary
                                  ? 'Re-summarize'
                                  : 'AI summary'}
                            </button>
                          </span>
                        </td>
                        <td className={td}>
                          {request.label || '—'}
                          <p className="mt-0.5 text-xs text-muted">{humanize(request.entity)}</p>
                        </td>
                        <td className={td}>
                          <span className="inline-flex items-center gap-2">
                            {request.requestedBy?.name || request.requestedBy?.email || '—'}
                            {request.requestedByModel === 'Buyer' && (
                              <span className="rounded-full bg-neutral-wash px-2 py-0.5 text-[11px] font-medium text-neutral-ink">
                                Customer request
                              </span>
                            )}
                          </span>
                          {/* A buyer has no role — the badge above already says
                              who they are, so there is nothing to humanize. */}
                          {request.requestedByModel !== 'Buyer' && (
                            <p className="mt-0.5 text-xs text-muted">
                              {humanize(request.requestedBy?.role || '')}
                            </p>
                          )}
                        </td>
                        <td className={td}>{formatDate(request.createdAt)}</td>
                        <td className={`${td} text-right`}>
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              loading={busy}
                              loadingLabel="Working…"
                              onClick={() => decide(request, true)}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              className="text-ink-2 hover:text-critical-ink"
                              onClick={() => decide(request, false)}
                            >
                              Reject
                            </Button>
                          </div>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr className="bg-plane">
                          <td className={td} colSpan={5}>
                            {summary && (
                              <div className="mb-4 rounded-xl border border-hairline bg-surface p-4">
                                <p className="label-mono">Summary</p>
                                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
                                  {summary.data.summary}
                                </p>
                                <p className="mt-2 text-xs text-muted">
                                  {summary.mode === 'ai'
                                    ? 'AI-generated from this request.'
                                    : 'Written from this request — AI summary unavailable right now.'}
                                </p>
                              </div>
                            )}

                            <p className="label-mono">What would change</p>
                            <dl className="mt-2 grid gap-x-8 gap-y-3 sm:grid-cols-2">
                              {fields.map(([field, value]) => (
                                <div key={field}>
                                  <dt className="text-xs font-medium text-muted">{field}</dt>
                                  <dd className="mt-0.5 whitespace-pre-line text-sm text-ink">
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
                            <div className="mt-5 max-w-xl">
                              <Field
                                label="Reason for rejecting"
                                id={`reject-reason-${request._id}`}
                                placeholder="Optional — it is sent to nobody automatically."
                                hint="Recorded against the decision, so the next person to look knows why."
                                value={notes[request._id] || ''}
                                onChange={(e) =>
                                  setNotes({ ...notes, [request._id]: e.target.value })
                                }
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>

        <aside className="space-y-6">
          <Card className="p-5">
            <p className="label-mono">How this works</p>
            <h2 className="mt-1 text-base font-semibold text-ink">Nothing here has happened</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Every row is a change a manager or a customer has asked for and that the system has
              deliberately not made. Approving applies it immediately and writes an audit entry
              against your name; rejecting leaves the record exactly as it is.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Open <span className="font-medium text-ink">Show details</span> before deciding — the
              row names the fields, the panel underneath shows the values they would be set to.
            </p>
          </Card>

          <Card className="p-5">
            <p className="label-mono">Elsewhere</p>
            <h2 className="mt-1 text-base font-semibold text-ink">Account requests</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              People asking for access to the CRM are a different decision, and they are answered
              on the{' '}
              <Link to="/crm/users" className={link}>
                Users
              </Link>{' '}
              page.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
