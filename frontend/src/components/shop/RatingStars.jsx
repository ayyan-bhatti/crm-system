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
 *
 * `size` exists because the same rating appears at two very different scales:
 * a whisper under a grid caption, and a real line of information beside a
 * product headline. Scaling one component is what keeps the two consistent.
 */
export default function RatingStars({ rating, className = '', showCount = true, size = 'sm' }) {
  const average = Math.max(0, Math.min(5, rating?.average || 0));
  const count = rating?.count || 0;

  if (count === 0) return null;

  const star = size === 'lg' ? 'h-4 w-4' : 'h-3 w-3';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex gap-px" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => {
          const fill = Math.max(0, Math.min(1, average - i)) * 100;
          return (
            <span key={i} className={`relative inline-block ${star}`}>
              <Star className={`absolute inset-0 ${star} text-rule`} />
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill}%` }}>
                <Star className={`${star} text-brand`} />
              </span>
            </span>
          );
        })}
      </div>

      {/* The number in words, because a row of shapes is not a rating to
          anyone who cannot see it. */}
      <span className="sr-only">
        {average.toFixed(1)} out of 5 stars, {count} {count === 1 ? 'review' : 'reviews'}
      </span>

      {showCount && (
        <span
          aria-hidden="true"
          className={`tabular ${size === 'lg' ? 'text-sm text-ink-2' : 'text-xs text-muted'}`}
        >
          {average.toFixed(1)} <span className="text-muted">({count})</span>
        </span>
      )}
    </div>
  );
}

function Star({ className }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="currentColor" aria-hidden="true">
      <path d="M10 1.5l2.6 5.4 5.9.7-4.3 4.1 1.1 5.8L10 14.7l-5.3 2.8 1.1-5.8-4.3-4.1 5.9-.7L10 1.5z" />
    </svg>
  );
}
