/**
 * The contract between the LLM and the database.
 *
 * This single file defines which entities are searchable, which fields exist on
 * each, and which operators each field type accepts. Two things are generated
 * from it:
 *
 *   1. the system prompt sent to the model (so it knows what it may ask for)
 *   2. the validator that checks the model's reply (so it can only ask for that)
 *
 * Keeping both on one source of truth is the point: if the prompt and the
 * validator were written separately they would drift, and every drift is either
 * a rejected valid query or — worse — an accepted invalid one.
 *
 * SECURITY: this schema is the boundary. The model's output is untrusted input,
 * exactly like a request body. Field names and operators are matched against
 * these allow-lists before anything reaches Mongoose, so a hallucinated or
 * hostile response cannot inject an arbitrary Mongo operator such as `$where`.
 */

const { CUSTOMER_STATUS_VALUES, ORDER_STATUS_VALUES } = require('../config/constants');

/** Which operators are legal for each field type. */
const OPERATORS_BY_TYPE = {
  string: ['eq', 'contains', 'in'],
  enum: ['eq', 'in'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['before', 'after', 'between', 'withinDays'],
  boolean: ['eq'],
  objectId: ['eq', 'in'],
};

const ENTITIES = {
  customer: {
    model: 'Customer',
    description: 'People and companies in the CRM.',
    fields: {
      name: { type: 'string', description: 'Contact name' },
      email: { type: 'string' },
      phone: { type: 'string' },
      company: { type: 'string' },
      city: { type: 'string', description: 'City the customer is located in' },
      status: { type: 'enum', values: CUSTOMER_STATUS_VALUES },
      notes: { type: 'string', description: 'Free-text notes on the account' },
      createdAt: { type: 'date', description: 'When the customer was added' },
    },
    // Keyword fallback searches these when the AI path is unavailable.
    keywordFields: ['name', 'email', 'company', 'city', 'notes'],
    defaultSort: 'createdAt',
  },

  product: {
    model: 'Product',
    description: 'Inventory items.',
    fields: {
      name: { type: 'string' },
      sku: { type: 'string', description: 'Stock keeping unit, stored uppercase' },
      category: { type: 'string' },
      price: { type: 'number', description: 'Unit price' },
      stockQty: { type: 'number', description: 'Units currently in stock' },
      createdAt: { type: 'date' },
    },
    keywordFields: ['name', 'sku', 'category'],
    defaultSort: 'name',
  },

  order: {
    model: 'Order',
    description: 'Sales orders placed for a customer.',
    fields: {
      status: { type: 'enum', values: ORDER_STATUS_VALUES },
      total: { type: 'number', description: 'Order value' },
      createdAt: { type: 'date', description: 'When the order was placed' },
    },
    keywordFields: [],
    defaultSort: 'createdAt',
  },
};

/**
 * Conditions that can't be written as a plain field comparison because they
 * span two collections. Each one is implemented explicitly in the translator.
 *
 * `orderActivity` is what makes the flagship example query — "customers in
 * Karachi with no orders in the last 30 days" — expressible at all.
 */
const SPECIAL_CONDITIONS = {
  customer: {
    orderActivity: {
      description:
        'Whether the customer has placed orders recently. ' +
        '{ "type": "none" | "any", "withinDays": <positive integer> }',
      validate(value) {
        if (!value || typeof value !== 'object') return null;
        if (!['none', 'any'].includes(value.type)) return null;

        const withinDays = Number(value.withinDays);
        if (!Number.isFinite(withinDays) || withinDays <= 0 || withinDays > 3650) return null;

        return { type: value.type, withinDays: Math.floor(withinDays) };
      },
    },
  },

  product: {
    lowStock: {
      description: 'true to return only products at or below their low-stock threshold',
      validate(value) {
        return typeof value === 'boolean' ? value : null;
      },
    },
  },
};

/** The maximum number of rows an AI search may return in one response. */
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 25;

/**
 * Render the schema as the text description handed to the model.
 *
 * Generated rather than hand-written so that adding a field above automatically
 * teaches the model about it — there is no second place to remember to update.
 */
function describeSchema() {
  const lines = [];

  for (const [entity, config] of Object.entries(ENTITIES)) {
    lines.push(`ENTITY "${entity}" — ${config.description}`);

    for (const [field, meta] of Object.entries(config.fields)) {
      const ops = OPERATORS_BY_TYPE[meta.type].join(', ');
      const values = meta.values ? ` one of: ${meta.values.join(' | ')};` : '';
      const note = meta.description ? ` ${meta.description};` : '';
      lines.push(`  - ${field} (${meta.type})${note}${values} operators: ${ops}`);
    }

    const specials = SPECIAL_CONDITIONS[entity];
    if (specials) {
      for (const [key, meta] of Object.entries(specials)) {
        lines.push(`  - ${key} (special condition) — ${meta.description}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

module.exports = {
  ENTITIES,
  OPERATORS_BY_TYPE,
  SPECIAL_CONDITIONS,
  MAX_RESULTS,
  DEFAULT_RESULTS,
  describeSchema,
};
