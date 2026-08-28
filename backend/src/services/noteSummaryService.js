const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');

const log = componentLogger('ai-note-summary');

const MAX_SUMMARY = 700;
const MAX_NOTES_IN_CONTEXT = 40;

/**
 * A one-paragraph catch-up over a customer's or an order's note history.
 *
 * The notes themselves are already facts on the record — this only asks the
 * model to condense what is already true and already written down, never to
 * add anything the timeline does not contain. Access is whatever
 * `activityController.loadSubject` already decided before this is called;
 * this file has no opinion on who may read a given thread.
 */

function validateSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = string(raw.summary, MAX_SUMMARY);
  return summary ? { summary } : null;
}

function buildSystemPrompt() {
  return `You write a one-paragraph catch-up summary of a note thread on a CRM record, for
someone about to pick the account back up after a while away. The notes are given to you
in order, oldest first, each with who wrote it and when. Summarise what has happened —
do not invent anything not written in one of the notes, and do not give advice or
recommend an action; that is a separate feature. Be concrete: mention names, dates and
outcomes that actually appear in the notes, not vague summaries of vague summaries.

Respond with a JSON object only: {"summary": "<one paragraph>"}`;
}

function callModel(notes) {
  return aiClient.complete({
    feature: 'note-summary',
    system: buildSystemPrompt(),
    user: JSON.stringify(
      notes
        .slice()
        .reverse() // oldest first, for a summary that reads as a narrative
        .map((n) => ({ author: n.author?.name, role: n.author?.role, when: n.createdAt, body: n.body }))
    ),
    maxTokens: 500,
  });
}

/** A plain, deterministic fallback: count, span, and the most recent note verbatim. */
function fallbackSummary(notes) {
  if (!notes.length) return 'No notes have been written yet.';

  const latest = notes[0];
  const oldest = notes[notes.length - 1];
  const span =
    notes.length > 1
      ? ` since ${new Date(oldest.createdAt).toISOString().slice(0, 10)}`
      : '';

  return (
    `${notes.length} note${notes.length === 1 ? '' : 's'}${span}. Most recent, from ` +
    `${latest.author?.name || 'someone'} on ${new Date(latest.createdAt).toISOString().slice(0, 10)}: ` +
    `"${latest.body.slice(0, 200)}${latest.body.length > 200 ? '…' : ''}"`
  );
}

/**
 * Summarise a note thread. Never throws.
 * `{ mode: 'ai'|'fallback', summary }`.
 */
async function summarize(notes) {
  const capped = notes.slice(0, MAX_NOTES_IN_CONTEXT);

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', summary: fallbackSummary(capped) };
  }

  if (!capped.length) {
    return { mode: 'fallback', summary: fallbackSummary(capped) };
  }

  let text;
  try {
    text = await callModel(capped);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the deterministic summary');
    return { mode: 'fallback', summary: fallbackSummary(capped) };
  }

  const result = parseAndValidate(text, validateSummary);
  if (!result.ok) return { mode: 'fallback', summary: fallbackSummary(capped) };

  return { mode: 'ai', summary: result.value.summary };
}

module.exports = { summarize, validateSummary, fallbackSummary };
