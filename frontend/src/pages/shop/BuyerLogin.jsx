import { useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { errorMessage } from '../../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../../components/common';
import { btnPrimary, link } from '../../ui';

export default function BuyerLogin() {
  const { login, isSignedIn, loading: sessionLoading } = useBuyerAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // See the matching comment in BuyerRegister.jsx: without this, the
  // "already signed in" guard below can win a redirect race against this
  // page's own post-login navigate(), sending a buyer who just signed in
  // here to /account/orders instead of wherever they meant to go.
  const justSubmitted = useRef(false);

  if (sessionLoading) return <Spinner full />;
  if (isSignedIn && !justSubmitted.current) return <Navigate to="/account/orders" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
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

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="font-display mb-6 text-center text-2xl font-semibold text-ink">
          Sign in
        </h1>

        <Card className="p-6">
          <ErrorBanner message={error} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              required
              hint="The email you registered with."
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />

            <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
              {submitting ? <Spinner /> : 'Sign in'}
            </button>
          </form>
        </Card>

        <p className="mt-5 text-center text-sm text-ink-2">
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
        <p className="mt-8 text-center text-xs text-muted">
          Are you an admin or staff member?{' '}
          <Link to="/crm/login" className="font-medium text-ink-2 hover:text-ink hover:underline">
            Login to CRM
          </Link>
        </p>
      </div>
    </div>
  );
}
