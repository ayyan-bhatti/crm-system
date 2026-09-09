/**
 * A star rating plus its review count — shared between the product card and
 * the product detail page so the two never render the same number two
 * different ways.
 *
 * Rendered as five stacked pairs (an outline star with a clipped, filled star
 * on top) rather than five conditionally-swapped icons, so a rating like 4.3
 * shows a partially filled star instead of rounding to the nearest whole one
 * — rounding here would make every product ending in ".3" through ".7" look
 * identical to its neighbours.
 */
export default function RatingStars({ rating, className = '', showCount = true }) {
  const average = Math.max(0, Math.min(5, rating?.average || 0));
  const count = rating?.count || 0;

  if (count === 0) return null;

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <div className="flex" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => {
          const fill = Math.max(0, Math.min(1, average - i)) * 100;
          return (
            <span key={i} className="relative inline-block h-3 w-3">
              <Star className="absolute inset-0 text-hairline" fill="currentColor" />
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill}%` }}>
                <Star className="text-brand-strong" fill="currentColor" />
              </span>
            </span>
          );
        })}
      </div>
      <span className="sr-only">{average.toFixed(1)} out of 5 stars</span>
      {showCount && <span className="label-mono">{count}</span>}
    </div>
  );
}

function Star({ className, fill }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-3 w-3 ${className}`} fill={fill}>
      <path d="M10 1.5l2.6 5.4 5.9.7-4.3 4.1 1.1 5.8L10 14.7l-5.3 2.8 1.1-5.8-4.3-4.1 5.9-.7L10 1.5z" />
    </svg>
  );
}
