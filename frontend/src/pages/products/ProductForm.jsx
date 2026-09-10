import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { productsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import {
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  ErrorBanner,
  Field,
  PageHeader,
  Spinner,
  Textarea,
  useFormValidation,
  validators,
} from '../../components/common';
import { useToast } from '../../components/Toast';
import { input, money } from '../../ui';
import ProductImage from '../../components/shop/ProductImage';

/** A blank variant row. Black is a neutral starting colour, not a suggestion. */
function emptyVariant() {
  return {
    key: crypto.randomUUID?.() || String(Math.random()),
    _id: null,
    colorName: '',
    colorHex: '#000000',
    size: '',
    stockQty: '',
    priceOverride: '',
  };
}

/** The fields on a variant row that can be wrong, and what wrong means. */
const VARIANT_RULES = {
  colorName: validators.required('Colour name'),
  stockQty: validators.stock,
  // Optional: blank means "use the product price", which is not an error.
  priceOverride: (value) => (value === '' ? null : validators.price(value)),
};

const VARIANT_FIELDS = Object.keys(VARIANT_RULES);

function variantError(row, field) {
  return VARIANT_RULES[field](row[field]);
}

/**
 * Create / edit a product. Reachable only by managers and admins — the route is
 * wrapped in <ProtectedRoute roles={...}> in App.jsx, and the API enforces the
 * same rule independently.
 *
 * The form is sectioned by the DECISION each group represents — what the thing
 * is, what it costs, how it looks in the shop, what it is made of, what colours
 * it comes in — rather than being one twenty-control stack in schema order.
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
    brand: '',
    tags: '',
    featured: false,
    newArrival: false,
    isActive: true,
    salePrice: '',
    subcategory: '',
    materials: '',
    width: '',
    height: '',
    depth: '',
  });
  const [variants, setVariants] = useState([]);
  const [variantTouched, setVariantTouched] = useState({});
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
      brand: existing.brand || '',
      tags: (existing.tags || []).join(', '),
      featured: Boolean(existing.featured),
      newArrival: Boolean(existing.newArrival),
      isActive: existing.isActive !== false,
      salePrice: existing.salePrice == null ? '' : String(existing.salePrice),
      subcategory: existing.subcategory || '',
      materials: (existing.materials || []).join(', '),
      width: existing.dimensions?.width == null ? '' : String(existing.dimensions.width),
      height: existing.dimensions?.height == null ? '' : String(existing.dimensions.height),
      depth: existing.dimensions?.depth == null ? '' : String(existing.dimensions.depth),
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

  /*
   * The rules depend on whether there are variants: with them, the top-level
   * stock box is derived and disabled, so demanding a number in it would block
   * a save on a field the user cannot even type into.
   */
  const rules = useMemo(
    () => ({
      name: validators.required('Name'),
      sku: validators.required('SKU'),
      category: validators.required('Category'),
      imageUrl: validators.required('Image URL'),
      price: validators.price,
      salePrice: (value) => (value === '' ? null : validators.price(value)),
      stockQty: (value) => (hasVariants ? null : validators.stock(value)),
      lowStockThreshold: validators.stock,
    }),
    [hasVariants]
  );

  const { visibleErrors, markTouched, validate, submitted } = useFormValidation(rules);
  const errors = visibleErrors(form);

  function fieldProps(field) {
    return {
      value: form[field],
      error: errors[field],
      onChange: (event) => update(field, event.target.value),
      onBlur: () => markTouched(field),
    };
  }

  /** True when any variant row has something wrong with it. */
  const variantsInvalid = variants.some((row) =>
    VARIANT_FIELDS.some((field) => variantError(row, field))
  );

  async function handleSubmit(event) {
    event.preventDefault();

    // `validate` reports every field, so nothing stays hidden — and because it
    // flips `submitted`, the variant rows start reporting themselves too.
    const formOk = validate(form);
    if (!formOk || variantsInvalid) return;

    setSubmitting(true);
    setError('');

    const { width, height, depth, ...rest } = form;

    const payload = {
      ...rest,
      price: Number(form.price),
      stockQty: hasVariants ? variantStockTotal : Number(form.stockQty),
      lowStockThreshold: Number(form.lowStockThreshold),
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      materials: form.materials
        .split(',')
        .map((material) => material.trim())
        .filter(Boolean),
      dimensions: {
        width: width === '' ? null : Number(width),
        height: height === '' ? null : Number(height),
        depth: depth === '' ? null : Number(depth),
        unit: 'cm',
      },
      salePrice: form.salePrice === '' ? null : Number(form.salePrice),
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
      <div className="mx-auto max-w-3xl">
        <Breadcrumb
          className="mb-3"
          items={[{ label: 'Products', to: '/crm/products' }, { label: 'Edit product' }]}
        />
        <PageHeader eyebrow="Product" title="Edit product" />
        <ErrorBanner message={loadError} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Breadcrumb
        className="mb-3"
        items={[
          { label: 'Products', to: '/crm/products' },
          ...(isEdit && existing ? [{ label: existing.name, to: `/crm/products/${id}` }] : []),
          { label: isEdit ? 'Edit' : 'New product' },
        ]}
      />

      <PageHeader
        eyebrow="Product"
        title={isEdit ? 'Edit product' : 'New product'}
        subtitle={
          isEdit
            ? 'Saving updates the storefront immediately.'
            : 'A product needs a name, an SKU, a price, a category and a photo before it can be sold.'
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {/* `noValidate` — this form shows its own messages, and the native
          bubble suppresses them. */}
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <Section title="Identity" description="What the thing is, and where it sits in the shop.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              required
              placeholder="Halden Lounge Chair"
              hint="Shown to customers on the storefront."
              {...fieldProps('name')}
            />
            <Field
              label="SKU"
              required
              placeholder="HAL-LC-01"
              hint="Stored uppercase and must be unique."
              {...fieldProps('sku')}
            />
            <Field
              label="Category"
              required
              placeholder="Seating"
              hint="Used for storefront filtering and the shop's category menu."
              {...fieldProps('category')}
            />
            <Field
              label="Subcategory"
              placeholder="Lounge chair"
              hint="A finer cut within the category."
              {...fieldProps('subcategory')}
            />
            <Field
              label="Brand / designer"
              placeholder="Halden Studio"
              hint="Shown on the storefront card and product page."
              {...fieldProps('brand')}
            />
            <Field
              label="Tags"
              placeholder="mid-century, oak, lounge"
              hint="Comma-separated — used by search and “you might also like”."
              {...fieldProps('tags')}
            />
          </div>
        </Section>

        <Section
          title="Price and stock"
          description="What it sells for, and how many you have. Individual colours can override the price below."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Price"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              required
              placeholder="1299.00"
              hint="In USD, e.g. 29.99."
              {...fieldProps('price')}
            />
            <Field
              label="Sale price"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="999.00"
              hint="Optional. Leave blank to sell at the regular price."
              {...fieldProps('salePrice')}
            />
            <Field
              label="Stock quantity"
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              required={!hasVariants}
              disabled={hasVariants}
              placeholder="24"
              hint={
                hasVariants
                  ? 'Added up from the colours below — edit the quantities there.'
                  : 'Whole units available right now.'
              }
              error={hasVariants ? undefined : errors.stockQty}
              value={hasVariants ? String(variantStockTotal) : form.stockQty}
              onChange={(e) => update('stockQty', e.target.value)}
              onBlur={() => markTouched('stockQty')}
            />
            <Field
              label="Low stock threshold"
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              placeholder="10"
              hint="Flagged as low at or below this level."
              {...fieldProps('lowStockThreshold')}
            />
          </div>
        </Section>

        <Section
          title="Photography"
          description="The main photo is what a shopper sees first, in the grid and on the product page."
        >
          <div className="space-y-4">
            <Field
              label="Image URL"
              type="url"
              required
              placeholder="https://example.com/halden-chair.jpg"
              hint="Paste a direct link to the main product photo."
              {...fieldProps('imageUrl')}
            />

            {/*
              An honest preview, which the previous one was not.
              It hid the image on error and left a caption reading "shown as it
              will look on the storefront" beside empty space — so a dead URL
              looked like a rendering quirk in this form rather than like the
              broken picture every shopper was about to get. `ProductImage` is
              the same component the storefront uses, so what appears here IS
              what appears there, including the fallback.
            */}
            {form.imageUrl && (
              <div className="flex items-center gap-4 rounded-xl border border-hairline bg-plane p-3">
                <ProductImage
                  product={{ ...form, _id: id }}
                  src={form.imageUrl}
                  alt=""
                  className="h-20 w-20 shrink-0 rounded-lg border border-hairline bg-neutral-wash object-cover"
                />
                <p className="text-xs leading-relaxed text-muted">
                  Preview — exactly what the storefront will render. If this shows initials rather
                  than a photo, the link did not load and shoppers will see the same thing.
                </p>
              </div>
            )}

            <Field
              label="More images"
              hint="One URL per line, up to 8. The first is used for the card's hover image."
            >
              <Textarea
                rows={3}
                placeholder={'https://example.com/halden-side.jpg\nhttps://example.com/halden-detail.jpg'}
                value={images}
                onChange={(e) => setImages(e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Storefront copy"
          description="What the product page says once a shopper has clicked through."
        >
          <div className="space-y-4">
            <Field
              label="Description"
              hint="Leave it blank and that page has a name, a price and nothing else — this is most of what sells the item."
            >
              <Textarea
                rows={5}
                placeholder="Solid oak frame, hand-finished in Lahore. Seats one, comfortably, for a very long evening."
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
              />
            </Field>

            <fieldset className="rounded-xl border border-hairline bg-plane p-4">
              <legend className="px-1.5 text-sm font-semibold text-ink">Where it appears</legend>
              <div className="mt-2 space-y-3">
                <Checkbox
                  label="Active"
                  hint="Unticked, the product is hidden from the storefront entirely."
                  checked={form.isActive}
                  onChange={(e) => update('isActive', e.target.checked)}
                />
                <Checkbox
                  label="Feature on the storefront homepage"
                  hint="Featured products get a slot on the front page."
                  checked={form.featured}
                  onChange={(e) => update('featured', e.target.checked)}
                />
                <Checkbox
                  label="Show in “New Arrivals”"
                  hint="Worth turning off once the product is no longer new."
                  checked={form.newArrival}
                  onChange={(e) => update('newArrival', e.target.checked)}
                />
              </div>
            </fieldset>
          </div>
        </Section>

        <Section
          title="Materials and dimensions"
          description="Optional, and the two questions a furniture shopper asks before they buy."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label="Materials"
                placeholder="Oak, brass, wool"
                hint="Comma-separated."
                {...fieldProps('materials')}
              />
            </div>
            <Field
              label="Width (cm)"
              type="number"
              inputMode="decimal"
              min="0"
              placeholder="78"
              {...fieldProps('width')}
            />
            <Field
              label="Height (cm)"
              type="number"
              inputMode="decimal"
              min="0"
              placeholder="92"
              {...fieldProps('height')}
            />
            <Field
              label="Depth (cm)"
              type="number"
              inputMode="decimal"
              min="0"
              placeholder="84"
              {...fieldProps('depth')}
            />
          </div>
        </Section>

        <VariantEditor
          variants={variants}
          basePrice={Number(form.price) || 0}
          showErrors={submitted}
          touched={variantTouched}
          onBlur={(key, field) =>
            setVariantTouched((current) => ({ ...current, [`${key}.${field}`]: true }))
          }
          onChange={updateVariant}
          onAdd={() => setVariants((rows) => [...rows, emptyVariant()])}
          onRemove={(key) => setVariants((rows) => rows.filter((row) => row.key !== key))}
        />

        {/*
          Sticky on desktop: this form is five sections tall, and a save button
          you have to scroll to find is one people lose track of halfway down.
        */}
        <div className="sticky bottom-0 -mx-1 border-t border-hairline bg-plane/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-plane/80">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              loading={submitting}
              loadingLabel={isEdit ? 'Saving…' : 'Creating…'}
            >
              {isEdit ? 'Save changes' : 'Create product'}
            </Button>
            <Button variant="secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            {hasVariants && (
              <p className="text-xs text-muted">
                Stock total from colours:{' '}
                <span className="tabular font-medium text-ink-2">{variantStockTotal}</span>
              </p>
            )}
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

/**
 * Rows of colour / size / quantity, each its own stock pool.
 *
 * NO VARIANTS IS A FIRST-CLASS STATE, not an empty list to be filled in. Most
 * of this catalogue is sold as a single undifferentiated thing, so the editor
 * opens closed, with a sentence explaining what adding one would do and what
 * happens if you do not. Presenting an empty table with headers would imply
 * that a product is incomplete until it has colours.
 */
function VariantEditor({
  variants,
  basePrice,
  showErrors,
  touched,
  onBlur,
  onChange,
  onAdd,
  onRemove,
}) {
  /** A row's error, but only once the user has had their turn on that field. */
  function errorFor(row, field) {
    if (!showErrors && !touched[`${row.key}.${field}`]) return undefined;
    return variantError(row, field) || undefined;
  }

  function variantFieldProps(row, field) {
    return {
      value: row[field],
      error: errorFor(row, field),
      onChange: (event) => onChange(row.key, field, event.target.value),
      onBlur: () => onBlur(row.key, field),
    };
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 border-b border-hairline pb-4">
        <h2 className="text-base font-semibold text-ink">Colours and sizes</h2>
        <p className="mt-1 text-sm text-ink-2">
          Each colour keeps its own stock pool. Most products need none of this.
        </p>
      </div>

      {variants.length === 0 ? (
        <div>
          <p className="text-sm text-ink-2">
            This product is sold as one thing, with the single stock quantity above.
          </p>
          <p className="mt-1.5 text-sm text-muted">
            Add colours if shoppers need to choose between them — each one keeps its own stock, and
            the storefront will require a choice before the product can be added to a cart.
          </p>
          <Button variant="secondary" className="mt-4" onClick={onAdd}>
            Add a colour
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {variants.map((row, index) => (
            <fieldset key={row.key} className="rounded-xl border border-hairline bg-plane p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <legend className="sr-only">Variant {index + 1}</legend>
                <p className="label-mono" aria-hidden="true">
                  Variant {index + 1}
                </p>
                <button
                  type="button"
                  onClick={() => onRemove(row.key)}
                  className="rounded-md px-1.5 py-0.5 text-xs font-medium text-muted transition-colors hover:text-critical-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Remove
                </button>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Colour name"
                  name={`variant-${row.key}-name`}
                  required
                  placeholder="Midnight"
                  hint="Shown as a swatch to shoppers."
                  {...variantFieldProps(row, 'colorName')}
                />

                <div>
                  <label
                    className="mb-1.5 block text-sm font-medium text-ink"
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
                      className="h-10 w-14 shrink-0 cursor-pointer rounded-md border border-hairline bg-raised"
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
                  placeholder="Medium"
                  hint="Optional. Leave blank if this product has one size."
                  value={row.size}
                  onChange={(e) => onChange(row.key, 'size', e.target.value)}
                />

                <Field
                  label="Quantity"
                  name={`variant-${row.key}-qty`}
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min="0"
                  required
                  placeholder="12"
                  hint="Stock for this specific colour/size combination."
                  {...variantFieldProps(row, 'stockQty')}
                />

                <div className="sm:col-span-2">
                  <Field
                    label="Price override"
                    name={`variant-${row.key}-price`}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    placeholder={String(basePrice || '')}
                    hint={`Optional. Leave blank to use the product price of ${money(basePrice)}.`}
                    {...variantFieldProps(row, 'priceOverride')}
                  />
                </div>
              </div>
            </fieldset>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={onAdd}>
              Add another colour
            </Button>
            <p className="text-xs text-muted">
              Two rows with the same colour and size are rejected — combine them into one row with
              the total quantity.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
