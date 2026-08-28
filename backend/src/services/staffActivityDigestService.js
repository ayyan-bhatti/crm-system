const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const { USER_STATUS } = require('../config/constants');

const log = componentLogger('ai-staff-activity-digest');

const WINDOW_DAYS = 30;
const IDLE_DAYS = 30;
const MAX_NARRATIVE = 900;
const MAX_LISTED = 8;

/**
 * A plain-English digest of recent STAFF activity, for an admin.
 *
 * Same split every other AI feature in this app uses, and worth restating
 * because it is the whole reason these are trustworthy: MongoDB does all the
 * counting, and the model is handed the finished figures with one job —
 * write the sentence around them. There is no numeric field in the response
 * schema at all (see `validateNarrative`), so there is nothing for a model to
 * invent a number into.
 *
 * WHAT "ACTIVITY" MEANS HERE.
 *
 * Writes, from the audit trail — not sign-ins. The app records who CHANGED
 * something, and never records a bare session, so "active" can only honestly
 * mean "has written something recently". An account with no audit entries in
 * the window is reported as idle, which is the useful signal for an admin
 * deciding whether a seat is still needed; it is deliberately NOT called
 * "hasn't logged in", because this data cannot support that claim.
 */

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Who has been writing, who has not, and anything structurally odd about the
 * account list. Every figure comes from a real query.
 */
async function computeActivityFacts() {
  const since = daysAgo(WINDOW_DAYS);

  const [users, byActor] = await Promise.all([
    User.find({}).select('name role status createdAt').lean(),
    AuditLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$actor.user',
          writes: { $sum: 1 },
          lastAt: { $max: '$createdAt' },
        },
      },
      { $sort: { writes: -1 } },
    ]),
  ]);

  const statsById = new Map(byActor.map((row) => [String(row._id), row]));

  const active = [];
  const idle = [];

  for (const user of users) {
    // A deactivated or rejected account is already handled — reporting it as
    // "idle" would bury the accounts an admin can actually act on.
    if (user.status !== USER_STATUS.ACTIVE) continue;

    const stats = statsById.get(String(user._id));

    if (stats) {
      active.push({
        name: user.name,
        role: user.role,
        writes: stats.writes,
        lastActiveAt: stats.lastAt,
      });
    } else {
      idle.push({
        name: user.name,
        role: user.role,
        // How long the account has EXISTED without writing anything. A brand
        // new account with no writes yet is not the same finding as a
        // year-old one, and this is what lets the narrative tell them apart.
        accountAgeDays: Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86400000),
      });
    }
  }

  active.sort((a, b) => b.writes - a.writes);
  idle.sort((a, b) => b.accountAgeDays - a.accountAgeDays);

  const byStatus = users.reduce((acc, user) => {
    acc[user.status] = (acc[user.status] || 0) + 1;
    return acc;
  }, {});

  return {
    windowDays: WINDOW_DAYS,
    idleThresholdDays: IDLE_DAYS,
    totalAccounts: users.length,
    activeAccounts: byStatus[USER_STATUS.ACTIVE] || 0,
    pendingAccounts: byStatus[USER_STATUS.PENDING] || 0,
    deactivatedAccounts: byStatus[USER_STATUS.DEACTIVATED] || 0,
    totalWrites: byActor.reduce((sum, row) => sum + row.writes, 0),
    mostActive: active.slice(0, MAX_LISTED),
    idleAccounts: idle.slice(0, MAX_LISTED),
  };
}

function validateNarrative(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const narrative = string(raw.narrative, MAX_NARRATIVE);
  return narrative ? { narrative } : null;
}

function buildSystemPrompt() {
  return `You write a short digest of recent STAFF activity for an administrator of a
CRM, narrating figures that have ALREADY been calculated from the database. Never
calculate, estimate, or restate a number differently than given, and never claim
anything the data does not contain — in particular, "activity" here means records
CHANGED, never sign-ins, so do not say anyone has or has not logged in.

Call out anything an admin should look at: an account that has existed a long time
without changing anything, accounts still waiting on approval, or one person
accounting for nearly all the activity. If nothing looks unusual, say so plainly
rather than manufacturing a concern. Two to four sentences, direct, no filler.

Respond with a JSON object only: {"narrative": "<the digest text>"}`;
}

function callModel(facts, userId) {
  return aiClient.complete({
    feature: 'staff-activity-digest',
    userId,
    system: buildSystemPrompt(),
    user: JSON.stringify(facts),
    maxTokens: 500,
  });
}

function fallbackNarrative(facts) {
  const parts = [
    `${facts.totalWrites} change${facts.totalWrites === 1 ? '' : 's'} recorded across ` +
      `${facts.activeAccounts} active account${facts.activeAccounts === 1 ? '' : 's'} in the ` +
      `last ${facts.windowDays} days.`,
  ];

  if (facts.mostActive[0]) {
    parts.push(
      `${facts.mostActive[0].name} made the most (${facts.mostActive[0].writes}).`
    );
  }

  if (facts.idleAccounts.length) {
    parts.push(
      `${facts.idleAccounts.length} active account${
        facts.idleAccounts.length === 1 ? ' has' : 's have'
      } changed nothing in that window: ${facts.idleAccounts.map((a) => a.name).join(', ')}.`
    );
  }

  if (facts.pendingAccounts) {
    parts.push(
      `${facts.pendingAccounts} account${
        facts.pendingAccounts === 1 ? ' is' : 's are'
      } still pending.`
    );
  }

  return parts.join(' ');
}

/** The staff activity digest. Never throws. `{ mode, facts, narrative }`. */
async function getDigest(userId = null) {
  const facts = await computeActivityFacts();

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

module.exports = { getDigest, computeActivityFacts, validateNarrative };
