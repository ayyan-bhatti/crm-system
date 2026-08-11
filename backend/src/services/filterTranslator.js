const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { ENTITIES, DEFAULT_RESULTS } = require('./filterSchema');
const { containsRegex } = require('../utils/queryHelpers');

/**
 * Converts a validated filter object into a Mongoose query and runs it.
 *
 * By the time anything gets here the filter has already been checked against
 * the schema allow-lists, so this file can map fields and operators directly.
 * It is deliberately the only place that knows how an operator name becomes a
 * Mongo expression.
 */

const MODELS = { customer: Customer, product: Product, order: Order };

/** Populate paths that make a result readable in the UI. */
const POPULATE = {
  customer: [{ path: 'assignedTo', select: 'name email role' }],
  product: [],
  order: [
    { path: 'customer', select: 'name email company city' },
    { path: 'items.product', select: 'name sku' },
  ],
};

/** Turn one validated condition into a Mongo expression for its field. */
function conditionToMongo({ operator, value }) {
  switch (operator) {
    case 'eq':
      return value;

    case 'contains':
      return containsRegex(value);

    case 'in':
      return { $in: value };

    case 'gt':
      return { $gt: value };
    case 'gte':
      return { $gte: value };
    case 'lt':
      return { $lt: value };
    case 'lte':
      return { $lte: value };

    case 'between':
      return { $gte: value[0], $lte: value[1] };

    case 'before':
      return { $lt: value };
    case 'after':
      return { $gt: value };

    case 'withinDays': {
      // "in the last N days" — counted back from now.
      const cutoff = new Date(Date.now() - value * 24 * 60 * 60 * 1000);
      return { $gte: cutoff };
    }

    default:
      // Unreachable: the validator rejects unknown operators before this point.
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

/**
 * Build the Mongo filter for the plain field conditions.
 *
 * Conditions on the same field are combined with $and rather than overwriting
 * each other, so "price over 10 and under 50" survives as two clauses instead
 * of the second silently replacing the first.
 */
function conditionsToMongo(conditions) {
  const query = {};
  const extraClauses = [];

  for (const condition of conditions) {
    const expression = conditionToMongo(condition);

    if (Object.prototype.hasOwnProperty.call(query, condition.field)) {
      extraClauses.push({ [condition.field]: expression });
    } else {
      query[condition.field] = expression;
    }
  }

  if (extraClauses.length) {
    const base = { ...query };
    return { $and: [base, ...extraClauses] };
  }

  return query;
}

/**
 * Apply the cross-collection conditions.
 *
 * These need their own queries because MongoDB cannot join in a plain find().
 * `orderActivity` resolves to a set of customer ids first, then filters the
 * customer collection by membership in that set.
 */
async function applySpecialConditions(entity, special, query) {
  const result = { ...query };

  if (entity === 'customer' && special.orderActivity) {
    const { type, withinDays } = special.orderActivity;
    const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);

    // Customers with at least one order since the cutoff. Cancelled orders are
    // excluded — a cancelled order is not evidence of activity.
    const activeCustomerIds = await Order.find({
      createdAt: { $gte: cutoff },
      status: { $ne: 'cancelled' },
    }).distinct('customer');

    result._id = type === 'any' ? { $in: activeCustomerIds } : { $nin: activeCustomerIds };
  }

  if (entity === 'product' && special.lowStock === true) {
    result.$expr = { $lte: ['$stockQty', '$lowStockThreshold'] };
  }

  return result;
}

/**
 * Combine the AI-derived filter with the caller's role scope.
 *
 * $and rather than a merge: both objects may contain $or (a sales rep's scope
 * does), and spreading one over the other would drop a clause and leak records
 * the user is not allowed to see. This is why AI search cannot become a
 * permission bypass.
 */
function withScope(query, scopeFilter) {
  if (!scopeFilter || Object.keys(scopeFilter).length === 0) return query;
  if (Object.keys(query).length === 0) return scopeFilter;
  return { $and: [query, scopeFilter] };
}

/** Run a validated filter and return the matching documents. */
async function runFilter(filter, scopeFilter) {
  const { entity, conditions, special, sort, limit } = filter;

  const Model = MODELS[entity];
  let query = conditionsToMongo(conditions);
  query = await applySpecialConditions(entity, special, query);
  query = withScope(query, scopeFilter);

  const data = await Model.find(query)
    .populate(POPULATE[entity])
    .sort({ [sort.field]: sort.direction === 'asc' ? 1 : -1 })
    .limit(limit);

  return { data, mongoQuery: query };
}

/**
 * Filler words carrying no search signal.
 *
 * The fallback receives whole *questions*, not search terms — "customers in
 * Karachi with no orders in the last 30 days". Matching that string literally
 * finds nothing, because no customer record contains the sentence. Stripping
 * the question scaffolding leaves the part that identifies a record.
 *
 * Entity nouns (customer, product, order…) are included: they tell us which
 * collection to search, which `inferEntity` uses, but they are not text to
 * match against a record's fields.
 */
const STOP_WORDS = new Set([
  // question and command scaffolding
  'a', 'about', 'all', 'an', 'and', 'any', 'anyone', 'anything', 'are', 'as', 'at',
  'be', 'been', 'by', 'did', 'do', 'does', 'everyone', 'everything', 'find', 'for',
  'from', 'get', 'give', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'in',
  'is', 'it', 'its', 'like', 'list', 'look', 'looking', 'me', 'my', 'need', 'no',
  'none', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'please', 'search', 'see',
  'she', 'show', 'so', 'some', 'someone', 'something', 'tell', 'that', 'the',
  'their', 'them', 'there', 'these', 'they', 'this', 'those', 'to', 'under', 'up',
  'us', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'whose', 'why', 'will', 'with', 'without', 'you', 'your',
  // time language
  'ago', 'day', 'days', 'last', 'latest', 'month', 'months', 'never', 'new', 'old',
  'past', 'recent', 'recently', 'since', 'today', 'week', 'weeks', 'year', 'years',
  // entity nouns — they select the collection, they are not search text
  'account', 'accounts', 'client', 'clients', 'contact', 'contacts', 'customer',
  'customers', 'inventory', 'item', 'items', 'lead', 'leads', 'order', 'orders',
  'product', 'products', 'purchase', 'purchases', 'sale', 'sales', 'stock',
]);

/** Words that hint at which collection the user means. */
const ENTITY_HINTS = {
  customer: ['customer', 'customers', 'client', 'clients', 'lead', 'leads', 'account',
    'accounts', 'contact', 'contacts', 'company', 'companies'],
  product: ['product', 'products', 'stock', 'inventory', 'item', 'items', 'sku',
    'price', 'category'],
  order: ['order', 'orders', 'sale', 'sales', 'purchase', 'purchases', 'invoice'],
};

/**
 * Break a free-text question into the terms worth searching for.
 *
 * Bare numbers are dropped: in a natural-language query they are almost always
 * a quantity or a timeframe ("last 30 days", "over 500"), not text that appears
 * in a record. Hyphens, dots and @ are kept inside tokens so SKUs (`FURN-001`)
 * and email addresses survive intact.
 */
function tokenize(rawQuery) {
  const tokens = String(rawQuery)
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.'-]+/u)
    .map((token) => token.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !/^\d+$/.test(token));

  // De-duplicate, and cap the count so a pasted paragraph cannot build a
  // hundred-clause $or.
  return [...new Set(tokens)].slice(0, 8);
}

/**
 * Guess which collection the question is about.
 *
 * Scored by hint hits, with the earliest-mentioned entity winning a tie — in
 * "customers … with no orders", the user is asking for customers, and they said
 * so first. Falls back to customers, which is what a bare name or company
 * almost always means.
 */
function inferEntity(rawQuery, requestedEntity) {
  // An explicit request from the client always wins.
  if (requestedEntity && ENTITIES[requestedEntity]) return requestedEntity;

  const text = String(rawQuery).toLowerCase();
  let best = null;

  for (const [entity, hints] of Object.entries(ENTITY_HINTS)) {
    let hits = 0;
    let earliest = Infinity;

    for (const hint of hints) {
      const at = text.search(new RegExp(`\\b${hint}\\b`));
      if (at !== -1) {
        hits += 1;
        earliest = Math.min(earliest, at);
      }
    }

    if (hits === 0) continue;
    if (!best || hits > best.hits || (hits === best.hits && earliest < best.earliest)) {
      best = { entity, hits, earliest };
    }
  }

  return best ? best.entity : 'customer';
}

/**
 * The graceful degradation path, used whenever the AI step is unavailable or
 * its answer failed validation.
 *
 * It cannot reproduce what the model does — no date maths, no cross-collection
 * conditions — but it should still answer the recognisable part of the
 * question. So the query is tokenised, filler words are dropped, and a record
 * matching *any* remaining term is returned, ranked by how many it matched.
 *
 * Orders carry no searchable text of their own, so a question that resolves to
 * orders searches customers instead — a name is what someone would be typing.
 */
async function runKeywordSearch(rawQuery, scopeFilters, requestedEntity) {
  let entity = inferEntity(rawQuery, requestedEntity);

  // Fall back to customers for any entity with nothing to match against.
  if (!ENTITIES[entity] || !ENTITIES[entity].keywordFields.length) entity = 'customer';

  const schema = ENTITIES[entity];
  const Model = MODELS[entity];
  const fields = schema.keywordFields;

  let terms = tokenize(rawQuery);

  // Tokenising can legitimately empty the list, and the right answer differs:
  //
  //   "001"                       a single identifier the number rule discarded.
  //                               Search it literally — it is what was meant.
  //   "show me all the customers" filler only. Searching it literally matches
  //                               nothing; the user asked to see everything, so
  //                               fall through to the most recent records.
  //
  // A query with no whitespace is an identifier; one with whitespace is a
  // sentence.
  if (!terms.length) {
    const raw = String(rawQuery).trim();
    if (raw && !/\s/.test(raw) && raw.length <= 40) terms = [raw.toLowerCase()];
  }
  const clauses = terms.flatMap((term) =>
    fields.map((field) => ({ [field]: containsRegex(term) }))
  );

  let query = clauses.length ? { $or: clauses } : {};
  query = withScope(query, scopeFilters[entity]);

  // Over-fetch so ranking has something to sort before the result is trimmed.
  const candidates = await Model.find(query)
    .populate(POPULATE[entity])
    .sort({ [schema.defaultSort]: -1 })
    .limit(DEFAULT_RESULTS * 3);

  // Rank by how many distinct terms a record matched, so "karachi textiles"
  // puts the company of that name above everything merely in Karachi. Mongo
  // cannot express this in a plain find(), and the candidate set is small.
  const ranked =
    terms.length > 1
      ? candidates
          .map((doc) => {
            const haystack = fields
              .map((field) => String(doc[field] ?? ''))
              .join(' ')
              .toLowerCase();
            return { doc, score: terms.filter((term) => haystack.includes(term)).length };
          })
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.doc)
      : candidates;

  return {
    entity,
    data: ranked.slice(0, DEFAULT_RESULTS),
    // Returned so the UI can show which words were actually searched for —
    // otherwise a user cannot tell why a question produced these results.
    terms,
    mongoQuery: query,
  };
}

module.exports = {
  runFilter,
  runKeywordSearch,
  // Exported for tests.
  conditionsToMongo,
  withScope,
  tokenize,
  inferEntity,
};
