import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  card,
  btn,
  btnPrimary,
  btnSecondary,
  btnGhost,
  btnDanger,
  btnSmall,
  btnLarge,
  input,
  label as labelClass,
  hintText,
  errorText,
  STATUS_STYLES,
  humanize,
} from '../ui';

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
  return <div className={`animate-skeleton rounded-md bg-sunken ${className}`} />;
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

/**
 * Page heading with an optional action on the right.
 *
 * `eyebrow` is the small tracked-out line above the title — it carries the
 * section a screen belongs to ("Commerce", "Marketing") so the title itself
 * does not have to repeat it, which is what keeps titles short.
 */
export function PageHeader({ title, subtitle, action, eyebrow }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="label-mono mb-2">{eyebrow}</p>}
        <h1 className="text-[26px] font-semibold leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-ink-2">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
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
        <p id={hintId} className={hintText}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={errorText}>
          {/* An icon beside the text, for the same reason the status pills
              carry a dot: the failure must not be signalled by red alone. */}
          <svg viewBox="0 0 20 20" className="mt-px h-3.5 w-3.5 shrink-0 fill-current" aria-hidden="true">
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
          </svg>
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

/* ===========================================================================
 * Controls
 * ======================================================================== */

const BUTTON_VARIANTS = {
  primary: btnPrimary,
  secondary: btnSecondary,
  ghost: btnGhost,
  danger: btnDanger,
  /** Unstyled geometry only — for a caller supplying its own colours. */
  bare: btn,
};

const BUTTON_SIZES = { sm: btnSmall, md: '', lg: btnLarge };

/**
 * The button, in every variant the app uses.
 *
 * WHY `loading` IS A PROP RATHER THAN THE CALLER SWAPPING THE LABEL
 *
 * Two things have to happen together when a form is submitting: the label has
 * to say so, and the control has to stop accepting clicks. Left to each call
 * site, those drift apart — and the half that gets forgotten is invariably the
 * second, which is how one impatient double-click becomes two orders. Binding
 * them to one prop means a button that *says* it is working cannot also still
 * be submitting.
 *
 * `loadingLabel` defaults to the idle label, so a caller that supplies nothing
 * still gets a spinner and a disabled control rather than nothing at all.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingLabel,
  icon,
  type = 'button',
  className = '',
  disabled,
  children,
  ...rest
}) {
  const classes = `${BUTTON_VARIANTS[variant] || btnPrimary} ${BUTTON_SIZES[size] || ''} ${className}`;

  return (
    <button type={type} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? (
        <>
          <span
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current"
            aria-hidden="true"
          />
          {loadingLabel || children}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
}

/** The same button geometry on a router link, for navigation that looks like an action. */
export function ButtonLink({ variant = 'primary', size = 'md', className = '', to, ...rest }) {
  const classes = `${BUTTON_VARIANTS[variant] || btnPrimary} ${BUTTON_SIZES[size] || ''} ${className}`;
  return <Link to={to} className={classes} {...rest} />;
}

/**
 * A native `<select>`, styled to match the text inputs.
 *
 * Native rather than a custom listbox on purpose: the platform control already
 * has keyboard support, type-ahead, and — the part a custom one never gets
 * right — a usable picker on a phone. The only thing added is the chevron,
 * since `appearance-none` removes the browser's own.
 */
export function Select({ className = '', children, ...rest }) {
  return (
    <div className="relative">
      <select className={`${input} appearance-none pr-9 ${className}`} {...rest}>
        {children}
      </select>
      <svg
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 fill-muted"
        aria-hidden="true"
      >
        <path d="M5.6 7.5L10 11.9l4.4-4.4 1.4 1.4-5.8 5.8-5.8-5.8z" />
      </svg>
    </div>
  );
}

/** A textarea on the same geometry as the inputs. */
export function Textarea({ className = '', rows = 4, ...rest }) {
  return <textarea rows={rows} className={`${input} resize-y leading-relaxed ${className}`} {...rest} />;
}

/**
 * Checkbox and radio, sharing one row layout.
 *
 * The whole row is the label, so the hit target is the text as well as the
 * 16px box — a control you have to aim at is a control people mis-click,
 * and it is the single cheapest usability win available on a form.
 */
function ChoiceRow({ type, label, hint, className = '', id, ...rest }) {
  const generatedId = useId();
  const controlId = id || rest.name ? `${rest.name || ''}-${rest.value || generatedId}` : generatedId;

  return (
    <label
      htmlFor={controlId}
      className={`flex cursor-pointer items-start gap-3 text-sm ${className}`}
    >
      <input
        id={controlId}
        type={type}
        className={`mt-0.5 h-4 w-4 shrink-0 cursor-pointer border-rule text-brand accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane ${
          type === 'radio' ? 'rounded-full' : 'rounded-sm'
        }`}
        {...rest}
      />
      <span className="min-w-0">
        <span className="font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Checkbox(props) {
  return <ChoiceRow type="checkbox" {...props} />;
}

export function Radio(props) {
  return <ChoiceRow type="radio" {...props} />;
}

/* ===========================================================================
 * Navigation
 * ======================================================================== */

/**
 * Breadcrumbs. `items` is `[{ label, to }]`; the last entry is the current
 * page and is rendered as text rather than a link — a link to where you
 * already are is a small lie about what will happen when it is clicked.
 */
export function Breadcrumb({ items = [], className = '' }) {
  if (!items.length) return null;

  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
              {isLast || !item.to ? (
                <span className={isLast ? 'font-medium text-ink-2' : undefined} aria-current={isLast ? 'page' : undefined}>
                  {item.label}
                </span>
              ) : (
                <Link to={item.to} className="transition-colors hover:text-ink">
                  {item.label}
                </Link>
              )}
              {!isLast && (
                <svg viewBox="0 0 20 20" className="h-3 w-3 shrink-0 fill-rule" aria-hidden="true">
                  <path d="M7.5 4.6L12.9 10l-5.4 5.4-1.4-1.4L10.1 10 6.1 6z" />
                </svg>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Tabs. Controlled: `value`, `onChange`, and `tabs` as `[{ value, label, count }]`.
 *
 * Real `role="tab"` semantics with arrow-key movement, because a row of
 * styled buttons that merely looks like tabs announces itself as a row of
 * buttons and gives a keyboard user no way to know they are alternatives.
 */
export function Tabs({ tabs = [], value, onChange, className = '' }) {
  function handleKey(event) {
    const index = tabs.findIndex((tab) => tab.value === value);
    if (index < 0) return;

    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;

    if (next !== null) {
      event.preventDefault();
      onChange(tabs[next].value);
    }
  }

  return (
    <div role="tablist" onKeyDown={handleKey} className={`flex gap-1 border-b border-hairline ${className}`}>
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane ${
              active
                ? 'border-brand text-ink'
                : 'border-transparent text-muted hover:border-rule hover:text-ink'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={`ml-2 text-xs ${active ? 'text-brand-ink' : 'text-muted'}`}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A table in a horizontally scrollable container.
 *
 * The container is the point: a wide table inside a page that scrolls
 * horizontally drags the whole layout sideways on a phone, so the overflow is
 * confined to the table itself. `caption` is visually hidden and names the
 * table for a screen reader, which otherwise announces "table" and nothing.
 */
export function Table({ caption, children, className = '' }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={`w-full min-w-[36rem] border-collapse text-left ${className}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

/**
 * A dropdown menu anchored to a trigger.
 *
 * `trigger` is rendered inside the button; `children` are the menu contents,
 * and are handed a `close` callback so an item can dismiss the menu after
 * acting. Shared rather than written twice because the CRM's profile menu and
 * the storefront's account menu need the identical three behaviours — close on
 * outside click, close on Escape, close on navigate — and the one that always
 * gets forgotten in a hand-rolled version is Escape.
 */
export function DropdownMenu({ trigger, label, children, align = 'right', triggerClassName = '' }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointer(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    }
    function handleKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={label}
        className={triggerClassName}
      >
        {trigger}
      </button>

      {/*
        A DISCLOSURE, NOT AN ARIA MENU — deliberately.

        This carried `role="menu"` and `role="menuitem"` on its rows. Both
        were removed, for two reasons that point the same way.

        The first is honesty: `role="menu"` is a promise that arrow keys move
        between items, Home/End jump to the ends and Tab leaves the menu
        entirely. This component implements none of that, so a screen-reader
        user was being told to expect a keyboard contract that did not exist —
        which is worse than no role at all, because they act on it.

        The second is that `role="menuitem"` OVERRIDES the element's own role,
        so a perfectly ordinary `<button>Sign out</button>` stopped being a
        button to anything that asks — assistive technology and tests alike.

        A labelled `aria-expanded` trigger revealing real buttons and links is
        the simpler pattern, it keeps every element's natural semantics, and
        Tab already walks the items in order.
      */}
      {open && (
        <div
          className={`absolute z-40 mt-2 w-52 overflow-hidden rounded-lg border border-hairline bg-surface py-1 shadow-pop ${
            align === 'left' ? 'left-0' : 'right-0'
          }`}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

/** One row inside a `DropdownMenu`. Renders as a link or a button. */
export function MenuItem({ to, onClick, children, className = '' }) {
  const classes = `block w-full px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:bg-sunken hover:text-ink ${className}`;

  if (to) {
    return (
      <Link to={to} className={classes} onClick={onClick}>
        {children}
      </Link>
    );
  }

  return (
    <button type="button" className={classes} onClick={onClick}>
      {children}
    </button>
  );
}

/* ===========================================================================
 * Overlays
 * ======================================================================== */

/**
 * Everything an overlay has to get right, in one place: Escape closes it, the
 * page behind it stops scrolling, focus moves into it on open and returns to
 * whatever opened it on close, and Tab cycles within it rather than walking
 * off into the page underneath.
 *
 * Sharing this is what stops the cart drawer, the quick-view modal and the
 * confirm dialog each implementing three of the four.
 */
function useOverlay(open, onClose) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement;

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const panel = panelRef.current;
    // The panel itself is focusable as a fallback, so focus never stays behind
    // on the page when an overlay holds no focusable control of its own.
    const first = panel?.querySelector(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    (first || panel)?.focus();

    function handleKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }

      if (event.key !== 'Tab' || !panel) return;

      const focusable = Array.from(
        panel.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);

      if (!focusable.length) return;

      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = overflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  return panelRef;
}

/**
 * A centred modal dialog.
 *
 * Rendered through a portal to `document.body` rather than in place: a modal
 * that renders inside the page can be clipped by any ancestor with `overflow`
 * or a transform, and the ancestor responsible is usually several components
 * away from the one that looks broken.
 */
export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  const panelRef = useOverlay(open, onClose);
  const titleId = useId();
  const descriptionId = useId();

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return createPortal(
    <div
      className="animate-backdrop-in fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className={`animate-palette-in max-h-[92vh] w-full ${widths[size] || widths.md} overflow-y-auto rounded-t-2xl border border-hairline bg-surface shadow-pop focus:outline-none sm:rounded-2xl`}
      >
        {(title || onClose) && (
          <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
            <div className="min-w-0">
              {title && (
                <h2 id={titleId} className="text-lg font-semibold text-ink">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-ink-2">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 -mt-1 rounded-md p-1.5 text-muted transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
                <path d="M5.3 4A1 1 0 004 5.3L8.6 10 4 14.7A1 1 0 105.3 16L10 11.4l4.7 4.6a1 1 0 001.3-1.3L11.4 10 16 5.3A1 1 0 0014.7 4L10 8.6z" />
              </svg>
            </button>
          </div>
        )}

        <div className="px-6 py-5">{children}</div>

        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-hairline bg-plane px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/**
 * A panel sliding in from the edge — the cart, the mobile filter rail.
 *
 * A drawer rather than a modal wherever the content is a LIST the page behind
 * is still the context for: a full-screen dialog for "your cart" throws away
 * the product the shopper was looking at when they opened it.
 */
export function Drawer({ open, onClose, title, side = 'right', children, footer, className = '' }) {
  const panelRef = useOverlay(open, onClose);
  const titleId = useId();

  if (!open) return null;

  return createPortal(
    <div
      className="animate-backdrop-in fixed inset-0 z-50 bg-ink/40"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className={`animate-drawer-in absolute inset-y-0 flex w-full max-w-md flex-col border-hairline bg-surface shadow-pop focus:outline-none ${
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l'
        } ${className}`}
      >
        <div className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 rounded-md p-1.5 text-muted transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
              <path d="M5.3 4A1 1 0 004 5.3L8.6 10 4 14.7A1 1 0 105.3 16L10 11.4l4.7 4.6a1 1 0 001.3-1.3L11.4 10 16 5.3A1 1 0 0014.7 4L10 8.6z" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && <div className="border-t border-hairline bg-plane px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ===========================================================================
 * Form validation
 * ======================================================================== */

/**
 * Client-side validation that only speaks once the user has had their turn.
 *
 * THE TIMING IS THE WHOLE POINT. Validating on every keystroke from an empty
 * field means the form shouts "Email address is required" at somebody who has
 * typed one character and is plainly still typing. So a field reports nothing
 * until it has been blurred once or the form has been submitted — and after
 * that it updates live, because once someone knows a field is wrong they want
 * to see the moment it becomes right.
 *
 * `rules` is `{ field: (value, values) => string | null }`.
 */
export function useFormValidation(rules) {
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const errorsFor = useCallback(
    (values) => {
      const found = {};
      Object.entries(rules).forEach(([field, rule]) => {
        const message = rule(values[field], values);
        if (message) found[field] = message;
      });
      return found;
    },
    [rules]
  );

  const visibleErrors = useCallback(
    (values) => {
      const all = errorsFor(values);
      if (submitted) return all;
      return Object.fromEntries(Object.entries(all).filter(([field]) => touched[field]));
    },
    [errorsFor, submitted, touched]
  );

  const markTouched = useCallback((field) => {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }, []);

  /** Returns true when the form is clean and may be submitted. */
  const validate = useCallback(
    (values) => {
      setSubmitted(true);
      return Object.keys(errorsFor(values)).length === 0;
    },
    [errorsFor]
  );

  return { visibleErrors, markTouched, validate, submitted };
}

/** The validation messages the whole app shares, so the wording never drifts. */
export const validators = {
  required: (label) => (value) =>
    !value || !String(value).trim() ? `${label} is required.` : null,

  email: (value) => {
    if (!value || !String(value).trim()) return 'Email address is required.';
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value).trim())
      ? null
      : 'Please enter a valid email address.';
  },

  password: (value) => {
    if (!value) return 'Password is required.';
    return String(value).length < 8 ? 'Password must be at least 8 characters.' : null;
  },

  match: (other, message) => (value, values) => (value === values[other] ? null : message),

  phone: (value) => {
    if (!value || !String(value).trim()) return null;
    return /^[+()\d][\d\s().-]{6,}$/.test(String(value).trim())
      ? null
      : 'Please enter a valid phone number.';
  },

  /** Money. Rejects empty, negative and non-numeric; allows decimals. */
  price: (value) => {
    if (value === '' || value === null || value === undefined) return 'Price is required.';
    const number = Number(value);
    if (Number.isNaN(number)) return 'Price must be a number.';
    return number < 0 ? 'Price cannot be negative.' : null;
  },

  /** Stock. A non-negative whole number — half a sofa is not a quantity. */
  stock: (value) => {
    if (value === '' || value === null || value === undefined) return 'Stock is required.';
    const number = Number(value);
    if (Number.isNaN(number)) return 'Stock must be a number.';
    if (number < 0) return 'Stock cannot be negative.';
    return Number.isInteger(number) ? null : 'Stock must be a whole number.';
  },
};

export { hintText, errorText };
