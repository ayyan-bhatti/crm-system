import { Link } from 'react-router-dom';
import { campaignsApi } from '../../api/resources';
import useFetch from '../../hooks/useFetch';
import {
  Card,
  ErrorBanner,
  EmptyState,
  PageHeader,
  TableSkeleton,
} from '../../components/common';
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_STYLES,
  btnPrimary,
  formatDate,
  link,
  td,
  th,
} from '../../ui';

/**
 * The campaign ledger.
 *
 * An admin sees every campaign; a manager sees their own. That is scoped by
 * the server, not here — a manager reading colleagues' marketing plans is not
 * something the role needs, and an admin sees a manager's through the approval
 * queue when it matters.
 *
 * THE THREE COUNTS ARE THE POINT OF THIS TABLE. "Sent 40" on its own invites
 * the question this screen exists to pre-empt: what happened to the other
 * twenty? Showing delivered, skipped-for-consent and failed side by side makes
 * a consent gap read as a consent gap rather than a broken send.
 */
export default function CampaignList() {
  const { data, loading, error } = useFetch(() => campaignsApi.list(), []);

  const campaigns = data?.data || [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Campaigns"
        subtitle="Email, SMS and WhatsApp sends. Nothing goes out to anyone who has not opted in."
        action={
          <Link to="/crm/campaigns/new" className={btnPrimary}>
            New campaign
          </Link>
        }
      />

      <ErrorBanner message={error} />

      {loading && <TableSkeleton rows={5} columns={5} />}

      {!loading && !campaigns.length && (
        <EmptyState
          title="No campaigns yet"
          hint="Pick an audience, let the AI draft the copy, and review it before anything is sent."
          action={
            <Link to="/crm/campaigns/new" className={btnPrimary}>
              New campaign
            </Link>
          }
        />
      )}

      {!loading && campaigns.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-hairline">
              <thead className="bg-plane">
                <tr>
                  <th className={th}>Campaign</th>
                  <th className={th}>Channel</th>
                  <th className={th}>Status</th>
                  <th className={th}>Outcome</th>
                  <th className={th}>Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {campaigns.map((campaign) => (
                  <tr key={campaign._id} className="hover:bg-neutral-wash">
                    <td className={td}>
                      <Link to={`/crm/campaigns/${campaign._id}`} className={link}>
                        {campaign.name}
                      </Link>
                      {campaign.goal && (
                        <p className="mt-0.5 max-w-md truncate text-xs text-muted">
                          {campaign.goal}
                        </p>
                      )}
                    </td>

                    <td className={`${td} capitalize`}>{campaign.channel}</td>

                    <td className={td}>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${
                          CAMPAIGN_STATUS_STYLES[campaign.status]
                        }`}
                      >
                        {CAMPAIGN_STATUS_LABELS[campaign.status]}
                      </span>
                    </td>

                    <td className={td}>
                      {campaign.status === 'sent' ? (
                        <span className="text-xs">
                          <strong className="text-ink">{campaign.sentCount}</strong> sent
                          {campaign.skippedNoConsentCount > 0 && (
                            <>
                              {' · '}
                              <span className="text-amber-700">
                                {campaign.skippedNoConsentCount} no opt-in
                              </span>
                            </>
                          )}
                          {campaign.failureCount > 0 && (
                            <>
                              {' · '}
                              <span className="text-critical">{campaign.failureCount} failed</span>
                            </>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>

                    <td className={td}>{formatDate(campaign.createdAt)}</td>
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
