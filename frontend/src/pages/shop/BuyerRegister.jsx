import { useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { errorMessage } from '../../api/client';
import { Button, ErrorBanner, Field, Spinner } from '../../components/common';
import ConsentCheckboxes from '../../components/ConsentCheckboxes';
/*
 * The password control is shared with the sign-in page rather than written
 * twice. The two screens are one pair — same geometry, same show/hide
 * behaviour, same reason for building the accessible name out of text rather
 * than an `aria-label` — and a second copy is how the two quietly stop matching.
 */
import { PasswordField } from './BuyerLogin';
import { link } from '../../ui';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * Client-side hints only — the server is still the real authority on both.
 *
 * TEN CHARACTERS, NOT THE SHARED `validators.password`'s EIGHT. The storefront
 * account minimum is ten and is enforced on the server; using the generic rule
 * here would let this form accept a nine-character password, post it, and get
 * the rejection back from the API — which is a worse experience than the
 * inline message, and a message that contradicts the hint printed under the
 * field besides.
 */
function validate(form) {
  const errors = {};
  if (!form.name.trim()) errors.name = 'Enter your name.';
  if (!EMAIL_RE.test(form.email)) errors.email = 'Enter a valid email address.';
  if (form.password.length < 10) errors.password = 'Use at least 10 characters.';
  return errors;
}

export default function BuyerRegister() {
  const { register, isSignedIn, loading: sessionLoading } = useBuyerAuth();
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * The three consent flags live in the same state object as the credentials
   * and are posted with them. `validate()` ignores them — they are optional by
   * definition, and creating an account must never fail because of a checkbox.
   */
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    emailOptIn: false,
    smsOptIn: false,
    whatsappOptIn: false,
  });
  const [touched, setTouched] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * `register()` flips `isSignedIn` true (via BuyerAuthContext's setBuyer)
   * before the `navigate('/', ...)` below runs, which can re-render this
   * component — still mounted at /register — with the guard just below now
   * true. That guard's own redirect fires from react-router's <Navigate>,
   * i.e. from a useEffect, so it commits AFTER this file's synchronous
   * navigate() call and overwrites it: a freshly registered buyer landed on
   * their empty order history instead of the shop home. The guard's actual
   * job — sending someone who ARRIVES at this page already signed in
   * elsewhere back out — never applies to a sign-in this submit itself just
   * caused, so it's safe to skip in that one case.
   */
  const justSubmitted = useRef(false);

  if (sessionLoading) return <Spinner full />;
  if (isSignedIn && !justSubmitted.current) return <Navigate to="/account/orders" replace />;

  const fieldErrors = validate(form);

  /** Errors are shown on blur, or once the form has been submitted — never mid-keystroke. */
  function blur(field) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setTouched({ name: true, email: true, password: true });
    if (Object.keys(fieldErrors).length) return;

    setSubmitting(true);
    setError('');
    justSubmitted.current = true;

    try {
      await register(form);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      justSubmitted.current = false;
      setError(errorMessage(err, 'Unable to create your account'));
    } finally {
      setSubmitting(false);
    }
  }

  const returningToCheckout = location.state?.from === '/checkout';

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_minmax(0,26rem)] lg:items-start lg:gap-20 lg:py-24">
      <RegisterAside />

      <div className="w-full">
        <p className="label-mono">Your account</p>
        <h1 className="font-display mt-2 text-[32px] leading-tight text-ink sm:text-[36px]">
          Create an account
        </h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-ink-2">
          {returningToCheckout
            ? 'One short step, then straight back to your basket to finish checking out.'
            : 'It takes a minute, and it is what puts your orders, addresses and delivery updates in one place.'}
        </p>

        <div className="mt-8">
          <ErrorBanner message={error} onDismiss={() => setError('')} />

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <Field
              label="Name"
              name="name"
              autoComplete="name"
              placeholder="Amina Raza"
              required
              hint="How we address you on your order confirmations."
              value={form.name}
              onBlur={() => blur('name')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={touched.name ? fieldErrors.name : undefined}
            />
            <Field
              label="Email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="name@example.com"
              required
              hint="Used to send your order confirmations."
              value={form.email}
              onBlur={() => blur('email')}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              error={touched.email ? fieldErrors.email : undefined}
            />
            <PasswordField
              id="register-password"
              label="Password"
              autoComplete="new-password"
              hint="At least 10 characters."
              value={form.password}
              onBlur={() => blur('password')}
              onChange={(value) => setForm({ ...form, password: value })}
              error={touched.password ? fieldErrors.password : undefined}
            />

            {/*
              MARKETING CONSENT AT REGISTRATION.

              This is where the round's "opt-in checkboxes on guest checkout"
              lands, and it is worth knowing why it is not on a guest checkout:
              there is no guest checkout. An earlier round made an account
              mandatory before buying, enforced on the route rather than only
              in the UI, so registration is the step every storefront purchase
              now passes through.

              Every box starts unchecked and creating the account is not
              conditional on any of them — which is the difference between
              collecting consent and extracting it.
            */}
            <ConsentCheckboxes
              legend="Keep in touch (optional)"
              hint="Entirely up to you — your account works the same either way, and you can change your mind at any time."
              value={form}
              onChange={(next) => setForm({ ...form, ...next })}
              disabled={submitting}
            />

            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={submitting}
              loadingLabel="Creating account…"
            >
              Create account
            </Button>
          </form>
        </div>

        <p className="mt-7 text-sm text-ink-2">
          Already have an account?{' '}
          <Link to="/login" state={location.state} className={link}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

/** The editorial half — see the note on `AuthAside` in BuyerLogin.jsx. */
function RegisterAside() {
  const points = [
    ['Checkout in a tap', 'Saved addresses mean the next order takes seconds, not minutes.'],
    ['Know where it is', 'A delivery timeline and courier tracking on every order.'],
    ['Change your mind', 'Ask to amend or cancel while an order is still being prepared.'],
  ];

  return (
    <aside className="hidden lg:block lg:pt-16">
      <p className="label-mono">Join us</p>
      <p className="font-display mt-3 max-w-md text-[40px] leading-[1.1] text-ink">
        Everything you buy, kept in one calm place.
      </p>

      <dl className="mt-10 max-w-sm space-y-6 border-t border-hairline pt-8">
        {points.map(([term, detail]) => (
          <div key={term} className="flex gap-4">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
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
