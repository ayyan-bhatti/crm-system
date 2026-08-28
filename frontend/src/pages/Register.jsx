import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../components/common';
import { REQUESTABLE_ROLES } from '../constants';
import { btnPrimary, humanize, input, link } from '../ui';

/**
 * Ask for an account.
 *
 * NOT A REGISTRATION, AND THE PAGE SAYS SO THROUGHOUT.
 *
 * Submitting creates an account that cannot be used until an administrator
 * approves it. That is the single most important thing for this page to
 * communicate, because the failure mode if it does not is somebody filling in a
 * form, being told "success", and then being unable to sign in with no idea
 * why. So the heading, the button and the confirmation all say "request".
 *
 * There is no redirect on success and no session — see the note on `register`
 * in AuthContext. The page swaps itself for a confirmation instead, which is
 * the honest end of the flow: there is nowhere to go yet.
 */
export default function Register() {
  const { register, isAuthenticated, loading: sessionLoading } = useAuth();

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    requestedRole: 'sales_rep',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * What the server said, once the request is in. Held rather than shown as a
   * toast: a toast disappears, and this is the only place the person is told
   * that nothing further will happen until somebody acts.
   */
  const [submitted, setSubmitted] = useState(null);

  if (sessionLoading) return <Spinner full />;
  if (isAuthenticated) return <Navigate to="/crm" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const result = await register(form);
      setSubmitted(result);
    } catch (err) {
      setError(errorMessage(err, 'Unable to send your request'));
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Request sent</h1>
          </div>

          <Card className="p-6">
            <p className="text-sm text-ink-2">
              {submitted.message ||
                'Your request has been sent to an administrator. You will be able to sign in once it has been approved.'}
            </p>

            {/*
              Stated plainly because it is the thing people get wrong: the
              password is already set, so there is nothing else to do and no
              second email to wait for beyond the decision itself.
            */}
            <p className="mt-3 text-sm text-ink-2">
              Sign in with the password you just chose — once your request has been
              approved, it will simply start working.
            </p>
          </Card>

          <p className="mt-4 text-center text-sm text-muted">
            <Link to="/crm/login" className={link}>
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">SimpleCRM</h1>
          <p className="mt-1 text-sm text-muted">Request an account</p>
        </div>

        <Card className="p-6">
          <ErrorBanner message={error} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />

            {/*
              Administrator is not in this list, and cannot be added to it by
              editing the request: the API validates against the same set and
              refuses outright rather than quietly downgrading, so somebody
              cannot come away believing they asked for admin and got it.
            */}
            <Field
              label="Role you are requesting"
              hint="An administrator decides what you are actually granted."
            >
              <select
                className={input}
                value={form.requestedRole}
                onChange={(e) => setForm({ ...form, requestedRole: e.target.value })}
              >
                {REQUESTABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {humanize(role)}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              // Stating the rule up front is worth more than a good error
              // message: nobody enjoys discovering a policy one rejection at a
              // time. The server is still the enforcement — see
              // backend/src/utils/passwordPolicy.js — this is just the hint.
              hint="At least 10 characters, mixing letters, numbers and symbols — or a phrase of 14+ characters."
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />

            <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
              {submitting ? <Spinner /> : 'Send request'}
            </button>
          </form>

          <p className="mt-4 text-xs text-muted">
            Your account is created straight away but cannot be used until an administrator
            approves it. You will not be signed in yet.
          </p>
        </Card>

        <p className="mt-4 text-center text-sm text-muted">
          Already have an account?{' '}
          <Link to="/crm/login" className={link}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
