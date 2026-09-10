import { Link } from 'react-router-dom';
import { Breadcrumb } from '../../components/common';
import { ROOMS } from '../../shopContent';

/**
 * "Shop by room" — each card is a named set of real categories (see `ROOMS` in
 * shopContent.js), not a separate taxonomy the catalogue has to keep in sync.
 *
 * PHOTOGRAPHIC NOW, WHERE THERE IS A HONEST PHOTOGRAPH TO USE.
 *
 * This page used to argue itself out of imagery: a room has no single
 * representative product, so a cropped stock photo was said to be a worse
 * promise than a heading and a list of categories. That reasoning holds
 * against a *stock* photo. It does not hold against the picture already used
 * for the room's leading category on the home page — the same verified
 * Unsplash image the seed catalogue uses for that category's own products, so
 * every photo on the site still traces back to one checked source. A furniture
 * shop's "shop by room" page that shows no rooms is a contents page, and the
 * one thing a visitor wants from it is to see what a room looks like.
 *
 * The fallback matters as much as the mapping: a room added to `ROOMS` with no
 * image here renders as a typographic tile rather than a broken one, so the
 * page cannot be broken by editing a content file.
 */

/**
 * Room → the Unsplash id already in use for that room's leading category.
 * Keyed on the slug rather than the display name, because the name is copy and
 * copy gets edited.
 */
const ROOM_IMAGES = {
  'living-room': '1600210491369-e753d80a41f3',
  'dining-room': '1758977404607-9d6217cad08a',
  bedroom: '1616594039964-ae9021a400a0',
  outdoor: '1777052854737-7893f50de539',
};

export default function Rooms() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <Breadcrumb items={[{ label: 'Home', to: '/' }, { label: 'Rooms' }]} className="mb-6" />

      <header className="max-w-2xl">
        <p className="label-mono">Shop by room</p>
        <h1 className="font-display mt-2 text-[34px] leading-[1.05] text-ink sm:text-[52px]">
          What are you furnishing?
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-ink-2">
          Every room pulls together the categories that actually belong in it — so a single link
          gets you the sofa, the coffee table and the rug rather than three separate hunts.
        </p>
      </header>

      <div className="mt-12 grid gap-x-6 gap-y-12 sm:mt-16 sm:grid-cols-2">
        {ROOMS.map((room, index) => {
          const image = ROOM_IMAGES[room.slug];

          return (
            <article key={room.slug} className="group">
              <Link
                to={`/products?category=${encodeURIComponent(room.categories.join(','))}`}
                className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 focus-visible:ring-offset-plane"
              >
                <div
                  className={`relative overflow-hidden rounded-lg bg-sunken ${
                    /* The first tile is the widest thing on the page, so it
                       gets the most generous crop; the rest stay uniform so
                       the grid still reads as a grid. */
                    index === 0 ? 'aspect-[16/10] sm:aspect-[4/3]' : 'aspect-[16/10]'
                  }`}
                >
                  {image ? (
                    <img
                      src={`https://images.unsplash.com/photo-${image}?w=1000&q=75&auto=format&fit=crop`}
                      alt=""
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-[var(--motion-ease)] group-hover:scale-[1.03]"
                    />
                  ) : (
                    <span className="absolute inset-0 flex items-end bg-ink p-7">
                      <span className="font-display text-[30px] leading-tight text-plane">
                        {room.name}
                      </span>
                    </span>
                  )}
                </div>

                <h2 className="font-display mt-5 text-[26px] leading-tight text-ink">
                  {room.name}
                </h2>
              </Link>

              <p className="mt-2 text-sm leading-relaxed text-ink-2">
                {room.categories.join(' · ')}
              </p>

              <Link
                to={`/products?category=${encodeURIComponent(room.categories.join(','))}`}
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-brand"
              >
                Shop {room.name.toLowerCase()}
                <span
                  aria-hidden="true"
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </article>
          );
        })}
      </div>
    </div>
  );
}
