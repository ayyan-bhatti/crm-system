import { Link } from 'react-router-dom';
import { money } from '../../ui';

export default function ProductCard({ product }) {
  return (
    <Link
      to={`/shop/products/${product._id}`}
      className="hover-lift group block overflow-hidden rounded-xl border border-hairline bg-surface"
    >
      <div className="aspect-square overflow-hidden bg-neutral-wash">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt=""
            className="h-full w-full object-cover transition-transform duration-[220ms] group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted">
            No image
          </div>
        )}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-medium text-ink">{product.name}</p>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink tabular">{money(product.price)}</span>
          {!product.inStock && (
            <span className="text-xs font-medium text-critical-ink">Out of stock</span>
          )}
        </div>
      </div>
    </Link>
  );
}
