import { useState } from 'react';
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
import { ROLE_VALUES, ROLES } from '../../constants';
import { btnPrimary, formatDate, humanize, input, td, th } from '../../ui';

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

  /** Send a fresh invitation to someone who has not accepted yet. */
  async function resendInvite(user) {
    try {
      await usersApi.invite({ name: user.name, email: user.email, role: user.role });
      toast.success(`A new invitation has been sent to ${user.email}.`);
      reload();
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
          onInvited={(message) => {
            setShowForm(false);
            toast.success(message);
            reload();
          }}
          onError={(message) => toast.error(message)}
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
                            {user.status === 'pending' && (
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
      onInvited(result.message || `Invitation sent to ${form.email}.`);
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
        They will receive a link to choose their own password. The invitation expires in 7
        days.
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
