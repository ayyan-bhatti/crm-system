import { useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { errorMessage } from '../../api/client';
import {
  Button,
  ErrorBanner,
  Field,
  Spinner,
  useFormValidation,
  validators,
} from '../../components/common';
import { errorText, hintText, input, label as labelClass, link } from '../../ui';

/**
 * Signing in to the shop.
 *
 * NOT THE CRM'S SIGN-IN SCREEN, and the difference is deliberate. Staff sign in
 * to start work; a shopper signs in in the middle of buying something, usually
 * having been sent here from checkout. So the page is warm rather than
 * administrative, it says why an account is worth having, and — the part that
 * actually matters — it hands the buyer straight back to wherever they came
 * from. `location.state.from` is that round trip, and it is passed on to the
 * register link too, so creating an account instead of signing in does not
 * quietly lose the cart the shopper was carrying.
 */
export default function BuyerLogin() {
  const { login, isSignedIn, loading: sessionLoading } = useBuyerAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * Validation that only speaks once the field has had its turn — see
   * `useFormValidation`. On a sign-in form this matters more than on most:
   * shouting "Please enter a valid email address" at somebody two characters
   * into typing one is the fastest way to make a shop feel hostile.
   */
  const validation = useFormValidation({
    email: validators.email,
    password: validators.required('Password'),
  });
  const errors = validation.visibleErrors(form);

  // See the matching comment in BuyerRegister.jsx: without this, the
  // "already signed in" guard below can win a redirect race against this
  // page's own post-login navigate(), sending a buyer who just signed in
  // here to /account/orders instead of wherever they meant to go.
  const justSubmitted = useRef(false);

  if (sessionLoading) return <Spinner full />;
  if (isSignedIn && !justSubmitted.current) return <Navigate to="/account/orders" replace />;

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validation.validate(form)) return;

    setSubmitting(true);
    setError('');
    justSubmitted.current = true;

    try {
      await login(form.email, form.password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      justSubmitted.current = false;
      setError(errorMessage(err, 'Unable to sign in'));
    } finally {
      setSubmitting(false);
    }
  }

  const returningToCheckout = location.state?.from === '/checkout';

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_minmax(0,26rem)] lg:items-center lg:gap-20 lg:py-24">
      <AuthAside />

      <div className="w-full">
        <p className="label-mono">Your account</p>
        <h1 className="font-display mt-2 text-[32px] leading-tight text-ink sm:text-[36px]">
          Welcome back
        </h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-ink-2">
          {returningToCheckout
            ? 'Sign in to finish checking out — everything in your basket is still there.'
            : 'Sign in to follow an order, revisit a saved address, or pick up where you left off.'}
        </p>

        <div className="mt-8">
          <ErrorBanner message={error} onDismiss={() => setError('')} />

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <Field
              label="Email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="name@example.com"
              required
              hint="The email you registered with."
              value={form.email}
              error={errors.email}
              onBlur={() => validation.markTouched('email')}
              onChange={(e) => update('email', e.target.value)}
            />

            <PasswordField
              id="signin-password"
              label="Password"
              autoComplete="current-password"
              value={form.password}
              error={errors.password}
              onBlur={() => validation.markTouched('password')}
              onChange={(value) => update('password', value)}
            />

            <Button type="submit" size="lg" className="w-full" loading={submitting} loadingLabel="Signing in…">
              Sign in
            </Button>
          </form>
        </div>

        <p className="mt-7 text-sm text-ink-2">
          New here?{' '}
          <Link to="/register" state={location.state} className={link}>
            Create an account
          </Link>
        </p>

        {/*
          Deliberately quiet — a small line under the actual sign-in form,
          not a second tab or a toggle competing with it. A shopper never
          needs to see it register; the one visitor it is for is looking
          for exactly this sentence and nothing else on the page.
        */}
        <p className="mt-10 border-t border-hairline pt-5 text-xs text-muted">
          Are you an admin or staff member?{' '}
          <Link to="/crm/login" className="font-medium text-ink-2 hover:text-ink hover:underline">
            Login to CRM
          </Link>
        </p>
      </div>
    </div>
  );
}

/**
 * The editorial half.
 *
 * Set in the display face and carrying no form controls at all, which is the
 * point: it is the reason to have an account, stated once, rather than a second
 * column of things to read while filling one in. Hidden below `lg`, where the
 * form is the entire screen and anything above it is just distance between the
 * shopper and the keyboard.
 */
function AuthAside() {
  const points = [
    ['Track every delivery', 'A live timeline for each order, from packing to the doorstep.'],
    ['Addresses that stay put', 'Save the places you order to once, and check out in a tap.'],
    ['Your order history', 'Every purchase, receipt and courier reference in one place.'],
  ];

  return (
    <aside className="hidden lg:block">
      <p className="label-mono">Shop account</p>
      <p className="font-display mt-3 max-w-md text-[40px] leading-[1.1] text-ink">
        Pieces made to last, looked after from order to doorstep.
      </p>

      <dl className="mt-10 max-w-sm space-y-6 border-t border-hairline pt-8">
        {points.map(([term, detail]) => (
          <div key={term} className="flex gap-4">
            <span
              aria-hidden="true"
              className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
            />
            <div>
              <dt className="text-sm font-semibold text-ink">{term}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-ink-2">{detail}</dd>
            </div>
          </div>
        ))}
      </dl>
    </aside>
  );
}

/**
 * A password field with a real show/hide control.
 *
 * A BUTTON, NOT AN ICON THAT HAPPENS TO BE CLICKABLE. It is keyboard
 * reachable, it announces its state through `aria-pressed`, and its accessible
 * name says what it will do ("Show password" / "Hide password") rather than
 * what it currently is — a toggle labelled with its own state is the classic
 * way to make everyone guess.
 *
 * The name is built from visible text plus a visually-hidden word rather than
 * an `aria-label`, and that is not decoration either: the storefront's own
 * end-to-end specs look this form's fields up by label, and a button carrying
 * `aria-label="Show password"` would answer to `getByLabel(/password/i)` and
 * make the query that fills the field ambiguous.
 *
 * Hand-rolled rather than `Field` with a child, because `Field` clones its
 * child to attach the id — which would land on a wrapper `div` here, not the
 * input, and quietly break the label association it exists to guarantee.
 */
export function PasswordField({ id, label, value, error, hint, onChange, onBlur, autoComplete }) {
  const [visible, setVisible] = useState(false);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const describedBy = [error ? errorId : null, hint && !error ? hintId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      <label className={labelClass} htmlFor={id}>
        {label}
        <span className="ml-1 text-critical-ink" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (Required)</span>
      </label>

      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className={`${input} pr-16`}
          autoComplete={autoComplete}
          required
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          value={value}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((current) => !current)}
          className="absolute inset-y-0 right-0 flex items-center rounded-r-md px-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane"
        >
          {visible ? 'Hide' : 'Show'}
          <span className="sr-only"> password</span>
        </button>
      </div>

      {hint && !error && (
        <p id={hintId} className={hintText}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={errorText}>
          <svg viewBox="0 0 20 20" className="mt-px h-3.5 w-3.5 shrink-0 fill-current" aria-hidden="true">
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
}
