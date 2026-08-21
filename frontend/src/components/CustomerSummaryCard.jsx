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

/**
 * The health score.
 *
 * Shown WITH its breakdown, not as a bare number. A score nobody can explain is
 * a score people learn to ignore — and unlike the narrative below it, this
 * figure is computed by a formula, so the "why" is available and should be on
 * screen rather than buried in a tooltip.
 *
 * A meter rather than a chart: it is one number on a fixed 0-100 scale, and the
 * bar communicates that immediately in a way "72" alone does not.
 */
const HEALTH_STYLES = {
  healthy: { label: 'Healthy', bar: 'bg-good', text: 'text-good-ink' },
  stable: { label: 'Stable', bar: 'bg-brand', text: 'text-brand-ink' },
  at_risk: { label: 'At risk', bar: 'bg-warning', text: 'text-warning-ink' },
  dormant: { label: 'Dormant', bar: 'bg-critical', text: 'text-critical-ink' },
};

/**
 * Churn risk, shown next to the score because they answer different questions
 * and are allowed to disagree.
 *
 * A customer with forty orders who has gone quiet scores superbly on health and
 * is the most urgent call in the book. Showing only the score would hide
 * exactly the case a rep most needs to see, which is why this sits beside it
 * rather than being folded into it.
 *
 * The REASON is shown, not just the level. A flag a rep cannot interrogate is a
 * flag they learn to ignore — "they normally order every 24 days and it has
 * been 96" is checkable and actionable; "at risk" on its own is neither.
 */
const CHURN_STYLES = {
  high: {
    badge: 'bg-critical-wash text-critical-ink',
    border: 'border-critical/30',
    dot: 'bg-critical',
  },
  moderate: {
    badge: 'bg-warning-wash text-warning-ink',
    border: 'border-warning/30',
    dot: 'bg-warning',
  },
  low: { badge: 'bg-good-wash text-good-ink', border: 'border-hairline', dot: 'bg-good' },
  unknown: {
    badge: 'bg-neutral-wash text-neutral-ink',
    border: 'border-hairline',
    dot: 'bg-muted',
  },
};

function ChurnRisk({ churn }) {
  const style = CHURN_STYLES[churn.level] || CHURN_STYLES.unknown;

  return (
    <div className={`mb-5 rounded-lg border p-4 ${style.border}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Churn risk</p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.badge}`}>
          {churn.label}
        </span>
      </div>

      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
        <p className="text-sm text-ink-2">{churn.reason}</p>
      </div>
    </div>
  );
}

function HealthScore({ health }) {
  const style = HEALTH_STYLES[health.band] || HEALTH_STYLES.dormant;

  return (
    <div className="mb-5 rounded-lg border border-hairline p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Health score</p>
        <p className={`text-sm font-semibold ${style.text}`}>{style.label}</p>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-2xl font-semibold tabular-nums text-ink">{health.score}</span>
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-wash"
          role="meter"
          aria-valuenow={health.score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Customer health score"
        >
          <div
            className={`h-full rounded-full ${style.bar}`}
            style={{ width: `${health.score}%` }}
          />
        </div>
      </div>

      {/* The explanation. Recency, frequency and value, each with the actual
          figure that drove it — so "why 41?" is answerable on the page. */}
      <dl className="mt-3 grid gap-1.5 text-xs sm:grid-cols-3">
        {health.components.map((component) => (
          <div key={component.key}>
            <dt className="font-medium text-ink-2">
              {component.label}{' '}
              <span className="text-muted">({Math.round(component.weight * 100)}%)</span>
            </dt>
            <dd className="text-muted">{component.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

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

  const { metrics, health, churn, summary, mode } = data;
  const trend = TREND_LABELS[metrics.trend] || TREND_LABELS.no_orders;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Account summary</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${trend.className}`}>
          {trend.text}
        </span>
      </div>

      {health && <HealthScore health={health} />}
      {churn && <ChurnRisk churn={churn} />}

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

        <p className="mt-3 text-xs text-muted">
          {mode === 'ai'
            ? `AI-generated from the figures above · ${humanize(summary.confidence)} confidence`
            : 'Written from the figures above — AI summary unavailable right now'}
        </p>
      </div>

      {/*
        The recommended action, promoted out of the narrative.

        It was previously the third paragraph inside the grey block above,
        styled identically to the summary prose — which made the one line a rep
        is supposed to ACT on look like more description. It is the only part of
        this card that asks for a decision, so it gets its own block, its own
        label and an accent border.
      */}
      {summary.recommendedAction && (
        <div className="mt-4 rounded-lg border-l-4 border-brand bg-brand-wash px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-ink opacity-80">
            Suggested next step
          </p>
          <p className="mt-1 text-sm font-medium text-ink">{summary.recommendedAction}</p>
        </div>
      )}
    </Card>
  );
}
