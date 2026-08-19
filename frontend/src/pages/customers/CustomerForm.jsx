import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { customersApi, usersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../../components/common';
import { useAuth } from '../../context/AuthContext';
import { CUSTOMER_STATUSES, FULL_ACCESS_ROLES } from '../../constants';
import { btnPrimary, btnSecondary, input } from '../../ui';

/**
 * Create and edit share one component.
 *
 * The two screens differ only in whether they load an existing record first and
 * which API call they submit to — duplicating the twelve form fields to keep
 * them separate would mean every future field change has to be made twice.
 */
export default function CustomerForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { user } = useAuth();

  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    city: '',
    status: 'lead',
    notes: '',
    assignedTo: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * `loadError` is destructured deliberately — it used to be dropped.
   *
   * When loading the record failed (deleted since the link was made, no
   * permission, network down) the screen rendered an EMPTY form with no
   * indication anything was wrong. Pressing "Save changes" then PATCHed the
   * record with blank fields, so a failure to READ turned into data loss on
   * WRITE. Caught by a test asserting the message appears.
   */
  const { data: existing, loading, error: loadError } = useFetch(
    () => (isEdit ? customersApi.get(id) : null),
    [id]
  );

  const { data: users } = useFetch(() => usersApi.assignable(), []);

  // Populate the form once the record arrives.
  useEffect(() => {
    if (!existing) return;
    setForm({
      name: existing.name || '',
      email: existing.email || '',
      phone: existing.phone || '',
      company: existing.company || '',
      city: existing.city || '',
      status: existing.status || 'lead',
      notes: existing.notes || '',
      assignedTo: existing.assignedTo?._id || '',
    });
  }, [existing]);

  // Only managers and admins may reassign, matching the API rule — a sales rep
  // sending `assignedTo` gets a 403, so the control is hidden rather than
  // offered and then rejected.
  const canReassign = FULL_ACCESS_ROLES.includes(user.role);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    // Strip the assignment field entirely when the user isn't allowed to set it.
    const payload = { ...form };
    if (!canReassign) delete payload.assignedTo;
    else if (!payload.assignedTo) payload.assignedTo = null;

    try {
      const saved = isEdit
        ? await customersApi.update(id, payload)
        : await customersApi.create(payload);
      navigate(`/customers/${saved._id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not save customer'));
      setSubmitting(false);
    }
  }

  if (isEdit && loading) return <Spinner full />;

  /*
   * A record that could not be loaded gets the error and nothing else. Showing
   * the form as well would invite the user to save over a record we never read.
   */
  if (isEdit && loadError) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Edit customer" />
        <ErrorBanner message={loadError} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={isEdit ? 'Edit customer' : 'New customer'} />

      <Card className="p-6">
        <ErrorBanner message={error} onDismiss={() => setError('')} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              required
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
            />
            <Field
              label="Email"
              type="email"
              required
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
            />
            <Field label="Phone" value={form.phone} onChange={(e) => update('phone', e.target.value)} />
            <Field
              label="Company"
              value={form.company}
              onChange={(e) => update('company', e.target.value)}
            />
            <Field label="City" value={form.city} onChange={(e) => update('city', e.target.value)} />

            <Field label="Status">
              <select
                className={input}
                value={form.status}
                onChange={(e) => update('status', e.target.value)}
              >
                {CUSTOMER_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {canReassign && (
            <Field label="Assigned to">
              <select
                className={input}
                value={form.assignedTo}
                onChange={(e) => update('assignedTo', e.target.value)}
              >
                <option value="">Unassigned</option>
                {(users || []).map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Notes">
            <textarea
              className={`${input} min-h-28`}
              maxLength={2000}
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
              placeholder="Anything worth remembering about this account."
            />
          </Field>

          <div className="flex gap-3 pt-2">
            <button type="submit" className={btnPrimary} disabled={submitting}>
              {submitting ? <Spinner /> : isEdit ? 'Save changes' : 'Create customer'}
            </button>
            <button type="button" className={btnSecondary} onClick={() => navigate(-1)}>
              Cancel
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
