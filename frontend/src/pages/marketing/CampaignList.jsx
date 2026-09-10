import { Link } from 'react-router-dom';
import { campaignsApi } from '../../api/resources';
import useFetch from '../../hooks/useFetch';
import {
  ButtonLink,
  Card,
  ErrorBanner,
  EmptyState,
  PageHeader,
  Table,
  TableSkeleton,
} from '../../components/common';
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_STYLES,
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
    <div>
      <PageHeader
        eyebrow="Marketing"
        title="Campaigns"
        subtitle="Email, SMS and WhatsApp sends. Nothing goes out to anyone who has not opted in."
        action={<ButtonLink to="/crm/campaigns/new">New campaign</ButtonLink>}
      />

      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        {loading && <TableSkeleton rows={5} columns={6} />}

        {!loading && !campaigns.length && (
          <EmptyState
            title="No campaigns yet"
            hint="Pick an audience, let the AI draft the copy, and review it before anything is sent."
            action={
              <ButtonLink to="/crm/campaigns/new" variant="secondary">
                New campaign
              </ButtonLink>
            }
          />
        )}

        {!loading && campaigns.length > 0 && (
          <Table caption="Campaigns">
            <thead className="border-b border-hairline bg-plane">
              <tr>
                <th className={th} scope="col">
                  Campaign
                </th>
                <th className={th} scope="col">
                  Channel
                </th>
                <th className={th} scope="col">
                  Status
                </th>
                <th className={th} scope="col">
                  Audience
                </th>
                <th className={th} scope="col">
                  Outcome
                </th>
                <th className={th} scope="col">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {campaigns.map((campaign) => (
                <tr key={campaign._id} className="transition-colors hover:bg-sunken">
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
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${
                        CAMPAIGN_STATUS_STYLES[campaign.status]
                      }`}
                    >
                      {/* A dot as well as the word, so the state never rests
                          on colour alone. */}
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-current opacity-70"
                      />
                      {CAMPAIGN_STATUS_LABELS[campaign.status]}
                    </span>
                  </td>

                  <td className={`${td} tabular`}>
                    {campaign.audienceCount ? (
                      <span className="font-medium text-ink">{campaign.audienceCount}</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>

                  <td className={td}>
                    {campaign.status === 'sent' ? (
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="tabular">
                          <strong className="font-semibold text-good-ink">
                            {campaign.sentCount}
                          </strong>{' '}
                          <span className="text-ink-2">sent</span>
                        </span>
                        {campaign.skippedNoConsentCount > 0 && (
                          <span className="tabular rounded bg-warning-wash px-1.5 py-0.5 font-medium text-warning-ink">
                            {campaign.skippedNoConsentCount} no opt-in
                          </span>
                        )}
                        {campaign.failureCount > 0 && (
                          <span className="tabular rounded bg-critical-wash px-1.5 py-0.5 font-medium text-critical-ink">
                            {campaign.failureCount} failed
                          </span>
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
          </Table>
        )}
      </Card>
    </div>
  );
}
