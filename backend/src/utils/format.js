/**
 * Server-side formatting helpers.
 *
 * Small, but shared: the deterministic summary fallback needs to render money
 * the same way the frontend does, and a second inline implementation would
 * drift the first time either changed.
 */

/** Format a number as currency for inclusion in generated text. */
function money(value) {
  const amount = Number(value) || 0;
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

module.exports = { money };
