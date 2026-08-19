/**
 * Getting structured, trustworthy JSON out of a language model.
 *
 * This file is the one place that knows how to turn a model's reply into data
 * the rest of the app is allowed to use. Both AI features go through it, which
 * is the point: the alternative is two slightly different parsers that drift,
 * and the one that drifts is the one that lets something through.
 *
 * THE PRINCIPLE
 *
 * A model's output is untrusted input, exactly like a request body. It is not
 * "nearly right" data that needs tidying — it is a string from outside the
 * system, and everything after parsing treats it that way. That framing is what
 * makes the rules below obvious rather than paranoid:
 *
 *   - parse defensively, because "respond with JSON only" is an instruction,
 *     not a guarantee
 *   - validate against an allow-list, so a field we did not ask for cannot
 *     reach the database or the screen
 *   - fail closed: anything that does not validate is discarded entirely, and
 *     the caller degrades to its fallback rather than using half an answer
 *
 * WHY NOT A SCHEMA LIBRARY (zod, ajv)
 *
 * Both would work. Neither is here, for two reasons. The validation this app
 * needs is not really "is this a string" — it is "is this field name on the
 * allow-list for this entity, and is this operator legal for that field type",
 * which is domain logic a generic validator expresses awkwardly. And the AI
 * search validator already generates the model's prompt from the same schema
 * object (filterSchema.js), so the prompt and the validator cannot disagree —
 * a property worth more than a shorter validator, and one a separate schema
 * library would take away.
 */

/**
 * Pull a JSON object out of a model's reply.
 *
 * The model is asked for bare JSON, but instruction-following is not a
 * guarantee, so this tolerates the two things that actually happen in practice:
 * a ```json fence around the object, and a sentence before or after it.
 *
 * Braces are counted rather than regex-matched so a nested object does not
 * truncate the match at the first closing brace. String literals are tracked so
 * a `}` inside a value — a customer note, say — does not end the object early.
 * Both of those were real failure modes, not hypothetical ones.
 *
 * @returns {object|null} the parsed object, or null if there isn't a usable one.
 */
function extractJson(text) {
  if (typeof text !== 'string') return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;

  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];

    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString && char === '{') {
      depth += 1;
    } else if (!inString && char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null; // Balanced braces but not valid JSON.
        }
      }
    }
  }

  return null; // Never closed.
}

/**
 * Run one model reply through parse-then-validate.
 *
 * Every AI feature does the same three things in the same order, and the value
 * of doing them here is that the *failure* shape is identical too: a caller
 * always gets `{ ok: false, reason }` and never an exception, so no AI feature
 * can 500 because a model said something strange.
 *
 * @param {string} text raw model output
 * @param {(parsed: object) => T|null} validate returns the cleaned value, or
 *   null to reject it. Throwing is also treated as a rejection.
 * @returns {{ ok: true, value: T } | { ok: false, reason: string }}
 * @template T
 */
function parseAndValidate(text, validate) {
  const parsed = extractJson(text);

  if (!parsed) {
    return { ok: false, reason: 'AI response was not valid JSON' };
  }

  let value;
  try {
    value = validate(parsed);
  } catch (err) {
    // A validator that throws is rejecting the input, and the message usually
    // says which field was wrong — worth keeping for the logs.
    return { ok: false, reason: `AI response rejected: ${err.message}` };
  }

  if (value === null || value === undefined) {
    return { ok: false, reason: 'AI response did not match the expected shape' };
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Small field validators, shared by the response schemas.
//
// These exist because every AI response so far needs the same handful of
// checks, and writing them inline three times is how the fourth one ends up
// missing a length cap.
// ---------------------------------------------------------------------------

/**
 * A non-empty string, trimmed and capped.
 *
 * The cap is not cosmetic. Without it, one unusual response can push a wall of
 * text into a card sized for two sentences, and there is no upstream limit that
 * prevents it — `max_tokens` bounds the whole reply, not any single field.
 */
function string(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

/** One of a fixed set of values, or a stated default. */
function enumValue(value, allowed, fallback = null) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * A finite number within bounds.
 *
 * Present for completeness, and deliberately unused by the summary schema —
 * see the note there about why that schema has no numeric fields at all.
 */
function boundedNumber(value, { min, max, integer = false }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < min || number > max) return null;
  return integer ? Math.floor(number) : number;
}

module.exports = {
  extractJson,
  parseAndValidate,
  string,
  enumValue,
  boundedNumber,
};
