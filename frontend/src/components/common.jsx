import { cloneElement, useId } from 'react';
import { card, btnSecondary, input, label as labelClass, STATUS_STYLES, humanize } from '../ui';

/**
 * The small presentational pieces used across every screen.
 *
 * They share a file because each is only a few lines — splitting them into
 * eight files would add navigation cost without adding clarity.
 */

/** Loading indicator. `full` centres it in the page for first loads. */
export function Spinner({ full = false }) {
  const dot = (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-rule border-t-brand" />
  );

  if (!full) return dot;

  return (
    <div className="flex min-h-64 items-center justify-center" role="status" aria-label="Loading">
      {dot}
    </div>
  );
}

/**
 * A placeholder shaped like the content it replaces, so the layout does not
 * jump when data lands.
 */
export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-neutral-wash ${className}`} />;
}

/**
 * A skeleton shaped like the table it is standing in for.
 *
 * WHY THIS RATHER THAN A SPINNER
 *
 * A centred spinner tells the user "wait" and nothing else. A skeleton tells
 * them what is coming and roughly how much of it, so the screen does not
 * rearrange itself when the data lands — that jump is what makes a fast page
 * feel unfinished, and it is worse than the wait it replaced.
 *
 * It reserves the real layout, so the content appears IN PLACE rather than
 * pushing everything down. Matching the column count matters for the same
 * reason: a three-column skeleton followed by a six-column table is its own
 * small lurch.
 */
export function TableSkeleton({ rows = 5, columns = 4 }) {
  return (
    <div className="px-4 py-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b border-hairline py-3 last:border-0"
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              // The first column is usually a name and the widest; varying the
              // rest slightly stops the block reading as a solid grey rectangle.
              className={`h-4 ${columnIndex === 0 ? 'flex-[2]' : 'flex-1'} ${
                columnIndex % 2 ? 'opacity-70' : ''
              }`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The loading state for a card of figures — the dashboard tiles, the customer
 * summary. Same reasoning as TableSkeleton.
 */
export function CardSkeleton({ lines = 3 }) {
  return (
    <div className="space-y-3 p-5" aria-hidden="true">
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={`h-4 ${index === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/**
 * The state a list is in when it has nothing to show, told apart properly.
 *
 * "No customers" and "no customers MATCHING THIS SEARCH" are different
 * situations needing different responses, and showing the first when the second
 * is true is a real usability failure: the user concludes the database is empty
 * and stops looking, when in fact they have a filter applied that they may have
 * forgotten about.
 */
export function ListEmptyState({ filtered, entity, onClear, action }) {
  if (filtered) {
    return (
      <EmptyState
        title={`No ${entity} match your filters`}
        hint="Try a different search, or clear the filters to see everything."
        action={
          onClear ? (
            <button type="button" className={btnSecondary} onClick={onClear}>
              Clear filters
            </button>
          ) : null
        }
      />
    );
  }

  return (
    <EmptyState
      title={`No ${entity} yet`}
      hint={`They will appear here once the first one is added.`}
      action={action}
    />
  );
}

/** Red banner for a failed request. Renders nothing when there is no message. */
export function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-critical/25 bg-critical-wash px-4 py-3 text-sm text-critical-ink">
      <span className="flex items-start gap-2">
        {/* Icon + text, so the meaning never rests on the colour alone. */}
        <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 fill-current" aria-hidden="true">
          <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
        </svg>
        {message}
      </span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="font-medium hover:underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Green banner for a successful action. */
export function SuccessBanner({ message }) {
  if (!message) return null;

  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-good/25 bg-good-wash px-4 py-3 text-sm text-good-ink">
      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-current" aria-hidden="true">
        <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm4 6.2l-4.7 4.7a1 1 0 01-1.42 0L6 11.02l1.42-1.42 1.17 1.18 4-4L14 8.2z" />
      </svg>
      {message}
    </div>
  );
}

/** Shown in place of a table when a query returns nothing. */
export function EmptyState({ title = 'Nothing here yet', hint, action }) {
  return (
    <div className="px-4 py-14 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-neutral-wash">
        <svg viewBox="0 0 20 20" className="h-5 w-5 fill-muted" aria-hidden="true">
          <path d="M9 2a7 7 0 105.2 11.66l3.07 3.07a1 1 0 001.42-1.42l-3.07-3.07A7 7 0 009 2zm0 2a5 5 0 110 10A5 5 0 019 4z" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-2">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Coloured pill for an enum value (customer status, order status, user role). */
export function StatusBadge({ value }) {
  if (!value) return <span className="text-muted">—</span>;

  const style = STATUS_STYLES[value] || 'bg-neutral-wash text-neutral-ink';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${style}`}
    >
      {/* A dot plus the word: identity is never colour-only. */}
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {humanize(value)}
    </span>
  );
}

/** Page heading with an optional action on the right. */
export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A labelled form control. `children` lets a caller swap in a select or textarea.
 *
 * THE LABEL IS PROGRAMMATICALLY ASSOCIATED WITH THE CONTROL.
 *
 * It previously rendered a bare `<label>` next to the input with no `htmlFor`
 * and no nesting. It LOOKED correct — the text sits above the field — but
 * nothing connected the two, which meant:
 *
 *   - a screen reader announced the input as unlabelled
 *   - clicking the label did not focus the field
 *   - `getByLabelText` could not find it, which is how this was noticed
 *
 * The last one is the least important and the reason it was caught: a test
 * written the way a user interacts with the page fails on markup a user with a
 * screen reader could not use either. Generating the id here rather than asking
 * every caller for one means no form can forget it.
 *
 * `hint` and `error` are wired to `aria-describedby`, so the requirement or the
 * failure is announced with the field rather than being visual-only.
 *
 * `required`, when passed, marks the field two ways at once — an asterisk
 * AND the word "Required" in the label, plus `aria-required` on the control.
 * Colour or the asterisk alone is not enough: a screen reader user gets
 * nothing from a symbol with no accessible name, and a colourblind user
 * cannot rely on colour alone either. Both together is what the WCAG
 * guidance actually asks for, not decoration.
 */
export function Field({ label, error, children, hint, id, required = false, ...inputProps }) {
  const generatedId = useId();
  const fieldId = id || inputProps.name || generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  const describedBy = [error ? errorId : null, hint && !error ? hintId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      <label className={labelClass} htmlFor={fieldId}>
        {label}
        {required && (
          <span className="ml-1 text-critical-ink" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (Required)</span>}
      </label>

      {children ? (
        // A caller-supplied control (select, textarea, SearchSelect) gets the
        // same id so the label still points at something real.
        cloneElement(children, {
          id: children.props.id || fieldId,
          'aria-describedby': describedBy || undefined,
          'aria-required': required || undefined,
        })
      ) : (
        <input
          className={input}
          id={fieldId}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          required={required}
          {...inputProps}
        />
      )}

      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-xs text-critical-ink">
          {error}
        </p>
      )}
    </div>
  );
}

/** Card wrapper used by every list and detail panel. */
export function Card({ children, className = '' }) {
  return <div className={`${card} ${className}`}>{children}</div>;
}

/**
 * Pagination footer.
 *
 * Deliberately just prev/next plus a position readout: page-number buttons look
 * nice but add real complexity (ellipsis logic, window sizing) for a CRM list
 * people mostly filter rather than page through.
 */
export function Pagination({ page, pages, total, onChange }) {
  if (!total) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-3">
      <p className="text-sm text-muted">
        Page <span className="font-medium text-ink-2">{page}</span> of {pages} ·{' '}
        <span className="font-medium text-ink-2">{total}</span>{' '}
        {total === 1 ? 'result' : 'results'}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className={btnSecondary}
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={btnSecondary}
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
