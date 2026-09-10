import { useId, useState } from 'react';
import { input, label as labelClass, hintText, errorText } from '../ui';

/**
 * The shell every CRM authentication screen sits in.
 *
 * WHY ONE SHELL RATHER THAN SIX CENTRED BOXES
 *
 * These six screens — sign in, request an account, forgot, reset, accept an
 * invite, confirm an email — are the only parts of the CRM someone sees before
 * they are signed in, and several of them are reached from an email link. A
 * page reached from an email that looks slightly different from the last one is
 * indistinguishable, to a careful person, from a phishing page. So they share a
 * single layout: the same dark brand panel, the same wordmark, the same form
 * column, the same spacing. Consistency here is a security affordance, not
 * decoration.
 *
 * On large screens it is a split: a quiet ink panel carrying the wordmark, and
 * the form on the warm page ground beside it. Below `lg` there is no room for
 * two columns and the form is the only thing that matters, so the panel
 * collapses to a slim header strip.
 *
 * The `<h1>` lives HERE, exactly once per screen, taken from `title`. Pages
 * pass their heading in rather than rendering their own, which is what
 * guarantees no screen ends up with two of them or none.
 */

/** The wordmark's lock-up mark. Brand fill, near-black glyph — never white. */
function Mark({ className = '' }) {
  return (
    <span
      className={`flex items-center justify-center rounded-lg bg-brand font-bold text-on-brand ${className}`}
      aria-hidden="true"
    >
      S
    </span>
  );
}

const DEFAULT_TAGLINE =
  'Customers, orders, approvals and delivery — one system, scoped to what each role actually needs to see.';

export default function AuthLayout({
  title,
  subtitle,
  eyebrow,
  children,
  footer,
  aside,
  tagline = DEFAULT_TAGLINE,
  /**
   * Wrap the heading and body in a polite live region. Only the screens whose
   * whole content swaps as a request resolves (email confirmation) want this —
   * on a form it would announce every field as it changed.
   */
  live = false,
}) {
  return (
    <div className="flex min-h-full flex-col bg-plane lg:flex-row">
      {/* --- Slim brand strip — below lg, where the split does not fit. ----- */}
      <header className="flex items-center gap-2.5 bg-ink px-5 py-3.5 lg:hidden">
        <Mark className="h-8 w-8 text-[13px]" />
        <span className="font-display text-lg text-plane">SimpleCRM</span>
      </header>

      {/* --- Brand panel — lg and up. -------------------------------------- */}
      <aside className="relative hidden shrink-0 flex-col justify-between overflow-hidden bg-ink px-12 py-14 lg:flex lg:w-[42%] xl:px-16 xl:py-16">
        {/* A single warm bloom in the corner. Decorative, clipped by the
            panel's own overflow, and never in the way of the text. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-28 -top-28 h-80 w-80 rounded-full bg-brand/20 blur-3xl"
        />

        <div className="relative flex items-center gap-3">
          <Mark className="h-9 w-9 text-sm" />
          <span className="label-mono">Staff workspace</span>
        </div>

        <div className="relative">
          <p className="font-display text-[3.5rem] leading-[0.95] text-plane xl:text-[4rem]">
            SimpleCRM
          </p>
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-plane/75">{tagline}</p>
        </div>

        <div className="relative">
          {aside || (
            <p className="text-xs text-plane/55">
              Staff access only. Customer accounts live on the shop.
            </p>
          )}
        </div>
      </aside>

      {/* --- Form column ---------------------------------------------------- */}
      <main className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
        <div
          className="animate-fade-rise w-full max-w-[26rem]"
          aria-live={live ? 'polite' : undefined}
        >
          <div className="mb-7">
            {eyebrow && <p className="label-mono mb-2.5">{eyebrow}</p>}
            <h1 className="text-[27px] font-semibold leading-tight tracking-tight text-ink">
              {title}
            </h1>
            {subtitle && <p className="mt-2 text-sm leading-relaxed text-ink-2">{subtitle}</p>}
          </div>

          {children}

          {footer && <div className="mt-6 text-center text-sm text-ink-2">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/**
 * A password field with a show/hide toggle.
 *
 * NOT BUILT ON `Field`, and the reason is structural rather than stylistic: the
 * toggle has to sit inside the input's own box, which means the input needs a
 * positioned wrapper — and `Field` clones whatever single child it is given and
 * puts the label's `id` on it, so handing it a wrapper would point the label at
 * a `<div>`. The label wiring, the hint, the error and the required marking are
 * therefore mirrored here deliberately, from the same class strings, so the two
 * cannot drift apart visually.
 *
 * THE TOGGLE'S ACCESSIBLE NAME DELIBERATELY AVOIDS THE WORD "PASSWORD".
 * `aria-label` becomes the button's accessible name, and a button called
 * "Show password" sitting beside a field called "Password" gives a screen
 * reader user two things with nearly the same name in the same place. Naming it
 * after what it does to the text — and pointing it at the field with
 * `aria-controls` — is both clearer to listen to and unambiguous to query.
 */
export function PasswordField({
  label: labelText,
  hint,
  error,
  id,
  required = false,
  className = '',
  ...inputProps
}) {
  const generatedId = useId();
  const fieldId = id || generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  const [visible, setVisible] = useState(false);

  const describedBy = [error ? errorId : null, hint && !error ? hintId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <label className={labelClass} htmlFor={fieldId}>
        {labelText}
        {required && (
          <span className="ml-1 text-critical-ink" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (Required)</span>}
      </label>

      <div className="relative">
        <input
          {...inputProps}
          id={fieldId}
          type={visible ? 'text' : 'password'}
          className={`${input} pr-16`}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          required={required}
        />

        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-pressed={visible}
          aria-controls={fieldId}
          aria-label={visible ? 'Hide the characters you typed' : 'Show the characters you typed'}
          className="absolute inset-y-px right-px flex items-center rounded-r-md px-3 text-xs font-semibold text-ink-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>

      {hint && !error && (
        <p id={hintId} className={hintText}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={errorText}>
          {/* Icon beside the text: the failure is never signalled by red alone. */}
          <svg
            viewBox="0 0 20 20"
            className="mt-px h-3.5 w-3.5 shrink-0 fill-current"
            aria-hidden="true"
          >
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A polite live region wrapper for the banner slot above a form.
 *
 * Every one of these screens can fail in a way the user has to read — wrong
 * password, expired link, rate limit — and a banner that simply appears is
 * silent to anyone not looking at that part of the page.
 */
export function StatusRegion({ children }) {
  return <div aria-live="polite">{children}</div>;
}
