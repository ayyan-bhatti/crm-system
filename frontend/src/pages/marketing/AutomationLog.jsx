import { useState } from 'react';
import { automationApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
  Table,
  TableSkeleton,
} from '../../components/common';
import {
  OUTBOUND_KIND_LABELS,
  RECIPIENT_STATUS_LABELS,
  formatDateTime,
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
 * otherwise has none — and, since a date on its own is something a reader has
 * to do arithmetic on, the card also says how long ago that was and turns the
 * card itself amber once the gap is long enough to be worth asking about.
 *
 * READING IS OPEN TO ANY STAFF MEMBER; CHANGING IS ADMIN ONLY. The more people
 * who can notice a date that stopped moving, the shorter the silence.
 */

/**
 * How many days of silence is worth flagging.
 *
 * Neither job runs on a fixed cadence — they fire when an order becomes
 * eligible, so a quiet fortnight in a small shop is normal and means nothing.
 * Fourteen days is chosen to sit beyond that ordinary quiet: long enough that
 * a healthy deployment rarely trips it, short enough that a scheduler which
 * died is noticed in weeks rather than in quarters. It is a prompt to check,
 * not an assertion that something is broken, and the card says so.
 */
const STALE_AFTER_DAYS = 14;

function daysSince(value) {
  if (!value) return null;
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

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
    <div>
      <PageHeader
        eyebrow="Marketing"
        title="Post-sale automation"
        subtitle="Review requests and reorder reminders. Both respect opt-in, and neither ever sends twice for the same order."
        action={
          can.configureAutomation && (
            <Button onClick={runNow} loading={busy} loadingLabel="Running…">
              Run now
            </Button>
          )
        }
      />

      <ErrorBanner message={error} />

      <div className="space-y-5">
        {/* --- is it running? ------------------------------------------------ */}
        <div className="grid gap-4 sm:grid-cols-2">
          <JobCard
            title="Review request"
            hint={
              settings
                ? `Sent ${settings.reviewRequestDelayDays} days after an order is delivered.`
                : 'Sent a set number of days after an order is delivered.'
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

        {/* --- settings, admin only ------------------------------------------ */}
        {can.configureAutomation && settings && (
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink">Settings</h2>
            <p className="mt-1 text-xs text-muted">
              Changes save the moment you make them. Turning a job off stops it sending; it does
              not delete anything it has already sent.
            </p>

            <div className="mt-5 space-y-5">
              <Checkbox
                label="Send review requests after delivery"
                hint="Asks the customer what they thought, once the order has had time to arrive."
                checked={settings.reviewRequestEnabled}
                disabled={busy}
                onChange={(e) => saveSetting({ reviewRequestEnabled: e.target.checked })}
              />

              <div className="max-w-xs pl-7">
                <Field
                  label="Days after delivery"
                  type="number"
                  min={1}
                  max={30}
                  defaultValue={settings.reviewRequestDelayDays}
                  disabled={busy || !settings.reviewRequestEnabled}
                  hint="Long enough that they have used it, short enough that they remember buying it."
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
              </div>

              <Checkbox
                label="Send reorder reminders"
                hint="Nudges a customer as they approach the point they usually reorder at."
                checked={settings.reorderReminderEnabled}
                disabled={busy}
                onChange={(e) => saveSetting({ reorderReminderEnabled: e.target.checked })}
              />
            </div>
          </Card>
        )}

        {/* --- the log -------------------------------------------------------- */}
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-hairline p-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Sent log</h2>
              <p className="mt-1 text-xs text-muted">
                Every automated message, whether it went out or was held back for lack of opt-in.
              </p>
            </div>

            <div className="w-full sm:w-56">
              <Field label="Show">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">Both automations</option>
                  <option value="review_request">Review requests</option>
                  <option value="reorder_reminder">Reorder reminders</option>
                </Select>
              </Field>
            </div>
          </div>

          {loading && <TableSkeleton rows={5} columns={4} />}

          {!loading && !messages.length && (
            <EmptyState
              title="Nothing sent yet"
              hint="Automated messages appear here once an order has been delivered long enough ago, or a customer comes up for a reorder."
            />
          )}

          {!loading && messages.length > 0 && (
            <Table caption="Automated messages sent">
              <thead className="border-b border-hairline bg-plane">
                <tr>
                  <th className={th} scope="col">
                    When
                  </th>
                  <th className={th} scope="col">
                    Kind
                  </th>
                  <th className={th} scope="col">
                    Contact
                  </th>
                  <th className={th} scope="col">
                    Outcome
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {messages.map((message) => (
                  <tr key={message._id} className="transition-colors hover:bg-sunken">
                    <td className={`${td} whitespace-nowrap`}>
                      {formatDateTime(message.createdAt)}
                    </td>
                    <td className={td}>
                      <span className="text-ink">{OUTBOUND_KIND_LABELS[message.kind]}</span>
                      {message.order?.orderNumber && (
                        <span className="tabular block text-xs text-muted">
                          {message.order.orderNumber}
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      <div className="font-medium text-ink">{message.toName || '—'}</div>
                      <div className="text-xs text-muted">{message.toAddress}</div>
                    </td>
                    <td className={td}>
                      <span
                        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${
                          message.status === 'sent'
                            ? 'bg-good-wash text-good-ink ring-good/20'
                            : message.status === 'skipped_no_consent'
                              ? 'bg-warning-wash text-warning-ink ring-warning/25'
                              : 'bg-critical-wash text-critical-ink ring-critical/20'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full bg-current opacity-70"
                        />
                        {RECIPIENT_STATUS_LABELS[message.status]}
                      </span>
                      <span className="mt-1 block text-xs capitalize text-muted">
                        {message.channel}
                        {message.transport ? ` · ${message.transport}` : ''}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * One job's state.
 *
 * "Never run" and "last ran three months ago" are printed rather than left
 * blank, because a blank reads as "we did not check". The whole point of the
 * card is to make a stopped scheduler visible, so a job that is switched on
 * and has said nothing for a fortnight gets the amber edge — the reader should
 * not have to subtract two dates in their head to notice.
 *
 * A job that is switched OFF is never flagged. It is silent because somebody
 * asked it to be, and colouring that as a problem is the fastest way to teach
 * people that the amber cards can be ignored.
 */
function JobCard({ title, hint, enabled, lastRun }) {
  const days = daysSince(lastRun);
  const stale = enabled && (days === null || days >= STALE_AFTER_DAYS);

  const ago =
    days === null
      ? null
      : days === 0
        ? 'today'
        : days === 1
          ? 'yesterday'
          : `${days} days ago`;

  return (
    <Card className={`p-5 ${stale ? 'border-warning/40' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <p className="mt-1 text-xs text-muted">{hint}</p>
        </div>

        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${
            enabled
              ? 'bg-good-wash text-good-ink ring-good/20'
              : 'bg-neutral-wash text-neutral-ink ring-rule/40'
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full bg-current ${enabled ? '' : 'opacity-40'}`}
          />
          {enabled ? 'On' : 'Off'}
        </span>
      </div>

      <div className="mt-4 border-t border-hairline pt-3">
        <p className="label-mono">Last sent something</p>
        {lastRun ? (
          <p className="mt-1 text-sm text-ink-2">
            <span className="font-medium text-ink">{formatDateTime(lastRun)}</span>
            {ago && <span className="text-muted"> · {ago}</span>}
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-2">Has not sent anything yet</p>
        )}
      </div>

      {stale && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-wash px-3 py-2 text-xs text-warning-ink">
          <svg viewBox="0 0 20 20" className="mt-px h-3.5 w-3.5 shrink-0 fill-current" aria-hidden="true">
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
          </svg>
          <span>
            This job is switched on but has sent nothing{' '}
            {days === null ? 'at all' : `for ${days} days`}. That can simply mean no order came
            up — or that the scheduler has stopped. Worth a look.
          </span>
        </p>
      )}
    </Card>
  );
}
