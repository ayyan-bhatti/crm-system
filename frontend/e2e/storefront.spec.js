import { expect, test } from '@playwright/test';

/**
 * The storefront ("buyer track"): a public shop bolted onto the internal CRM,
 * architecturally isolated from staff — its own cookies, its own CSRF pair,
 * its own axios client, its own React contexts. This spec proves the whole
 * thing end to end, against the one seeded product (Blue Widget, $25, stock
 * 40) and no seeded buyer.
 *
 * Serial by design, same reasoning as order-flow.spec.js: several tests here
 * build on state a previous one created (a registered buyer, an order placed
 * while signed in), so they run in the order written rather than in
 * isolation. GEMINI_API_KEY is unset in the e2e environment (see
 * e2eServer.js), so every AI-shaped feature exercised here — the storefront
 * search box — takes its documented `mode: 'fallback'` path.
 */

const ADMIN = { email: 'e2e-admin@example.com', password: 'Karachi-Ledger-72' };
const MANAGER = { email: 'e2e-manager@example.com', password: 'Lahore-Ledger-53' };
const BUYER = {
  name: 'Fatima Noor',
  email: 'fatima.buyer@example.com',
  password: 'Storefront-Buyer-42',
};

/** Sign in to the internal CRM through the real form. */
async function signInStaff(page, creds) {
  await page.goto('/crm/login');
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/crm\/login/);
}

/** Sign in to the storefront through the real buyer form. */
async function signInBuyer(page, creds = BUYER) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('Catalogue', () => {
  test('the home page shows the seeded product as featured', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /featured/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Blue Widget/i })).toBeVisible();
  });

  test('the catalogue lists it, and the search box finds it via the fallback path', async ({
    page,
  }) => {
    await page.goto('/products');
    await expect(page.getByRole('link', { name: /Blue Widget/i })).toBeVisible();

    // No GEMINI_API_KEY in this environment, so this exercises
    // shopSearchService's substring-match fallback, not a live model call —
    // the point of the test is that the fallback still returns a real,
    // correct result rather than an empty or broken one.
    const searchBox = page.getByLabel(/search products/i);
    await searchBox.fill('Widget');
    await page.getByRole('button', { name: /^search$/i }).click();

    await expect(page.getByText(/showing keyword matches for/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /Blue Widget/i })).toBeVisible();

    // The fallback strips filler words, so the words it actually searched for
    // are rarely the words that were typed — the grid now shows them, for the
    // same reason the internal AI search bar does.
    await expect(page.getByText(/searched for:/i)).toBeVisible();
  });

  test('a search for nothing that exists returns no matches, not stale results', async ({
    page,
  }) => {
    await page.goto('/products');

    const searchBox = page.getByLabel(/search products/i);
    await searchBox.fill('zzznonexistentproductzzz');
    await page.getByRole('button', { name: /^search$/i }).click();

    await expect(page.getByText(/no products found/i)).toBeVisible();
  });
});

test.describe('Product detail and guest cart', () => {
  test('shows the real product and adds it to the cart', async ({ page }) => {
    await page.goto('/products');
    await page.getByRole('link', { name: /Blue Widget/i }).click();

    await expect(page).toHaveURL(/\/products\/[a-f0-9]{24}/);
    await expect(page.getByRole('heading', { name: 'Blue Widget' })).toBeVisible();
    await expect(page.getByText('$25.00')).toBeVisible();
    await expect(page.getByText(/in stock/i)).toBeVisible();

    await page.getByRole('button', { name: /add to cart/i }).click();

    await expect(page.getByText(/added 1 to your cart/i)).toBeVisible();
    await expect(page.getByLabel('Cart, 1 item')).toBeVisible();
  });

  /**
   * The guest cart's whole point is that it never touches the server (see
   * CartContext's comment on why). Proving it survives a reload is not
   * enough on its own — a bug that silently re-fetched an empty server cart
   * on reload could still "pass" a check that only looks at final state — so
   * this also watches the network and asserts nothing hit /shop/cart.
   */
  test('the guest cart is localStorage-backed and survives a reload with no network call', async ({
    page,
  }) => {
    await page.goto('/products');
    await page.getByRole('link', { name: /Blue Widget/i }).click();
    await page.getByRole('button', { name: /add to cart/i }).click();
    await expect(page.getByLabel('Cart, 1 item')).toBeVisible();

    const cartRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/shop/cart')) cartRequests.push(req.url());
    });

    await page.reload();

    await expect(page.getByLabel('Cart, 1 item')).toBeVisible();
    expect(cartRequests).toHaveLength(0);

    const stored = await page.evaluate(() => localStorage.getItem('simplecrm_shop_cart'));
    const parsed = JSON.parse(stored);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].product.name).toBe('Blue Widget');
  });
});

test.describe('Checkout requires a buyer account', () => {
  /**
   * Guest checkout was removed from the FRONTEND (Checkout.jsx) — the
   * backend endpoint still accepts a guest payload (see
   * `shopCheckoutController` and `attachBuyerIfPresent`), it is just
   * unreachable from this UI now. A guest can still browse and build a
   * cart freely; reaching the checkout form requires signing in.
   */
  test('sends a guest with items in the cart to sign in instead of a guest checkout form', async ({
    page,
  }) => {
    await page.goto('/products');
    await page.getByRole('link', { name: /Blue Widget/i }).click();

    await page.getByLabel(/quantity/i).selectOption('2');
    await page.getByRole('button', { name: /add to cart/i }).click();
    await expect(page.getByLabel('Cart, 2 items')).toBeVisible();

    await page.getByLabel(/cart, 2 items/i).click();
    await page.getByRole('link', { name: /checkout/i }).click();

    // No guest delivery-details form any more — straight to sign-in.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel(/^name/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /place order/i })).toHaveCount(0);

    // The cart survives the round trip — it lives in localStorage,
    // untouched by this redirect (see CartContext's guest-cart merge,
    // exercised for real by the "Cart merge and buyer checkout" flow below).
    const stored = await page.evaluate(() => localStorage.getItem('simplecrm_shop_cart'));
    expect(JSON.parse(stored)).toHaveLength(1);
  });
});

test.describe('Buyer registration and session', () => {
  test('registers a new buyer account', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel(/^name/i).fill(BUYER.name);
    await page.getByLabel(/email/i).fill(BUYER.email);
    await page.getByLabel(/password/i).fill(BUYER.password);
    await page.getByRole('button', { name: /create account/i }).click();

    // Registration signs the buyer straight in and lands on the shop home
    // (the app's front door, at "/" — see the note at the top of App.jsx).
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(new RegExp(`hi, ${BUYER.name.split(' ')[0]}`, 'i'))).toBeVisible();
  });

  test('rejects a weak password with a visible message', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel(/^name/i).fill('Weak Password');
    await page.getByLabel(/email/i).fill('weak.password@example.com');
    await page.getByLabel(/password/i).fill('short');
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page.getByText(/at least 10 characters/i)).toBeVisible();
    await expect(page).toHaveURL(/\/register/);
  });

  test('signs in and keeps the session across a reload, then signs out', async ({ page }) => {
    await signInBuyer(page);
    await expect(page.getByText(new RegExp(`hi, ${BUYER.name.split(' ')[0]}`, 'i'))).toBeVisible();

    await page.reload();
    await expect(page.getByText(new RegExp(`hi, ${BUYER.name.split(' ')[0]}`, 'i'))).toBeVisible();

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('link', { name: /^sign in$/i })).toBeVisible();
  });

  /**
   * The architectural guarantee the whole "buyer track" rests on: a buyer
   * session and a staff session can be open in the same browser at once,
   * under different cookie names, and neither disturbs the other.
   */
  test('a buyer session and a staff session coexist without interfering', async ({ context }) => {
    const buyerPage = await context.newPage();
    await signInBuyer(buyerPage);
    await expect(
      buyerPage.getByText(new RegExp(`hi, ${BUYER.name.split(' ')[0]}`, 'i'))
    ).toBeVisible();

    const staffPage = await context.newPage();
    await signInStaff(staffPage, ADMIN);
    await expect(staffPage.getByRole('link', { name: /customers/i }).first()).toBeVisible();

    const cookies = await context.cookies();
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));

    expect(byName.shop_access).toBeTruthy();
    expect(byName.shop_refresh).toBeTruthy();
    expect(byName.simplecrm_access).toBeTruthy();
    expect(byName.simplecrm_refresh).toBeTruthy();
    expect(byName.shop_access.value).not.toBe(byName.simplecrm_access.value);
    expect(byName.shop_access.httpOnly).toBe(true);
    expect(byName.simplecrm_access.httpOnly).toBe(true);

    // Signing in as staff, in the same context, must not have touched the
    // buyer session that was already open.
    await buyerPage.reload();
    await expect(buyerPage).not.toHaveURL(/\/login/);
    await expect(
      buyerPage.getByText(new RegExp(`hi, ${BUYER.name.split(' ')[0]}`, 'i'))
    ).toBeVisible();

    await staffPage.close();
    await buyerPage.close();
  });
});

test.describe('Buyer address book', () => {
  test('adds an address and it appears on the account page', async ({ page }) => {
    await signInBuyer(page);
    await page.goto('/account/addresses');

    await page.getByRole('button', { name: /add address/i }).click();
    await page.getByLabel(/label/i).fill('Home');
    await page.getByLabel(/^address/i).fill('45 Boat Basin, Clifton');
    // Required since round 2 — a courier needs the city to route the parcel,
    // so it is the one part of a delivery address held separately from the
    // free-text block. See Buyer.js's addressSchema.
    await page.getByLabel(/^city/i).fill('Karachi');
    await page.getByLabel(/phone/i).fill('0300-1234567');
    await page.getByRole('button', { name: /save address/i }).click();

    await expect(page.getByText(/address added/i)).toBeVisible();
    await expect(page.getByText('Home')).toBeVisible();
    await expect(page.getByText('45 Boat Basin, Clifton')).toBeVisible();
    await expect(page.getByText('Karachi')).toBeVisible();
  });
});

test.describe('Cart merge and buyer checkout', () => {
  /**
   * Adds to cart as a guest, THEN signs in — the one legitimate multi-tab
   * scenario BuyerAuthContext's own comment calls out: someone who started
   * shopping before creating an account should not lose what they picked.
   * Places the order this spec's remaining tests (history, detail, staff
   * approval) all build on.
   */
  test('a guest cart merges into the buyer account on login, then checks out', async ({
    page,
  }) => {
    await page.goto('/products');
    await page.getByRole('link', { name: /Blue Widget/i }).click();
    await page.getByRole('button', { name: /add to cart/i }).click();
    await expect(page.getByLabel('Cart, 1 item')).toBeVisible();

    await signInBuyer(page);

    // The merge is async (a POST to /shop/cart/merge, then a re-fetch of the
    // server cart) — the badge settling back to 1 rather than reverting to 0
    // is the proof the guest line survived the merge onto a fresh server cart.
    await expect(page.getByLabel('Cart, 1 item')).toBeVisible();

    await page.getByLabel(/cart, 1 item/i).click();
    // Scoped to the drawer: the home page behind it also shows "Blue Widget"
    // as a featured product card, which an unscoped lookup would collide with.
    const drawer = page.getByRole('dialog', { name: /shopping cart/i });
    await expect(drawer.getByText('Blue Widget')).toBeVisible();
    await drawer.getByRole('link', { name: /checkout/i }).click();

    await expect(page).toHaveURL(/\/checkout/);
    // Signed in with a saved address: no guest form, the saved address is
    // pre-selected (Checkout.jsx defaults to the first one).
    await expect(page.getByText('Home', { exact: true })).toBeVisible();
    await expect(page.getByText('45 Boat Basin, Clifton')).toBeVisible();

    await page.getByRole('button', { name: /place order/i }).click();

    await expect(page).toHaveURL(/\/order-confirmation\/[a-f0-9]{24}/);
    await expect(page.getByRole('heading', { name: /thank you for your order/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /view your orders/i })).toBeVisible();
  });
});

test.describe('Buyer order history and actions', () => {
  test('the order appears in history, and its detail page has the right line items', async ({
    page,
  }) => {
    await signInBuyer(page);
    await page.goto('/account/orders');

    await expect(page.getByRole('heading', { name: 'Your orders', exact: true })).toBeVisible();
    const orderLink = page.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first();
    await expect(orderLink).toBeVisible();
    await orderLink.click();

    await expect(page).toHaveURL(/\/account\/orders\/[a-f0-9]{24}/);
    await expect(page.getByRole('cell', { name: 'Blue Widget' })).toBeVisible();
    await expect(page.getByText('$25.00').first()).toBeVisible();
  });

  test('requesting different quantities puts the order in a pending-request state', async ({
    page,
  }) => {
    await signInBuyer(page);
    await page.goto('/account/orders');
    await page.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first().click();

    await page.getByRole('button', { name: /request different quantities/i }).click();
    await page.getByLabel(/new quantity for Blue Widget/i).fill('3');
    await page.getByRole('button', { name: /send request/i }).click();

    // The order itself does not change yet — only the request exists, waiting
    // on staff. What the UI can show right now is the confirmation that the
    // request was sent; the order's own state stays "pending" throughout.
    await expect(page.getByText(/edit request has been sent for approval/i)).toBeVisible();
    await expect(page.getByText(/^pending$/i)).toBeVisible();

    // A second request against the same order is refused server-side while
    // one is outstanding — proves the request really landed, not just the
    // toast.
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: /request cancellation/i }).click();
    await expect(page.getByText(/already a change waiting for approval/i)).toBeVisible();
  });
});

test.describe('Staff decide the buyer requests', () => {
  test('an admin sees the customer-request pill in Approvals and approves it', async ({
    page,
  }) => {
    await signInStaff(page, ADMIN);
    await page.goto('/crm/approvals');

    await expect(page.getByText(/customer request/i)).toBeVisible();
    await expect(page.getByText(/change items/i)).toBeVisible();

    await page.getByRole('button', { name: /^approve$/i }).click();
    await expect(page.getByText(/approved, and the change has been made/i)).toBeVisible();
    await expect(page.getByText(/nothing waiting/i)).toBeVisible();
  });

  test('the approved edit is reflected on the buyer’s order', async ({ page }) => {
    await signInBuyer(page);
    await page.goto('/account/orders');
    await page.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first().click();

    // Quantity 3 at $25 — the edit requested above, now actually applied.
    await expect(page.getByText('$75.00').first()).toBeVisible();
  });

  test('a manager reaches Approvals and can decide a buyer-originated request', async ({
    page,
  }) => {
    // A fresh buyer-originated request for the manager to act on — the order
    // is still pending after the admin's edit above, so this is allowed.
    const buyerPage = await page.context().newPage();
    await signInBuyer(buyerPage);
    await buyerPage.goto('/account/orders');
    await buyerPage.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first().click();
    buyerPage.once('dialog', (dialog) => dialog.accept());
    await buyerPage.getByRole('button', { name: /request cancellation/i }).click();
    await expect(
      buyerPage.getByText(/cancellation request has been sent for approval/i)
    ).toBeVisible();
    await buyerPage.close();

    await signInStaff(page, MANAGER);
    await page.goto('/crm/approvals');

    // Per the phase-4 RBAC rule, a manager's queue is the buyer-request
    // subset of the same list an admin sees — proven here by the pill being
    // present on every row a manager can see at all.
    await expect(page.getByText(/customer request/i)).toBeVisible();

    await page.getByRole('button', { name: /^approve$/i }).click();
    await expect(page.getByText(/approved, and the change has been made/i)).toBeVisible();
  });

  test('the cancellation approved by the manager is reflected on the buyer’s order', async ({
    page,
  }) => {
    await signInBuyer(page);
    await page.goto('/account/orders');
    await page.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first().click();

    await expect(page.getByText(/^cancelled$/i)).toBeVisible();
    await expect(page.getByText(/already cancelled and can no longer be changed/i)).toBeVisible();
  });
});
