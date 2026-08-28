const AuditLog = require('../models/AuditLog');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');

const log = componentLogger('ai-audit-digest');

const MAX_NARRATIVE = 900;
const MAX_LISTED = 8;

/**
 * A plain-English summary of whatever the audit screen is CURRENTLY showing.
 *
 * WHY THIS TAKES THE SCREEN'S FILTER RATHER THAN SUMMARISING EVERYTHING.
 *
 * An audit trail is only ever read through a filter — "customer deletions
 * this week", "what did this person do" — and a digest of the unfiltered
 * collection would answer a question nobody asked while contradicting the
 * rows on screen. So the caller passes the same filter the list endpoint
 * built, and every figure here is computed over exactly those rows. The two
 * cannot disagree, because they are the same query.
 *
 * As everywhere else: MongoDB counts, the model narrates. The response schema
 * has no numeric field, so there is no number for a model to invent.
 */

/** Facts about one filtered slice of the trail. Every figure is a real count. */
async function computeAuditFacts(filter = {}) {
  const [total, byAction, byEntity, byActor, byDay, range] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.aggregate([
      { $match: filter },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    AuditLog.aggregate([
      { $match: filter },
      { $group: { _id: '$entity', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    AuditLog.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { user: '$actor.user', name: '$actor.name', role: '$actor.role' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: MAX_LISTED },
    ]),
    AuditLog.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: MAX_LISTED },
    ]),
    AuditLog.aggregate([
      { $match: filter },
      { $group: { _id: null, first: { $min: '$createdAt' }, last: { $max: '$createdAt' } } },
    ]),
  ]);

  const asCounts = (rows) =>
    rows.reduce((acc, row) => {
      acc[row._id || 'unknown'] = row.count;
      return acc;
    }, {});

  return {
    // Echoed back so the narrative can say what it is summarising rather than
    // implying it covers the whole trail.
    filtersApplied: Object.keys(filter),
    total,
    byAction: asCounts(byAction),
    byEntity: asCounts(byEntity),
    byActor: byActor.map((row) => ({
      name: row._id.name || 'Former colleague',
      role: row._id.role || 'unknown',
      count: row.count,
    })),
    busiestDays: byDay.map((row) => ({ date: row._id, count: row.count })),
    firstAt: range[0]?.first || null,
    lastAt: range[0]?.last || null,
  };
}

function validateNarrative(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const narrative = string(raw.narrative, MAX_NARRATIVE);
  return narrative ? { narrative } : null;
}

function buildSystemPrompt() {
  return `You summarise a filtered slice of a CRM's audit log for an administrator,
narrating figures that have ALREADY been calculated from the database. Never
calculate, estimate, or restate a number differently than given, and never mention a
person, entity type or date that does not appear in the data you are given.

Say what happened in this range in plain English, and point out anything worth a
second look — deletions, one person accounting for most of the activity, or an
unusual concentration of changes on a single day. Do not imply wrongdoing; an audit
digest reports, it does not accuse. If nothing stands out, say the activity looks
routine. Two to four sentences, direct, no filler.

Respond with a JSON object only: {"narrative": "<the summary text>"}`;
}

function callModel(facts, userId) {
  return aiClient.complete({
    feature: 'audit-digest',
    userId,
    system: buildSystemPrompt(),
    user: JSON.stringify(facts),
    maxTokens: 500,
  });
}

function fallbackNarrative(facts) {
  if (facts.total === 0) {
    return 'No audit entries match the current filters.';
  }

  const parts = [`${facts.total} entr${facts.total === 1 ? 'y' : 'ies'} match the current filters.`];

  const actions = Object.entries(facts.byAction)
    .map(([action, count]) => `${count} ${action}`)
    .join(', ');
  if (actions) parts.push(`By action: ${actions}.`);

  const entities = Object.entries(facts.byEntity)
    .map(([entity, count]) => `${count} on ${entity}`)
    .join(', ');
  if (entities) parts.push(`By record type: ${entities}.`);

  if (facts.byActor[0]) {
    parts.push(
      `${facts.byActor[0].name} accounts for the most (${facts.byActor[0].count}).`
    );
  }

  if (facts.busiestDays[0]) {
    parts.push(
      `The busiest day was ${facts.busiestDays[0].date} with ${facts.busiestDays[0].count}.`
    );
  }

  return parts.join(' ');
}

/** The audit digest for one filtered range. Never throws. `{ mode, facts, narrative }`. */
async function getDigest(filter = {}, userId = null) {
  const facts = await computeAuditFacts(filter);

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', facts, narrative: fallbackNarrative(facts) };
  }

  let text;
  try {
    text = await callModel(facts, userId);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the templated digest');
    return { mode: 'fallback', facts, narrative: fallbackNarrative(facts) };
  }

  const result = parseAndValidate(text, validateNarrative);
  if (!result.ok) return { mode: 'fallback', facts, narrative: fallbackNarrative(facts) };

  return { mode: 'ai', facts, narrative: result.value.narrative };
}

module.exports = { getDigest, computeAuditFacts, validateNarrative };
