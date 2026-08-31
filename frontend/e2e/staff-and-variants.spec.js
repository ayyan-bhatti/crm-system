import { expect, test } from '@playwright/test';

/**
 * Round 3's two claims that only a browser can settle.
 *
 * 1. ALL THREE STAFF ROLES STILL WORK after the CRM's visual update. The
 *    round's definition of done asks for this by name — sign in as each and
 *    complete one real workflow — because a re-skin is exactly the kind of
 *    change that breaks a screen for the one role nobody thought to open.
 *
 * 2. A PRODUCT WITH VARIANTS CANNOT BE BOUGHT WITHOUT CHOOSING ONE, and a
 *    product WITHOUT variants is unaffected. The server enforces the first
 *    (see backend/tests/productVariants.test.js); this proves the storefront
 *    does not let a shopper reach the failure in the first place.
 *
 * Serial by design, like the other specs here: the delivery-status test needs
 * the order the assignment test created.
 */

const ADMIN = { email: 'e2e-admin@example.com', password: 'Karachi-Ledger-72' };
const MANAGER = { email: 'e2e-manager@example.com', password: 'Lahore-Ledger-53' };
const REP = { email: 'e2e-rep@example.com', password: 'Multan-Ledger-64' };

async function signIn(page, creds) {
  await page.goto('/crm/login');
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/crm\/login/);
}

const main = (page) => page.getByRole('main');

test.describe('The internal CRM still works for every staff role', () => {
  test('an admin can view a customer, place an order and assign it to a rep', async ({ page }) => {
    await signIn(page, ADMIN);

    // --- view a customer ---------------------------------------------------
    await page.goto('/crm/customers');
    await page.getByRole('link', { name: /Karachi Traders/i }).click();
    await expect(page.getByRole('heading', { name: /Karachi Traders/i })).toBeVisible();

    // The other half of the gate the rep test checks: an admin, who CAN create
    // orders, still sees the button. A gate that hides it from everybody would
    // satisfy that test and break the product.
    await expect(page.getByRole('link', { name: /^new order$/i })).toBeVisible();

    // --- place an order ----------------------------------------------------
    await page.goto('/crm/orders/new');

    const customerBox = page.getByLabel(/customer/i);
    await customerBox.click();
    await customerBox.fill('Karachi');
    await page.getByRole('option', { name: /Karachi Traders/i }).click();

    // The product picker is addressed by its placeholder, matching
    // order-flow.spec.js — its label is the line number, not "Product".
    const productBox = page.getByPlaceholder(/search products/i);
    await productBox.click();
    await productBox.fill('Widget');
    await page.getByRole('option', { name: /Blue Widget/i }).click();

    await page.getByRole('button', { name: /create order/i }).click();

    await expect(page).toHaveURL(/\/crm\/orders\/[a-f0-9]{24}/);

    // --- assign it ---------------------------------------------------------
    await page.getByRole('button', { name: /reassign/i }).click();
    await page.getByPlaceholder(/search colleagues/i).fill('Sara');
    await page.getByRole('option', { name: /Sara Iqbal/i }).click();

    await expect(page.getByText(/order reassigned/i)).toBeVisible();
    await expect(main(page).getByText('Sara Iqbal')).toBeVisible();
  });

  /**
   * The delivery panel, driven by an admin. The estimate requirement is the
   * interesting part: the server refuses `shipped` without a date, and the form
   * has to say so before the request rather than after it.
   */
  test('an admin can move an order through delivery, with the promised date already set', async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    await page.goto('/crm/orders');
    await page.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first().click();

    await page.getByRole('button', { name: /update delivery/i }).click();

    /*
     * THE DATE IS ALREADY THERE, and this assertion replaces one that expected
     * the opposite.
     *
     * This test used to ship without a date, assert the refusal, then click
     * "use the usual 5 days". That refusal is now unreachable through the
     * normal flow: an order gets its promised date at CREATION, computed from
     * the delivery speed the buyer chose, because a shopper picking next-day is
     * picking a date and picks it before they pay. Leaving the field blank
     * until a staff member typed one meant the confirmation page could only say
     * "we will let you know".
     *
     * The guard itself is still enforced and still tested — at the API level in
     * tests/fulfilment.test.js, where the estimate is cleared first to simulate
     * an order written before this change. What is checked here is the
     * behaviour a staff member actually meets.
     */
    await expect(page.getByLabel(/estimated delivery/i)).not.toHaveValue('');

    await page.getByLabel(/delivery status/i).selectOption('shipped');
    await page.getByRole('button', { name: /save delivery status/i }).click();

    await expect(page.getByText(/delivery status updated/i)).toBeVisible();
    await expect(main(page).getByText('Shipped').first()).toBeVisible();
  });

  test('a manager can view a customer and reach the order they need to work', async ({ page }) => {
    await signIn(page, MANAGER);

    await page.goto('/crm/customers');
    await page.getByRole('link', { name: /Karachi Traders/i }).click();
    await expect(page.getByRole('heading', { name: /Karachi Traders/i })).toBeVisible();

    await page.goto('/crm/orders');
    await expect(page.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first()).toBeVisible();
  });

  /**
   * The rep is the role a UI change is most likely to break, because their
   * access is scoped by RECORD rather than by role: they see the orders
   * assigned to them and nothing else, and they have no customer book at all.
   */
  test('a sales rep sees only their assigned order, and can update its delivery', async ({
    page,
  }) => {
    await signIn(page, REP);

    // No customer book — the nav section is absent rather than 403ing, which is
    // the documented choice (a missing section reads as "not my job").
    await expect(page.getByRole('link', { name: /^customers$/i })).toHaveCount(0);

    await page.goto('/crm/orders');

    /*
     * ...and no "New order" button either, which it used to show.
     *
     * A rep cannot create an order — that is a commercial commitment, and their
     * job is to fulfil orders rather than agree them — but the button was
     * rendered for every role regardless of `writeOrders`. So the single
     * primary action on a rep's main screen was one the API would refuse, after
     * they had filled the whole form in. Same reasoning as the missing
     * Customers nav item above: absence reads as "not my job", a dead button
     * reads as a broken app.
     */
    await expect(page.getByRole('link', { name: /^new order$/i })).toHaveCount(0);

    const orderLink = page.getByRole('link').filter({ hasText: /^ORD-|^#/ }).first();
    await expect(orderLink).toBeVisible();
    await orderLink.click();

    // They may move the parcel along — they are the person who knows it moved.
    await page.getByRole('button', { name: /update delivery/i }).click();
    await page.getByLabel(/delivery status/i).selectOption('out_for_delivery');
    await page.getByRole('button', { name: /save delivery status/i }).click();

    await expect(page.getByText(/delivery status updated/i)).toBeVisible();
    await expect(main(page).getByText('Out for delivery').first()).toBeVisible();

    // ...but they may not reassign it. That is a staffing decision.
    await expect(page.getByRole('button', { name: /^reassign$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /request transfer/i })).toBeVisible();
  });
});

test.describe('Buying a product that comes in colours', () => {
  test('the card shows swatches and the detail page insists on a choice', async ({ page }) => {
    await page.goto('/products');

    const card = page.getByRole('link', { name: /Trail Jacket/i });
    await expect(card).toBeVisible();
    await card.click();

    await expect(page.getByRole('heading', { name: 'Trail Jacket' })).toBeVisible();

    /*
     * The whole point: Add to cart is DISABLED until a colour is chosen, and
     * the page says why. A shopper must not be able to reach the server's
     * refusal, which is where a variant-less order would otherwise be caught.
     */
    await expect(page.getByRole('button', { name: /add to cart/i })).toBeDisabled();
    await expect(page.getByText(/choose a colour to continue/i)).toBeVisible();

    // Sand is seeded with zero stock, so its swatch is offered and disabled —
    // "not available right now" and "we don't make it" are different facts.
    await expect(
      page.getByRole('button', { name: /Sand \(out of stock\)/i })
    ).toBeDisabled();

    await page.getByRole('button', { name: /^Midnight$/ }).click();
    await expect(page.getByRole('button', { name: /add to cart/i })).toBeEnabled();

    await page.getByRole('button', { name: /add to cart/i }).click();
    await expect(page.getByLabel('Cart, 1 item')).toBeVisible();

    // The chosen colour travels with the line and is shown in the drawer —
    // otherwise two colours of one jacket are indistinguishable in a cart.
    await page.getByLabel(/cart, 1 item/i).click();
    const drawer = page.getByRole('dialog', { name: /shopping cart/i });
    await expect(drawer.getByText('Midnight / M')).toBeVisible();
  });

  test('a product with no variants is unaffected and adds straight to the cart', async ({
    page,
  }) => {
    await page.goto('/products');
    await page.getByRole('link', { name: /Blue Widget/i }).click();

    // No picker, no gate — exactly as before variants existed. This is the
    // shape every product in a real deployment is already in.
    await expect(page.getByText(/choose a colour to continue/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /add to cart/i })).toBeEnabled();

    await page.getByRole('button', { name: /add to cart/i }).click();
    await expect(page.getByLabel('Cart, 1 item')).toBeVisible();
  });

  test('the catalogue filters by colour', async ({ page }) => {
    await page.goto('/products');

    await page.getByRole('button', { name: /^Midnight$/ }).click();

    await expect(page.getByRole('link', { name: /Trail Jacket/i })).toBeVisible();
    // The widget has no colours at all, so a colour filter must exclude it.
    await expect(page.getByRole('link', { name: /Blue Widget/i })).toHaveCount(0);
  });
});
