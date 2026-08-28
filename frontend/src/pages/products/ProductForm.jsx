import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { productsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../../components/common';
import { useToast } from '../../components/Toast';
import { btnPrimary, btnSecondary, input } from '../../ui';

/**
 * Create / edit a product. Reachable only by managers and admins — the route is
 * wrapped in <ProtectedRoute roles={...}> in App.jsx, and the API enforces the
 * same rule independently.
 */
export default function ProductForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  // Saving navigates to the product's page, so the confirmation has to outlive
  // this component — the same reason customers and orders use a toast.
  const toast = useToast();

  const [form, setForm] = useState({
    name: '',
    sku: '',
    price: '',
    stockQty: '',
    category: '',
    lowStockThreshold: '10',
    imageUrl: '',
    description: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * `loadError` is destructured deliberately, the same as in CustomerForm.
   *
   * Dropping it renders an EMPTY form when the record could not be loaded, and
   * pressing "Save changes" then PATCHes the product with blank fields — a
   * failure to READ turning into data loss on WRITE.
   */
  const {
    data: existing,
    loading,
    error: loadError,
  } = useFetch(() => (isEdit ? productsApi.get(id) : null), [id]);

  useEffect(() => {
    if (!existing) return;
    setForm({
      name: existing.name || '',
      sku: existing.sku || '',
      // Numbers become strings for the controlled inputs, then back to numbers
      // on submit — a number-typed value here makes clearing the field awkward.
      price: String(existing.price ?? ''),
      stockQty: String(existing.stockQty ?? ''),
      category: existing.category || '',
      lowStockThreshold: String(existing.lowStockThreshold ?? '10'),
      imageUrl: existing.imageUrl || '',
      description: existing.description || '',
    });
  }, [existing]);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const payload = {
      ...form,
      price: Number(form.price),
      stockQty: Number(form.stockQty),
      lowStockThreshold: Number(form.lowStockThreshold),
    };

    try {
      const saved = isEdit
        ? await productsApi.update(id, payload)
        : await productsApi.create(payload);
      toast.success(isEdit ? 'Changes saved.' : `${saved.name} added.`);
      navigate(`/crm/products/${saved._id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not save product'));
      setSubmitting(false);
    }
  }

  if (isEdit && loading) return <Spinner full />;

  // A record that could not be loaded gets the error and nothing else. Showing
  // the form would invite the user to save over a record we never read.
  if (isEdit && loadError) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Edit product" />
        <ErrorBanner message={loadError} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={isEdit ? 'Edit product' : 'New product'} />

      <Card className="p-6">
        <ErrorBanner message={error} onDismiss={() => setError('')} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              required
              hint="Shown to customers on the storefront."
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
            />
            <Field
              label="SKU"
              required
              hint="Stored uppercase and must be unique."
              value={form.sku}
              onChange={(e) => update('sku', e.target.value)}
            />
            <Field
              label="Price"
              type="number"
              step="0.01"
              min="0"
              required
              hint="In USD, e.g. 29.99."
              value={form.price}
              onChange={(e) => update('price', e.target.value)}
            />
            <Field
              label="Stock quantity"
              type="number"
              min="0"
              required
              hint="How many units are available right now."
              value={form.stockQty}
              onChange={(e) => update('stockQty', e.target.value)}
            />
            <Field
              label="Category"
              required
              hint="Used for storefront filtering."
              value={form.category}
              onChange={(e) => update('category', e.target.value)}
            />
            <Field
              label="Low stock threshold"
              type="number"
              min="0"
              hint="Flagged as low at or below this level."
              value={form.lowStockThreshold}
              onChange={(e) => update('lowStockThreshold', e.target.value)}
            />
            <div className="sm:col-span-2">
              <Field
                label="Image URL"
                type="url"
                required
                hint="Paste a direct link to a product photo."
                value={form.imageUrl}
                onChange={(e) => update('imageUrl', e.target.value)}
              />
            </div>
          </div>

          <Field label="Description" hint="A short paragraph shown on the product page.">
            <textarea
              rows={3}
              className={input}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
            />
          </Field>

          {form.imageUrl && (
            <div className="flex items-center gap-3 rounded-lg border border-hairline bg-plane p-3">
              <img
                src={form.imageUrl}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
                onLoad={(e) => {
                  e.currentTarget.style.display = '';
                }}
                className="h-16 w-16 rounded-md border border-hairline bg-neutral-wash object-cover"
              />
              <p className="text-xs text-muted">Preview — shown as it will look on the storefront.</p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button type="submit" className={btnPrimary} disabled={submitting}>
              {submitting ? <Spinner /> : isEdit ? 'Save changes' : 'Create product'}
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
