import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { campaignsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import {
  Breadcrumb,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
  Table,
  Tabs,
} from '../../components/common';
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_STYLES,
  RECIPIENT_STATUS_LABELS,
  formatDateTime,
  td,
  th,
} from '../../ui';

/**
 * One campaign: what it says, who it reached, and what happened to each of
 * them.
 *
 * THE RECIPIENT TABLE IS THE FEATURE, not the counts above it. "Sent to 40"
 * cannot answer "did Ayesha get it", and that is the question somebody always
 * asks — usually the day after, usually about the one person who matters. Every
 * contact in the audience has a row, including the ones who were skipped for
 * lack of consent, so the numbers add up and nothing is unexplained.
 *
 * SENT AND SKIPPED-FOR-NO-CONSENT MUST NOT LOOK ALIKE.
 *
 * They were previously three words in three different colours, in a column of
 * fifty rows, which is exactly the presentation that lets somebody scan the
 * table and conclude the whole audience was messaged. They are now separate
 * pills with their own icon, AND the table can be filtered down to one outcome
 * at a time — because the useful question is almost never "show me everyone",
 * it is "show me the ones who did not get it". The filter is client-side over
 * rows already fetched; it asks the server nothing.
 */

/** The outcome pill, per recipient. Icon + word + colour, never colour alone. */
const OUTCOME_STYLES = {
  sent: {
    className: 'bg-good-wash text-good-ink ring-good/20',
    // A tick.
    path: 'M10 2a8 8 0 100 16 8 8 0 000-16zm4 6.2l-4.7 4.7a1 1 0 01-1.42 0L6 11.02l1.42-1.42 1.17 1.18 4-4L14 8.2z',
  },
  skipped_no_consent: {
    className: 'bg-warning-wash text-warning-ink ring-warning/25',
    // A barred circle — refused, not failed.
    path: 'M10 2a8 8 0 100 16 8 8 0 000-16zM4.9 6.3L13.7 15A6 6 0 014.9 6.3zm1.4-1.4a6 6 0 018.8 8.8z',
  },
  failed: {
    className: 'bg-critical-wash text-critical-ink ring-critical/20',
    path: 'M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z',
  },
  pending: {
    className: 'bg-neutral-wash text-neutral-ink ring-rule/40',
    path: 'M10 2a8 8 0 100 16 8 8 0 000-16zm1 4v4.2l3 1.8-.8 1.3-3.7-2.2V6z',
  },
};

function OutcomeBadge({ status }) {
  const style = OUTCOME_STYLES[status] || OUTCOME_STYLES.pending;

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${style.className}`}
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 fill-current" aria-hidden="true">
        <path d={style.path} />
      </svg>
      {RECIPIENT_STATUS_LABELS[status] || status}
    </span>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const toast = useToast();

  const { data, loading, error, reload } = useFetch(() => campaignsApi.get(id), [id]);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [outcome, setOutcome] = useState('all');

  const campaign = data?.campaign;
  const recipients = useMemo(() => data?.recipients || [], [data]);

  /** Row counts per outcome, for the filter tabs. */
  const counts = useMemo(() => {
    const tally = { all: recipients.length, sent: 0, skipped_no_consent: 0, failed: 0, pending: 0 };
    recipients.forEach((recipient) => {
      if (tally[recipient.status] !== undefined) tally[recipient.status] += 1;
    });
    return tally;
  }, [recipients]);

  const shown =
    outcome === 'all' ? recipients : recipients.filter((r) => r.status === outcome);

  async function handleSend() {
    setSending(true);

    try {
      const result = await campaignsApi.send(id);

      /*
       * `queued` decides the message, and getting this wrong is the whole
       * reason the flag exists. A manager whose campaign went to the approval
       * queue and who was told "Campaign sent" would believe it had gone out.
       */
      if (result.queued) {
        toast.info(
          `Sent to an administrator for approval — ${result.outsideScope} contacts are outside your own.`
        );
      } else {
        const sent = result.data?.sentCount ?? 0;
        const skipped = result.data?.skippedNoConsentCount ?? 0;
        toast.success(
          `Sent to ${sent} contact${sent === 1 ? '' : 's'}` +
            (skipped ? ` — ${skipped} skipped for lack of opt-in.` : '.')
        );
      }

      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the campaign'));
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);

    try {
      await campaignsApi.remove(id);
      toast.success('Draft deleted');
      window.history.back();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the draft'));
      setDeleting(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!campaign) return null;

  // DRAFT ONLY. Editing, sending and deleting all live behind this one flag,
  // mirroring the backend's own guard — a campaign that has sent is a record
  // of something that happened, and a queued one is somebody else's decision.
  const sendable = campaign.status === 'draft';

  const bodyForChannel =
    campaign.channel === 'email'
      ? campaign.content.body
      : campaign.channel === 'sms'
        ? campaign.content.sms || campaign.content.body
        : campaign.content.whatsapp || campaign.content.body;

  return (
    <div>
      <Breadcrumb
        className="mb-4"
        items={[{ label: 'Campaigns', to: '/crm/campaigns' }, { label: campaign.name }]}
      />

      <PageHeader
        eyebrow="Marketing"
        title={campaign.name}
        subtitle={campaign.goal}
        action={
          sendable && (
            <>
              <ButtonLink to={`/crm/campaigns/${id}/edit`} variant="secondary">
                Edit
              </ButtonLink>
              <Button onClick={handleSend} loading={sending} loadingLabel="Sending…">
                Send campaign
              </Button>
            </>
          )
        }
      />

      <div className="space-y-5">
        {/* --- summary ------------------------------------------------------ */}
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${
                CAMPAIGN_STATUS_STYLES[campaign.status]
              }`}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
              {CAMPAIGN_STATUS_LABELS[campaign.status]}
            </span>
            <span className="text-sm capitalize text-ink-2">{campaign.channel}</span>
            {campaign.sentAt && (
              <span className="text-sm text-muted">Sent {formatDateTime(campaign.sentAt)}</span>
            )}
          </div>

          {campaign.status === 'pending_approval' && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-wash px-3 py-2.5 text-sm text-warning-ink">
              <Dot />
              <span>
                Waiting for an administrator. It reaches contacts outside your own, so it needs
                approving before it goes. <strong className="font-semibold">Nothing has been
                sent.</strong>
              </span>
            </p>
          )}

          {campaign.status === 'failed' && campaign.failureReason && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-critical/25 bg-critical-wash px-3 py-2.5 text-sm text-critical-ink">
              <Dot />
              <span>{campaign.failureReason}</span>
            </p>
          )}

          {campaign.status === 'sent' && (
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Audience" value={campaign.audienceCount} />
              <Stat label="Delivered" value={campaign.sentCount} tone="good" />
              {/*
                The skipped count is shown ALWAYS when the campaign has sent,
                including when it is zero. A number that only appears when it is
                non-zero teaches people that its absence means "not measured".
              */}
              <Stat
                label="No opt-in"
                value={campaign.skippedNoConsentCount}
                tone={campaign.skippedNoConsentCount ? 'warn' : 'plain'}
              />
              <Stat
                label="Failed"
                value={campaign.failureCount}
                tone={campaign.failureCount ? 'bad' : 'plain'}
              />
            </div>
          )}

          {campaign.status === 'sent' && campaign.skippedNoConsentCount > 0 && (
            <p className="mt-3 text-xs text-muted">
              The {campaign.skippedNoConsentCount} contact
              {campaign.skippedNoConsentCount === 1 ? '' : 's'} marked{' '}
              <span className="font-medium text-warning-ink">no opt-in</span> were never messaged
              — this is a consent gap, not a delivery failure. Collect their consent and they are
              reachable next time.
            </p>
          )}
        </Card>

        {/* --- the copy ------------------------------------------------------ */}
        <Card className="p-5">
          <h2 className="label-mono">The message</h2>

          {campaign.content.subject && (
            <p className="mt-3 text-sm font-semibold text-ink">{campaign.content.subject}</p>
          )}

          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
            {bodyForChannel}
          </p>

          {campaign.content.socialPost && (
            <div className="mt-4 rounded-md border border-hairline bg-plane p-4">
              <p className="label-mono">Social post — copy and paste</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">
                {campaign.content.socialPost}
              </p>
            </div>
          )}
        </Card>

        {/* --- per-recipient outcomes ---------------------------------------- */}
        {recipients.length > 0 && (
          <Card className="overflow-hidden">
            {/* The Tabs component carries its own bottom rule, so this header
                does not add a second one directly above it. */}
            <div className="px-5 pt-4">
              <h2 className="text-sm font-semibold text-ink">
                Recipients <span className="tabular text-muted">({recipients.length})</span>
              </h2>
              <p className="mt-1 text-xs text-muted">
                Every contact in the audience, including the ones nothing was sent to.
              </p>

              <Tabs
                className="mt-3"
                value={outcome}
                onChange={setOutcome}
                tabs={[
                  { value: 'all', label: 'All', count: counts.all },
                  { value: 'sent', label: 'Sent', count: counts.sent },
                  {
                    value: 'skipped_no_consent',
                    label: 'No opt-in',
                    count: counts.skipped_no_consent,
                  },
                  { value: 'failed', label: 'Failed', count: counts.failed },
                ]}
              />
            </div>

            {shown.length === 0 ? (
              <EmptyState
                title="Nothing in this outcome"
                hint="No recipient of this campaign ended up here — which, for the failure tabs, is the good answer."
              />
            ) : (
              <Table caption="Campaign recipients and what happened to each">
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th} scope="col">
                      Contact
                    </th>
                    <th className={th} scope="col">
                      Outcome
                    </th>
                    <th className={th} scope="col">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {shown.map((recipient) => (
                    <tr
                      key={recipient._id}
                      /*
                        A tint on the whole row, not just the pill. Fifty rows
                        of near-identical text is exactly where a single
                        coloured word stops being noticed, and the rows that
                        got nothing are the ones somebody came here to find.
                      */
                      className={
                        recipient.status === 'skipped_no_consent'
                          ? 'bg-warning-wash/40'
                          : recipient.status === 'failed'
                            ? 'bg-critical-wash/40'
                            : undefined
                      }
                    >
                      <td className={td}>
                        <div className="font-medium text-ink">{recipient.toName || '—'}</div>
                        <div className="text-xs text-muted">{recipient.toAddress}</div>
                      </td>
                      <td className={td}>
                        <OutcomeBadge status={recipient.status} />
                      </td>
                      <td className={`${td} text-xs text-muted`}>
                        {recipient.error || recipient.transport}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}

        {/* --- draft-only destructive corner ---------------------------------- */}
        {sendable && (
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink">Before you send</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-2">
              Sending is irreversible — a campaign cannot be sent twice, and a repeat has to be a
              new campaign. While it is still a draft it can be edited or thrown away.
            </p>
            <div className="mt-4">
              <Button
                variant="danger"
                size="sm"
                onClick={handleDelete}
                loading={deleting}
                loadingLabel="Deleting…"
              >
                Delete draft
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

/** The leading marker on a banner, so meaning is not carried by colour alone. */
function Dot() {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 fill-current" aria-hidden="true">
      <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
    </svg>
  );
}

const TONES = {
  good: 'text-good-ink',
  warn: 'text-warning-ink',
  bad: 'text-critical-ink',
  plain: 'text-ink',
};

/** See the identical note on CampaignForm's Stat — same component, same reason. */
function Stat({ label, value, tone = 'plain' }) {
  return (
    <div
      role="group"
      aria-label={`${label}: ${value}`}
      className="rounded-md border border-hairline bg-plane px-3 py-2.5"
    >
      <p className="text-xs text-muted" aria-hidden="true">
        {label}
      </p>
      <p className={`tabular mt-0.5 text-xl font-semibold ${TONES[tone]}`} aria-hidden="true">
        {value}
      </p>
    </div>
  );
}
