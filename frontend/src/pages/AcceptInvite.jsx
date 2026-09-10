import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import useFetch from '../hooks/useFetch';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import {
  Button,
  Card,
  ErrorBanner,
  Spinner,
  useFormValidation,
  validators,
} from '../components/common';
import { humanize, link } from '../ui';
import AuthLayout, { PasswordField, StatusRegion } from './AuthLayout';

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
const RULES = { password: validators.password };

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

  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);
  const errors = visibleErrors({ password });

  /* Live rather than on blur — see the note in ResetPassword. */
  const mismatch = confirmation.length > 0 && password !== confirmation;

  async function handleSubmit(event) {
    event.preventDefault();

    if (password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }
    if (!validate({ password })) return;

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
      navigate('/crm', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not activate the account'));
      setSubmitting(false);
    }
  }

  if (!token) return <InviteProblem message="This invitation link is incomplete." />;

  if (loading) {
    return (
      <AuthLayout
        eyebrow="Invitation"
        title="Checking your invitation"
        subtitle="One moment — we are confirming the link is still valid."
        live
      >
        <Card className="p-6 shadow-lift sm:p-7">
          <Spinner full />
        </Card>
      </AuthLayout>
    );
  }

  if (inviteError) return <InviteProblem message={inviteError} />;
  if (!invite) return null;

  return (
    <AuthLayout
      eyebrow="Invitation"
      title={`Welcome, ${invite.name.split(' ')[0]}`}
      subtitle="Choose a password to activate your SimpleCRM account."
    >
      <Card className="p-6 shadow-lift sm:p-7">
        {/* What they are accepting, stated plainly. */}
        <dl className="mb-5 divide-y divide-hairline rounded-lg border border-hairline bg-plane px-4 text-sm">
          <div className="flex items-baseline justify-between gap-3 py-2.5">
            <dt className="shrink-0 text-muted">Email</dt>
            <dd className="min-w-0 truncate font-medium text-ink">{invite.email}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2.5">
            <dt className="shrink-0 text-muted">Role</dt>
            <dd className="font-medium text-ink">{humanize(invite.role)}</dd>
          </div>
        </dl>

        <StatusRegion>
          <ErrorBanner message={error} onDismiss={() => setError('')} />
        </StatusRegion>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <PasswordField
            label="Password"
            autoComplete="new-password"
            placeholder="At least 10 characters"
            required
            minLength={10}
            hint="At least 10 characters, mixing letters, numbers and symbols — or a phrase of 14+ characters."
            value={password}
            error={errors.password}
            onBlur={() => markTouched('password')}
            onChange={(event) => setPassword(event.target.value)}
          />

          <PasswordField
            label="Confirm password"
            autoComplete="new-password"
            placeholder="Type it again"
            required
            value={confirmation}
            error={mismatch ? 'Passwords do not match.' : undefined}
            onChange={(event) => setConfirmation(event.target.value)}
          />

          <Button
            type="submit"
            className="w-full"
            loading={submitting}
            loadingLabel="Activating…"
            disabled={mismatch || !password}
          >
            Activate my account
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}

/**
 * An invite that cannot be used. Deliberately does NOT offer a "request a new
 * one" action, because unlike a password reset the recipient cannot issue
 * themselves another — only an administrator can.
 */
function InviteProblem({ message }) {
  return (
    <AuthLayout
      eyebrow="Invitation"
      title="This invitation cannot be used"
      footer={
        <Link to="/crm/login" className={link}>
          Back to sign in
        </Link>
      }
    >
      <Card className="p-6 shadow-lift sm:p-7">
        <div className="flex items-start gap-3 rounded-lg border border-critical/25 bg-critical-wash px-4 py-3 text-sm text-critical-ink">
          <svg
            viewBox="0 0 20 20"
            className="mt-0.5 h-4 w-4 shrink-0 fill-current"
            aria-hidden="true"
          >
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
          </svg>
          <p>{message}</p>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          Ask whoever invited you to send a new invitation.
        </p>
      </Card>
    </AuthLayout>
  );
}
