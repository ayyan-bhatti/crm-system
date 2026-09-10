import { useMemo } from 'react';

/**
 * Choosing a colour, and then a size within that colour.
 *
 * WHY SIZE IS FILTERED BY THE CHOSEN COLOUR RATHER THAN LISTED IN FULL
 *
 * Variants are a flat list of real combinations, not a grid of every colour
 * crossed with every size — a shop genuinely can stock Midnight in S and L but
 * Sand only in M. Listing all sizes and rejecting the impossible ones on submit
 * is the common way to build this and it is worse: the shopper picks a
 * combination that was never offered, and finds out at the point of a failure
 * message. Filtering the second choice by the first means only real
 * combinations are ever offered.
 *
 * A SIZE THAT EXISTS BUT IS SOLD OUT IS SHOWN AND DISABLED, not hidden. "We
 * don't have that in your size right now" and "we don't make that size" are
 * different facts, and hiding the first tells the shopper the second.
 *
 * THE ACCESSIBLE NAMES HERE ARE A CONTRACT. The colour buttons are named by
 * the colour ("Midnight", "Forest (out of stock)") and the fieldset's legend
 * carries the current selection, which is what lets both a screen reader and
 * the test suite answer "which colour is chosen" without looking at a pixel.
 */
export default function VariantPicker({ variants, value, onChange }) {
  // Distinct colours, preserving catalogue order rather than sorting — the
  // order a shop lists its colours in is usually deliberate.
  const colours = useMemo(() => {
    const seen = new Map();
    for (const variant of variants) {
      const key = variant.color.name;
      if (!seen.has(key)) {
        seen.set(key, { name: key, hex: variant.color.hex, inStock: variant.inStock });
      } else if (variant.inStock) {
        seen.get(key).inStock = true;
      }
    }
    return [...seen.values()];
  }, [variants]);

  const selected = variants.find((v) => v._id === value) || null;
  const selectedColour = selected?.color.name || null;

  const sizesForColour = useMemo(() => {
    if (!selectedColour) return [];
    return variants.filter((v) => v.color.name === selectedColour && v.size);
  }, [variants, selectedColour]);

  /**
   * Picking a colour selects a variant immediately — the first available size
   * in that colour, or the first size at all if every one is sold out.
   *
   * Selecting eagerly rather than leaving the choice null matters for the
   * single most common case by far: a product with colours and NO sizes, where
   * choosing the colour IS choosing the variant and a second click on an
   * invisible size control would be impossible.
   */
  function chooseColour(name) {
    const inColour = variants.filter((v) => v.color.name === name);
    const preferred = inColour.find((v) => v.inStock) || inColour[0];
    onChange(preferred?._id || null);
  }

  return (
    <div className="space-y-7">
      <fieldset>
        <legend className="mb-3 flex flex-wrap items-baseline gap-x-2">
          <span className="label-mono">
            Colour
            <span className="ml-1 text-critical-ink" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (Required)</span>
          </span>
          {selectedColour && (
            <span className="text-sm font-medium text-ink">{selectedColour}</span>
          )}
        </legend>

        <div className="flex flex-wrap gap-3">
          {colours.map((colour) => {
            const active = colour.name === selectedColour;
            return (
              <button
                key={colour.name}
                type="button"
                onClick={() => chooseColour(colour.name)}
                disabled={!colour.inStock}
                aria-pressed={active}
                title={colour.inStock ? colour.name : `${colour.name} — out of stock`}
                className={`relative h-10 w-10 rounded-full ring-1 ring-inset ring-ink/15 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane ${
                  active ? 'ring-2 ring-brand ring-offset-2 ring-offset-plane' : ''
                } ${colour.inStock ? 'hover:scale-105' : 'cursor-not-allowed opacity-40'}`}
                style={{ backgroundColor: colour.hex }}
              >
                {/* The name is the accessible label; the colour alone is not one. */}
                <span className="sr-only">
                  {colour.name}
                  {colour.inStock ? '' : ' (out of stock)'}
                </span>
                {!colour.inStock && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 flex items-center justify-center text-xs font-bold text-ink/60"
                  >
                    ✕
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-2.5 text-xs text-muted">
          Shown as a swatch — pick one to add to your cart.
        </p>
      </fieldset>

      {sizesForColour.length > 0 && (
        <fieldset>
          <legend className="label-mono mb-3">
            Size
            <span className="ml-1 text-critical-ink" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (Required)</span>
          </legend>

          <div className="flex flex-wrap gap-2">
            {sizesForColour.map((variant) => (
              <button
                key={variant._id}
                type="button"
                onClick={() => onChange(variant._id)}
                disabled={!variant.inStock}
                aria-pressed={variant._id === value}
                className={`min-w-14 rounded-md border px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-plane ${
                  variant._id === value
                    ? 'border-ink bg-ink text-plane'
                    : 'border-rule bg-surface text-ink-2 hover:border-ink/30 hover:text-ink'
                } ${variant.inStock ? '' : 'cursor-not-allowed text-muted line-through opacity-50'}`}
              >
                {variant.size}
              </button>
            ))}
          </div>
          <p className="mt-2.5 text-xs text-muted">
            Only the sizes stocked in {selectedColour} are shown.
          </p>
        </fieldset>
      )}
    </div>
  );
}
