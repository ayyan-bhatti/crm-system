import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { productsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import {
  Breadcrumb,
  ButtonLink,
  Card,
  DropdownMenu,
  ErrorBanner,
  MenuItem,
  PageHeader,
  Spinner,
  Table,
} from '../../components/common';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import Can from '../../components/Can';
import ProductImage from '../../components/shop/ProductImage';
import { btnSecondary, formatDate, money, td, th, variantLabel } from '../../ui';

/**
 * One product, as the catalogue holds it.
 *
 * The wide column is what the product IS — price, stock, copy, the colours it
 * is sold in. The narrow one is how it appears to a shopper: the photograph,
 * and the switches that decide whether the storefront shows it at all.
 */
export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Deleting navigates back to the list, so a banner rendered here would vanish
  // with the component and the user would arrive with no confirmation at all.
  const toast = useToast();
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);

  const { data: product, loading, error } = useFetch(() => productsApi.get(id), [id]);

  async function handleDelete() {
    const ok = await confirm('Delete this product? This cannot be undone.', {
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;

    setDeleting(true);

    try {
      await productsApi.remove(id);
      toast.success(`${product?.name || 'Product'} deleted.`);
      navigate('/crm/products', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete product'));
      setDeleting(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!product) return null;

  const variants = product.variants || [];
  const dimensions = product.dimensions || {};
  const hasDimensions = Boolean(dimensions.width || dimensions.height || dimensions.depth);
  const inactive = product.isActive === false;

  return (
    <div>
      <Breadcrumb
        className="mb-3"
        items={[{ label: 'Products', to: '/crm/products' }, { label: product.name }]}
      />

      <PageHeader
        eyebrow="Product"
        title={product.name}
        subtitle={
          [
            product.sku,
            product.subcategory ? `${product.category} · ${product.subcategory}` : product.category,
            product.brand,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        action={
          <Can do="manageProducts">
            <>
            <ButtonLink to={`/crm/products/${product._id}/edit`}>Edit</ButtonLink>

            {/* Destructive action behind a menu, not beside Edit. */}
            <DropdownMenu
              label="More product actions"
              triggerClassName={btnSecondary}
              trigger={
                <>
                  <span className="sr-only">More actions</span>
                  <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
                    <path d="M10 6a1.6 1.6 0 110-3.2A1.6 1.6 0 0110 6zm0 5.6a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2zm0 5.6a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2z" />
                  </svg>
                </>
              }
            >
              {(close) => (
                <MenuItem
                  className="text-critical-ink hover:bg-critical-wash hover:text-critical-ink"
                  onClick={() => {
                    close();
                    handleDelete();
                  }}
                >
                  {deleting ? 'Deleting…' : 'Delete product'}
                </MenuItem>
              )}
            </DropdownMenu>
            </>
          </Can>
        }
      />

      {product.isLowStock && (
        <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-critical/25 bg-critical-wash px-4 py-3 text-sm text-critical-ink">
          <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 fill-current" aria-hidden="true">
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
          </svg>
          <span>
            <strong className="font-semibold">Low stock.</strong> Only {product.stockQty} left,
            at or below the threshold of {product.lowStockThreshold}.
          </span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-6">
          <Card className="p-5">
            <PanelHeading eyebrow="Commercials" title="Price and stock" />

            <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Fact label="Price">
                {product.salePrice ? (
                  <span className="flex items-baseline gap-2">
                    <span className="tabular">{money(product.salePrice)}</span>
                    <span className="tabular text-xs font-normal text-muted line-through">
                      {money(product.price)}
                    </span>
                  </span>
                ) : (
                  <span className="tabular">{money(product.price)}</span>
                )}
              </Fact>
              <Fact label="In stock" tone={product.isLowStock ? 'critical' : undefined}>
                <span className="tabular">{product.stockQty}</span>
              </Fact>
              <Fact label="Low stock threshold">
                <span className="tabular">{product.lowStockThreshold}</span>
              </Fact>
              <Fact label="SKU">
                <span className="font-mono text-[13px]">{product.sku}</span>
              </Fact>
              <Fact label="Category">
                {product.subcategory
                  ? `${product.category} · ${product.subcategory}`
                  : product.category}
              </Fact>
              <Fact label="Brand / designer">{product.brand || '—'}</Fact>
              {hasDimensions && (
                <Fact label="Dimensions">
                  {[
                    dimensions.width && `W ${dimensions.width}`,
                    dimensions.height && `H ${dimensions.height}`,
                    dimensions.depth && `D ${dimensions.depth}`,
                  ]
                    .filter(Boolean)
                    .join(' × ')}{' '}
                  {dimensions.unit || 'cm'}
                </Fact>
              )}
              {product.materials?.length > 0 && (
                <Fact label="Materials">{product.materials.join(', ')}</Fact>
              )}
              <Fact label="Added">{formatDate(product.createdAt)}</Fact>
            </dl>
          </Card>

          {/*
            The colours, as a table rather than as a sentence.

            Stock is held PER VARIANT, so "12 in stock" on the product tells a
            manager almost nothing about whether the colour a customer wants can
            actually be sent. The per-row numbers are the ones any ordering
            decision is made against.
          */}
          {variants.length > 0 && (
            <Card>
              <div className="border-b border-hairline px-5 py-4">
                <PanelHeading eyebrow="Catalogue" title="Colours and sizes" />
                <p className="mt-1.5 text-sm text-ink-2">
                  Each row is one buyable combination, with its own stock pool.
                </p>
              </div>

              <Table caption={`Variants of ${product.name}`}>
                <thead className="border-b border-hairline bg-plane">
                  <tr>
                    <th className={th}>Colour / size</th>
                    <th className={`${th} text-right`}>Price</th>
                    <th className={`${th} text-right`}>In stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {variants.map((variant) => (
                    <tr key={variant._id}>
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          {variant.color?.hex && (
                            <span
                              aria-hidden="true"
                              className="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ring-ink/15"
                              style={{ backgroundColor: variant.color.hex }}
                            />
                          )}
                          <span className="font-medium text-ink">
                            {variantLabel(variant) || 'Unnamed'}
                          </span>
                        </span>
                      </td>
                      <td className={`${td} tabular text-right`}>
                        {variant.priceOverride == null
                          ? money(product.price)
                          : money(variant.priceOverride)}
                      </td>
                      <td
                        className={`${td} tabular text-right ${
                          variant.stockQty === 0 ? 'font-medium text-critical-ink' : ''
                        }`}
                      >
                        {variant.stockQty === 0 ? 'Out of stock' : variant.stockQty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          <Card className="p-5">
            <PanelHeading eyebrow="Storefront" title="Description" />
            {product.description ? (
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                {product.description}
              </p>
            ) : (
              <p className="mt-3 text-sm text-muted">
                No description yet. The storefront page for this product currently shows a name, a
                price and nothing else.
              </p>
            )}

            {product.tags?.length > 0 && (
              <div className="mt-5 border-t border-hairline pt-4">
                <p className="label-mono">Tags</p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {product.tags.map((tag) => (
                    <li
                      key={tag}
                      className="rounded-full border border-hairline bg-sunken px-2.5 py-0.5 text-xs text-ink-2"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>

        <aside className="space-y-6">
          <Card className="overflow-hidden">
            {/*
              `ProductImage` is the storefront's own component, so what shows
              here IS what a shopper sees — including its fallback when the
              link is dead.
            */}
            <ProductImage
              product={product}
              alt={product.name}
              className="aspect-square w-full bg-neutral-wash object-cover"
            />
            <div className="border-t border-hairline px-5 py-4">
              <PanelHeading eyebrow="Storefront" title="Visibility" />
              <dl className="mt-4 space-y-3">
                <Fact label="Status" tone={inactive ? 'critical' : undefined}>
                  {inactive ? 'Inactive — hidden from the store' : 'Active'}
                </Fact>
                <Fact label="Featured on the homepage">{product.featured ? 'Yes' : 'No'}</Fact>
                <Fact label="Shown in New Arrivals">{product.newArrival ? 'Yes' : 'No'}</Fact>
              </dl>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function PanelHeading({ eyebrow, title }) {
  return (
    <div className="min-w-0">
      <p className="label-mono">{eyebrow}</p>
      <h2 className="mt-1 text-base font-semibold text-ink">{title}</h2>
    </div>
  );
}

/** One key/value pair, with real `<dt>`/`<dd>` semantics. */
function Fact({ label, children, tone }) {
  return (
    <div>
      <dt className="label-mono">{label}</dt>
      <dd
        className={`mt-1 text-sm font-medium ${
          tone === 'critical' ? 'text-critical-ink' : 'text-ink'
        }`}
      >
        {children}
      </dd>
    </div>
  );
}
