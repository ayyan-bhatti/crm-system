import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { errorMessage } from '../../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../../components/common';
import { btnPrimary, link } from '../../ui';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** Client-side hints only — the server is still the real authority on both. */
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

  const [form, setForm] = useState({ name: '', email: '', password: '' });
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
      navigate('/', { replace: true });
    } catch (err) {
      justSubmitted.current = false;
      setError(errorMessage(err, 'Unable to create your account'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="font-display mb-6 text-center text-2xl font-semibold text-ink">
          Create an account
        </h1>

        <Card className="p-6">
          <ErrorBanner message={error} />

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <Field
              label="Name"
              autoComplete="name"
              required
              value={form.name}
              onBlur={() => blur('name')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={touched.name ? fieldErrors.name : undefined}
            />
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              required
              hint="Used to send your order confirmations."
              value={form.email}
              onBlur={() => blur('email')}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              error={touched.email ? fieldErrors.email : undefined}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              hint="At least 10 characters."
              value={form.password}
              onBlur={() => blur('password')}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              error={touched.password ? fieldErrors.password : undefined}
            />

            <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
              {submitting ? <Spinner /> : 'Create account'}
            </button>
          </form>
        </Card>

        <p className="mt-5 text-center text-sm text-ink-2">
          Already have an account?{' '}
          <Link to="/login" className={link}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
