import { useState } from 'react';
import { activityApi } from '../api/resources';
import useFetch from '../hooks/useFetch';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Spinner } from './common';
import { btnPrimary, card, formatDateTime, humanize, input } from '../ui';

/**
 * The notes timeline on a customer or an order.
 *
 * One component for both, because everything about it — ordering, authorship,
 * immutability — is identical and only the URL differs. Two components would
 * mean two places to fix the next thing.
 *
 * THERE IS NO EDIT CONTROL AND NO DELETE CONTROL.
 *
 * Not an oversight and not a later milestone. Notes are append-only: this is
 * the record of what people said about an account, and its value comes from
 * being what was actually written at the time. The screen says so in as many
 * words, because a missing button reads as unfinished software unless the
 * interface explains that the absence is the point.
 *
 * A correction is another note. That is how it works in a paper ledger, and for
 * the same reason.
 */
export default function ActivityTimeline({ entity, id, title = 'Notes' }) {
  const { data: notes, loading, error, reload } = useFetch(() => activityApi.list(entity, id), [id]);

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [summary, setSummary] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  async function summarize() {
    setSummarizing(true);
    setSummaryError('');

    try {
      const result = await activityApi.summarize(entity, id);
      setSummary({ mode: result.mode, text: result.data.summary });
    } catch (err) {
      setSummaryError(errorMessage(err, 'Could not summarize these notes'));
    } finally {
      setSummarizing(false);
    }
  }

  const trimmed = draft.trim();

  async function submit(event) {
    event.preventDefault();
    if (!trimmed || saving) return;

    setSaving(true);
    setSaveError('');

    try {
      await activityApi.add(entity, id, trimmed);
      // Cleared only after the write succeeds. Clearing optimistically loses
      // what somebody typed if the request fails, and a note is often the only
      // copy of what was just said on a call.
      setDraft('');
      reload();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="text-xs text-muted">Notes cannot be edited or removed once saved</p>
      </div>

      {/* On demand, not auto-fetched: a fresh model call on every page visit
          for a thread nobody asked to have summarized would just be spend. */}
      {notes?.length > 0 && (
        <div className="mb-5">
          <button
            type="button"
            className="text-xs font-medium text-brand hover:underline disabled:opacity-50"
            onClick={summarize}
            disabled={summarizing}
          >
            {summarizing ? 'Summarizing…' : summary ? 'Re-summarize' : 'Summarize this thread'}
          </button>

          {summaryError && <ErrorBanner message={summaryError} />}

          {summary && (
            <div className="mt-2 rounded-lg border border-hairline bg-plane p-3.5">
              <p className="text-sm text-ink-2">{summary.text}</p>
              <p className="mt-2 text-xs text-muted">
                {summary.mode === 'ai'
                  ? 'AI-generated from the notes above.'
                  : 'Written from the notes above — AI summary unavailable right now.'}
              </p>
            </div>
          )}
        </div>
      )}

      <form onSubmit={submit} className="mb-5 space-y-2">
        <label htmlFor={`note-${entity}-${id}`} className="sr-only">
          Add a note
        </label>
        <textarea
          id={`note-${entity}-${id}`}
          className={`${input} min-h-[76px] resize-y`}
          placeholder="What happened? Calls, promises, complaints — whatever the next person needs to know."
          maxLength={2000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />

        {saveError && <ErrorBanner message={saveError} onDismiss={() => setSaveError('')} />}

        <div className="flex items-center justify-between gap-3">
          {/*
           * The counter appears only as the limit comes into view. Showing
           * "0 / 2000" against an empty box invites people to treat a note as a
           * form field with a quota rather than a sentence.
           */}
          <span className="text-xs text-muted">
            {draft.length > 1800 ? `${draft.length} / 2000` : ''}
          </span>

          <button type="submit" className={btnPrimary} disabled={!trimmed || saving}>
            {saving ? <Spinner /> : 'Add note'}
          </button>
        </div>
      </form>

      {loading && <Spinner />}
      {error && <ErrorBanner message={error} />}

      {!loading && !error && notes?.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">
          Nothing recorded yet. The first note is usually the most useful one.
        </p>
      )}

      {!loading && !error && notes?.length > 0 && (
        <ol className="space-y-3">
          {notes.map((note) => (
            <li key={note._id} className={`${card} p-3.5`}>
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium text-ink">
                  {note.author?.name || 'Unknown'}
                </span>
                <span className="text-xs text-muted">{humanize(note.author?.role)}</span>
                <span className="ml-auto text-xs text-muted">
                  {formatDateTime(note.createdAt)}
                </span>
              </div>

              {/*
               * `whitespace-pre-wrap` keeps the line breaks somebody typed.
               * A note is often a list of three things, and collapsing it into
               * one paragraph makes it harder to read than it was to write.
               */}
              <p className="whitespace-pre-wrap break-words text-sm text-ink-2">{note.body}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
