import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { productsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, PageHeader, Spinner } from '../../components/common';
import { useToast } from '../../components/Toast';
import { RoleGate } from '../../components/ProtectedRoute';
import { PRODUCT_WRITE_ROLES } from '../../constants';
import { btnDanger, btnPrimary, formatDate, money } from '../../ui';

export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Deleting navigates back to the list, so a banner rendered here would vanish
  // with the component and the user would arrive with no confirmation at all.
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);

  const { data: product, loading, error } = useFetch(() => productsApi.get(id), [id]);

  async function handleDelete() {
    if (!window.confirm('Delete this product? This cannot be undone.')) return;

    setDeleting(true);

    try {
      await productsApi.remove(id);
      toast.success(`${product?.name || 'Product'} deleted.`);
      navigate('/products', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete product'));
      setDeleting(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!product) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={product.name}
        subtitle={product.sku}
        action={
          <RoleGate roles={PRODUCT_WRITE_ROLES}>
            <div className="flex gap-2">
              <Link to={`/products/${product._id}/edit`} className={btnPrimary}>
                Edit
              </Link>
              <button
                type="button"
                className={btnDanger}
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? <Spinner /> : 'Delete'}
              </button>
            </div>
          </RoleGate>
        }
      />


      {product.isLowStock && (
        <div className="rounded-md border border-critical/25 bg-critical-wash px-4 py-3 text-sm text-critical-ink">
          Stock is at or below the low-stock threshold of {product.lowStockThreshold}.
        </div>
      )}

      <Card className="p-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Detail label="Price" value={money(product.price)} />
          <Detail
            label="In stock"
            value={product.stockQty}
            emphasis={product.isLowStock ? 'text-critical-ink' : undefined}
          />
          <Detail label="Category" value={product.category} />
          <Detail label="Low stock threshold" value={product.lowStockThreshold} />
          <Detail label="SKU" value={product.sku} />
          <Detail label="Added" value={formatDate(product.createdAt)} />
        </dl>
      </Card>
    </div>
  );
}

function Detail({ label, value, emphasis }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-1 text-sm font-medium ${emphasis || 'text-ink'}`}>{value}</dd>
    </div>
  );
}
