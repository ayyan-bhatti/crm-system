import { useEffect, useState } from 'react';
import { placeholderImage, livePhotoFor } from '../../ui';

/**
 * A product photograph that cannot fail to render.
 *
 * WHY THIS IS A COMPONENT AND NOT A BARE `<img>`.
 *
 * Product images come from three places with three different reliability
 * stories: a URL somebody typed into the CRM (which can be a typo, a dead link,
 * or a host that blocks hotlinking), a keyword-matched photo from a third-party
 * library (which can be slow, rate-limited, or blocked on a corporate network),
 * and a generated data URI (which cannot fail at all). Only the last one is
 * guaranteed, so every one of the first two needs a path back to it.
 *
 * A broken-image icon in a product grid is worse than no photo. It is the one
 * piece of UI that says "nobody runs this shop" more loudly than an empty
 * state, and it is the default browser behaviour for a URL that 404s — so the
 * fallback has to be explicit or it does not exist.
 */

/**
 * How long to wait before treating a silent image as a failed one.
 *
 * A DEAD HOST DOES NOT FIRE `onError`. It fires nothing at all — the request
 * hangs until the browser's own timeout, which is measured in tens of seconds,
 * and until then the element is simply empty. That is worse than a broken-image
 * icon, because an empty box looks like a page that has finished rendering.
 *
 * This was not hypothetical: the seeded catalogue pointed at picsum.photos,
 * which is unreachable from some networks (including the one this was developed
 * on), and every product showed a blank grey square with no error anywhere —
 * in the console, in the network tab as a failure, or on screen. The shop
 * looked abandoned and nothing said why.
 *
 * Six seconds is longer than a slow image on a bad connection and far shorter
 * than a browser's own patience.
 */
const IMAGE_TIMEOUT_MS = 6000;

export default function ProductImage({ product, src, alt, className = '', ...rest }) {
  /*
   * THREE SOURCES, TRIED IN ORDER, not two.
   *
   * The earlier version fell from a broken URL straight to the generated tile,
   * which was wrong in the most common real case: a product whose `imageUrl`
   * points at something dead. That is not "this product has no photo" — it is
   * "this link is broken" — and answering it with an initials tile means a
   * catalogue of lettered squares, which is exactly what a shop is not supposed
   * to look like.
   *
   *   0. the URL somebody actually set (a typo, a dead host, a hotlink block)
   *   1. a keyword-matched live photograph, derived from the product's own name
   *   2. the generated tile, which cannot fail — no network, never 404s
   *
   * Step 2 stays the floor rather than the default. Offline, or with the photo
   * host blocked, the page still renders something clean and on-brand.
   */
  const [stage, setStage] = useState(0);
  const [loaded, setLoaded] = useState(false);

  /*
   * Built conditionally rather than filtered.
   *
   * The first version wrote `[src || '', live, tile].filter(Boolean)` with a
   * separate `start` index to skip the empty slot — and the two disagreed. With
   * no `src` the filter collapsed the array to two entries, `start` was 1, and
   * index 1 was now the TILE: a product with no image URL skipped the live
   * photo entirely and went straight to initials. Exactly the case the live
   * photo exists for. Two ways of expressing "where do we begin" is one too
   * many, so the array is just correct by construction now.
   */
  const chain = [...(src ? [src] : []), livePhotoFor(product), placeholderImage(product)];
  const current = chain[Math.min(stage, chain.length - 1)];
  const isLast = stage >= chain.length - 1;

  // A new source deserves its own chance to load.
  useEffect(() => {
    setStage(0);
    setLoaded(false);
  }, [src]);

  const advance = () => {
    setLoaded(false);
    setStage((s) => Math.min(s + 1, chain.length - 1));
  };

  useEffect(() => {
    // The tile is a data URI and cannot hang, so no timer once we reach it.
    if (loaded || isLast) return undefined;
    const timer = setTimeout(advance, IMAGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, loaded, isLast]);

  return (
    <img
      key={current}
      src={current}
      alt={alt ?? product?.name ?? ''}
      onError={() => !isLast && advance()}
      onLoad={() => setLoaded(true)}
      /*
       * Lazy by default because a catalogue page mounts a dozen of these at
       * once, and async decoding keeps a slow image off the main thread rather
       * than letting it stall the rest of the page.
       */
      loading="lazy"
      decoding="async"
      className={className}
      {...rest}
    />
  );
}
