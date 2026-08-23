const { GoogleGenAI } = require('@google/genai');
const env = require('../config/env');
const { componentLogger } = require('../config/logger');
const aiUsageService = require('./aiUsageService');

const log = componentLogger('ai');

/**
 * The single Gemini client, and everything that makes calling it safe.
 *
 * WHY THE PROVIDER SWAP CHANGED ONLY THIS FILE
 *
 * Every AI feature talks to `complete()` below and to nothing else. Switching
 * from Anthropic to Gemini therefore meant rewriting one function body: the
 * search translator, the customer summary and the lead scorer never knew which
 * model they were talking to, and still do not. That seam was the point of
 * putting this file in front of the SDK, and it is the first time it has had to
 * prove itself.
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
 * Per-ATTEMPT timeout.
 *
 * Raised from ten seconds after measuring the real thing. Gemini 3 Flash is
 * slower and far more variable than the model this was originally tuned
 * against: the same short prompt came back in 3 seconds one moment and took
 * over 10 the next, so a ten-second ceiling was cancelling calls that were
 * about to succeed and then paying to make them again. One live query burned
 * two timeouts before its third attempt worked — 24 seconds to get an answer
 * the first attempt would have produced in twelve.
 *
 * Fifteen rather than twenty, which was the first correction. Measured over
 * live calls the typical reply lands in 2-4 seconds, so anything past fifteen
 * is a stall rather than a slow answer, and waiting the extra five only delays
 * the retry that is going to produce the result.
 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * The ceiling on the whole operation, retries included.
 *
 * A per-attempt timeout bounds one call; without this, three attempts bound
 * nothing in particular — worst case was a minute of somebody watching a
 * spinner on a search box. No new attempt starts once this has elapsed, so the
 * user waits for the attempt in flight and then gets the fallback, which was
 * always going to be the answer at that point.
 */
const TOTAL_DEADLINE_MS = 20000;

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
 * Head-room added to every caller's token budget for the model's thinking.
 *
 * Gemini counts thinking tokens against `maxOutputTokens`, so a caller asking
 * for 600 tokens of summary was really asking for "600 tokens of thinking and
 * summary combined" — and could get back a perfectly successful response with
 * no text in it. Measured at 68-109 thought tokens for a one-word reply at the
 * lowest thinking level, so 256 is comfortable head-room rather than a guess,
 * and it is spent only if the model actually uses it.
 */
const THINKING_ALLOWANCE_TOKENS = 256;

/**
 * SDK retries are turned OFF because this module does its own.
 *
 * Leaving both on multiplies them — two SDK retries inside a loop that also
 * retries twice is up to nine calls for one request, at nine times the cost,
 * and the logs would show one attempt. Retry logic belongs in exactly one
 * layer.
 *
 * The timeout is set here rather than per call so it cannot be forgotten at a
 * call site, and it applies per ATTEMPT — a retry gets a fresh budget rather
 * than inheriting the remains of an exhausted one.
 */
const gemini = env.geminiApiKey
  ? new GoogleGenAI({
      apiKey: env.geminiApiKey,
      httpOptions: { timeout: REQUEST_TIMEOUT_MS },
    })
  : null;

/** Is the AI configured at all? Callers check this before building a prompt. */
function isConfigured() {
  return Boolean(gemini);
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

  /*
   * 499 is the client cancelling, which here means our own timeout fired. The
   * request never reached a verdict, so it is exactly as retryable as a dropped
   * connection — and it arrives WITH a status, so without this line it would
   * fall through to the permanent branch below and never be retried.
   */
  if (status === 499) return true;

  if (status) return false; // Any other explicit status is a permanent answer.

  // No status: a timeout, DNS failure or dropped connection. The request never
  // got an answer, so trying again is reasonable.
  return true;
}

/**
 * How long the server asked us to wait, in ms, or null if it did not say.
 *
 * Gemini returns this on a 429 as a `RetryInfo` detail (`retryDelay: "47s"`),
 * and reading it is the difference between backing off and making things worse.
 * On the free tier the quota is five requests per MINUTE, so three attempts
 * 250ms apart do not ride out a rate limit — they spend two more of the five
 * requests that are left, on calls that cannot possibly succeed yet.
 */
function retryAfterMs(err) {
  const raw = err?.message;
  if (typeof raw !== 'string') return null;

  /*
   * Parsed out of the message text rather than a structured field, because the
   * SDK surfaces the API's JSON body as a string. Ugly, and still much better
   * than ignoring an explicit instruction from the server about when it will
   * answer us.
   */
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(raw);
  if (match) return Math.ceil(Number(match[1]) * 1000);

  const seconds = /Please retry in (\d+(?:\.\d+)?)s/.exec(raw);
  return seconds ? Math.ceil(Number(seconds[1]) * 1000) : null;
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
/**
 * Pull token counts out of a Gemini response.
 *
 * `usageMetadata` names things differently from the Anthropic shape this file
 * used to speak, and the difference is not only cosmetic: `candidatesTokenCount`
 * excludes THINKING tokens, which are billed as output. Reading only that field
 * would under-report the cost of every call on a model that thinks — quietly,
 * and in the direction that flatters the bill.
 */
function readUsage(usage) {
  const input = usage?.promptTokenCount ?? 0;
  const output = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);

  return { input, output };
}

function logUsage({ feature, model, usage, durationMs, attempts, ok, error }) {
  const { input: inputTokens, output: outputTokens } = readUsage(usage);

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

  if (!gemini) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const startedAt = Date.now();
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;

    try {
      const response = await gemini.models.generateContent({
        model: env.geminiModel,
        contents: user,
        config: {
          systemInstruction: system,
          /*
           * THINKING TOKENS COME OUT OF THIS BUDGET.
           *
           * `maxOutputTokens` caps thinking AND the reply together, which is a
           * genuine trap: asking for 20 tokens got back a successful response
           * containing 16 thinking tokens and NO TEXT AT ALL. The call did not
           * fail, it just produced nothing, which is why the guard below treats
           * an empty reply as an error rather than parsing it.
           *
           * So the caller's budget is topped up by a fixed thinking allowance
           * rather than being quietly eaten by it. The caller asked for room
           * for a reply, and that is what it should get.
           */
          maxOutputTokens: maxTokens + THINKING_ALLOWANCE_TOKENS,

          /*
           * Thinking turned as low as the API allows, not off.
           *
           * These are translation and summarisation tasks with a strict output
           * shape, not problems that reward deliberation — the reply is either
           * valid JSON or it is discarded, so extra reasoning has nothing to
           * improve and costs both money and latency in front of a waiting user.
           *
           * `thinkingLevel: 'low'` rather than `thinkingBudget: 0`: the latter
           * is what the Gemini 2.x models took, and Gemini 3 rejects it outright
           * with a 400 INVALID_ARGUMENT. Low is the floor there; unset, the same
           * one-word prompt spent over a hundred tokens thinking about it.
           */
          thinkingConfig: { thinkingLevel: 'low' },
        },
      });

      const durationMs = Date.now() - startedAt;
      const { input, output } = readUsage(response.usageMetadata);

      logUsage({
        feature,
        model: env.geminiModel,
        usage: response.usageMetadata,
        durationMs,
        attempts: attempt,
        ok: true,
      });

      persistUsage({
        feature,
        model: env.geminiModel,
        inputTokens: input,
        outputTokens: output,
        durationMs,
        attempts: attempt,
        outcome: 'ok',
        userId,
      });

      /*
       * `response.text` is the SDK's convenience accessor, and it returns
       * undefined rather than throwing when the model produced no text — which
       * happens when a reply is cut off by maxOutputTokens or stopped by a
       * safety filter. Treating that as a failure is right: the callers parse
       * this as JSON, and an empty string would surface as a confusing parse
       * error instead of the retry-or-fall-back this deserves.
       */
      const text = response.text;

      if (!text) {
        throw new Error(
          `Model returned no text (finish reason: ${
            response.candidates?.[0]?.finishReason ?? 'unknown'
          })`
        );
      }

      return text;
    } catch (err) {
      lastError = err;

      // A permanent failure, or the last attempt: stop.
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;

      /*
       * Wait as long as the server asked, when it asked — or give up if that is
       * longer than anyone is going to wait.
       *
       * A 429 carrying "retry in 47s" is not a blip to back off from, it is the
       * server saying the quota is gone for the next minute. Retrying anyway
       * spends more of a quota that is already exhausted and cannot succeed;
       * the honest move is to stop now and let the caller fall back, which is
       * both faster for the user and cheaper for the account.
       */
      const serverWait = retryAfterMs(err);
      const elapsed = Date.now() - startedAt;
      const remaining = TOTAL_DEADLINE_MS - elapsed;

      const wait = serverWait ?? backoffDelay(attempt);

      if (wait >= remaining) break;

      await sleep(wait);
    }
  }

  const failedAfterMs = Date.now() - startedAt;

  logUsage({
    feature,
    model: env.geminiModel,
    usage: null,
    durationMs: failedAfterMs,
    // The attempts actually made, which is not always MAX_ATTEMPTS: a
    // permanent error or an exhausted quota stops the loop early, and a log
    // that always claimed three would hide exactly that.
    attempts: attemptsMade,
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
    model: env.geminiModel,
    durationMs: failedAfterMs,
    attempts: attemptsMade,
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
  retryAfterMs,
  backoffDelay,
  REQUEST_TIMEOUT_MS,
  MAX_ATTEMPTS,
  TOTAL_DEADLINE_MS,
};
