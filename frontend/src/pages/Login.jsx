import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../components/common';
import { btnPrimary, link } from '../ui';

/**
 * Real, already-shipped things this app does — not marketing copy invented
 * for this screen. Kept short and specific on purpose: a claim a new admin
 * can go straight to the dashboard and verify beats a vaguer, punchier one.
 */
const HIGHLIGHTS = [
  { title: 'One decision queue', body: 'Every proposed change, from any manager, in one place.' },
  { title: 'AI that shows its work', body: 'Figures come from the database; the model only writes the sentence around them.' },
  { title: 'A command palette', body: 'Press ⌘K anywhere in the CRM to jump straight to a customer, order or page.' },
];

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
  if (isAuthenticated) return <Navigate to="/crm" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      await login(form.email, form.password);
      // Send them back to whatever page bounced them here, if any.
      navigate(location.state?.from || '/crm', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Unable to sign in'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="crm-shell flex min-h-full">
      {/* --- Brand panel — hidden below lg, where there is no room for two
          columns and the form is the only thing that matters anyway. ----- */}
      <div className="crm-glow relative hidden w-[42%] shrink-0 flex-col justify-between overflow-hidden border-r border-hairline bg-surface px-12 py-14 lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="bg-brand-gradient flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white shadow-lift">
            S
          </span>
          <span className="font-display text-lg font-semibold tracking-tight text-ink">
            SimpleCRM
          </span>
        </div>

        <div className="animate-fade-rise">
          <h1 className="max-w-md text-4xl font-semibold leading-[1.1] tracking-tight text-ink">
            Run the whole business from one screen.
          </h1>
          <p className="mt-4 max-w-sm text-sm text-ink-2">
            Customers, orders, approvals and delivery — one system, scoped to
            what each role actually needs to see.
          </p>
        </div>

        <ul className="stagger-children space-y-5">
          {HIGHLIGHTS.map((item) => (
            <li key={item.title} className="flex gap-3">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-ink">{item.title}</p>
                <p className="mt-0.5 text-sm text-muted">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* --- Form column --------------------------------------------------- */}
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="animate-fade-rise w-full max-w-sm">
          <div className="mb-7 text-center lg:hidden">
            <span className="bg-brand-gradient mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold text-white shadow-lift">
              S
            </span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight text-ink">Welcome back</h2>
          <p className="mt-1.5 text-sm text-ink-2">Sign in to your SimpleCRM account</p>

          <Card className="mt-6 p-6 shadow-lift">
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
                <Link to="/crm/forgot-password" className={link}>
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
            <Link to="/crm/register" className={link}>
              Request one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
