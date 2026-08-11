import { useState } from 'react';
import { Link } from 'react-router-dom';
import { aiSearchApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Spinner, StatusBadge, EmptyState } from './common';
import { btnPrimary, input, money, formatDate, link } from '../ui';

/**
 * Natural-language search box, backed by POST /api/ai-search.
 *
 * The endpoint answers in one of two modes and the UI says which:
 *   "ai"       — Claude translated the question into a structured filter
 *   "fallback" — the AI path was unavailable, so this is a keyword search
 *
 * Showing the mode (and, for AI results, the filter that was actually run)
 * matters: without it a user has no way to tell a precise answer from a rough
 * one, and no way to understand why results look the way they do.
 */

const EXAMPLES = [
  'customers in Karachi with no orders in the last 30 days',
  'active customers at Acme',
  'products under $50 that are running low',
  'completed orders over $500 this month',
];

export default function AiSearchBar() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runSearch(searchText) {
    const text = searchText.trim();
    if (!text) return;

    setLoading(true);
    setError('');

    try {
      setResult(await aiSearchApi.search(text));
    } catch (err) {
      setError(errorMessage(err, 'Search failed'));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Ask a question</h2>
      <p className="mt-1 text-sm text-muted">
        Describe what you are looking for in plain English.
      </p>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(query);
        }}
      >
        <input
          className={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. customers in Karachi with no orders in the last 30 days"
          maxLength={500}
        />
        <button type="submit" className={btnPrimary} disabled={loading || !query.trim()}>
          {loading ? <Spinner /> : 'Search'}
        </button>
      </form>

      {/* Example queries double as documentation of what the endpoint can do. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="rounded-full border border-hairline px-2.5 py-1 text-xs text-ink-2 hover:bg-plane"
            onClick={() => {
              setQuery(example);
              runSearch(example);
            }}
          >
            {example}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <ErrorBanner message={error} onDismiss={() => setError('')} />
        {result && <SearchResults result={result} />}
      </div>
    </Card>
  );
}

/** Renders whichever entity came back, with a badge explaining the mode. */
function SearchResults({ result }) {
  const { mode, entity, count, data, filter, reason, terms } = result;
  const isAi = mode === 'ai';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            isAi ? 'bg-good-wash text-good-ink' : 'bg-warning-wash text-warning-ink'
          }`}
        >
          {isAi ? 'AI filter' : 'Keyword fallback'}
        </span>
        <span className="text-sm text-ink-2">
          {count} {entity}
          {count === 1 ? '' : 's'} found
        </span>
      </div>

      {/* When the AI path is unavailable, say why rather than failing silently. */}
      {!isAi && reason && (
        <p className="mb-3 text-xs text-muted">
          Showing a plain keyword search because the AI step was unavailable: {reason}
        </p>
      )}

      {/*
        The fallback strips filler words from the question, so the words it
        actually searched for are rarely the words that were typed. Showing them
        is the difference between "no results" and "no results *for this*".
      */}
      {!isAi && terms?.length > 0 && (
        <p className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Searched for:</span>
          {terms.map((term) => (
            <span key={term} className="rounded bg-neutral-wash px-1.5 py-0.5 font-medium text-ink-2">
              {term}
            </span>
          ))}
        </p>
      )}

      {/* Showing the generated filter makes the AI's interpretation reviewable. */}
      {isAi && filter && (
        <details className="mb-3">
          <summary className="cursor-pointer text-xs text-muted hover:text-ink-2">
            View the filter that was applied
          </summary>
          {/* A quiet code surface — a saturated block here would shout louder
              than the results it is explaining. */}
          <pre className="mt-2 overflow-x-auto rounded-lg border border-hairline bg-plane p-3 text-xs leading-relaxed text-ink-2">
            {JSON.stringify(filter, null, 2)}
          </pre>
        </details>
      )}

      {count === 0 ? (
        <EmptyState title="No matches" hint="Try rephrasing the question." />
      ) : (
        <ul className="divide-y divide-hairline rounded-md border border-hairline">
          {data.map((row) => (
            <li key={row._id} className="px-4 py-2.5">
              <ResultRow entity={entity} row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row, shaped by which entity the search returned. */
function ResultRow({ entity, row }) {
  if (entity === 'customer') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to={`/customers/${row._id}`} className={link}>
            {row.name}
          </Link>
          <p className="text-xs text-muted">
            {[row.company, row.city, row.email].filter(Boolean).join(' · ')}
          </p>
        </div>
        <StatusBadge value={row.status} />
      </div>
    );
  }

  if (entity === 'product') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to={`/products/${row._id}`} className={link}>
            {row.name}
          </Link>
          <p className="text-xs text-muted">
            {row.sku} · {row.category}
          </p>
        </div>
        <div className="text-right text-sm">
          <p className="font-medium text-ink">{money(row.price)}</p>
          <p className={`text-xs ${row.isLowStock ? 'text-critical-ink' : 'text-muted'}`}>
            {row.stockQty} in stock
          </p>
        </div>
      </div>
    );
  }

  // order
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <Link to={`/orders/${row._id}`} className={link}>
          {row.customer?.name || 'Order'}
        </Link>
        <p className="text-xs text-muted">{formatDate(row.createdAt)}</p>
      </div>
      <div className="flex items-center gap-3">
        <StatusBadge value={row.status} />
        <span className="text-sm font-medium text-ink">{money(row.total)}</span>
      </div>
    </div>
  );
}
