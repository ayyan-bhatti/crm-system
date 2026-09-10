import { useState } from 'react';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  StatusBadge,
} from '../components/common';
import { formatDate } from '../ui';

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
   *
   * REPORTED AS SOON AS THE SECOND FIELD HAS ANYTHING IN IT, rather than on
   * blur like the rest of the app's validation. Two password fields are the one
   * case where waiting is wrong: the user cannot see either value, so the only
   * way they learn they mistyped is this message, and the sooner it appears the
   * fewer characters they have to retype.
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
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow="You"
        title="Your account"
        subtitle="Your details, and your password."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] lg:items-start">
        {/* --- Who you are ------------------------------------------------ */}
        <Card className="p-5">
          <div className="border-b border-hairline pb-4">
            <p className="label-mono">Profile</p>
            <h2 className="mt-1 text-base font-semibold text-ink">Details</h2>
          </div>

          <dl className="mt-4 space-y-4">
            <Fact label="Name">{user.name}</Fact>
            <Fact label="Email">{user.email}</Fact>
            <Fact label="Role">
              <StatusBadge value={user.role} />
            </Fact>
            <Fact label="Member since">{formatDate(user.createdAt)}</Fact>
            <Fact label="Email confirmed">
              {user.emailVerified ? (
                'Yes'
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  Not yet
                  <Button variant="ghost" size="sm" loading={resending} loadingLabel="Sending…" onClick={handleResend}>
                    Resend
                  </Button>
                </span>
              )}
            </Fact>
          </dl>

          <p className="mt-5 border-t border-hairline pt-4 text-xs leading-relaxed text-muted">
            Your name, email and role are managed by an administrator. Confirming your email is
            optional — nothing here depends on it.
          </p>
        </Card>

        {/* --- Changing your password ------------------------------------- */}
        <Card className="p-5 sm:p-6">
          <div className="border-b border-hairline pb-4">
            <p className="label-mono">Security</p>
            <h2 className="mt-1 text-base font-semibold text-ink">Change password</h2>
            <p className="mt-1 text-sm text-ink-2">
              Changing your password signs you out on every other device. This one stays signed in.
            </p>
          </div>

          <div className="mt-5">
            <ErrorBanner message={error} onDismiss={() => setError('')} />
          </div>

          {/* `noValidate` — the messages below are ours, and the native bubble
              suppresses them. */}
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <Field
              label="Current password"
              type="password"
              autoComplete="current-password"
              placeholder="The one you use today"
              required
              value={form.currentPassword}
              onChange={set('currentPassword')}
            />

            <Field
              label="New password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 10 characters"
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
              placeholder="Type it again"
              required
              value={form.confirmation}
              error={mismatch ? 'The two new passwords do not match.' : undefined}
              onChange={set('confirmation')}
            />

            <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-hairline bg-surface/95 pt-4 backdrop-blur">
              <Button
                type="submit"
                loading={submitting}
                loadingLabel="Changing…"
                disabled={mismatch || !form.currentPassword || !form.newPassword}
              >
                Change password
              </Button>
              <p className="text-xs text-muted">You stay signed in on this device.</p>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}

/** One key/value pair, with real `<dt>`/`<dd>` semantics. */
function Fact({ label, children }) {
  return (
    <div>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}
