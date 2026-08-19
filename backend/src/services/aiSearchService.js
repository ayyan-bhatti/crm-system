const Anthropic = require('@anthropic-ai/sdk');
const env = require('../config/env');
const { extractJson, parseAndValidate } = require('./aiJson');
const {
  ENTITIES,
  OPERATORS_BY_TYPE,
  SPECIAL_CONDITIONS,
  MAX_RESULTS,
  DEFAULT_RESULTS,
  describeSchema,
} = require('./filterSchema');

/**
 * Turns a free-text question into a validated, structured filter object.
 *
 * The flow:
 *   natural language  ->  Claude  ->  JSON text  ->  parse  ->  validate  ->  filter
 *
 * Every step after "Claude" treats the model's output as untrusted input. The
 * model is a translator, not an authority: nothing it returns reaches the
 * database until it has been matched against the allow-lists in filterSchema.js.
 */

// The SDK client is created once and reused. A short timeout and a single retry
// keep a slow or wedged API call from holding an HTTP request open for minutes —
// the endpoint would rather fall back to keyword search than hang.
const anthropic = env.anthropicApiKey
  ? new Anthropic({ apiKey: env.anthropicApiKey, timeout: 20000, maxRetries: 1 })
  : null;

/**
 * The system prompt. The schema portion is generated from filterSchema.js so it
 * can never disagree with the validator.
 */
function buildSystemPrompt() {
  return `You translate natural-language search requests for a CRM into a JSON filter object.

Available data:

${describeSchema()}

Respond with a JSON object only — no prose, no markdown fences, no explanation.

Shape:
{
  "entity": "customer" | "product" | "order",
  "conditions": [
    { "field": "<field name>", "operator": "<operator>", "value": <value> }
  ],
  "special": { "<special condition>": <value> },
  "sort": { "field": "<field name>", "direction": "asc" | "desc" },
  "limit": <integer, 1-${MAX_RESULTS}>
}

Rules:
- "entity" is required. Pick the one the user is asking to see. If they ask for
  customers filtered by their order history, the entity is still "customer".
- "conditions" may be an empty array if the request has no filters.
- Use only the field names and operators listed above. Never invent a field.
- "contains" is a case-insensitive substring match; prefer it for names, cities,
  companies and free text.
- "in" takes an array of values. "between" takes a two-element array [low, high].
- "withinDays" takes a positive integer and means "in the last N days".
- Dates are ISO-8601 strings ("2026-01-31").
- Omit "special", "sort" and "limit" when the request does not call for them.

Examples:

User: customers in Karachi with no orders in the last 30 days
{"entity":"customer","conditions":[{"field":"city","operator":"contains","value":"Karachi"}],"special":{"orderActivity":{"type":"none","withinDays":30}}}

User: active leads at Acme
{"entity":"customer","conditions":[{"field":"status","operator":"eq","value":"active"},{"field":"company","operator":"contains","value":"Acme"}]}

User: products under $50 that are running low
{"entity":"product","conditions":[{"field":"price","operator":"lt","value":50}],"special":{"lowStock":true}}

User: the 10 biggest completed orders this year
{"entity":"order","conditions":[{"field":"status","operator":"eq","value":"completed"},{"field":"createdAt","operator":"withinDays","value":365}],"sort":{"field":"total","direction":"desc"},"limit":10}`;
}

/*
 * `extractJson` used to live here. It moved to services/aiJson.js when the
 * customer summary needed exactly the same defensive parsing — two copies of a
 * parser that guards against untrusted input is how one of them ends up missing
 * a case. It is re-exported below so the existing tests and callers are
 * unaffected.
 */

/** Coerce a value to the declared field type, or return undefined if impossible. */
function coerce(value, type, meta) {
  switch (type) {
    case 'string':
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;

    case 'enum':
      return meta.values.includes(value) ? value : undefined;

    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }

    case 'date': {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }

    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;

    case 'objectId':
      return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) ? value : undefined;

    default:
      return undefined;
  }
}

/**
 * Validate the parsed object against the schema.
 *
 * Returns a clean filter, or throws with a reason. Unknown fields, unknown
 * operators and uncoercible values are dropped or rejected rather than passed
 * through — this function is the security boundary described in filterSchema.js.
 */
function validateFilter(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Model did not return a JSON object');
  }

  const entity = raw.entity;
  if (!Object.prototype.hasOwnProperty.call(ENTITIES, entity)) {
    throw new Error(`Unknown entity: ${entity}`);
  }

  const schema = ENTITIES[entity];
  const conditions = [];

  for (const condition of Array.isArray(raw.conditions) ? raw.conditions : []) {
    if (!condition || typeof condition !== 'object') continue;

    const { field, operator } = condition;

    // Reject anything not explicitly declared for this entity. Using
    // hasOwnProperty guards against inherited keys like "constructor".
    if (!Object.prototype.hasOwnProperty.call(schema.fields, field)) {
      throw new Error(`Unknown field "${field}" on ${entity}`);
    }

    const meta = schema.fields[field];
    if (!OPERATORS_BY_TYPE[meta.type].includes(operator)) {
      throw new Error(`Operator "${operator}" is not valid for ${entity}.${field}`);
    }

    // Multi-value operators need an array; everything else a single value.
    let value;
    if (operator === 'in') {
      if (!Array.isArray(condition.value) || condition.value.length === 0) {
        throw new Error(`Operator "in" on ${field} needs a non-empty array`);
      }
      value = condition.value.map((v) => coerce(v, meta.type, meta)).filter((v) => v !== undefined);
      if (!value.length) throw new Error(`No usable values for ${field}`);
    } else if (operator === 'between') {
      if (!Array.isArray(condition.value) || condition.value.length !== 2) {
        throw new Error(`Operator "between" on ${field} needs [low, high]`);
      }
      value = condition.value.map((v) => coerce(v, meta.type, meta));
      if (value.some((v) => v === undefined)) throw new Error(`Invalid range for ${field}`);
    } else if (operator === 'withinDays') {
      const days = Number(condition.value);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        throw new Error(`"withinDays" on ${field} needs a positive number of days`);
      }
      value = Math.floor(days);
    } else {
      value = coerce(condition.value, meta.type, meta);
      if (value === undefined) throw new Error(`Invalid value for ${field}`);
    }

    conditions.push({ field, operator, value });
  }

  // Cross-collection conditions, each validated by its own handler.
  const special = {};
  const allowedSpecials = SPECIAL_CONDITIONS[entity] || {};
  const rawSpecial = raw.special && typeof raw.special === 'object' ? raw.special : {};

  for (const [key, value] of Object.entries(rawSpecial)) {
    if (!Object.prototype.hasOwnProperty.call(allowedSpecials, key)) continue; // ignore unknown
    const cleaned = allowedSpecials[key].validate(value);
    if (cleaned !== null) special[key] = cleaned;
  }

  // Sort must name a real field on this entity, else fall back to the default.
  let sort = { field: schema.defaultSort, direction: 'desc' };
  if (raw.sort && Object.prototype.hasOwnProperty.call(schema.fields, raw.sort.field)) {
    sort = {
      field: raw.sort.field,
      direction: raw.sort.direction === 'asc' ? 'asc' : 'desc',
    };
  }

  const requestedLimit = Number(raw.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(1, Math.floor(requestedLimit)), MAX_RESULTS)
    : DEFAULT_RESULTS;

  return { entity, conditions, special, sort, limit };
}

/**
 * Ask Claude to translate the query.
 *
 * Notes on the request shape:
 *  - `max_tokens` is small because the answer is one short JSON object.
 *  - `effort: "low"` because this is a translation task, not deep reasoning;
 *    it cuts latency and cost noticeably.
 *  - No assistant-message prefill: it is rejected on this model family, and the
 *    JSON is coaxed out with the system prompt plus defensive parsing instead.
 */
async function callModel(query) {
  const response = await anthropic.messages.create({
    model: env.anthropicModel,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: query }],
  });

  // `content` is a list of blocks; join every text block rather than assuming
  // the first one is text.
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Translate a natural-language query into a validated filter.
 *
 * Never throws. Returns either:
 *   { mode: 'ai',       filter }
 *   { mode: 'fallback', filter: null, reason }
 *
 * The endpoint's contract is that it always returns results, so every failure
 * mode — no API key, network error, rate limit, unparseable reply, filter that
 * fails validation — collapses into the same graceful fallback signal.
 */
async function translateQuery(query) {
  if (!anthropic) {
    return { mode: 'fallback', filter: null, reason: 'ANTHROPIC_API_KEY is not configured' };
  }

  let text;
  try {
    text = await callModel(query);
  } catch (err) {
    if (!env.isTest) {
      // eslint-disable-next-line no-console
      console.warn(`[ai-search] model call failed, using keyword fallback: ${err.message}`);
    }
    return { mode: 'fallback', filter: null, reason: `AI request failed: ${err.message}` };
  }

  // Shared parse-then-validate: same defensive parsing and the same failure
  // shape as every other AI feature. See services/aiJson.js.
  const result = parseAndValidate(text, validateFilter);

  if (!result.ok) {
    return { mode: 'fallback', filter: null, reason: result.reason };
  }

  return { mode: 'ai', filter: result.value };
}

module.exports = {
  translateQuery,
  // Exported for unit tests and for reuse by the fallback path.
  buildSystemPrompt,
  extractJson,
  validateFilter,
};
