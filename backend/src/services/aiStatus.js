const env = require('../config/env');
const aiClient = require('./aiClient');
// Imported as a namespace rather than destructured, following the same
// convention as aiSearchController: a destructured reference is bound at import
// time and cannot be stubbed, which would leave the failure paths here — the
// ones this module exists to report on — untestable.
const aiUsageService = require('./aiUsageService');

/**
 * Is the AI actually working right now?
 *
 * WHY THIS EXISTS.
 *
 * Every AI feature in this codebase degrades gracefully: no key, a network
 * blip, an unparseable reply — all of them fall back to something that still
 * answers. That is the right behaviour and it has one bad consequence, which
 * this module exists to fix.
 *
 * A degraded feature looks like a working one. AI search returned results, the
 * summary card showed a summary, nothing errored, nothing was red. The system
 * had been running keyword search behind an "AI search" label for as long as
 * the key had been missing, and the only way to find out was to read the
 * `mode` field on an individual response and know what it meant.
 *
 * So: configuration is reported as a fact rather than inferred from behaviour,
 * and the recent outcome mix is reported next to it. Those answer two different
 * questions — "is the key present" and "is it actually succeeding" — and a
 * deployment can be wrong in either direction independently. A valid key whose
 * credit has run out reports configured: true and a wall of failures.
 */

/** How much history the outcome mix covers. Long enough to be meaningful. */
const RECENT_DAYS = 7;

/**
 * A one-line human summary, so an admin does not have to interpret the fields.
 *
 * The wording is deliberately specific about which of the two problems it is:
 * "not configured" and "configured but failing" have completely different
 * fixes, and a single "AI unavailable" would send someone to check the wrong
 * one.
 */
function describe({ configured, keyPresent, recent }) {
  if (!configured) {
    return keyPresent
      ? 'GEMINI_API_KEY is set but was not usable at startup. Every AI feature is ' +
          'falling back to its non-AI path.'
      : 'GEMINI_API_KEY is not set. Every AI feature is falling back to its non-AI ' +
          'path — AI search is running a plain keyword search.';
  }

  if (recent.calls === 0) {
    return 'AI is configured. No calls have been made recently, so this has not been ' +
      'exercised yet.';
  }

  if (recent.failed > 0 && recent.succeeded === 0) {
    return `AI is configured but every one of the last ${recent.calls} calls failed. The ` +
      'key may be invalid, out of credit, or blocked by the network.';
  }

  if (recent.failed > 0) {
    return `AI is working, with ${recent.failed} of ${recent.calls} recent calls failing.`;
  }

  return 'AI is configured and working.';
}

/**
 * The current state of the AI integration.
 *
 * Never throws: this is the endpoint someone calls when things are already
 * broken, and it failing would be its own small tragedy. A usage lookup that
 * cannot reach the database still yields a useful configuration answer.
 */
async function getAiStatus() {
  const configured = aiClient.isConfigured();

  /*
   * Reported separately from `configured` on purpose. They disagree when the
   * variable is set to something the SDK refused at construction — an empty
   * string, whitespace — and that distinction is the difference between "you
   * forgot to set it" and "you set it wrong".
   */
  const keyPresent = Boolean(env.geminiApiKey);

  const recent = {
    calls: 0,
    succeeded: 0,
    failed: 0,
    cached: 0,
    available: false,
    byFeature: [],
  };

  try {
    const { totals, byFeature } = await aiUsageService.getUsageSummary(RECENT_DAYS);

    /*
     * `calls` counts every request including cache hits, so a success is what
     * is left after removing the hits (which never reached the API) and the
     * failures. Reporting cache hits as successes would make a wholly broken
     * key look healthy for as long as the cache stayed warm.
     */
    recent.calls = totals?.calls ?? 0;
    recent.cached = totals?.cacheHits ?? 0;
    recent.failed = totals?.failedCalls ?? 0;
    recent.succeeded = Math.max(0, recent.calls - recent.cached - recent.failed);
    recent.available = true;

    /*
     * Per-feature, not just the aggregate. The whole point of adding this is
     * that "AI is configured and working" can be true in the aggregate while
     * one specific feature — a new one, most likely, since it has had the
     * least real traffic — is quietly failing every call. An admin reading
     * only `recent.calls`/`recent.failed` has no way to see that; this does.
     */
    recent.byFeature = (byFeature || []).map((row) => ({
      feature: row.feature,
      calls: row.calls,
      succeeded: Math.max(0, (row.calls ?? 0) - (row.cacheHits ?? 0) - (row.failedCalls ?? 0)),
      failed: row.failedCalls ?? 0,
      cached: row.cacheHits ?? 0,
    }));
  } catch {
    // Usage history is a nice-to-have here; configuration is the headline.
    recent.available = false;
  }

  const status = {
    configured,
    keyPresent,
    /*
     * The mode the NEXT request will take, which is what a reader actually
     * wants to know. `mode` on an individual search response says what one call
     * did; this says what the system is currently set up to do.
     */
    mode: configured ? 'ai' : 'fallback',
    model: env.geminiModel,
    recent: { days: RECENT_DAYS, ...recent },
  };

  return { ...status, summary: describe(status) };
}

module.exports = { getAiStatus, RECENT_DAYS };
