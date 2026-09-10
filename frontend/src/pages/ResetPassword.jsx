import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { useToast } from '../components/Toast';
import {
  Button,
  ButtonLink,
  Card,
  ErrorBanner,
  useFormValidation,
  validators,
} from '../components/common';
import { link } from '../ui';
import AuthLayout, { PasswordField, StatusRegion } from './AuthLayout';

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
const RULES = { password: validators.password };

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);
  const errors = visibleErrors({ password });

  /*
   * The confirmation field is checked here and nowhere else, on purpose. It is
   * not a security control — the server has no opinion about it — it exists so
   * a typo in a password the user cannot see does not lock them out of the
   * account they are in the middle of recovering.
   *
   * It reports LIVE rather than on blur, unlike every other field on these
   * screens: the second box is the last thing anyone types, so waiting for a
   * blur that may never come would mean the mismatch is only ever announced by
   * a disabled button with no explanation next to it.
   */
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
      <AuthLayout
        eyebrow="Password reset"
        title="This link is incomplete"
        subtitle="It may have been cut short by your email client. Please request a new one."
        footer={
          <Link to="/crm/login" className={link}>
            Back to sign in
          </Link>
        }
      >
        <Card className="p-6 shadow-lift sm:p-7">
          <p className="text-sm leading-relaxed text-ink-2">
            Reset links are long, and some email programs wrap them across two lines. Copying the
            whole link usually fixes it — otherwise start again from here.
          </p>
          <ButtonLink to="/crm/forgot-password" className="mt-5 w-full">
            Request a new link
          </ButtonLink>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow="Password reset"
      title="Choose a new password"
      subtitle="This signs you out on every device."
      footer={
        <Link to="/crm/login" className={link}>
          Back to sign in
        </Link>
      }
    >
      <Card className="p-6 shadow-lift sm:p-7">
        <StatusRegion>
          <ErrorBanner message={error} onDismiss={() => setError('')} />
        </StatusRegion>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <PasswordField
            label="New password"
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
            label="Confirm new password"
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
            loadingLabel="Saving…"
            disabled={mismatch || !password}
          >
            Set new password
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}
