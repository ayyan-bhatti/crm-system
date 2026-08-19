/**
 * Convert a duration string like "15m" or "7d" into milliseconds.
 *
 * The token TTLs are configured in the same zeit/ms format jsonwebtoken already
 * accepts, so that one setting can drive both the JWT's `expiresIn` and the
 * cookie's `maxAge` without being written twice in two different units — the
 * classic way a cookie and the token inside it end up expiring at different
 * times.
 *
 * This is deliberately a tiny local helper rather than a dependency: the `ms`
 * package is only present transitively (via jsonwebtoken), and depending on
 * another package's dependency is how builds break silently on an upgrade.
 */

const UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function ms(value) {
  // A plain number is already milliseconds — same rule jsonwebtoken applies to
  // `expiresIn`, so the two stay consistent.
  if (typeof value === 'number') return value;

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(value).trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${value}". Use a number of milliseconds or a string like "15m", "12h", "7d".`
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();

  return amount * UNITS[unit];
}

module.exports = ms;
