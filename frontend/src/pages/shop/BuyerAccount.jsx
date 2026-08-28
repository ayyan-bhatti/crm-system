import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopAuthApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { useToast } from '../../components/Toast';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../../components/common';
import { btnDanger, btnPrimary, btnSecondary, link } from '../../ui';

const EMPTY_FORM = { label: '', address: '', city: '', phone: '' };

/**
 * The buyer's saved addresses.
 *
 * `BuyerAuthContext` deliberately has no "refresh the buyer" call — see its
 * own comment on why the buyer session is kept simple. So this page keeps
 * its own copy of the address list, seeded from `buyer.addresses` once the
 * session loads, and updates that copy directly from what each mutation
 * returns rather than trying to write back into the shared context.
 */
export default function BuyerAccount() {
  const { buyer, isSignedIn, loading: authLoading } = useBuyerAuth();
  const toast = useToast();

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

  async function handleDelete(addressId) {
    if (!window.confirm('Remove this address?')) return;

    setBusy(true);
    try {
      const next = await shopAuthApi.deleteAddress(addressId);
      setAddresses(next);
      toast.success('Address removed.');
      if (editingId === addressId) closeForm();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove that address'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <PageHeader
        title="Your addresses"
        subtitle="Saved delivery addresses used at checkout."
        action={
          !adding && (
            <button type="button" className={btnSecondary} onClick={startAdd}>
              Add address
            </button>
          )
        }
      />

      <p className="mb-6 text-sm text-ink-2">
        Looking for an order?{' '}
        <Link to="/account/orders" className={link}>
          View your orders
        </Link>
      </p>

      {addresses.length === 0 && !adding && (
        <Card className="p-6 text-center text-sm text-ink-2">
          You have no saved addresses yet.
        </Card>
      )}

      {addresses.length > 0 && (
        <div className="space-y-3">
          {addresses.map((addr) => (
            <Card key={addr._id} className="flex items-start justify-between gap-4 p-4">
              <div className="text-sm">
                <p className="font-medium text-ink">{addr.label}</p>
                <p className="text-ink-2">{addr.address}</p>
                {addr.city && <p className="text-ink-2">{addr.city}</p>}
                {addr.phone && <p className="text-xs text-muted">{addr.phone}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy}
                  onClick={() => startEdit(addr)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={btnDanger}
                  disabled={busy}
                  onClick={() => handleDelete(addr._id)}
                >
                  Delete
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {adding && (
        <Card className="mt-6 p-6">
          <h2 className="mb-4 text-sm font-semibold text-ink">
            {editingId ? 'Edit address' : 'Add address'}
          </h2>

          <ErrorBanner message={error} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Label"
              required
              hint='A name to tell this address apart, e.g. "Home" or "Work".'
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <Field
              label="Address"
              required
              hint="Street, building, and any other delivery detail."
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
            <Field
              label="City"
              required
              hint="So the courier knows which city to deliver in."
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
            <Field
              label="Phone"
              type="tel"
              required
              hint="In case we need to reach you about delivery."
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />

            <div className="flex gap-2">
              <button type="submit" className={btnPrimary} disabled={busy}>
                {busy ? <Spinner /> : 'Save address'}
              </button>
              <button type="button" className={btnSecondary} disabled={busy} onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
