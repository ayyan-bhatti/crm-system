import { useState } from 'react';
import { usersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import {
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  Spinner,
  StatusBadge,
  SuccessBanner,
} from '../../components/common';
import { useAuth } from '../../context/AuthContext';
import { ROLE_VALUES } from '../../constants';
import { btnDanger, btnPrimary, formatDate, humanize, input, td, th } from '../../ui';

/**
 * Admin-only user management: list users, change roles, add and remove accounts.
 *
 * This is the counterpart to the registration rule — public sign-ups are always
 * sales reps, and this screen is where an admin promotes someone.
 */
export default function UserList() {
  const { user: currentUser } = useAuth();
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [showForm, setShowForm] = useState(false);

  const { data, loading, error, reload } = useFetch(() => usersApi.list(), []);

  async function changeRole(id, role) {
    setActionError('');
    setNotice('');

    try {
      await usersApi.update(id, { role });
      setNotice('Role updated.');
      reload();
    } catch (err) {
      setActionError(errorMessage(err, 'Could not update the role'));
    }
  }

  async function removeUser(id, name) {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;

    setActionError('');
    setNotice('');

    try {
      await usersApi.remove(id);
      setNotice('User deleted.');
      reload();
    } catch (err) {
      setActionError(errorMessage(err, 'Could not delete the user'));
    }
  }

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Manage who can access SimpleCRM and what they can do."
        action={
          <button type="button" className={btnPrimary} onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Close' : 'New user'}
          </button>
        }
      />

      <ErrorBanner message={actionError || error} onDismiss={() => setActionError('')} />
      <SuccessBanner message={notice} />

      {showForm && (
        <NewUserForm
          onCreated={() => {
            setShowForm(false);
            setNotice('User created.');
            reload();
          }}
          onError={setActionError}
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
                      <td className={td}>{formatDate(user.createdAt)}</td>
                      <td className={`${td} text-right`}>
                        {!isSelf && (
                          <button
                            type="button"
                            className="text-sm font-medium text-critical-ink hover:underline"
                            onClick={() => removeUser(user._id, user.name)}
                          >
                            Delete
                          </button>
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
function NewUserForm({ onCreated, onError }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'sales_rep' });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);

    try {
      await usersApi.create(form);
      onCreated();
    } catch (err) {
      onError(errorMessage(err, 'Could not create the user'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-4 p-5">
      <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-4">
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
        <Field
          label="Password"
          type="password"
          required
          minLength={8}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <Field label="Role">
          <select
            className={input}
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {ROLE_VALUES.map((role) => (
              <option key={role} value={role}>
                {humanize(role)}
              </option>
            ))}
          </select>
        </Field>

        <div className="sm:col-span-4">
          <button type="submit" className={btnPrimary} disabled={submitting}>
            {submitting ? <Spinner /> : 'Create user'}
          </button>
        </div>
      </form>
    </Card>
  );
}
