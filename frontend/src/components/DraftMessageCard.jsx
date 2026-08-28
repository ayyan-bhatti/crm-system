import { useState } from 'react';
import { customersApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Spinner } from './common';
import { btnSecondary, input } from '../ui';

/**
 * An AI-drafted follow-up email. Never sent — a starting point for a rep to
 * review and send by hand, which is why the draft itself gets no send control
 * here, only the tone that shaped it.
 *
 * Shared between the customer detail page and the order detail page, where it
 * drafts to the order's linked customer. Extracted rather than duplicated
 * because the tone list has to match `messageDraftService`'s own `TONES`
 * exactly — the backend validates against that enum, so a second copy of this
 * list is a second place for it to drift out of step.
 *
 * On-demand rather than fetched on mount: every render would otherwise be a
 * paid model call for a card most visits never use.
 */

const TONES = [
  { value: 'check-in', label: 'Check-in' },
  { value: 'upsell', label: 'Upsell' },
  { value: 'win-back', label: 'Win-back' },
];

export default function DraftMessageCard({ customerId, subtitle }) {
  const [tone, setTone] = useState('check-in');
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');

  async function handleDraft() {
    setDrafting(true);
    setError('');

    try {
      setDraft(await customersApi.draftMessage(customerId, tone));
    } catch (err) {
      setError(errorMessage(err, 'Could not draft a message'));
    } finally {
      setDrafting(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Draft a follow-up email</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>

        <div className="flex items-center gap-2">
          <select
            className={input}
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            aria-label="Message tone"
          >
            {TONES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button type="button" className={btnSecondary} onClick={handleDraft} disabled={drafting}>
            {drafting ? <Spinner /> : draft ? 'Redraft' : 'Draft'}
          </button>
        </div>
      </div>

      <ErrorBanner message={error} />

      {!draft && !drafting && !error && (
        <p className="mt-2 text-sm text-muted">
          Generates a starting point below — nothing is sent automatically.
        </p>
      )}

      {draft && (
        <div className="mt-4 rounded-lg border border-hairline bg-plane p-4">
          <p className="text-sm font-semibold text-ink">{draft.subject}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">{draft.body}</p>
          <p className="mt-3 text-xs text-muted">
            {draft.mode === 'ai'
              ? 'AI-drafted — review before sending.'
              : 'Written from a template — AI draft unavailable right now.'}
          </p>
        </div>
      )}
    </Card>
  );
}
