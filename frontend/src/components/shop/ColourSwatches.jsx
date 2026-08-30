/**
 * The little circles of colour on a product card.
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
  const shown = colours.slice(0, max);
  const extra = colours.length - shown.length;

  const dot = size === 'lg' ? 'h-6 w-6' : 'h-3.5 w-3.5';

  return (
    <div className="flex items-center gap-1.5">
      {shown.map((colour) => (
        <span
          key={colour.name}
          /*
           * `title` plus a screen-reader label, because a circle of colour has
           * no accessible name at all on its own — and for the roughly one in
           * twelve men who would not be able to tell two of these apart.
           */
          title={colour.inStock ? colour.name : `${colour.name} — out of stock`}
          className={`${dot} inline-block rounded-full ring-1 ring-inset ring-ink/15 ${
            colour.inStock ? '' : 'opacity-35'
          }`}
          style={{ backgroundColor: colour.hex }}
        >
          <span className="sr-only">
            {colour.name}
            {colour.inStock ? '' : ' (out of stock)'}
          </span>
        </span>
      ))}
      {extra > 0 && <span className="text-[11px] font-medium text-muted">+{extra}</span>}
    </div>
  );
}
