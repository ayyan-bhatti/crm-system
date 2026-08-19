const {
  extractJson,
  parseAndValidate,
  string,
  enumValue,
  boundedNumber,
} = require('../src/services/aiJson');

/**
 * The shared structured-output layer.
 *
 * These tests treat model output the way the code does: as untrusted input from
 * outside the system. So the cases are not "does it parse nice JSON" — they are
 * "what happens when the model returns something hostile, truncated, or subtly
 * wrong", because those are the inputs that decide whether the app is safe.
 */

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  /** "Respond with JSON only" is an instruction, not a guarantee. */
  it('parses an object inside a markdown fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object wrapped in prose', () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  /** Counting braces, not regex-matching — a real failure mode, not a theoretical one. */
  it('does not truncate at the first closing brace of a nested object', () => {
    const text = '{"outer":{"inner":{"deep":true}},"after":1}';
    expect(extractJson(text)).toEqual({ outer: { inner: { deep: true } }, after: 1 });
  });

  /** A customer note containing a brace must not end the object early. */
  it('ignores braces inside string values', () => {
    expect(extractJson('{"note":"use } carefully","ok":true}').ok).toBe(true);
  });

  it('handles an escaped quote inside a string', () => {
    expect(extractJson('{"note":"they said \\"yes\\"","ok":true}').ok).toBe(true);
  });

  it('returns null for a refusal with no JSON in it', () => {
    expect(extractJson("I can't help with that.")).toBeNull();
  });

  it('returns null for truncated JSON', () => {
    expect(extractJson('{"a":1,"b":')).toBeNull();
  });

  it('returns null for balanced braces that are not valid JSON', () => {
    expect(extractJson('{a: 1, b: 2}')).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(extractJson(null)).toBeNull();
    expect(extractJson(42)).toBeNull();
  });
});

describe('parseAndValidate', () => {
  const accept = (parsed) => ({ value: parsed.a });

  it('returns the validated value on success', () => {
    expect(parseAndValidate('{"a":1}', accept)).toEqual({ ok: true, value: { value: 1 } });
  });

  it('reports unparseable output rather than throwing', () => {
    const result = parseAndValidate('not json', accept);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not valid JSON/i);
  });

  /** A validator returning null is a rejection, not a value. */
  it('treats null from the validator as a rejection', () => {
    const result = parseAndValidate('{"a":1}', () => null);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not match/i);
  });

  /**
   * The property that matters most: no AI feature can 500 because a model said
   * something strange. Every failure is a value, never an exception.
   */
  it('converts a throwing validator into a failure result', () => {
    const result = parseAndValidate('{"a":1}', () => {
      throw new Error('field "entity" is not allowed');
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('field "entity" is not allowed');
  });

  it('never throws, whatever the model returned', () => {
    const nasty = ['', '```', '{', 'null', '[]', '{"__proto__":{"admin":true}}'];

    nasty.forEach((text) => {
      expect(() => parseAndValidate(text, accept)).not.toThrow();
    });
  });
});

describe('field validators', () => {
  describe('string', () => {
    it('trims and returns a usable value', () => {
      expect(string('  hello  ', 100)).toBe('hello');
    });

    it('rejects a non-string', () => {
      expect(string(42, 100)).toBeNull();
      expect(string(null, 100)).toBeNull();
      expect(string({ text: 'hi' }, 100)).toBeNull();
    });

    it('rejects an empty or whitespace-only string', () => {
      expect(string('', 100)).toBeNull();
      expect(string('   ', 100)).toBeNull();
    });

    /**
     * max_tokens bounds the whole reply, not any single field, so without this
     * one unusual response can push a wall of text into a two-sentence card.
     */
    it('caps the length', () => {
      expect(string('x'.repeat(500), 10)).toHaveLength(10);
    });
  });

  describe('enumValue', () => {
    it('accepts a listed value', () => {
      expect(enumValue('high', ['low', 'high'], 'low')).toBe('high');
    });

    it('falls back for anything unlisted', () => {
      expect(enumValue('extremely', ['low', 'high'], 'low')).toBe('low');
      expect(enumValue(undefined, ['low', 'high'], 'low')).toBe('low');
    });
  });

  describe('boundedNumber', () => {
    it('accepts a number in range', () => {
      expect(boundedNumber(50, { min: 0, max: 100 })).toBe(50);
    });

    it('rejects a number out of range', () => {
      expect(boundedNumber(500, { min: 0, max: 100 })).toBeNull();
      expect(boundedNumber(-1, { min: 0, max: 100 })).toBeNull();
    });

    it('rejects values that are not finite numbers', () => {
      expect(boundedNumber('abc', { min: 0, max: 100 })).toBeNull();
      expect(boundedNumber(Infinity, { min: 0, max: 100 })).toBeNull();
      expect(boundedNumber(NaN, { min: 0, max: 100 })).toBeNull();
    });

    it('floors when an integer is required', () => {
      expect(boundedNumber('7.9', { min: 0, max: 100, integer: true })).toBe(7);
    });
  });
});

describe('the allow-list principle', () => {
  const {
    validateSummary,
  } = require('../src/services/customerSummaryService');
  const { validateFilter } = require('../src/services/aiSearchService');

  /**
   * Both validators build their result field by field rather than spreading the
   * parsed object. That is the difference between a schema and a tidy-up:
   * `{ ...raw }` would carry through every key the model invented.
   */
  it('drops unknown keys from a summary response', () => {
    const result = validateSummary({
      headline: 'Growing account',
      summary: 'They order regularly.',
      confidence: 'high',
      totalRevenue: 999999,
      isAdmin: true,
    });

    expect(result.totalRevenue).toBeUndefined();
    expect(result.isAdmin).toBeUndefined();
  });

  /**
   * The search validator's job is different — the risk there is injection
   * rather than fabrication, because its output becomes a database query.
   */
  it('refuses a filter field that is not on the entity allow-list', () => {
    expect(() =>
      validateFilter({
        entity: 'customer',
        conditions: [{ field: 'password', operator: 'contains', value: 'a' }],
      })
    ).toThrow();
  });

  it('refuses a raw Mongo operator smuggled in as a filter', () => {
    expect(() =>
      validateFilter({
        entity: 'customer',
        conditions: [{ field: '$where', operator: 'eq', value: '1==1' }],
      })
    ).toThrow();
  });
});
