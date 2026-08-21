const Anthropic = require('@anthropic-ai/sdk');
const env = require('../config/env');
const { componentLogger } = require('../config/logger');
const aiUsageService = require('./aiUsageService');

const log = componentLogger('ai');

/**
 * The single Anthropic client, and everything that makes calling it safe.
 *
 * WHY ONE FILE RATHER THAN A CLIENT PER SERVICE
 *
 * Both AI features previously constructed their own `new Anthropic(...)` with
 * their own timeout and retry settings. That is two places to get the reliability
 * story right, and — more to the point — two places for it to quietly differ. A
 * timeout that is 20 seconds in one feature and unset in another is not a
 * configuration, it is an accident waiting to be discovered in production.
 *
 * WHAT THIS ADDS OVER CALLING THE SDK DIRECTLY
 *
 *   timeouts    a bounded wait, so a wedged API call cannot hold an HTTP
 *               request open indefinitely
 *   retries     with exponential backoff and jitter, on the failures that are
 *               actually worth retrying and only those
 *   usage log   what every call cost, so "why is the bill like that" has an
 *               answer that is not a guess
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not decide what happens when a call fails. Each feature has its own
 * sensible degraded behaviour — keyword search, a templated summary — and
 * burying a fallback in here would make those decisions invisible at the place
 * they matter.
 */

/**
 * Per-request timeout.
 *
 * Chosen against the user's patience, not the model's speed. These are short
 * prompts with small replies; anything past ten seconds means something is
 * wrong, and waiting longer only delays the fallback that is going to be shown
 * anyway. The SDK applies this per attempt, so a retry gets a fresh budget.
 */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * How many attempts in total (so 3 = one try plus two retries).
 *
 * Kept low on purpose. Every retry is a real delay in front of a user who is
 * waiting, and both features degrade gracefully — so the cost of giving up is
 * a plainer answer, not a broken page. Retrying five times to avoid a template
 * would be the wrong trade.
 */
const MAX_ATTEMPTS = 3;

/** Backoff base. Attempt 2 waits ~250ms, attempt 3 ~500ms, plus jitter. */
const BACKOFF_BASE_MS = 250;

/**
 * SDK retries are turned OFF because this module does its own.
 *
 * Leaving both on multiplies them — `maxRetries: 2` inside a loop that also
 * retries twice is up to nine calls for one request, at nine times the cost,
 * and the logs would show one attempt. Retry logic belongs in exactly one
 * layer.
 */
const anthropic = env.anthropicApiKey
  ? new Anthropic({
      apiKey: env.anthropicApiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    })
  : null;

/** Is the AI configured at all? Callers check this before building a prompt. */
function isConfigured() {
  return Boolean(anthropic);
}

/**
 * Which failures are worth trying again.
 *
 * The distinction matters in both directions. Retrying a 400 wastes time and
 * money on a request that will fail identically every time — the prompt is
 * wrong, and no amount of patience fixes it. Not retrying a 429 or a 503 throws
 * away a request that would very likely have succeeded a moment later.
 *
 *   429  rate limited            - transient by definition
 *   500+ upstream fault          - the other end had a bad moment
 *   timeout / network            - never reached a decision at all
 *   401/403 bad key, 400 bad request - permanent. Do not retry.
 */
function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;

  if (status === 429) return true;
  if (status >= 500) return true;
  if (status) return false; // Any other explicit status is a permanent answer.

  // No status: a timeout, DNS failure or dropped connection. The request never
  // got an answer, so trying again is reasonable.
  return true;
}

/**
 * Wait before the next attempt: exponential, with jitter.
 *
 * The jitter is not decoration. If several requests are rate limited at the
 * same moment and all back off by exactly 250ms, they retry in lockstep and hit
 * the limit together again — a thundering herd that turns one bad second into
 * several. Randomising spreads them out.
 */
function backoffDelay(attempt) {
  const base = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return base + Math.random() * base;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Log what a call cost.
 *
 * Deliberately a log line rather than a database collection. Token usage is
 * operational data — it is read while investigating a bill or a latency spike,
 * not queried by the application — and a log is where the platform's tooling can
 * already aggregate and alert on it. Writing it to MongoDB would add a write to
 * every AI request in exchange for a query nobody in this app makes.
 *
 * The fields are chosen so a single line answers the questions actually asked:
 * which feature, how many tokens each way, how long it took, and how many
 * attempts it needed.
 */
function logUsage({ feature, model, usage, durationMs, attempts, ok, error }) {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  /*
   * Structured, because these are the numbers a cost question is asked of.
   * "What did the summary feature cost last week" is a sum over a field, not a
   * regex over a sentence. aiUsageService persists the same figures for
   * querying; this line is for the log stream.
   */
  log[ok ? 'info' : 'warn'](
    {
      feature,
      model,
      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
      durationMs: Math.round(durationMs),
      attempts,
      outcome: ok ? 'ok' : 'failed',
      ...(error ? { error } : {}),
    },
    'AI request'
  );
}

/**
 * Persist the same figures the log line carries.
 *
 * Two destinations for one event, deliberately. The log answers "what happened
 * just now"; the collection answers "what did we spend last month, and on
 * what" — an aggregation over a time range, which a log platform can only do
 * with a query language and a long enough retention window.
 *
 * Never awaited by the caller and never able to fail a request: recording what
 * something cost must not break the thing the user asked for.
 */
function persistUsage(fields) {
  aiUsageService.recordUsage(fields).catch(() => {
    // recordUsage already logs its own failures.
  });
}

/**
 * Call the model with timeouts, retries and usage logging.
 *
 * Throws on failure — the caller decides what its degraded behaviour is. See
 * the note at the top about why the fallback does not live here.
 *
 * @param {object} options
 * @param {string} options.feature name used in the usage log ('ai-search', …)
 * @param {string} options.system system prompt
 * @param {string} options.user user message
 * @param {number} options.maxTokens cap on the reply
 * @returns {Promise<string>} the reply's text blocks, joined
 */
async function complete({ feature, system, user, maxTokens = 1024, userId = null }) {
  /*
   * The prompt ceiling, enforced BEFORE the call.
   *
   * Part of the input is user-supplied — a search box, a customer's free-text
   * notes — so without a limit someone pasting a document turns into a large
   * and entirely pointless bill. Refusing here costs nothing; discovering it on
   * an invoice costs the invoice.
   *
   * Truncating instead would be worse than refusing: a silently shortened
   * prompt produces a confidently wrong answer, and nobody would know why.
   */
  const promptChars = String(system).length + String(user).length;
  if (promptChars > env.aiMaxPromptChars) {
    log.warn(
      { feature, promptChars, limit: env.aiMaxPromptChars },
      'prompt exceeds the configured size limit — refusing to send it'
    );
    throw new Error(
      `Prompt is ${promptChars} characters, over the ${env.aiMaxPromptChars} limit`
    );
  }

  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const startedAt = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await anthropic.messages.create({
        model: env.anthropicModel,
        max_tokens: maxTokens,
        // Low effort: these are translation and summarisation tasks, not deep
        // reasoning. It cuts both latency and cost noticeably.
        output_config: { effort: 'low' },
        system,
        messages: [{ role: 'user', content: user }],
      });

      const durationMs = Date.now() - startedAt;

      logUsage({
        feature,
        model: env.anthropicModel,
        usage: response.usage,
        durationMs,
        attempts: attempt,
        ok: true,
      });

      persistUsage({
        feature,
        model: env.anthropicModel,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        durationMs,
        attempts: attempt,
        outcome: 'ok',
        userId,
      });

      // `content` is a list of blocks; join every text block rather than
      // assuming the first one is text.
      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    } catch (err) {
      lastError = err;

      // A permanent failure, or the last attempt: stop.
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;

      await sleep(backoffDelay(attempt));
    }
  }

  const failedAfterMs = Date.now() - startedAt;

  logUsage({
    feature,
    model: env.anthropicModel,
    usage: null,
    durationMs: failedAfterMs,
    attempts: MAX_ATTEMPTS,
    ok: false,
    error: lastError?.message,
  });

  /*
   * A failed call is recorded too. It cost time and, for anything that failed
   * after the model started responding, may have cost money — and a feature
   * that fails often is exactly what a usage report should surface.
   */
  persistUsage({
    feature,
    model: env.anthropicModel,
    durationMs: failedAfterMs,
    attempts: MAX_ATTEMPTS,
    outcome: 'failed',
    userId,
  });

  throw lastError;
}

module.exports = {
  complete,
  isConfigured,
  // Exported for tests.
  isRetryable,
  backoffDelay,
  REQUEST_TIMEOUT_MS,
  MAX_ATTEMPTS,
};
