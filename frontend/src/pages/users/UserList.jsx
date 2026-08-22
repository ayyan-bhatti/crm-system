import { useEffect, useState } from 'react';
import { usersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import {
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../../components/common';
import { useAuth } from '../../context/AuthContext';
import PendingApprovals from './PendingApprovals';
import { ROLE_VALUES, ROLES } from '../../constants';
import { btnPrimary, btnSecondary, formatDate, humanize, input, td, th } from '../../ui';

/**
 * Admin-only user management: list users, change roles, add and remove accounts.
 *
 * This is the counterpart to the registration rule — public sign-ups are always
 * sales reps, and this screen is where an admin promotes someone.
 */
export default function UserList() {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);

  /*
   * The invite link, when the server could not email it.
   *
   * Held in page state rather than shown in a toast, deliberately. A toast
   * disappears after a few seconds, and this is a long single-use URL the admin
   * has to copy and pass on — losing it means re-issuing the invite. It stays
   * until dismissed.
   */
  const [pendingLink, setPendingLink] = useState(null);

  // The user whose details are being corrected, if any.
  const [editing, setEditing] = useState(null);

  const { data, loading, error, reload } = useFetch(() => usersApi.list(), []);

  async function changeRole(id, role) {
    try {
      await usersApi.update(id, { role });
      // Role changes are the most consequential write on this screen and are
      // recorded in the audit trail; a visible confirmation matters.
      toast.success('Role updated.');
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the role'));
    }
  }

  /**
   * Deactivate or reactivate.
   *
   * Deactivation is the offboarding action, not deletion: deleting the account
   * would orphan every customer and order that references it as `createdBy`,
   * and the audit trail would lose the name behind past actions. It also takes
   * effect immediately — the API revokes their sessions and `protect` refuses
   * their next request.
   */
  async function setStatus(id, name, status) {
    const deactivating = status === 'deactivated';

    if (
      deactivating &&
      !window.confirm(
        `Deactivate ${name}? They will be signed out immediately and cannot sign in again ` +
          'until reactivated.'
      )
    ) {
      return;
    }

    try {
      await usersApi.setStatus(id, status);
      toast.success(deactivating ? `${name} deactivated.` : `${name} reactivated.`);
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not change the account status'));
    }
  }

  /**
   * What to do with an invite response, whether it came from the form or the
   * re-send button.
   *
   * The server tells us whether an email actually left the building. When it
   * did not — which is every deployment without a mail transport configured —
   * it hands back the link instead of pretending, and the admin sends it on
   * themselves.
   */
  function handleInviteResult(result, email) {
    const link = result?.meta?.inviteLink;

    if (link) {
      setPendingLink({ email, link });
    } else {
      setPendingLink(null);
      toast.success(result?.message || `Invitation sent to ${email}.`);
    }

    reload();
  }

  /** Send a fresh invitation to someone who has not accepted yet. */
  async function resendInvite(user) {
    try {
      const result = await usersApi.invite({
        name: user.name,
        email: user.email,
        role: user.role,
      });
      handleInviteResult(result, user.email);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not re-send the invitation'));
    }
  }

  async function removeUser(id, name) {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;

    try {
      await usersApi.remove(id);
      toast.success(`${name} deleted.`);
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the user'));
    }
  }

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Invite colleagues, manage their roles, and deactivate people who have left."
        action={
          <button type="button" className={btnPrimary} onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Close' : 'Invite user'}
          </button>
        }
      />

      {/* The list's own load failure stays inline — it explains why the table
          below is empty, so it belongs next to the table rather than floating
          past. Action results go to toasts. */}
      <ErrorBanner message={error} />

      {showForm && (
        <InviteUserForm
          onInvited={(result, email) => {
            setShowForm(false);
            handleInviteResult(result, email);
          }}
          onError={(message) => toast.error(message)}
        />
      )}

      {/*
        The approvals queue, above everything else on the screen. It renders
        nothing at all when nobody is waiting, so it costs no space in the
        normal case and is impossible to miss in the one that matters.
      */}
      <PendingApprovals onDecided={reload} />

      {editing && (
        <EditUserForm
          user={editing}
          onCancel={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            toast.success(`${name} updated.`);
            reload();
          }}
          onError={(message) => toast.error(message)}
        />
      )}

      {pendingLink && (
        <InviteLinkPanel
          email={pendingLink.email}
          link={pendingLink.link}
          onDismiss={() => setPendingLink(null)}
        />
      )}

      <Card>
        {loading ? (
          <Spinner full />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-hairline bg-plane">
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Email</th>
                  <th className={th}>Role</th>
                  <th className={th}>Status</th>
                  <th className={th}>Joined</th>
                  <th className={`${th} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {(data?.data || []).map((user) => {
                  const isSelf = user._id === currentUser._id;

                  return (
                    <tr key={user._id} className="hover:bg-plane">
                      <td className={td}>
                        {user.name}
                        {isSelf && <span className="ml-2 text-xs text-muted">(you)</span>}
                      </td>
                      <td className={td}>{user.email}</td>
                      <td className={td}>
                        {/*
                          Editing your own role is disabled: the API also blocks
                          self-deletion, and demoting yourself would lock the
                          last admin out of this screen.
                        */}
                        {isSelf ? (
                          <StatusBadge value={user.role} />
                        ) : (
                          <select
                            className={`${input} w-36`}
                            value={user.role}
                            onChange={(e) => changeRole(user._id, e.target.value)}
                          >
                            {ROLE_VALUES.map((role) => (
                              <option key={role} value={role}>
                                {humanize(role)}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className={td}>
                        {/*
                          Pending means invited but not yet activated — the
                          account exists and holds its role, but has no password
                          and cannot sign in. Showing it here is what makes an
                          un-accepted invite visible rather than a mystery.
                        */}
                        <StatusBadge value={user.status} />
                      </td>
                      <td className={td}>{formatDate(user.createdAt)}</td>
                      <td className={`${td} text-right`}>
                        {!isSelf && (
                          <div className="flex items-center justify-end gap-3">
                            {/*
                              Correcting a name or email. PATCH /api/users/:id
                              has always supported both; nothing in the UI
                              called it, so a typo in a colleague's address was
                              unfixable without a database console.
                            */}
                            <button
                              type="button"
                              className="text-sm font-medium text-ink-2 hover:underline"
                              onClick={() => setEditing(user)}
                            >
                              Edit
                            </button>

                            {/*
                              Only for an INVITED account. A pending sign-up
                              request is also `pending`, but that person already
                              has a password and needs a decision, not another
                              link — re-sending would mint an invite token for an
                              account that has no use for one.
                            */}
                            {user.status === 'pending' && !user.requestedRole && (
                              <button
                                type="button"
                                className="text-sm font-medium text-brand hover:underline"
                                onClick={() => resendInvite(user)}
                              >
                                Re-send invite
                              </button>
                            )}

                            {user.status === 'active' && (
                              <button
                                type="button"
                                className="text-sm font-medium text-ink-2 hover:underline"
                                onClick={() => setStatus(user._id, user.name, 'deactivated')}
                              >
                                Deactivate
                              </button>
                            )}

                            {user.status === 'deactivated' && (
                              <button
                                type="button"
                                className="text-sm font-medium text-brand hover:underline"
                                onClick={() => setStatus(user._id, user.name, 'active')}
                              >
                                Reactivate
                              </button>
                            )}

                            <button
                              type="button"
                              className="text-sm font-medium text-critical-ink hover:underline"
                              onClick={() => removeUser(user._id, user.name)}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Inline create form. Unlike public registration, an admin picks the role. */
/**
 * The invite link, when the server had no way to email it.
 *
 * WHY THIS SCREEN SHOWS A LINK AT ALL.
 *
 * With no mail transport configured the invite only ever reached the server
 * log, while the UI cheerfully reported that an invitation had been sent. The
 * feature looked like it worked and did not — the admin waited, the invitee
 * waited, and the one copy of the link sat somewhere neither of them looks.
 *
 * Showing it is safe here specifically because of who is looking: the admin or
 * manager who just issued this invite, who chose the address and the role and
 * can re-issue or revoke it at will. It tells them nothing they did not already
 * control. The password-reset flow deliberately does NOT do this, because there
 * the requester is an anonymous member of the public claiming to own an inbox.
 *
 * It is a warning rather than a success, because something IS misconfigured and
 * an admin who never notices will keep hand-delivering links forever.
 */
function InviteLinkPanel({ email, link, onDismiss }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      // Reverts so the button can be used again, and so a stale "Copied"
      // does not imply the clipboard still holds this particular link.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused, and over plain HTTP the API is not
      // there at all. The input below is selectable, so there is always a way
      // to get the link out — no error needs raising.
      setCopied(false);
    }
  }

  return (
    <Card className="mb-4 border-warning/40 p-5">
      <h2 className="text-base font-semibold text-ink">
        Invite created — no email was sent
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        This deployment has no mail transport configured, so nothing was delivered to{' '}
        <span className="font-medium text-ink">{email}</span>. Send them this link yourself. It
        works once and expires in 7 days.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        {/*
          Read-only rather than disabled: a disabled input cannot be selected,
          which would remove the fallback for anyone whose browser refuses
          clipboard access.
        */}
        <input
          type="text"
          readOnly
          value={link}
          aria-label="Invitation link"
          onFocus={(e) => e.target.select()}
          className={`${input} font-mono text-xs`}
        />
        <button type="button" onClick={copy} className={`${btnPrimary} shrink-0`}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      <p className="mt-3 text-xs text-muted">
        To have SimpleCRM email invitations itself, set <code>MAIL_TRANSPORT</code>,{' '}
        <code>MAIL_WEBHOOK_URL</code> and <code>MAIL_WEBHOOK_AUTH</code> — see the README.
      </p>

      <button type="button" onClick={onDismiss} className="mt-3 text-sm text-muted underline">
        Dismiss
      </button>
    </Card>
  );
}

/**
 * Invite a colleague.
 *
 * NO PASSWORD FIELD, AND THAT IS THE POINT.
 *
 * This replaced a form where the admin typed a password and presumably told the
 * new hire what it was. That pattern has the admin knowing someone else's
 * credential, the password travelling through whatever channel they used to
 * pass it on, and — in practice — nobody ever changing it. Here the invitee
 * sets their own through a single-use link, so it is never transmitted and
 * never known to anyone else.
 */
function InviteUserForm({ onInvited, onError }) {
  const { user: currentUser } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', role: 'sales_rep' });
  const [submitting, setSubmitting] = useState(false);

  /*
   * A manager may invite, but not as an admin — the API enforces this and
   * returns 403. Hiding the option too means they are not offered a choice that
   * will be refused.
   */
  const assignableRoles = ROLE_VALUES.filter(
    (role) => role !== ROLES.ADMIN || currentUser.role === ROLES.ADMIN
  );

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);

    try {
      const result = await usersApi.invite(form);
      onInvited(result, form.email);
      setForm({ name: '', email: '', role: 'sales_rep' });
    } catch (err) {
      onError(errorMessage(err, 'Could not send the invitation'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-4 p-5">
      <h2 className="mb-1 text-base font-semibold text-ink">Invite a colleague</h2>
      <p className="mb-4 text-sm text-ink-2">
        They choose their own password through a single-use link, which expires in 7 days. If
        this deployment has no mail transport configured, the link is shown here for you to
        send on yourself.
      </p>

      <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Name"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label="Email"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <Field label="Role">
          <select
            className={input}
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {assignableRoles.map((role) => (
              <option key={role} value={role}>
                {humanize(role)}
              </option>
            ))}
          </select>
        </Field>

        <div className="sm:col-span-3">
          <button type="submit" className={btnPrimary} disabled={submitting}>
            {submitting ? <Spinner /> : 'Send invitation'}
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Correct a colleague's name or email.
 *
 * WHY THIS EXISTS AND WHY IT IS SO SMALL.
 *
 * `PATCH /api/users/:id` has always accepted `name` and `email`, and nothing in
 * the UI ever called it with either — the role dropdown sent `role` and that
 * was the whole of it. So a typo in a colleague's address was unfixable without
 * a database console, on a screen whose entire purpose is managing people.
 *
 * NO PASSWORD FIELD, and no role field either. The endpoint accepts a password
 * and this form deliberately does not offer one: an admin setting somebody
 * else's password means the admin knows a credential that is not theirs, which
 * is exactly the pattern the invite flow was built to remove. Someone who has
 * lost access uses the reset flow. The role has its own control in the table,
 * where the consequence of changing it is visible next to the person.
 *
 * Rendered as a panel above the table rather than a modal: the row it refers to
 * stays on screen, so there is no doubt about who is being edited.
 */
function EditUserForm({ user, onCancel, onSaved, onError }) {
  const [form, setForm] = useState({ name: user.name, email: user.email });
  const [saving, setSaving] = useState(false);

  // Re-prefills when the admin clicks Edit on a different row without closing
  // the panel first — otherwise the form would keep the previous person's
  // details and quietly write them over this one.
  useEffect(() => {
    setForm({ name: user.name, email: user.email });
  }, [user]);

  const unchanged = form.name === user.name && form.email === user.email;

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);

    try {
      await usersApi.update(user._id, { name: form.name, email: form.email });
      onSaved(form.name);
    } catch (err) {
      onError(errorMessage(err, 'Could not update the account'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-4 p-5">
      <h2 className="mb-1 text-base font-semibold text-ink">Edit {user.name}</h2>
      <p className="mb-4 text-sm text-ink-2">
        Their role is changed in the table, and passwords are only ever set by the account
        holder through a reset link.
      </p>

      <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label="Email"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />

        <div className="flex gap-3 sm:col-span-2">
          <button type="submit" className={btnPrimary} disabled={saving || unchanged}>
            {saving ? <Spinner /> : 'Save changes'}
          </button>
          <button type="button" className={btnSecondary} onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
