import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { useToast } from '../components/Toast';
import { Card, ErrorBanner, Field, Spinner } from '../components/common';
import { btnPrimary, link } from '../ui';

/**
 * Choosing a new password from a reset link.
 *
 * The token arrives in the query string, which is where a link can carry it —
 * and is also why it is single-use and expires in 30 minutes: a URL ends up in
 * browser history, in the mailbox it was sent to, and in any referrer header
 * the page emits.
 *
 * Errors stay INLINE rather than becoming toasts. Every failure on this screen
 * is something the user has to act on — a weak password, or an expired link
 * needing a fresh request — and a message that floats away after four seconds
 * is the wrong place for it. The success is a toast, because the user is being
 * navigated away.
 */
export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * The confirmation field is checked here and nowhere else, on purpose. It is
   * not a security control — the server has no opinion about it — it exists so
   * a typo in a password the user cannot see does not lock them out of the
   * account they are in the middle of recovering.
   */
  const mismatch = confirmation.length > 0 && password !== confirmation;

  async function handleSubmit(event) {
    event.preventDefault();

    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await authApi.resetPassword({ token, password });
      toast.success('Password reset. Please sign in with your new password.');
      navigate('/crm/login', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not reset the password'));
      setSubmitting(false);
    }
  }

  /* A link with no token at all — someone pasted a truncated URL. */
  if (!token) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-12">
        <Card className="w-full max-w-sm p-6 text-center shadow-lift">
          <p className="text-sm font-medium text-ink">This link is incomplete</p>
          <p className="mt-2 text-sm text-ink-2">
            It may have been cut short by your email client. Please request a new one.
          </p>
          <Link to="/crm/forgot-password" className={`${btnPrimary} mt-5 w-full`}>
            Request a new link
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Choose a new password</h1>
          <p className="mt-1.5 text-sm text-ink-2">
            This signs you out on every device.
          </p>
        </div>

        <Card className="p-6 shadow-lift">
          <ErrorBanner message={error} onDismiss={() => setError('')} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              hint="At least 10 characters, mixing letters, numbers and symbols — or a phrase of 14+ characters."
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            <Field
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              error={mismatch ? 'The two passwords do not match.' : undefined}
              onChange={(event) => setConfirmation(event.target.value)}
            />

            <button
              type="submit"
              className={`${btnPrimary} w-full`}
              disabled={submitting || mismatch || !password}
            >
              {submitting ? <Spinner /> : 'Set new password'}
            </button>
          </form>
        </Card>

        <p className="mt-5 text-center text-sm text-ink-2">
          <Link to="/crm/login" className={link}>
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
