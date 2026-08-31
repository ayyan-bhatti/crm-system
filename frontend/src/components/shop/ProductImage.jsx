import { useEffect, useState } from 'react';
import { placeholderImage } from '../../ui';

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
 *
 * `key` on the img resets `failed` when the src changes, which matters in the
 * gallery: clicking a thumbnail swaps the source, and without the reset a
 * single broken image would pin every subsequent one to the placeholder.
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
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const resolved = src || '';

  // A new source deserves its own chance to load.
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [resolved]);

  useEffect(() => {
    if (!resolved || loaded || failed) return undefined;
    const timer = setTimeout(() => setFailed(true), IMAGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [resolved, loaded, failed]);

  const fallback = placeholderImage(product);

  return (
    <img
      src={failed || !resolved ? fallback : resolved}
      alt={alt ?? product?.name ?? ''}
      onError={() => setFailed(true)}
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
