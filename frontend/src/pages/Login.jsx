import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Spinner,
  useFormValidation,
  validators,
} from '../components/common';
import { link } from '../ui';
import AuthLayout, { PasswordField, StatusRegion } from './AuthLayout';

/**
 * Real, already-shipped things this app does — not marketing copy invented
 * for this screen. Kept short and specific on purpose: a claim a new admin
 * can go straight to the dashboard and verify beats a vaguer, punchier one.
 */
const HIGHLIGHTS = [
  { title: 'One decision queue', body: 'Every proposed change, from any manager, in one place.' },
  {
    title: 'AI that shows its work',
    body: 'Figures come from the database; the model only writes the sentence around them.',
  },
  {
    title: 'A command palette',
    body: 'Press ⌘K anywhere in the CRM to jump straight to a customer, order or page.',
  },
];

/**
 * THE PASSWORD RULE HERE IS "NOT EMPTY", NOT THE SIGN-UP POLICY.
 *
 * Sign-in is not the place to enforce a length: the only passwords that reach
 * this form are ones that already exist, and telling somebody their real
 * password is "too short" to even try is both wrong and a small disclosure
 * about the policy. The server decides whether the credentials are good; this
 * only catches the empty submit.
 *
 * Defined at module scope because `useFormValidation` memoises on `rules` — an
 * object literal in the body would be a new identity every render.
 */
const RULES = {
  email: validators.email,
  password: validators.required('Password'),
};

export default function Login() {
  const { login, isAuthenticated, loading: sessionLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);
  const errors = visibleErrors(form);

  // Wait for the session check before deciding — otherwise a refresh on /login
  // briefly shows the form to someone who is already signed in.
  if (sessionLoading) return <Spinner full />;
  if (isAuthenticated) return <Navigate to="/crm" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate(form)) return;

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
    <AuthLayout
      eyebrow="Sign in"
      title="Welcome back"
      subtitle="Sign in to your SimpleCRM account."
      aside={
        <ul className="space-y-4">
          {HIGHLIGHTS.map((item) => (
            <li key={item.title} className="flex gap-3">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-plane">{item.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-plane/60">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      }
      footer={
        <>
          No account?{' '}
          {/* "Request one", not "Create one": signing up does not produce a
              working account, and saying so here rather than only on the next
              page sets the expectation before anyone fills in a form. */}
          <Link to="/crm/register" className={link}>
            Request one
          </Link>
        </>
      }
    >
      <Card className="p-6 shadow-lift sm:p-7">
        <StatusRegion>
          <ErrorBanner message={error} />
        </StatusRegion>

        {/*
          `noValidate` because the app validates itself. Left on, the browser's
          own bubble fires first and replaces this form's message with a
          generic one nobody wrote.
        */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <Field
            label="Email address"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@example.com"
            required
            value={form.email}
            error={errors.email}
            onBlur={() => markTouched('email')}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />

          <PasswordField
            label="Password"
            autoComplete="current-password"
            placeholder="Your password"
            required
            value={form.password}
            error={errors.password}
            onBlur={() => markTouched('password')}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />

          <Button
            type="submit"
            className="w-full"
            loading={submitting}
            loadingLabel="Signing in…"
          >
            Sign in
          </Button>

          <p className="text-center text-sm">
            <Link to="/crm/forgot-password" className={link}>
              Forgot your password?
            </Link>
          </p>
        </form>
      </Card>
    </AuthLayout>
  );
}
