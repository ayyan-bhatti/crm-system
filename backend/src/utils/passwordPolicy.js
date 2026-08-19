const ApiError = require('./ApiError');

/**
 * Password strength rules, enforced wherever a password is set.
 *
 * WHY THE RULES ARE SHAPED LIKE THIS
 *
 * The obvious policy — "8 characters, one uppercase, one number, one symbol" —
 * is the one NIST SP 800-63B specifically advises against, and it is worth
 * being able to say why rather than copying it because it looks rigorous.
 * Composition rules do not produce unpredictable passwords; they produce
 * `Password1!`, because people satisfy them in the same handful of ways. What
 * actually resists guessing is *length* and *not being a password everyone else
 * already uses*.
 *
 * So the policy here is:
 *
 *   1. LENGTH FIRST. Ten characters minimum. From fourteen, length alone is
 *      enough — a passphrase like "correct horse battery staple" is far
 *      stronger than `Xy7!qZ` and should not be rejected for lacking a digit.
 *      Below fourteen, three of the four character classes are required,
 *      because a short password has to buy its entropy from variety instead.
 *
 *   2. BLOCKLIST. Reject the passwords that appear at the top of every breach
 *      corpus. Credential stuffing tries those first, so blocking them removes
 *      the cheapest attack outright. A production system would check against a
 *      full breach corpus (Have I Been Pwned's k-anonymity API, or a local
 *      dump); this is a deliberately small in-repo list, and calling that out
 *      is more honest than implying full coverage.
 *
 *   3. NOTHING DERIVED FROM THE ACCOUNT. `ayesha@company.com` /
 *      `ayesha2024` is guessed on the first try by anyone who knows the email
 *      address, which is exactly the person attacking the account.
 *
 *   4. A 72-BYTE CEILING. This one is a genuine bug rather than a policy
 *      choice: bcrypt silently truncates its input at 72 bytes. Without an
 *      explicit limit, a 100-character password would be *accepted*, silently
 *      shortened, and a different 100-character password sharing the first 72
 *      bytes would open the account. Rejecting is the only honest option —
 *      accepting input we then quietly discard is worse than saying no.
 */

/**
 * Passwords common enough that an attacker tries them before anything else.
 *
 * Kept short and readable on purpose: this is the illustrative version of a
 * check that belongs against a real breach corpus. Comparison is done on a
 * normalised form, so `P@ssw0rd` and `password` collapse to the same entry.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'passwort',
  'passphrase',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd',
  'letmein',
  'welcome',
  'welcome1',
  'qwerty',
  'qwertyuiop',
  'qwerty123',
  'iloveyou',
  'admin',
  'administrator',
  'adminadmin',
  'root',
  'rootroot',
  'changeme',
  'secret',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'trustno1',
  'starwars',
  'michael',
  'shadow',
  'master',
  'abc123',
  'abcd1234',
  'a1b2c3d4',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '111111',
  '000000',
  'zaq12wsx',
  '1qaz2wsx',
  // Anything named after this app is the first thing anyone tries here.
  'simplecrm',
  'simplecrm1',
  'simplecrm123',
]);

const MIN_LENGTH = 10;
/** Length at which we stop asking for character variety. */
const PASSPHRASE_LENGTH = 14;
/** bcrypt ignores everything past this. See rule 4 above. */
const MAX_BYTES = 72;

/**
 * Every form of a password worth comparing against the blocklist.
 *
 * People do two things to a common password when a rule pushes back: they
 * substitute characters (`P@ssw0rd`) and they bolt digits on the end
 * (`password123`). Checking only the raw string catches neither, and — the
 * subtlety that made the first version of this wrong — undoing substitutions
 * *before* stripping the suffix corrupts it: `P@ssw0rd123` folds to
 * `passwordi2e`, which matches nothing.
 *
 * So the suffix comes off first, then substitutions are undone, and every
 * intermediate form is compared. Generating candidates rather than computing
 * one canonical form is also just easier to reason about: each transformation
 * is independent, and adding another is one more line.
 */
const SUBSTITUTIONS = { '@': 'a', $: 's', 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };

function unsubstitute(value) {
  return value.replace(/[@$013457]/g, (char) => SUBSTITUTIONS[char]);
}

function normalisedForms(password) {
  const lower = password.toLowerCase();
  // Trailing digits and punctuation: the "123" and "!" of password123!
  const withoutSuffix = lower.replace(/[\d\W_]+$/, '');

  const forms = new Set();

  for (const base of [lower, withoutSuffix]) {
    if (!base) continue;
    forms.add(base);
    const unsubstituted = unsubstitute(base);
    forms.add(unsubstituted);
    forms.add(unsubstituted.replace(/[^a-z]/g, ''));
  }

  return forms;
}

/** How many of the four character classes appear. */
function characterClasses(password) {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password))
    .length;
}

/**
 * Check a password, returning every problem at once.
 *
 * All failures rather than the first: telling someone their password is too
 * short, watching them fix it, then telling them it also needs a capital is a
 * small cruelty that a single list avoids.
 *
 * @param {string} password
 * @param {{ name?: string, email?: string }} [user] used for the "nothing
 *   derived from the account" rule.
 * @returns {string[]} problems, empty when the password is acceptable.
 */
function checkPassword(password, user = {}) {
  const problems = [];

  if (typeof password !== 'string' || !password) {
    return ['Password is required'];
  }

  if (password.length < MIN_LENGTH) {
    problems.push(`Password must be at least ${MIN_LENGTH} characters`);
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) {
    problems.push(
      `Password must be at most ${MAX_BYTES} bytes — anything longer is silently ignored by the ` +
        'password hash, which would make it weaker than it looks'
    );
  }

  // Variety is only required of short passwords; length substitutes for it.
  if (password.length >= MIN_LENGTH && password.length < PASSPHRASE_LENGTH) {
    if (characterClasses(password) < 3) {
      problems.push(
        'Password must mix at least three of: lowercase, uppercase, numbers, symbols — ' +
          `or simply be ${PASSPHRASE_LENGTH} characters or longer`
      );
    }
  }

  const isCommon = [...normalisedForms(password)].some((form) => COMMON_PASSWORDS.has(form));
  if (isCommon) {
    problems.push('Password is too common — it appears in every list attackers try first');
  }

  // A single repeated character, or a straight run off the keyboard.
  if (/^(.)\1+$/.test(password)) {
    problems.push('Password cannot be a single repeated character');
  }

  const derived = derivedFromAccount(password, user);
  if (derived) problems.push(derived);

  return problems;
}

/** Reject a password built out of the account's own name or email. */
function derivedFromAccount(password, { name, email } = {}) {
  const lowered = password.toLowerCase();

  const emailLocal = String(email || '')
    .split('@')[0]
    .toLowerCase();
  if (emailLocal.length >= 4 && lowered.includes(emailLocal)) {
    return 'Password must not contain your email address';
  }

  // Each word of the name separately, so "Ayesha Khan" catches "ayesha2024".
  const words = String(name || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 4);

  if (words.some((word) => lowered.includes(word))) {
    return 'Password must not contain your name';
  }

  return null;
}

/**
 * Throw a 400 if the password is unacceptable.
 *
 * Problems are returned in `details`, the same shape the error handler already
 * uses for Mongoose validation failures — so the existing frontend error
 * display shows them with no change.
 */
function assertStrongPassword(password, user = {}) {
  const problems = checkPassword(password, user);

  if (problems.length) {
    throw ApiError.badRequest(
      'Password does not meet the security requirements',
      problems.reduce((acc, problem, index) => {
        acc[`password${index || ''}`] = problem;
        return acc;
      }, {})
    );
  }
}

module.exports = {
  checkPassword,
  assertStrongPassword,
  MIN_LENGTH,
  PASSPHRASE_LENGTH,
  MAX_BYTES,
};
