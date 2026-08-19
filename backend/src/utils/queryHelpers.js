const mongoose = require('mongoose');

/**
 * Helpers shared by every list endpoint.
 *
 * Customers, products, orders and audit logs all support paging, sorting and
 * text search. Keeping that logic here means the four endpoints behave
 * identically instead of quietly drifting apart as each one is edited.
 *
 * ---------------------------------------------------------------------------
 * PAGINATION: WHY BOTH STYLES EXIST
 * ---------------------------------------------------------------------------
 *
 * This module supports offset paging AND cursor paging, and which one runs is
 * decided by whether the caller sends `?cursor=`. That is not indecision — the
 * two answer different questions and each is bad at the other's job.
 *
 *   OFFSET (?page=3)
 *     + page numbers, a total count, and "jump to page 7"
 *     + trivially understood by anyone reading the URL
 *     - `skip` is O(n): MongoDB walks and discards every skipped document, so
 *       page 500 genuinely costs 500 pages of work
 *     - DRIFT. If a record is inserted while someone pages through, everything
 *       shifts down by one — so an item that was at the bottom of page 1 slides
 *       to the top of page 2 and is seen twice, while another is skipped
 *       entirely. Nothing errors; the user just gets a subtly wrong list.
 *
 *   CURSOR (?cursor=<opaque>)
 *     + O(log n) with an index, however deep you go
 *     + stable under insertion: "everything after this exact record" does not
 *       move when something is added above it
 *     - no page numbers and no jumping — only "next"
 *     - a total count needs a separate query
 *
 * The UI uses offset, because a CRM list with page numbers and "312 results" is
 * what people expect and the collections a human pages through are small.
 * Cursor is there for the cases that break offset: the audit log, which grows
 * without bound and is append-heavy (so drift is not theoretical), and any
 * script exporting a whole collection.
 *
 * Offering both costs one shared helper. Offering only offset would mean the
 * audit log gets slower and less correct the longer the system runs.
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
 *
 * ---------------------------------------------------------------------------
 * THE `_id` TIEBREAKER — a real bug, not a nicety
 * ---------------------------------------------------------------------------
 *
 * This used to return `{ createdAt: -1 }` and nothing else. Sorting by a
 * NON-UNIQUE field gives MongoDB no defined order among documents that tie, and
 * it is free to return them differently between two queries. Ties are not rare
 * here: the seed script creates records in a loop, and any bulk import stamps
 * dozens of rows with the same `createdAt` to the millisecond.
 *
 * The consequence is silent and confusing. Page 1 ends mid-tie; page 2 starts
 * mid-tie in a different order; a record appears on both pages while another
 * never appears at all. Nothing errors and the totals still look right.
 *
 * Appending `_id` — which is unique by construction — makes the ordering total,
 * so the sequence is identical every time. Cursor paging depends on this
 * absolutely: "everything after this record" is meaningless without a
 * deterministic definition of "after".
 */
function getSort(query, allowedFields, fallback = { createdAt: -1 }) {
  let sort = fallback;

  if (query.sort) {
    const raw = String(query.sort);
    const descending = raw.startsWith('-');
    const field = descending ? raw.slice(1) : raw;

    if (allowedFields.includes(field)) {
      sort = { [field]: descending ? -1 : 1 };
    }
  }

  // Already unique — adding _id again would be harmless but pointless.
  if (Object.prototype.hasOwnProperty.call(sort, '_id')) return sort;

  // The tiebreaker follows the primary field's direction, so the whole ordering
  // reads in one consistent direction rather than zig-zagging within each tie.
  const direction = Object.values(sort)[0] === 1 ? 1 : -1;

  return { ...sort, _id: direction };
}

/** The single field a sort is primarily on, and which way it runs. */
function primarySort(sort) {
  const [field, direction] = Object.entries(sort)[0];
  return { field, direction };
}

/**
 * Encode a cursor.
 *
 * It carries the sort value of the last row AND its `_id`, because the sort
 * field is not unique — without the id, a cursor landing in the middle of a run
 * of identical timestamps could not say which of them it meant, and would
 * either repeat or skip the rest of the run.
 *
 * Base64 of JSON, and deliberately treated as opaque by the client. Not for
 * secrecy — anyone can decode it — but so that the encoding can change later
 * without breaking callers who might otherwise have started parsing it.
 */
function encodeCursor(document, sortField) {
  const payload = { v: document[sortField], id: String(document._id) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decode a cursor, returning null for anything malformed. */
function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.id) return null;
    if (!mongoose.isValidObjectId(parsed.id)) return null;
    return parsed;
  } catch {
    // A cursor is client-supplied, so a corrupted one is ordinary bad input.
    return null;
  }
}

/**
 * Narrow a filter to "everything strictly after this cursor", in sort order.
 *
 * The predicate is the keyset pattern, and the `$or` is the part worth reading
 * carefully:
 *
 *   { $or: [ { sortField: { $lt: v } },
 *            { sortField: v, _id: { $lt: id } } ] }
 *
 * The first clause takes every row past the tie. The second walks the REST of
 * the tie the cursor stopped inside. Using only the first would drop the tail of
 * a tied run; using only `_id` would ignore the sort entirely.
 *
 * Returns the filter unchanged when the cursor is absent or unusable, so a
 * mangled cursor falls back to the first page instead of erroring.
 */
function applyCursor(filter, cursor, sort) {
  const decoded = decodeCursor(cursor);
  if (!decoded) return filter;

  const { field, direction } = primarySort(sort);
  const operator = direction === 1 ? '$gt' : '$lt';

  // Dates arrive from JSON as strings and must go back to Dates, or the
  // comparison is string-vs-Date and silently matches nothing.
  const value =
    typeof decoded.v === 'string' && !Number.isNaN(Date.parse(decoded.v)) && field !== '_id'
      ? new Date(decoded.v)
      : decoded.v;

  const keyset = {
    $or: [
      { [field]: { [operator]: value } },
      { [field]: value, _id: { [operator]: new mongoose.Types.ObjectId(decoded.id) } },
    ],
  };

  // $and rather than merging keys: the incoming filter may already have its own
  // $or (a sales rep's scope, a search clause), and overwriting it would drop a
  // permission rule.
  return { $and: [filter, keyset] };
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
 * Response shape for cursor paging.
 *
 * `nextCursor` is null on the last page, which is how a client knows to stop —
 * more reliable than comparing counts, because a page that happens to be
 * exactly `limit` long is indistinguishable from a full one.
 *
 * There is no `total`: counting the whole collection on every page is the cost
 * cursor paging exists to avoid. A caller who needs it can ask the offset
 * endpoint once.
 */
function cursorResponse({ data, limit, sort }) {
  const hasMore = data.length > limit;
  // One extra row was fetched purely to answer "is there a next page?" — it is
  // trimmed here rather than returned.
  const page = hasMore ? data.slice(0, limit) : data;

  const { field } = primarySort(sort);

  return {
    success: true,
    count: page.length,
    data: page,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1], field) : null,
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
  // Cursor paging
  encodeCursor,
  decodeCursor,
  applyCursor,
  cursorResponse,
  primarySort,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
