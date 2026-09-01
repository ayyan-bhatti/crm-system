import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * Round 4's claims that only a browser can settle.
 *
 * The unit and API suites already prove the rules — consent blocks a send,
 * approval routes a manager's campaign, the unsubscribe token flips the flag.
 * What they cannot prove is that a person can actually DO any of it: that the
 * contacts screen merges and renders, that the campaign builder's preview
 * tells the truth before you commit, and — the one that matters most — that
 * the unsubscribe link in an email lands somewhere that works.
 *
 * That last one is worth a browser test rather than an API test precisely
 * because it is the step that is usually decorative. A link that 404s, or
 * lands on a page whose JavaScript never fires, passes every server-side test
 * ever written and does nothing for the person who clicked it.
 *
 * Serial by design, like the other specs here: the campaign test spends the
 * consent that the unsubscribe test would otherwise need.
 */

const ADMIN = { email: 'e2e-admin@example.com', password: 'Karachi-Ledger-72' };
const REP = { email: 'e2e-rep@example.com', password: 'Multan-Ledger-64' };

const CONSENTED = 'contact@karachitraders.example';
const NOT_CONSENTED = 'quiet@karachitraders.example';

async function signIn(page, creds) {
  await page.goto('/crm/login');
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/crm\/login/);
}

const main = (page) => page.getByRole('main');

/**
 * The JWT secret `scripts/e2eServer.js` starts the backend with.
 *
 * Duplicated here on purpose and safe to have in the repository: it exists
 * only for the throwaway in-memory database an end-to-end run creates, and the
 * e2e server hard-codes it for exactly that reason.
 */
const E2E_SECRET = 'e2e-secret-not-used-outside-end-to-end-tests-000000';

/**
 * Mint an unsubscribe token the way `services/unsubscribeService` does.
 *
 * See the note in the unsubscribe test for why the token is computed rather
 * than read out of a delivered email.
 */
function signUnsubscribeToken(email, channel) {
  const payload = `${email.toLowerCase().trim()}:${channel}`;
  const signature = crypto.createHmac('sha256', E2E_SECRET).update(payload).digest('base64url');

  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

test.describe('Marketing contacts', () => {
  test('an admin sees every contact, with their opt-in state on the row', async ({ page }) => {
    await signIn(page, ADMIN);

    await page.getByRole('link', { name: /^contacts$/i }).click();
    await expect(page).toHaveURL(/\/crm\/contacts/);

    // Both seeded contacts, merged into the one list.
    await expect(main(page).getByText(CONSENTED)).toBeVisible();
    await expect(main(page).getByText(NOT_CONSENTED)).toBeVisible();

    // The hand-assigned tag is shown alongside the computed segments.
    await expect(main(page).getByText('VIP')).toBeVisible();
  });

  test('the opt-in filter separates the two', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/crm/contacts');

    await page.getByLabel(/opt-in channel/i).selectOption('email');
    await page.getByLabel(/opted in\?/i).selectOption('yes');

    await expect(main(page).getByText(CONSENTED)).toBeVisible();
    /*
     * The whole point of the filter. Somebody who has not agreed must be
     * absent from a list you are about to build a campaign from.
     */
    await expect(main(page).getByText(NOT_CONSENTED)).toHaveCount(0);
  });

  /**
   * The consent state has to be visible AND actionable from one place, because
   * "why did this person not get it" and "record that they said yes on the
   * phone" are the same conversation.
   */
  test('opening a contact shows their consent and offers to change it', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/crm/contacts');

    await main(page).getByText(NOT_CONSENTED).click();

    const panel = page.getByRole('dialog');
    await expect(panel.getByText(/never opted in/i).first()).toBeVisible();

    /*
     * The send controls are DISABLED with a reason, rather than hidden. Hidden,
     * a user wonders whether the shop can send email at all; disabled with an
     * explanation answers the question they actually have, which is "how do I
     * reach this person" — and the answer is "ask them first".
     */
    await expect(panel.getByText(/has not opted in to email/i)).toBeVisible();
    await expect(panel.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  /**
   * The export is admin-only, and a manager seeing every one of these rows on
   * screen still does not get the button. Reading a list and taking a copy of
   * it out of the building are different acts.
   */
  test('a sales rep sees the screen but not the export', async ({ page }) => {
    await signIn(page, REP);

    await page.goto('/crm/contacts');
    await expect(page.getByRole('heading', { name: /marketing contacts/i })).toBeVisible();

    await expect(page.getByRole('button', { name: /export to excel/i })).toHaveCount(0);
    // ...and no campaigns section at all: a bulk send is not a rep's decision.
    await expect(page.getByRole('link', { name: /^campaigns$/i })).toHaveCount(0);
  });
});

test.describe('Building and sending a campaign', () => {
  /**
   * THE CENTRAL TEST OF THIS ROUND.
   *
   * Two contacts match the audience; one has agreed to email. The campaign
   * must reach exactly one and must SAY it skipped the other — the difference
   * between a working consent gate and a broken send is entirely in whether
   * that second number is reported.
   */
  test('previews honestly, sends to the consented contact, and reports the skip', async ({
    page,
  }) => {
    await signIn(page, ADMIN);

    await page.getByRole('link', { name: /^campaigns$/i }).click();

    /*
     * `.first()`, and it is deliberate rather than a workaround.
     *
     * This is the CI-only failure caught in the round's first push: on a
     * fresh database the campaign list is genuinely empty, and — the same
     * pattern CustomerList/ProductList/OrderList already use — an empty list
     * renders "New campaign" TWICE, once as the page header's persistent
     * action and once as the empty state's call to action. Both are the same
     * link to the same destination; a user would click whichever one their
     * eye landed on. It never showed up locally because every other seeded
     * entity in this app always has at least one row, so this is the first
     * list a test has ever met while it was actually empty.
     */
    await page.getByRole('link', { name: /new campaign/i }).first().click();

    await page.getByLabel(/campaign name/i).fill('E2E win-back');
    await page.getByLabel(/what is this campaign for/i).fill('Check in with quiet customers');
    await page.getByLabel(/send to/i).selectOption('all');

    /*
     * THE PREVIEW TELLS THE TRUTH BEFORE ANYTHING IS WRITTEN.
     *
     * Two match the audience, one can be reached. Finding that out only after
     * pressing send is what makes a consent skip read as a bug in the sender.
     *
     * Each stat tile is an accessible group named "<label>: <value>", so it is
     * addressed by role rather than by a text locator that would also match
     * every ancestor element containing the same digit.
     */
    await expect(page.getByRole('group', { name: 'Match this audience: 2' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Opted in to email: 1' })).toBeVisible();

    // Write the copy by hand — the AI path has no key in the e2e environment
    // and would take its documented template, which is not what is under test.
    await page.getByLabel(/^subject$/i).fill('How are things?');
    await page.getByLabel(/email body/i).fill('Hi {{name}}, just checking in on you.');

    await page.getByRole('button', { name: /save as draft/i }).click();

    // Saving creates a DRAFT. Nothing has been sent.
    await expect(page).toHaveURL(/\/crm\/campaigns\/[a-f0-9]{24}/);
    await expect(main(page).getByText(/^Draft$/)).toBeVisible();

    await page.getByRole('button', { name: /send campaign/i }).click();

    await expect(page.getByText(/sent to 1 contact/i)).toBeVisible();

    // The counts, on the page, adding up.
    await expect(main(page).getByText(/^Sent$/).first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Delivered: 1' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'No opt-in: 1' })).toBeVisible();

    /*
     * And the per-person rows, which are the actual feature. "Sent to 1"
     * cannot answer "did this person get it", and that is the question
     * somebody always asks.
     */
    await expect(main(page).getByText(CONSENTED)).toBeVisible();
    await expect(main(page).getByText(NOT_CONSENTED)).toBeVisible();
    await expect(main(page).getByText('No opt-in').last()).toBeVisible();
  });

  test('a sent campaign cannot be sent again', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/crm/campaigns');

    await page.getByRole('link', { name: /E2E win-back/i }).click();

    /*
     * The button is gone rather than disabled. "It looked like it failed so I
     * pressed it again" is exactly how a list gets messaged twice, and the
     * safest version of that control is one that is not there.
     */
    await expect(page.getByRole('button', { name: /send campaign/i })).toHaveCount(0);
  });
});

test.describe('The unsubscribe link', () => {
  /**
   * THE STEP THAT IS USUALLY DECORATIVE.
   *
   * A link that 404s, or that lands on a page whose JavaScript never fires,
   * passes every server-side test and does nothing for the person who clicked
   * it. So this drives the real page in a real browser and then checks the CRM
   * agrees the consent is gone.
   *
   * The token is minted through the API rather than scraped out of a log,
   * because the console mail transport writes to the SERVER's stdout, which a
   * Playwright test cannot read. What is under test is the landing page and
   * the write behind it, and the token's own signing is covered by the unit
   * suite.
   */
  test('takes the recipient off the list, and the CRM shows it', async ({ page }) => {
    await signIn(page, ADMIN);

    /*
     * Make sure the contact is opted in first, so this spec stands on its own
     * whether or not the campaign spec above has already run.
     */
    await page.goto('/crm/contacts');
    await main(page).getByText(CONSENTED).click();

    const panel = page.getByRole('dialog');
    const optIn = panel.getByRole('button', { name: /^opt in$/i }).first();
    if (await optIn.count()) await optIn.click();

    await expect(panel.getByRole('button', { name: /^opt out$/i }).first()).toBeVisible();
    await panel.getByRole('button', { name: /^close$/i }).click();

    /*
     * The token is computed here with the same HMAC the server signs it with,
     * using the JWT secret the e2e backend is started with
     * (scripts/e2eServer.js). Scraping it out of a real email is not possible
     * — the console mail transport writes to the SERVER's stdout, which a
     * Playwright test cannot read.
     *
     * This does not weaken the test into checking its own arithmetic: the
     * server VERIFIES the token before acting on it, so a change to how links
     * are signed makes this token invalid and the test fails, which is the
     * correct outcome for a change that would break every link already sitting
     * in somebody's inbox.
     */
    const token = signUnsubscribeToken(CONSENTED, 'email');

    await page.goto(`/unsubscribe?token=${encodeURIComponent(token)}`);

    await expect(page.getByRole('heading', { name: /unsubscribed/i })).toBeVisible();

    /*
     * AND THE CRM AGREES. This is the assertion a decorative unsubscribe link
     * fails — the page can say "you have been unsubscribed" perfectly happily
     * while nothing was written, and only reading the state back catches it.
     */
    await page.goto('/crm/contacts');
    await main(page).getByText(CONSENTED).click();
    await expect(page.getByRole('dialog').getByText(/opted out/i).first()).toBeVisible();
  });

  test('says so plainly when the link has been mangled', async ({ page }) => {
    await page.goto('/unsubscribe?token=not-a-real-token');

    await expect(page.getByRole('heading', { name: /could not/i })).toBeVisible();
    // The advice has to be actionable: mail clients really do break long links.
    await expect(page.getByText(/copying the whole link/i)).toBeVisible();
  });
});
