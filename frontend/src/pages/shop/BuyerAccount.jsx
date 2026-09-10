import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopAuthApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { Button, Card, EmptyState, ErrorBanner, Field, Spinner } from '../../components/common';
import { link } from '../../ui';

const EMPTY_FORM = { label: '', address: '', city: '', phone: '' };

/**
 * The buyer's saved addresses.
 *
 * `BuyerAuthContext` deliberately has no "refresh the buyer" call — see its
 * own comment on why the buyer session is kept simple. So this page keeps
 * its own copy of the address list, seeded from `buyer.addresses` once the
 * session loads, and updates that copy directly from what each mutation
 * returns rather than trying to write back into the shared context.
 *
 * A GRID OF CARDS RATHER THAN A LIST OF ROWS, because an address is a block of
 * text that wants to be read as a block — the shape of it (name, street, city,
 * phone, on four lines) is itself how somebody recognises which one is which,
 * and flattening that into a row destroys the only cue there is.
 */
export default function BuyerAccount() {
  const { buyer, isSignedIn, loading: authLoading } = useBuyerAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [resending, setResending] = useState(false);

  async function handleResendVerification() {
    setResending(true);
    try {
      const result = await shopAuthApi.resendVerification();
      toast.success(result.message || 'Verification email sent.');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the verification email'));
    } finally {
      setResending(false);
    }
  }

  const [addresses, setAddresses] = useState(buyer?.addresses || []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (buyer) setAddresses(buyer.addresses || []);
  }, [buyer]);

  if (authLoading) return <Spinner full />;
  if (!isSignedIn) {
    return <Navigate to="/login" replace state={{ from: '/account/addresses' }} />;
  }

  function startAdd() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setAdding(true);
  }

  function startEdit(address) {
    setForm({
      label: address.label,
      address: address.address,
      city: address.city || '',
      phone: address.phone || '',
    });
    setEditingId(address._id);
    setAdding(true);
  }

  function closeForm() {
    setAdding(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      const payload = {
        label: form.label,
        address: form.address,
        city: form.city,
        phone: form.phone || undefined,
      };
      const next = editingId
        ? await shopAuthApi.updateAddress(editingId, payload)
        : await shopAuthApi.addAddress(payload);

      setAddresses(next);
      toast.success(editingId ? 'Address updated.' : 'Address added.');
      closeForm();
    } catch (err) {
      setError(errorMessage(err, 'Could not save that address'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Deleting always asks first, and the question names the address rather than
   * saying "this one" — a confirmation that does not say what it is about is a
   * speed bump, not a safeguard.
   */
  async function handleDelete(address) {
    const ok = await confirm(`Remove the address saved as “${address.label}”?`, {
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;

    setBusy(true);
    try {
      const next = await shopAuthApi.deleteAddress(address._id);
      setAddresses(next);
      toast.success('Address removed.');
      if (editingId === address._id) closeForm();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove that address'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <p className="label-mono">Your account</p>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[32px] leading-tight text-ink sm:text-[36px]">
            Your addresses
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-2">
            The places we deliver to. Saved here once, offered at every checkout.
          </p>
        </div>

        {!adding && (
          <Button variant="secondary" className="shrink-0" onClick={startAdd}>
            Add address
          </Button>
        )}
      </div>

      {buyer && !buyer.emailVerified && (
        <Card className="mt-8 flex flex-wrap items-center justify-between gap-3 border-warning/30 bg-warning-wash p-4 text-sm">
          <span className="text-warning-ink">Your email address has not been confirmed yet.</span>
          <button
            type="button"
            onClick={handleResendVerification}
            disabled={resending}
            className="font-semibold text-warning-ink underline underline-offset-[3px] disabled:opacity-50"
          >
            {resending ? 'Sending…' : 'Resend confirmation email'}
          </button>
        </Card>
      )}

      {adding && (
        <Card className="mt-8 p-6">
          <h2 className="font-display text-[22px] leading-none text-ink">
            {editingId ? 'Edit address' : 'Add address'}
          </h2>

          <div className="mt-5">
            <ErrorBanner message={error} onDismiss={() => setError('')} />

            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Label"
                  name="label"
                  required
                  placeholder="Home"
                  hint='A name to tell this address apart, e.g. "Home" or "Work".'
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
                <Field
                  label="Phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  required
                  placeholder="0300 1234567"
                  hint="In case we need to reach you about delivery."
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />

                <div className="sm:col-span-2">
                  <Field
                    label="Address"
                    name="address"
                    autoComplete="street-address"
                    required
                    placeholder="45 Boat Basin, Clifton"
                    hint="Street, building, and any other delivery detail."
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                  />
                </div>

                {/*
                  City is held separately from the free-text block and is
                  required — a courier routes on it, so it is the one part of
                  an address the system cannot treat as prose. See Buyer.js's
                  addressSchema.
                */}
                <Field
                  label="City"
                  name="city"
                  autoComplete="address-level2"
                  required
                  placeholder="Karachi"
                  hint="So the courier knows which city to deliver in."
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                />
              </div>

              <div className="flex flex-wrap gap-2.5 border-t border-hairline pt-5">
                <Button type="submit" loading={busy} loadingLabel="Saving…">
                  Save address
                </Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={closeForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        </Card>
      )}

      {addresses.length === 0 && !adding && (
        <Card className="mt-8">
          {/*
            No action button here on purpose: "Add address" already sits in the
            page header, and two controls with the same accessible name on one
            screen is an ambiguity for anyone navigating by name — and for the
            end-to-end specs that do exactly that.
          */}
          <EmptyState
            title="No saved addresses yet"
            hint="Use “Add address” above and it will be waiting for you the next time you check out."
          />
        </Card>
      )}

      {addresses.length > 0 && (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {addresses.map((addr) => (
            <li key={addr._id}>
              <Card
                className={`flex h-full flex-col p-5 ${
                  editingId === addr._id ? 'border-brand ring-1 ring-brand/20' : ''
                }`}
              >
                <div className="flex-1 text-sm">
                  <p className="font-semibold text-ink">{addr.label}</p>
                  <p className="mt-1.5 text-ink-2">{addr.address}</p>
                  {addr.city && <p className="text-ink-2">{addr.city}</p>}
                  {addr.phone && <p className="mt-1.5 text-xs text-muted">{addr.phone}</p>}
                </div>

                <div className="mt-5 flex gap-2 border-t border-hairline pt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => startEdit(addr)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-critical-ink hover:bg-critical-wash hover:text-critical-ink"
                    disabled={busy}
                    onClick={() => handleDelete(addr)}
                  >
                    Delete
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-10 border-t border-hairline pt-6 text-sm text-ink-2">
        Looking for an order?{' '}
        <Link to="/account/orders" className={link}>
          View your orders
        </Link>
      </p>
    </div>
  );
}
