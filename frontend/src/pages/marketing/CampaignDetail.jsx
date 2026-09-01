import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { campaignsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import { Card, ErrorBanner, PageHeader, Spinner } from '../../components/common';
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_STYLES,
  RECIPIENT_STATUS_LABELS,
  btnPrimary,
  btnSecondary,
  formatDateTime,
  link,
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
 */
export default function CampaignDetail() {
  const { id } = useParams();
  const toast = useToast();

  const { data, loading, error, reload } = useFetch(() => campaignsApi.get(id), [id]);
  const [sending, setSending] = useState(false);

  const campaign = data?.campaign;
  const recipients = data?.recipients || [];

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

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!campaign) return null;

  const sendable = campaign.status === 'draft';

  return (
    <div className="space-y-5">
      <PageHeader
        title={campaign.name}
        subtitle={campaign.goal}
        action={
          sendable && (
            <button type="button" className={btnPrimary} onClick={handleSend} disabled={sending}>
              {sending ? <Spinner /> : 'Send campaign'}
            </button>
          )
        }
      />

      <Link to="/crm/campaigns" className={link}>
        ← All campaigns
      </Link>

      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
              CAMPAIGN_STATUS_STYLES[campaign.status]
            }`}
          >
            {CAMPAIGN_STATUS_LABELS[campaign.status]}
          </span>
          <span className="text-sm capitalize text-ink-2">{campaign.channel}</span>
          {campaign.sentAt && (
            <span className="text-sm text-muted">Sent {formatDateTime(campaign.sentAt)}</span>
          )}
        </div>

        {campaign.status === 'pending_approval' && (
          <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Waiting for an administrator. It reaches contacts outside your own, so it needs
            approving before it goes. Nothing has been sent.
          </p>
        )}

        {campaign.status === 'failed' && campaign.failureReason && (
          <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
            {campaign.failureReason}
          </p>
        )}

        {campaign.status === 'sent' && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-ink">The message</h2>

        {campaign.content.subject && (
          <p className="text-sm font-medium text-ink">{campaign.content.subject}</p>
        )}

        <p className="whitespace-pre-wrap text-sm text-ink-2">
          {campaign.channel === 'email'
            ? campaign.content.body
            : campaign.channel === 'sms'
              ? campaign.content.sms || campaign.content.body
              : campaign.content.whatsapp || campaign.content.body}
        </p>

        {campaign.content.socialPost && (
          <div className="rounded-lg border border-hairline bg-plane p-3">
            <p className="text-xs font-medium text-ink-2">Social post — copy and paste</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">
              {campaign.content.socialPost}
            </p>
          </div>
        )}
      </Card>

      {recipients.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-hairline px-5 py-3">
            <h2 className="text-sm font-semibold text-ink">
              Recipients ({recipients.length})
            </h2>
          </div>

          <div className="max-h-96 overflow-auto">
            <table className="min-w-full divide-y divide-hairline">
              <thead className="sticky top-0 bg-plane">
                <tr>
                  <th className={th}>Contact</th>
                  <th className={th}>Outcome</th>
                  <th className={th}>Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {recipients.map((recipient) => (
                  <tr key={recipient._id}>
                    <td className={td}>
                      <div className="text-ink">{recipient.toName || '—'}</div>
                      <div className="text-xs text-muted">{recipient.toAddress}</div>
                    </td>
                    <td className={td}>
                      <span
                        className={
                          recipient.status === 'sent'
                            ? 'text-emerald-700'
                            : recipient.status === 'skipped_no_consent'
                              ? 'text-amber-700'
                              : 'text-critical'
                        }
                      >
                        {RECIPIENT_STATUS_LABELS[recipient.status]}
                      </span>
                    </td>
                    <td className={`${td} text-xs text-muted`}>
                      {recipient.error || recipient.transport}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {sendable && (
        <p className="text-xs text-muted">
          Sending is irreversible — a campaign cannot be sent twice, and a repeat has to be a new
          campaign.{' '}
          <button
            type="button"
            className={btnSecondary}
            onClick={async () => {
              try {
                await campaignsApi.remove(id);
                toast.success('Draft deleted');
                window.history.back();
              } catch (err) {
                toast.error(errorMessage(err, 'Could not delete the draft'));
              }
            }}
          >
            Delete draft
          </button>
        </p>
      )}
    </div>
  );
}

const TONES = {
  good: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-critical',
  plain: 'text-ink',
};

/** See the identical note on CampaignForm's Stat — same component, same reason. */
function Stat({ label, value, tone = 'plain' }) {
  return (
    <div
      role="group"
      aria-label={`${label}: ${value}`}
      className="rounded-lg border border-hairline bg-plane px-3 py-2"
    >
      <p className="text-xs text-muted" aria-hidden="true">
        {label}
      </p>
      <p className={`text-xl font-semibold ${TONES[tone]}`} aria-hidden="true">
        {value}
      </p>
    </div>
  );
}
