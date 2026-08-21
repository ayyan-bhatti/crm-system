import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import useFetch from '../hooks/useFetch';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { Card, ErrorBanner, Field, Spinner } from '../components/common';
import { btnPrimary, humanize, link } from '../ui';

/**
 * Accepting an invitation: choose a password, activate the account.
 *
 * THE PAGE SHOWS WHO THE INVITE IS FOR BEFORE ASKING FOR A PASSWORD.
 *
 * It loads the invite first and greets the person by name, with the role they
 * are accepting. That is not decoration — being asked to invent a password by
 * an anonymous box reached from an email link is indistinguishable from a
 * phishing page, and the one thing that makes it feel legitimate is the page
 * already knowing who you are and what you were offered.
 *
 * It also means an expired or already-used invite is reported on arrival,
 * rather than after the person has chosen and typed a password twice.
 */
export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useAuth();

  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const {
    data: invite,
    loading,
    error: inviteError,
  } = useFetch(() => (token ? authApi.getInvite(token) : null), [token]);

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
      await authApi.acceptInvite({ token, password });

      /*
       * The API signs the new user in as part of accepting, so the session
       * cookies already exist — but this tab's auth context does not know that
       * yet. Refreshing it means they land on the dashboard signed in, rather
       * than being bounced to /login by the route guard.
       */
      await refresh();

      toast.success('Welcome to SimpleCRM.');
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not activate the account'));
      setSubmitting(false);
    }
  }

  if (!token) return <InviteProblem message="This invitation link is incomplete." />;
  if (loading) return <Spinner full />;
  if (inviteError) return <InviteProblem message={inviteError} />;
  if (!invite) return null;

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white shadow-lift">
            S
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Welcome, {invite.name.split(' ')[0]}
          </h1>
          <p className="mt-1.5 text-sm text-ink-2">
            Choose a password to activate your SimpleCRM account.
          </p>
        </div>

        <Card className="p-6 shadow-lift">
          {/* What they are accepting, stated plainly. */}
          <dl className="mb-5 space-y-1.5 rounded-lg bg-plane p-3 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Email</dt>
              <dd className="truncate font-medium text-ink">{invite.email}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Role</dt>
              <dd className="font-medium text-ink">{humanize(invite.role)}</dd>
            </div>
          </dl>

          <ErrorBanner message={error} onDismiss={() => setError('')} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              hint="At least 10 characters, mixing letters, numbers and symbols — or a phrase of 14+ characters."
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            <Field
              label="Confirm password"
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
              {submitting ? <Spinner /> : 'Activate my account'}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}

/**
 * An invite that cannot be used. Deliberately does NOT offer a "request a new
 * one" action, because unlike a password reset the recipient cannot issue
 * themselves another — only an administrator can.
 */
function InviteProblem({ message }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm p-6 text-center shadow-lift">
        <p className="text-sm font-medium text-ink">This invitation cannot be used</p>
        <p className="mt-2 text-sm text-ink-2">{message}</p>
        <p className="mt-4 text-xs text-muted">
          Ask whoever invited you to send a new invitation.
        </p>
        <p className="mt-5 text-sm">
          <Link to="/login" className={link}>
            Back to sign in
          </Link>
        </p>
      </Card>
    </div>
  );
}
