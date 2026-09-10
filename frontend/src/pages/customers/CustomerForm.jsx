import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { customersApi, usersApi } from '../../api/resources';
import ConsentCheckboxes from '../../components/ConsentCheckboxes';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import {
  Breadcrumb,
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
  Spinner,
  Textarea,
  useFormValidation,
  validators,
} from '../../components/common';
import { CUSTOMER_STATUSES } from '../../constants';
import { humanize } from '../../ui';

/**
 * Create and edit share one component.
 *
 * The two screens differ only in whether they load an existing record first and
 * which API call they submit to — duplicating the twelve form fields to keep
 * them separate would mean every future field change has to be made twice.
 *
 * THE FORM IS SECTIONED, and that is not decoration. A single stack of twelve
 * controls asks the reader to work out for themselves which of them belong
 * together; three headed sections say it. It also gives every group a place to
 * carry one line of explanation, which is where "why does this form want a
 * consent tick?" gets answered rather than in a support call.
 */

/**
 * Defined at module scope so its identity is stable across renders — the
 * validation hook memoises on it.
 */
const RULES = {
  name: validators.required('Name'),
  email: validators.email,
  phone: validators.phone,
};

export default function CustomerForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { can } = usePermissions();

  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    address: '',
    company: '',
    city: '',
    status: 'lead',
    notes: '',
    assignedTo: '',
    emailOptIn: false,
    smsOptIn: false,
    whatsappOptIn: false,
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * Client-side validation that only speaks once the user has had their turn —
   * nothing is reported until a field has been blurred or the form submitted.
   * See the long note on `useFormValidation`.
   */
  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);
  const errors = visibleErrors(form);

  /*
   * A successful save navigates to the customer's detail page, so the
   * confirmation goes through the toast system. The FAILURE stays as an inline
   * banner on purpose: the user is still on the form, still looking at the
   * fields that need fixing, and a message that floats away after four seconds
   * is the wrong place for something they have to act on.
   */
  const toast = useToast();

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
      address: existing.address || '',
      company: existing.company || '',
      city: existing.city || '',
      status: existing.status || 'lead',
      notes: existing.notes || '',
      assignedTo: existing.assignedTo?._id || '',
      // Read out of the stored channel-keyed block into the flat names the
      // checkboxes and the API speak. See models/marketingConsent.js.
      emailOptIn: Boolean(existing.marketing?.email?.optIn),
      smsOptIn: Boolean(existing.marketing?.sms?.optIn),
      whatsappOptIn: Boolean(existing.marketing?.whatsapp?.optIn),
    });
  }, [existing]);

  // Only managers and admins may reassign, matching the API rule — a sales rep
  // sending `assignedTo` gets a 403, so the control is hidden rather than
  // offered and then rejected. The rule itself lives in hooks/usePermissions,
  // so it cannot drift from the same rule applied on other screens.
  const canReassign = can.reassignRecords;

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  /** Wires a text field to its value, its error and its blur in one place. */
  function fieldProps(field) {
    return {
      value: form[field],
      error: errors[field],
      onChange: (event) => update(field, event.target.value),
      onBlur: () => markTouched(field),
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();

    // Stops here rather than sending something the server will only refuse.
    // `validate` also flips every field to "reported", so nothing stays hidden.
    if (!validate(form)) return;

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

      toast.success(isEdit ? 'Changes saved.' : `${saved.name} added.`);
      navigate(`/crm/customers/${saved._id}`, { replace: true });
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
      <div className="mx-auto max-w-3xl">
        <Breadcrumb
          className="mb-3"
          items={[{ label: 'Customers', to: '/crm/customers' }, { label: 'Edit customer' }]}
        />
        <PageHeader eyebrow="Customer" title="Edit customer" />
        <ErrorBanner message={loadError} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Breadcrumb
        className="mb-3"
        items={[
          { label: 'Customers', to: '/crm/customers' },
          ...(isEdit && existing ? [{ label: existing.name, to: `/crm/customers/${id}` }] : []),
          { label: isEdit ? 'Edit' : 'New customer' },
        ]}
      />

      <PageHeader
        eyebrow="Customer"
        title={isEdit ? 'Edit customer' : 'New customer'}
        subtitle={
          isEdit
            ? 'Changes take effect as soon as you save. Consent changes are written to the audit trail.'
            : 'Only a name and an email are required — everything else can be filled in later.'
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {/*
        `noValidate` because this form shows its own messages. The native
        bubble suppresses them, and it cannot say anything useful about why a
        field matters.
      */}
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <Section
          title="Who they are"
          description="The details anyone would need to reach this account."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              required
              placeholder="Karachi Textiles"
              autoComplete="organization"
              {...fieldProps('name')}
            />
            <Field
              label="Email"
              type="email"
              required
              inputMode="email"
              autoComplete="email"
              placeholder="orders@karachitextiles.com"
              hint="Used to match this customer to any storefront orders they place."
              {...fieldProps('email')}
            />
            <Field
              label="Phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+92 300 1234567"
              hint="Needed if they place an order."
              {...fieldProps('phone')}
            />
            <Field
              label="Company"
              placeholder="Karachi Textiles Ltd"
              autoComplete="organization"
              {...fieldProps('company')}
            />
            <Field label="City" placeholder="Karachi" {...fieldProps('city')} />

            {/*
              A textarea and one free-text block, not street/postcode/country
              boxes. Address formats differ by country — postcodes are optional
              in some and structured differently in others — so a fixed set of
              fields forces every address that does not fit into the wrong one.
              Nothing here sorts or validates on the parts, so splitting them
              would buy nothing and cost a class of unenterable addresses.

              Spans both columns because an address is the one field on this
              form that genuinely needs the width.
            */}
            <div className="sm:col-span-2">
              <Field
                label="Address"
                hint="Optional unless an order needs delivery — where deliveries go. Shown to the rep working an order for this customer."
              >
                <Textarea
                  rows={3}
                  placeholder={'Plot 14, Korangi Industrial Area\nKarachi 74900'}
                  value={form.address}
                  onChange={(e) => update('address', e.target.value)}
                />
              </Field>
            </div>
          </div>
        </Section>

        <Section
          title="Ownership"
          description="Where this account sits in the pipeline, and who is looking after it."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Status" hint="Move a lead to active once they have bought something.">
              <Select value={form.status} onChange={(e) => update('status', e.target.value)}>
                {CUSTOMER_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </Select>
            </Field>

            {canReassign && (
              <Field label="Assigned to" hint="Leave blank to assign later.">
                <Select
                  value={form.assignedTo}
                  onChange={(e) => update('assignedTo', e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {(users || []).map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name} ({u.role})
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <div className="sm:col-span-2">
              <Field
                label="Notes"
                hint="Up to 2,000 characters. Visible to everyone who can open this account."
              >
                <Textarea
                  rows={4}
                  maxLength={2000}
                  value={form.notes}
                  onChange={(e) => update('notes', e.target.value)}
                  placeholder="Anything worth remembering about this account."
                />
              </Field>
            </div>
          </div>
        </Section>

        {/*
          Marketing consent.

          THREE SEPARATE BOXES, and every one starts unchecked — for a new
          customer because the schema defaults them off, and on an edit because
          they are read from what is actually stored. There is no code path
          through this form that produces an opted-in customer without somebody
          ticking a box.

          The warning is not decoration. A rep can type a customer in from a
          business card, and a business card is not consent. Every change here
          is written to the audit trail against the name of whoever made it,
          which is exactly the record a complaint gets checked against.
        */}
        <Section
          title="Marketing consent"
          description="Nothing is ticked by default, and nothing here is inferred from a purchase."
        >
          <ConsentCheckboxes
            legend="Marketing consent"
            hint="Only tick these if this person has actually agreed to be contacted this way. Changes are recorded in the audit trail against your name."
            value={form}
            onChange={(next) => setForm((prev) => ({ ...prev, ...next }))}
          />
        </Section>

        {/*
          THE ACTION BAR STICKS TO THE BOTTOM OF THE VIEWPORT.

          A four-section form is taller than a laptop screen, and a save button
          that has to be scrolled to is a save button people forget is there.
          Sticky on desktop only — on a phone the browser chrome already eats
          the bottom of the screen, and a bar pinned over it is worse than one
          at the end of the content.
        */}
        <div className="sticky bottom-0 -mx-1 border-t border-hairline bg-plane/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-plane/80">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              loading={submitting}
              loadingLabel={isEdit ? 'Saving…' : 'Creating…'}
            >
              {isEdit ? 'Save changes' : 'Create customer'}
            </Button>
            <Button variant="secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <p className="text-xs text-muted">
              {isEdit ? 'Saving returns you to this customer.' : 'Required fields are marked *.'}
            </p>
          </div>
        </div>
      </form>
    </div>
  );
}

/** One headed group of fields, with the sentence that explains why it exists. */
function Section({ title, description, children }) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 border-b border-hairline pb-4">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
      </div>
      {children}
    </Card>
  );
}
