import { customersApi } from '../api/resources';
import useFetch from '../hooks/useFetch';
import { Card, ErrorBanner, Skeleton } from './common';
import { formatDate, humanize, money } from '../ui';

/**
 * The AI account summary on the customer detail screen.
 *
 * TWO DESIGN DECISIONS WORTH POINTING AT
 *
 * 1. The FIGURES and the NARRATIVE are visually separate, because they have
 *    different provenance. The numbers are computed from the database and are
 *    exactly right; the paragraph is generated and is an interpretation. Laying
 *    them out as one block would invite a reader to trust both equally.
 *
 * 2. When the model is unavailable the card still renders, with the same
 *    figures and plainer wording, labelled as such. It never shows an error —
 *    the data is not missing, only the prose. Silently showing templated text
 *    as though a model wrote it would be the easy option and the wrong one.
 */

const TREND_LABELS = {
  rising: { text: 'Growing', className: 'bg-good-wash text-good-ink' },
  steady: { text: 'Steady', className: 'bg-brand-wash text-brand-ink' },
  declining: { text: 'Declining', className: 'bg-critical-wash text-critical-ink' },
  new: { text: 'New', className: 'bg-brand-wash text-brand-ink' },
  dormant: { text: 'Dormant', className: 'bg-warning-wash text-warning-ink' },
  no_orders: { text: 'No orders', className: 'bg-neutral-wash text-neutral-ink' },
};

function Metric({ label, value }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

export default function CustomerSummaryCard({ customerId }) {
  const { data, loading, error } = useFetch(
    () => customersApi.summary(customerId),
    [customerId]
  );

  if (loading) {
    return (
      <Card className="p-5">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
        <Skeleton className="h-16" />
      </Card>
    );
  }

  // The whole card is optional context, so a failure here should not take over
  // the page the user actually came to see.
  if (error) return <ErrorBanner message={`Could not load the account summary: ${error}`} />;
  if (!data) return null;

  const { metrics, summary, mode } = data;
  const trend = TREND_LABELS[metrics.trend] || TREND_LABELS.no_orders;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Account summary</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${trend.className}`}>
          {trend.text}
        </span>
      </div>

      {/* Computed from the database — exact. */}
      <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Orders" value={metrics.orderCount} />
        <Metric label="Revenue" value={money(metrics.totalRevenue)} />
        <Metric label="Avg order" value={money(metrics.averageOrderValue)} />
        <Metric
          label="Last order"
          value={metrics.lastOrderDate ? formatDate(metrics.lastOrderDate) : '—'}
        />
      </div>

      {/* Generated — an interpretation, kept visually distinct from the above. */}
      <div className="rounded-lg border border-hairline bg-plane p-4">
        <p className="text-sm font-semibold text-ink">{summary.headline}</p>
        <p className="mt-1.5 text-sm text-ink-2">{summary.summary}</p>

        {summary.recommendedAction && (
          <p className="mt-3 text-sm text-ink">
            <span className="font-medium">Suggested next step: </span>
            {summary.recommendedAction}
          </p>
        )}

        <p className="mt-3 text-xs text-muted">
          {mode === 'ai'
            ? `AI-generated from the figures above · ${humanize(summary.confidence)} confidence`
            : 'Written from the figures above — AI summary unavailable right now'}
        </p>
      </div>
    </Card>
  );
}
