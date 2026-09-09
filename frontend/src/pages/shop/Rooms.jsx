import { Link } from 'react-router-dom';
import { ROOMS } from '../../shopContent';

/**
 * "Shop by room" — each card is a named set of real categories (see
 * `ROOMS` in shopContent.js), not a separate taxonomy the catalogue has to
 * keep in sync. Deliberately typographic rather than photographic: a room
 * has no single representative product, and a stretched, cropped stock
 * photo would be a worse promise than a heading and a category list.
 */
export default function Rooms() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <p className="label-mono">Shop by room</p>
      <h1 className="font-display mt-1 mb-2 text-3xl font-semibold text-ink">
        What are you furnishing?
      </h1>
      <p className="mb-8 max-w-xl text-sm text-ink-2">
        Every room pulls together the categories that actually belong in it.
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        {ROOMS.map((room, index) => (
          <Link
            key={room.slug}
            to={`/products?category=${encodeURIComponent(room.categories.join(','))}`}
            className={`hover-lift group flex min-h-48 flex-col justify-end rounded-2xl border p-8 transition-colors ${
              index % 3 === 0
                ? 'border-ink bg-ink text-plane hover:bg-ink/95'
                : 'border-hairline bg-surface text-ink hover:bg-neutral-wash/50'
            }`}
          >
            <h2 className="font-display text-2xl font-semibold">{room.name}</h2>
            <p
              className={`mt-2 text-sm ${index % 3 === 0 ? 'text-plane/70' : 'text-ink-2'}`}
            >
              {room.categories.join(' · ')}
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold">
              Shop {room.name.toLowerCase()}
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
