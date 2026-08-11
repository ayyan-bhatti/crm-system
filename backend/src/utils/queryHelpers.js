/**
 * Helpers shared by every list endpoint.
 *
 * Customers, products and orders all support paging, sorting and text search.
 * Keeping that logic here means the three endpoints behave identically instead
 * of quietly drifting apart as each one is edited.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Escape a user-supplied string so it can be embedded in a RegExp literally.
 *
 * Without this, a search for "c++" or "a.b" would be interpreted as a pattern
 * and could either error or match far more than the user intended.
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a case-insensitive "contains" regex from user input. */
function containsRegex(value) {
  return new RegExp(escapeRegex(value.trim()), 'i');
}

/**
 * Read `?page=` and `?limit=` into skip/limit values.
 * The limit is capped so a client cannot ask for the entire collection at once.
 */
function getPagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const requested = parseInt(query.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, requested), MAX_LIMIT);

  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Turn `?sort=-createdAt` into a Mongoose sort object, restricted to an
 * allow-list of sortable fields.
 *
 * The allow-list matters: passing raw user input to .sort() would let a client
 * sort by any field in the document, including ones that aren't indexed.
 */
function getSort(query, allowedFields, fallback = { createdAt: -1 }) {
  if (!query.sort) return fallback;

  const raw = String(query.sort);
  const descending = raw.startsWith('-');
  const field = descending ? raw.slice(1) : raw;

  if (!allowedFields.includes(field)) return fallback;

  return { [field]: descending ? -1 : 1 };
}

/** Standard shape for every paginated list response. */
function paginatedResponse({ data, total, page, limit }) {
  return {
    success: true,
    count: data.length,
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
    data,
  };
}

/**
 * Build a `createdAt` range filter from `?from=` and `?to=`.
 * Returns null when neither is supplied, so callers can skip the key entirely.
 *
 * `to` is pushed to the end of that day so a range like from=2024-01-01&to=2024-01-31
 * includes orders placed on the 31st, which is what a user means by "to".
 */
function getDateRange(from, to) {
  const range = {};

  if (from) {
    const start = new Date(from);
    if (!Number.isNaN(start.getTime())) range.$gte = start;
  }

  if (to) {
    const end = new Date(to);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
  }

  return Object.keys(range).length ? range : null;
}

module.exports = {
  escapeRegex,
  containsRegex,
  getPagination,
  getSort,
  paginatedResponse,
  getDateRange,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
