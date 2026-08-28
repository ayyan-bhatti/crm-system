const Customer = require('../models/Customer');
const Order = require('../models/Order');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const { diff, snapshot } = require('./auditService');

const log = componentLogger('ai-change-summary');

const MAX_SUMMARY = 300;
const MODELS = { customer: Customer, order: Order };

/**
 * Turn a pending change request's before/after into one readable sentence
 * for the approval queue, so an admin is not parsing raw field-level JSON to
 * decide.
 *
 * THE DIFF ITSELF IS THE SAME CODE THE AUDIT TRAIL USES.
 *
 * `services/auditService.js`'s `diff()` already computes exactly this —
 * field, from, to — at approval time, for the permanent record. Reusing it
 * here rather than writing a second comparison means a pending request's
 * preview and its eventual audit entry can never disagree about what
 * changed, because they are the same function run on the same shape of
 * data. The model receives only that computed diff, never the raw
 * documents — it is translating a list of {field, from, to} triples into
 * prose, not reading a customer record and forming its own opinion of what
 * matters.
 */

/** What would change if this pending request were approved, right now. */
async function previewDiff(request) {
  if (request.action === 'create') {
    return { before: null, after: request.payload || {} };
  }

  const Model = MODELS[request.entity];
  const current = await Model.findById(request.entityId);
  if (!current) return null;

  const before = snapshot(current);

  if (request.action === 'delete') return { before, after: null };
  if (request.action === 'cancel') return { before, after: { ...before, status: 'cancelled' } };
  if (request.action === 'transfer') {
    return { before, after: { ...before, assignedTo: request.payload?.assignedTo ?? null } };
  }

  // update
  return { before, after: { ...before, ...(request.payload || {}) } };
}

function validateSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = string(raw.summary, MAX_SUMMARY);
  return summary ? { summary } : null;
}

function buildSystemPrompt() {
  return `You turn a field-level diff of a pending CRM change into one plain sentence for
an administrator deciding whether to approve it. You are given the entity type, the
action, and a list of {field, from, to} changes that have ALREADY been computed — do not
recalculate anything, and mention only fields actually in the list. For a "create" there
is no "from"; describe what is being created. For a "delete" or "cancel" there is no
"to"; describe what is being removed or cancelled.

Respond with a JSON object only: {"summary": "<one sentence>"}`;
}

function callModel(request, changes) {
  return aiClient.complete({
    feature: 'change-request-summary',
    system: buildSystemPrompt(),
    user: JSON.stringify({ entity: request.entity, action: request.action, changes }),
    maxTokens: 200,
  });
}

/** A plain, deterministic sentence built from the same diff. */
function fallbackSummary(request, changes) {
  if (request.action === 'create') return `Create a new ${request.entity}.`;
  if (request.action === 'delete') return `Delete this ${request.entity}.`;
  if (request.action === 'cancel') return `Cancel this ${request.entity}.`;

  if (!changes.length) return `No fields would actually change.`;

  const parts = changes
    .slice(0, 4)
    .map((c) => `${c.field}: "${format(c.from)}" → "${format(c.to)}"`);

  return `${parts.join(', ')}${changes.length > 4 ? `, and ${changes.length - 4} more` : ''}.`;
}

function format(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Summarise a pending change request. Never throws.
 * `{ mode: 'ai'|'fallback', summary, changes }` — or `null` if the record
 * the request refers to has since been deleted (nothing to preview).
 */
async function summarize(request) {
  const preview = await previewDiff(request);
  if (!preview) return null;

  const changes = diff(preview.before, preview.after);

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', summary: fallbackSummary(request, changes), changes };
  }

  let text;
  try {
    text = await callModel(request, changes);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the deterministic summary');
    return { mode: 'fallback', summary: fallbackSummary(request, changes), changes };
  }

  const result = parseAndValidate(text, validateSummary);
  if (!result.ok) {
    return { mode: 'fallback', summary: fallbackSummary(request, changes), changes };
  }

  return { mode: 'ai', summary: result.value.summary, changes };
}

module.exports = { summarize, previewDiff, validateSummary };
