import { expect, test } from '@playwright/test';

/**
 * The critical path: sign in, create an order, see it recorded.
 *
 * This is the flow that must never break, and the one where the most machinery
 * meets: cookie auth, the CSRF header, a searchable picker hitting a real
 * endpoint, and an order written inside a MongoDB transaction. Every previous
 * layer of testing mocks one side of that; this mocks nothing.
 */

const ADMIN = {
  email: 'e2e-admin@example.com',
  password: 'Karachi-Ledger-72',
};

/** Sign in through the real form and wait for the dashboard. */
async function signIn(page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // The redirect away from /login is the signal the session took hold.
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('Authentication', () => {
  test('signs in and reaches the dashboard', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('link', { name: /customers/i }).first()).toBeVisible();
  });

  /**
   * The Phase 1.1 guarantee, verified in a real browser rather than asserted
   * from a response header: the session cookies exist, and JavaScript cannot
   * read them.
   */
  test('stores the session in httpOnly cookies and nothing in localStorage', async ({
    page,
    context,
  }) => {
    await signIn(page);

    const cookies = await context.cookies();
    const access = cookies.find((c) => c.name === 'simplecrm_access');
    const refresh = cookies.find((c) => c.name === 'simplecrm_refresh');

    expect(access?.httpOnly).toBe(true);
    expect(refresh?.httpOnly).toBe(true);

    // The browser's own view: document.cookie cannot see the session, and
    // nothing was written to storage.
    const visibleToJs = await page.evaluate(() => document.cookie);
    expect(visibleToJs).not.toContain('simplecrm_access');
    expect(visibleToJs).not.toContain('simplecrm_refresh');

    const storage = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    expect(storage.local).toHaveLength(0);
    expect(storage.session).toHaveLength(0);
  });

  test('keeps the session across a page reload', async ({ page }) => {
    await signIn(page);
    await page.reload();

    // Restored from the cookie via /auth/me — no token to read, so this is the
    // only thing that could have kept the user signed in.
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('rejects wrong credentials with a visible message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(ADMIN.email);
    await page.getByLabel(/password/i).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs out and clears the session', async ({ page, context }) => {
    await signIn(page);

    await page.getByRole('button', { name: /sign out|log ?out/i }).click();
    await expect(page).toHaveURL(/\/login/);

    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'simplecrm_refresh')).toBeUndefined();
  });

  test('sends an unauthenticated visitor to login', async ({ page }) => {
    await page.goto('/customers');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Creating an order', () => {
  /**
   * The headline test.
   *
   * Every step is real: the picker queries /api/customers/options, the submit
   * carries the CSRF header and the session cookie, and the API writes the
   * order inside a transaction. If any one of those is wrong, this fails.
   */
  test('creates an order from the searchable pickers', async ({ page }) => {
    await signIn(page);

    await page.goto('/orders/new');

    // --- customer picker -------------------------------------------------
    const customerBox = page.getByLabel(/customer/i);
    await customerBox.click();
    await customerBox.fill('Karachi');
    await page.getByRole('option', { name: /Karachi Traders/i }).click();

    // --- product picker --------------------------------------------------
    const productBox = page.getByPlaceholder(/search products/i);
    await productBox.click();
    await productBox.fill('Widget');
    await page.getByRole('option', { name: /Blue Widget/i }).click();

    await page.getByRole('spinbutton').fill('2');

    // 2 x $25, computed by the form from the price the picker returned.
    await expect(page.getByText('$50.00').first()).toBeVisible();

    await page.getByRole('button', { name: /create order/i }).click();

    // Redirected to the new order's detail page.
    await expect(page).toHaveURL(/\/orders\/[a-f0-9]{24}/);
    await expect(page.getByText(/Karachi Traders/i).first()).toBeVisible();
  });

  test('shows the new order in the list', async ({ page }) => {
    await signIn(page);
    await page.goto('/orders');

    await expect(page.getByText(/Karachi Traders/i).first()).toBeVisible();
  });

  /**
   * The picker must reach the server. Typing something that matches nothing
   * proves it is querying rather than filtering a preloaded list — a
   * client-side filter over a fixed page would behave identically for a match
   * and could not be told apart.
   */
  test('the customer picker searches the server', async ({ page }) => {
    await signIn(page);
    await page.goto('/orders/new');

    const request = page.waitForRequest((req) =>
      req.url().includes('/api/customers/options')
    );

    const customerBox = page.getByLabel(/customer/i);
    await customerBox.click();
    await customerBox.fill('Karachi');

    await request;
    await expect(page.getByRole('option', { name: /Karachi Traders/i })).toBeVisible();
  });

  test('reports no matches rather than silently showing nothing', async ({ page }) => {
    await signIn(page);
    await page.goto('/orders/new');

    const customerBox = page.getByLabel(/customer/i);
    await customerBox.click();
    await customerBox.fill('zzzz-no-such-customer');

    await expect(page.getByText(/no customers match/i)).toBeVisible();
  });

  test('will not submit without a customer', async ({ page }) => {
    await signIn(page);
    await page.goto('/orders/new');

    await expect(page.getByRole('button', { name: /create order/i })).toBeDisabled();
  });
});
