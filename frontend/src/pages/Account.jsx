import { useState } from 'react';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../components/common';
import { btnPrimary, formatDate, humanize } from '../ui';

/**
 * The signed-in user's own account: who they are, and changing their password.
 *
 * WHY THIS PAGE EXISTS
 *
 * `POST /api/auth/change-password` had been built, tested and documented — and
 * nothing in the UI called it. From a user's point of view that is not a
 * feature, it is an endpoint. An audit of the frontend wiring is what turned it
 * up, which is the argument for auditing wiring separately from implementation.
 *
 * WHY THE ERROR IS INLINE AND THE SUCCESS IS A TOAST
 *
 * A rejected password is something the user must act on while looking at the
 * field they need to fix, so it stays on the page. The success navigates
 * nowhere, but a toast is still right: the form clears itself, and without a
 * message the screen would simply go blank with no indication anything
 * happened.
 */
export default function Account() {
  const { user } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmation: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  async function handleResend() {
    setResending(true);
    try {
      const result = await authApi.resendVerification();
      toast.success(result.message || 'Verification email sent.');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the verification email'));
    } finally {
      setResending(false);
    }
  }

  /*
   * Checked here and nowhere else. The server has no opinion about the
   * confirmation field — it exists so a typo in a password nobody can see does
   * not lock someone out of their own account.
   */
  const mismatch = form.confirmation.length > 0 && form.newPassword !== form.confirmation;

  const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function handleSubmit(event) {
    event.preventDefault();

    if (form.newPassword !== form.confirmation) {
      setError('The two new passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await authApi.changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });

      toast.success('Password changed. Every other device has been signed out.');
      setForm({ currentPassword: '', newPassword: '', confirmation: '' });
    } catch (err) {
      setError(errorMessage(err, 'Could not change the password'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Your account" subtitle="Your details, and your password." />

      <Card className="p-5">
        <h2 className="mb-4 text-base font-semibold text-ink">Details</h2>
        <dl className="space-y-3 text-sm">
          <Detail label="Name">{user.name}</Detail>
          <Detail label="Email">{user.email}</Detail>
          <Detail label="Role">{humanize(user.role)}</Detail>
          <Detail label="Member since">{formatDate(user.createdAt)}</Detail>
          <Detail label="Email confirmed">
            {user.emailVerified ? (
              'Yes'
            ) : (
              <span className="inline-flex items-center gap-2">
                Not yet
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resending}
                  className="text-xs font-medium text-brand hover:underline disabled:opacity-50"
                >
                  {resending ? 'Sending…' : 'Resend'}
                </button>
              </span>
            )}
          </Detail>
        </dl>
        <p className="mt-4 border-t border-hairline pt-3 text-xs text-muted">
          Your name, email and role are managed by an administrator. Confirming your email is
          optional — nothing here depends on it.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Change password</h2>
        <p className="mt-1 mb-4 text-sm text-ink-2">
          Changing your password signs you out on every other device. This one stays signed
          in.
        </p>

        <ErrorBanner message={error} onDismiss={() => setError('')} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={form.currentPassword}
            onChange={set('currentPassword')}
          />

          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            hint="At least 10 characters, mixing letters, numbers and symbols — or a phrase of 14+ characters."
            value={form.newPassword}
            onChange={set('newPassword')}
          />

          <Field
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirmation}
            error={mismatch ? 'The two new passwords do not match.' : undefined}
            onChange={set('confirmation')}
          />

          <button
            type="submit"
            className={btnPrimary}
            disabled={submitting || mismatch || !form.currentPassword || !form.newPassword}
          >
            {submitting ? <Spinner /> : 'Change password'}
          </button>
        </form>
      </Card>
    </div>
  );
}

function Detail({ label, children }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}
