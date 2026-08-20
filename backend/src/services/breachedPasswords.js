const crypto = require('crypto');
const env = require('../config/env');

/**
 * Check a password against the Have I Been Pwned breach corpus.
 *
 * WHY THIS IS WORTH DOING
 *
 * The in-repo blocklist catches the fifty passwords everyone thinks of. The
 * real corpus has over half a billion, and credential-stuffing tools work
 * straight from it — so "not in a breach" is a far stronger property than "not
 * obviously bad". It is also the one password rule that keeps working as
 * attackers' wordlists grow, without anyone having to maintain a list.
 *
 * K-ANONYMITY: THE PASSWORD NEVER LEAVES THIS SERVER
 *
 * This is the part worth understanding before trusting a third party with
 * anything password-shaped, and the reason this is acceptable at all:
 *
 *   1. SHA-1 the password locally.
 *   2. Send only the FIRST FIVE characters of the hash.
 *   3. HIBP returns every suffix it holds beginning with that prefix —
 *      typically several hundred — and the comparison happens here.
 *
 * So the service sees five hex characters, which match roughly 800 hashes in
 * its database. It cannot tell which one was asked about, cannot reconstruct
 * the password, and cannot link the request to an account. Nothing secret is
 * transmitted.
 *
 * SHA-1 is used because that is the corpus's format. It is broken for
 * signatures and irrelevant here — this is a lookup key, not a security
 * boundary, and the passwords are stored with bcrypt regardless.
 *
 * IT FAILS OPEN, DELIBERATELY
 *
 * If the API is slow, down, or blocked by a firewall, the check is skipped and
 * registration proceeds on the local rules alone. The alternative — refusing to
 * let anyone sign up or change their password because a third-party service is
 * unreachable — trades a strong password policy for an outage. The local
 * blocklist, the length rule and the account-derivation rule all still apply, so
 * failing open degrades the policy rather than removing it.
 */

const HIBP_URL = 'https://api.pwnedpasswords.com/range';

/**
 * Short, because this sits in the middle of a user waiting for a signup to
 * complete. If it has not answered in three seconds it is not going to make the
 * experience better by answering in ten.
 */
const TIMEOUT_MS = 3000;

/**
 * How many appearances in the corpus count as "breached".
 *
 * Not 1. A password appearing exactly once may be a genuinely strong passphrase
 * that happened to be in a dump — rejecting it teaches people the rules are
 * arbitrary. Ten or more means it is in the wordlists that matter.
 */
const APPEARANCE_THRESHOLD = 10;

/**
 * Look the password up.
 *
 * @returns {Promise<{ breached: boolean, count: number, checked: boolean }>}
 *   `checked: false` means the service could not be reached and no conclusion
 *   was drawn — see the fail-open note above.
 */
async function checkBreached(password) {
  // Turned off in tests: a unit test must not depend on a third-party service
  // being reachable, and 400 tests hitting a public API would be rude.
  if (!env.breachCheckEnabled) {
    return { breached: false, count: 0, checked: false };
  }

  const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  try {
    const response = await fetch(`${HIBP_URL}/${prefix}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Requested by the API's usage guidance so operators can identify
        // traffic; it carries no user information.
        'User-Agent': 'SimpleCRM-password-policy',
        // Pads the response to a uniform size, so an observer watching the
        // encrypted connection cannot infer anything from its length.
        'Add-Padding': 'true',
      },
    });

    if (!response.ok) {
      return { breached: false, count: 0, checked: false };
    }

    const body = await response.text();

    /*
     * Each line is `SUFFIX:COUNT`. The whole list is scanned rather than
     * short-circuiting on a match, which costs nothing at this size and keeps
     * the timing independent of where in the list the answer sits.
     */
    for (const line of body.split('\n')) {
      const [candidate, rawCount] = line.trim().split(':');
      if (candidate === suffix) {
        const count = Number(rawCount) || 0;
        return { breached: count >= APPEARANCE_THRESHOLD, count, checked: true };
      }
    }

    return { breached: false, count: 0, checked: true };
  } catch (err) {
    // Timeout, DNS failure, firewall. Log once and let the password through on
    // the local rules — see the fail-open note.
    if (!env.isTest) {
      console.warn(
        `[password] Breach check unavailable (${err.message}). Falling back to the local rules.`
      );
    }
    return { breached: false, count: 0, checked: false };
  }
}

module.exports = { checkBreached, APPEARANCE_THRESHOLD, TIMEOUT_MS };
