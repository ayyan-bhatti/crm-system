import { useState } from 'react';
import { automationApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import {
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
  TableSkeleton,
} from '../../components/common';
import {
  OUTBOUND_KIND_LABELS,
  RECIPIENT_STATUS_LABELS,
  btnSecondary,
  formatDateTime,
  input,
  td,
  th,
} from '../../ui';

/**
 * The post-sale automations: what they have sent, and whether they are still
 * running.
 *
 * ============================================================================
 * WHY THIS SCREEN EXISTS
 * ============================================================================
 *
 * A scheduled job that stops firing produces NO SIGNAL AT ALL. A broken button
 * is reported within a day; a cron that quietly stopped in March is noticed in
 * June by somebody wondering why nobody reviews anything any more. There is no
 * error, no alert, and no user to complain — the whole failure is an absence.
 *
 * So the last-run date is the headline, above the log rather than buried in
 * it. A stale date next to an empty list is the visible form of a failure that
 * otherwise has none.
 *
 * READING IS OPEN TO ANY STAFF MEMBER; CHANGING IS ADMIN ONLY. The more people
 * who can notice a date that stopped moving, the shorter the silence.
 */
export default function AutomationLog() {
  const { can } = usePermissions();
  const toast = useToast();

  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload } = useFetch(
    () => automationApi.log(kind ? { kind } : {}),
    [kind]
  );

  const messages = data?.data || [];
  const settings = data?.settings;
  const lastRuns = data?.lastRuns || {};

  async function saveSetting(patch) {
    setBusy(true);

    try {
      await automationApi.updateSettings(patch);
      toast.success('Automation settings updated');
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the settings'));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);

    try {
      const result = await automationApi.run();
      toast.success(
        `Review requests: ${result.reviewRequests.sent} sent. ` +
          `Reorder reminders: ${result.reorderReminders.sent} sent.`
      );
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not run the automations'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Post-sale automation"
        subtitle="Review requests and reorder reminders. Both respect opt-in, and neither ever sends twice for the same order."
        action={
          can.configureAutomation && (
            <button type="button" className={btnSecondary} onClick={runNow} disabled={busy}>
              {busy ? <Spinner /> : 'Run now'}
            </button>
          )
        }
      />

      <ErrorBanner message={error} />

      {/* --- is it running? -------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2">
        <JobCard
          title="Review request"
          hint={
            settings
              ? `Sent ${settings.reviewRequestDelayDays} days after an order is delivered.`
              : ''
          }
          enabled={settings?.reviewRequestEnabled}
          lastRun={lastRuns.review_request}
        />
        <JobCard
          title="Reorder reminder"
          hint="Sent as a customer approaches their own usual reorder point."
          enabled={settings?.reorderReminderEnabled}
          lastRun={lastRuns.reorder_reminder}
        />
      </div>

      {/* --- settings, admin only -------------------------------------------- */}
      {can.configureAutomation && settings && (
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-ink">Settings</h2>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.reviewRequestEnabled}
              disabled={busy}
              onChange={(e) => saveSetting({ reviewRequestEnabled: e.target.checked })}
            />
            <span className="text-sm text-ink-2">Send review requests after delivery</span>
          </label>

          <label className="block max-w-xs">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">
              Days after delivery
            </span>
            <input
              className={input}
              type="number"
              min={1}
              max={30}
              defaultValue={settings.reviewRequestDelayDays}
              disabled={busy || !settings.reviewRequestEnabled}
              /*
               * Saved on blur rather than on change. A number input fires on
               * every keystroke, so typing "12" would send a request for "1"
               * first — and "1" is a valid setting, so it would be accepted and
               * briefly become the real one.
               */
              onBlur={(e) => {
                const days = Number(e.target.value);
                if (days !== settings.reviewRequestDelayDays && days >= 1 && days <= 30) {
                  saveSetting({ reviewRequestDelayDays: days });
                }
              }}
            />
            <span className="mt-1 block text-xs text-muted">
              Long enough that they have used it, short enough that they remember buying it.
            </span>
          </label>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.reorderReminderEnabled}
              disabled={busy}
              onChange={(e) => saveSetting({ reorderReminderEnabled: e.target.checked })}
            />
            <span className="text-sm text-ink-2">Send reorder reminders</span>
          </label>
        </Card>
      )}

      {/* --- the log ---------------------------------------------------------- */}
      <div className="flex items-center gap-3">
        <label className="block">
          <span className="sr-only">Filter by kind</span>
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Both automations</option>
            <option value="review_request">Review requests</option>
            <option value="reorder_reminder">Reorder reminders</option>
          </select>
        </label>
      </div>

      {loading && <TableSkeleton rows={5} columns={4} />}

      {!loading && !messages.length && (
        <EmptyState
          title="Nothing sent yet"
          hint="Automated messages appear here once an order has been delivered long enough ago, or a customer comes up for a reorder."
        />
      )}

      {!loading && messages.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-hairline">
              <thead className="bg-plane">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Kind</th>
                  <th className={th}>Contact</th>
                  <th className={th}>Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {messages.map((message) => (
                  <tr key={message._id}>
                    <td className={td}>{formatDateTime(message.createdAt)}</td>
                    <td className={td}>
                      {OUTBOUND_KIND_LABELS[message.kind]}
                      {message.order?.orderNumber && (
                        <span className="block text-xs text-muted">
                          {message.order.orderNumber}
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      <div className="text-ink">{message.toName || '—'}</div>
                      <div className="text-xs text-muted">{message.toAddress}</div>
                    </td>
                    <td className={td}>
                      <span
                        className={
                          message.status === 'sent'
                            ? 'text-emerald-700'
                            : message.status === 'skipped_no_consent'
                              ? 'text-amber-700'
                              : 'text-critical'
                        }
                      >
                        {RECIPIENT_STATUS_LABELS[message.status]}
                      </span>
                      <span className="block text-xs text-muted">
                        {message.channel}
                        {message.transport ? ` · ${message.transport}` : ''}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * One job's state.
 *
 * "Never run" and "last ran three months ago" are printed rather than left
 * blank, because a blank reads as "we did not check". The whole point of the
 * card is to make a stopped scheduler visible.
 */
function JobCard({ title, hint, enabled, lastRun }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-xs text-muted">{hint}</p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
            enabled
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
              : 'bg-neutral-100 text-neutral-600 ring-neutral-400/20'
          }`}
        >
          {enabled ? 'On' : 'Off'}
        </span>
      </div>

      <p className="mt-3 text-sm text-ink-2">
        {lastRun ? (
          <>
            Last sent something <strong>{formatDateTime(lastRun)}</strong>
          </>
        ) : (
          'Has not sent anything yet'
        )}
      </p>
    </Card>
  );
}
