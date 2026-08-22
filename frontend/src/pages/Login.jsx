import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../components/common';
import { btnPrimary, link } from '../ui';

export default function Login() {
  const { login, isAuthenticated, loading: sessionLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Wait for the session check before deciding — otherwise a refresh on /login
  // briefly shows the form to someone who is already signed in.
  if (sessionLoading) return <Spinner full />;
  if (isAuthenticated) return <Navigate to="/" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      await login(form.email, form.password);
      // Send them back to whatever page bounced them here, if any.
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Unable to sign in'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-full items-center justify-center px-4 py-12">
      {/* A single soft wash behind the card. Enough to stop the page reading as
          a blank sheet, quiet enough not to compete with the form. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,var(--color-brand-wash),transparent_70%)]"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-7 text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white shadow-lift">
            S
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Welcome back</h1>
          <p className="mt-1.5 text-sm text-ink-2">Sign in to your SimpleCRM account</p>
        </div>

        <Card className="p-6 shadow-lift">
          <ErrorBanner message={error} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />

            <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
              {submitting ? <Spinner /> : 'Sign in'}
            </button>

            <p className="text-center text-sm">
              <Link to="/forgot-password" className={link}>
                Forgot your password?
              </Link>
            </p>
          </form>
        </Card>

        <p className="mt-5 text-center text-sm text-ink-2">
          No account?{' '}
          {/* "Request one", not "Create one": signing up does not produce a
              working account, and saying so here rather than only on the next
              page sets the expectation before anyone fills in a form. */}
          <Link to="/register" className={link}>
            Request one
          </Link>
        </p>
      </div>
    </div>
  );
}
