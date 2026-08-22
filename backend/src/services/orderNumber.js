const Counter = require('../models/Counter');

/**
 * Human-readable order numbers.
 *
 * `ORD-000142` rather than `68f3a9c1b2d4e5f6a7b8c9d0`. The point is entirely
 * social: a Mongo ObjectId cannot be read down a phone line, quoted in an
 * email, or written on a delivery note. "What happened with 68f3a9…" is not a
 * sentence anyone finishes.
 *
 * THE FORMAT, AND WHY IT LOOKS LIKE THIS.
 *
 * The `ORD-` prefix means the number is self-describing: pasted into a search
 * box, a chat message, or a support ticket, it says what kind of thing it is
 * without context. It also makes the field trivially searchable without
 * matching every bare integer in the database.
 *
 * The zero padding is cosmetic and worth having: fixed-width numbers line up in
 * a table column, and they sort lexicographically in the same order they sort
 * numerically for as long as the padding holds. Six digits covers a million
 * orders, and the format degrades gracefully rather than breaking — order
 * 1,000,001 simply renders one character wider. Padding is presentation, not a
 * constraint, so nothing depends on the width.
 */

const PREFIX = 'ORD';
const PAD_TO = 6;

/** The counter document these numbers come from. */
const SEQUENCE = 'order';

/**
 * Render a sequence number in the display format.
 *
 * @param {number} seq
 * @returns {string} e.g. `ORD-000142`
 */
function formatOrderNumber(seq) {
  return `${PREFIX}-${String(seq).padStart(PAD_TO, '0')}`;
}

/**
 * Allocate the next order number.
 *
 * Atomic: no two callers can receive the same value, because the counter's
 * read and write are one operation. See models/Counter.js for why the obvious
 * alternative — counting existing orders and adding one — is a race.
 *
 * Pass the session when calling inside a transaction, so an aborted order does
 * not consume a number.
 *
 * @param {import('mongoose').ClientSession} [session]
 * @returns {Promise<string>}
 */
async function nextOrderNumber(session) {
  return formatOrderNumber(await Counter.next(SEQUENCE, { session }));
}

/**
 * Does this string look like an order number?
 *
 * Used by the list filter to tell `?search=ORD-000142` from a customer name,
 * so one search box can serve both without the caller having to say which they
 * meant.
 *
 * Deliberately loose: case-insensitive, and the prefix and padding are both
 * optional, so `ord-142`, `ORD-000142` and `142` are all recognised. Someone
 * typing a number they read off a screen should not have to reproduce its
 * formatting exactly.
 */
const LOOKS_LIKE_ORDER_NUMBER = /^\s*(?:ord[-\s]?)?(\d{1,12})\s*$/i;

/**
 * Normalise whatever the user typed into a stored order number.
 *
 * @param {string} input
 * @returns {string|null} the canonical form, or null if this is not one
 */
function parseOrderNumber(input) {
  const match = LOOKS_LIKE_ORDER_NUMBER.exec(String(input ?? ''));
  if (!match) return null;

  return formatOrderNumber(Number(match[1]));
}

module.exports = {
  nextOrderNumber,
  formatOrderNumber,
  parseOrderNumber,
  PREFIX,
  SEQUENCE,
};
