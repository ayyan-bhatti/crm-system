/**
 * The little circles of colour under a product card's caption.
 *
 * READ-ONLY BY DESIGN. A card's swatches say "this comes in four colours"; they
 * are not a picker. Making them selectable on a grid tile sounds helpful and is
 * not — the shopper has not chosen a size yet, cannot see the colour on the
 * product at that scale, and a click that silently changes what "Add to cart"
 * would do is exactly the kind of hidden state that gets an order returned. The
 * choice belongs on the detail page and in Quick View, where the consequence is
 * visible. See VariantPicker for that.
 *
 * DUPLICATE COLOURS ARE COLLAPSED. A product with one colour in four sizes has
 * four variants and one swatch — showing the same circle four times would imply
 * four choices that do not exist.
 *
 * Rendered as a `<ul>` rather than a row of spans: it is a list of the colours
 * something comes in, and a screen reader announcing "list, 4 items" before
 * reading the names is the difference between a set and four loose words.
 */
export default function ColourSwatches({ variants = [], max = 5, size = 'sm' }) {
  if (!variants.length) return null;

  const byColour = new Map();
  for (const variant of variants) {
    const key = variant.color?.name?.toLowerCase() || variant.colorName?.toLowerCase();
    if (!key) continue;

    if (!byColour.has(key)) {
      byColour.set(key, {
        name: variant.color?.name || variant.colorName,
        hex: variant.color?.hex || variant.colorHex,
        // A colour counts as available if ANY size of it is in stock.
        inStock: Boolean(variant.inStock),
      });
    } else if (variant.inStock) {
      byColour.get(key).inStock = true;
    }
  }

  const colours = [...byColour.values()];
  if (colours.length === 0) return null;

  const shown = colours.slice(0, max);
  const extra = colours.length - shown.length;

  const dot = size === 'lg' ? 'h-5 w-5' : 'h-3 w-3';

  return (
    <ul className="flex items-center gap-1.5">
      {shown.map((colour) => (
        <li
          key={colour.name}
          /*
           * `title` plus a screen-reader label, because a circle of colour has
           * no accessible name at all on its own — and for the roughly one in
           * twelve men who would not be able to tell two of these apart.
           */
          title={colour.inStock ? colour.name : `${colour.name} — out of stock`}
          className={`${dot} rounded-full ring-1 ring-inset ring-ink/20 ${
            colour.inStock ? '' : 'opacity-30'
          }`}
          style={{ backgroundColor: colour.hex }}
        >
          <span className="sr-only">
            {colour.name}
            {colour.inStock ? '' : ' (out of stock)'}
          </span>
        </li>
      ))}
      {extra > 0 && (
        <li className="text-[11px] font-medium tracking-wide text-muted">+{extra}</li>
      )}
    </ul>
  );
}
