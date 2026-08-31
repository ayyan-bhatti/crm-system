import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { productsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, Field, PageHeader, Spinner } from '../../components/common';
import { useToast } from '../../components/Toast';
import { btnPrimary, btnSecondary, input, money } from '../../ui';
import ProductImage from '../../components/shop/ProductImage';

/** A blank variant row. Black is a neutral starting colour, not a suggestion. */
function emptyVariant() {
  return { key: crypto.randomUUID?.() || String(Math.random()), _id: null, colorName: '', colorHex: '#000000', size: '', stockQty: '', priceOverride: '' };
}

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
  const [variants, setVariants] = useState([]);
  const [images, setImages] = useState('');
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

    /*
     * `_id` is carried into the form state and sent back on save.
     *
     * That is what keeps variant ids stable across an edit. Without it the
     * server would mint new ones on every save, which would orphan the
     * `variantId` snapshot on every existing order line and make live stock for
     * that colour unaddressable — see the note in the product controller.
     */
    setVariants(
      (existing.variants || []).map((variant) => ({
        key: String(variant._id),
        _id: variant._id,
        colorName: variant.color?.name || '',
        colorHex: variant.color?.hex || '#000000',
        size: variant.size || '',
        stockQty: String(variant.stockQty ?? ''),
        priceOverride: variant.priceOverride == null ? '' : String(variant.priceOverride),
      }))
    );

    setImages((existing.images || []).join('\n'));
  }, [existing]);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function updateVariant(key, field, value) {
    setVariants((rows) => rows.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  }

  const hasVariants = variants.length > 0;

  /*
   * With variants, the product's own stock is the SUM of them and the top-level
   * field is disabled rather than hidden. Hiding it would leave a manager
   * wondering where the stock number went; showing it, disabled, with the total
   * in it, says "this is still here, and it is now derived".
   */
  const variantStockTotal = variants.reduce((sum, row) => sum + (Number(row.stockQty) || 0), 0);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    const payload = {
      ...form,
      price: Number(form.price),
      stockQty: hasVariants ? variantStockTotal : Number(form.stockQty),
      lowStockThreshold: Number(form.lowStockThreshold),
      images: images
        .split('\n')
        .map((url) => url.trim())
        .filter(Boolean),
      variants: variants.map((row) => ({
        ...(row._id ? { _id: row._id } : {}),
        color: { name: row.colorName.trim(), hex: row.colorHex },
        size: row.size.trim(),
        stockQty: Number(row.stockQty),
        priceOverride: row.priceOverride === '' ? null : Number(row.priceOverride),
      })),
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
    <div className="mx-auto max-w-3xl">
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
              hint="In USD, e.g. 29.99. Individual colours can override this below."
              value={form.price}
              onChange={(e) => update('price', e.target.value)}
            />
            <Field
              label="Stock quantity"
              type="number"
              min="0"
              required={!hasVariants}
              disabled={hasVariants}
              hint={
                hasVariants
                  ? 'Added up from the colours below — edit the quantities there.'
                  : 'How many units are available right now.'
              }
              value={hasVariants ? String(variantStockTotal) : form.stockQty}
              onChange={(e) => update('stockQty', e.target.value)}
            />
            <Field
              label="Category"
              required
              hint="Used for storefront filtering and the shop's category menu."
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
                hint="Paste a direct link to the main product photo."
                value={form.imageUrl}
                onChange={(e) => update('imageUrl', e.target.value)}
              />
            </div>
          </div>

          <Field
            label="More images"
            hint="One URL per line, up to 8. The first is used for the card's hover image."
          >
            <textarea
              rows={2}
              className={input}
              value={images}
              onChange={(e) => setImages(e.target.value)}
            />
          </Field>

          <Field
            label="Description"
            hint="Shown to shoppers on the product page. Leave it blank and that page has a name, a price and nothing else — this is most of what sells the item."
          >
            <textarea
              rows={4}
              className={input}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
            />
          </Field>

          {/*
            An honest preview, which the previous one was not.
            It hid the image on error and left a caption reading "shown as it
            will look on the storefront" beside empty space — so a dead URL
            looked like a rendering quirk in this form rather than like the
            broken picture every shopper was about to get. `ProductImage` is the
            same component the storefront uses, so what appears here IS what
            appears there, including the fallback.
          */}
          {form.imageUrl && (
            <div className="flex items-center gap-3 rounded-lg border border-hairline bg-plane p-3">
              <ProductImage
                product={{ ...form, _id: id }}
                src={form.imageUrl}
                alt=""
                className="h-16 w-16 shrink-0 rounded-md border border-hairline bg-neutral-wash object-cover"
              />
              <p className="text-xs text-muted">
                Preview — exactly what the storefront will render. If this shows initials rather
                than a photo, the link did not load and shoppers will see the same thing.
              </p>
            </div>
          )}

          <VariantEditor
            variants={variants}
            basePrice={Number(form.price) || 0}
            onChange={updateVariant}
            onAdd={() => setVariants((rows) => [...rows, emptyVariant()])}
            onRemove={(key) => setVariants((rows) => rows.filter((row) => row.key !== key))}
          />

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

/**
 * Rows of colour / size / quantity, each its own stock pool.
 *
 * NO VARIANTS IS A FIRST-CLASS STATE, not an empty list to be filled in. Most
 * of this catalogue is sold as a single undifferentiated thing, so the editor
 * opens closed, with a sentence explaining what adding one would do and what
 * happens if you do not. Presenting an empty table with headers would imply
 * that a product is incomplete until it has colours.
 */
function VariantEditor({ variants, basePrice, onChange, onAdd, onRemove }) {
  return (
    <fieldset className="rounded-lg border border-hairline bg-plane p-4">
      <legend className="px-1 text-sm font-semibold text-ink">Colours and sizes</legend>

      {variants.length === 0 ? (
        <div className="mt-1">
          <p className="text-sm text-ink-2">
            This product is sold as one thing, with the single stock quantity above.
          </p>
          <p className="mt-1 text-xs text-muted">
            Add colours if shoppers need to choose between them — each one keeps its own stock,
            and the storefront will require a choice before the product can be added to a cart.
          </p>
          <button type="button" onClick={onAdd} className={`${btnSecondary} mt-3`}>
            Add a colour
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-4">
          {variants.map((row, index) => (
            <div
              key={row.key}
              className="rounded-lg border border-hairline bg-surface p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Variant {index + 1}
                </p>
                <button
                  type="button"
                  onClick={() => onRemove(row.key)}
                  className="text-xs text-muted hover:text-critical-ink"
                >
                  Remove
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Colour name"
                  name={`variant-${row.key}-name`}
                  required
                  hint="Shown as a swatch to shoppers."
                  value={row.colorName}
                  onChange={(e) => onChange(row.key, 'colorName', e.target.value)}
                />

                <div>
                  <label
                    className="mb-1.5 block text-sm font-medium text-ink-2"
                    htmlFor={`variant-${row.key}-hex`}
                  >
                    Swatch colour
                    <span className="ml-1 text-critical-ink" aria-hidden="true">
                      *
                    </span>
                    <span className="sr-only"> (Required)</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id={`variant-${row.key}-hex`}
                      type="color"
                      value={row.colorHex}
                      onChange={(e) => onChange(row.key, 'colorHex', e.target.value)}
                      className="h-9 w-14 shrink-0 cursor-pointer rounded border border-hairline bg-raised"
                      aria-describedby={`variant-${row.key}-hex-hint`}
                    />
                    {/*
                      The hex is editable as text as well as through the picker.
                      A brand colour arrives as "#2a78d6" in an email, and
                      hunting for it in a colour wheel is a poor use of anyone's
                      afternoon.
                    */}
                    <input
                      type="text"
                      value={row.colorHex}
                      onChange={(e) => onChange(row.key, 'colorHex', e.target.value)}
                      className={input}
                      aria-label="Swatch colour hex code"
                      placeholder="#1a2b3c"
                    />
                  </div>
                  <p id={`variant-${row.key}-hex-hint`} className="mt-1.5 text-xs text-muted">
                    The exact circle shoppers see. Six-digit hex, e.g. #1a2b3c.
                  </p>
                </div>

                <Field
                  label="Size"
                  name={`variant-${row.key}-size`}
                  hint="Optional. Leave blank if this product has one size."
                  value={row.size}
                  onChange={(e) => onChange(row.key, 'size', e.target.value)}
                />

                <Field
                  label="Quantity"
                  name={`variant-${row.key}-qty`}
                  type="number"
                  min="0"
                  required
                  hint="Stock for this specific colour/size combination."
                  value={row.stockQty}
                  onChange={(e) => onChange(row.key, 'stockQty', e.target.value)}
                />

                <div className="sm:col-span-2">
                  <Field
                    label="Price override"
                    name={`variant-${row.key}-price`}
                    type="number"
                    step="0.01"
                    min="0"
                    hint={`Optional. Leave blank to use the product price of ${money(basePrice)}.`}
                    value={row.priceOverride}
                    onChange={(e) => onChange(row.key, 'priceOverride', e.target.value)}
                  />
                </div>
              </div>
            </div>
          ))}

          <button type="button" onClick={onAdd} className={btnSecondary}>
            Add another colour
          </button>

          <p className="text-xs text-muted">
            Each row is one buyable combination. Two rows with the same colour and size are
            rejected — combine them into one row with the total quantity.
          </p>
        </div>
      )}
    </fieldset>
  );
}
