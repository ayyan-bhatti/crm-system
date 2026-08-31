const request = require('supertest');
const app = require('../src/app');
const { api, createProduct } = require('./helpers');
const { SHOP_CSRF_COOKIE, SHOP_CSRF_HEADER } = require('../src/middleware/shopCsrf');
const { MAX_ORDER_QTY } = require('../src/config/constants');
const stripeService = require('../src/services/stripeService');

/**
 * Two things the storefront used to get wrong in the same place: how many of a
 * thing you may buy, and whether it can take your money at all.
 *
 * Both were bugs a shopper met at the worst possible moment — after choosing,
 * after filling the form in, at the button — because in both cases the answer
 * lived on the server and the UI guessed at it.
 */

function cookieValue(res, name) {
  const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
}

async function buyerAgent() {
  const agent = request.agent(app);
  const res = await agent.post('/api/shop/auth/register').send({
    name: 'Bilal Ahmed',
    email: 'bilal-limits@example.com',
    password: 'Faisalabad-Kettle-41',
  });

  const csrf = cookieValue(res, SHOP_CSRF_COOKIE);
  const write = (method, url) => agent[method](url).set(SHOP_CSRF_HEADER, csrf);

  const address = await write('post', '/api/shop/auth/addresses').send({
    label: 'Home',
    address: '12 Canal Road',
    city: 'Lahore',
  });

  const addresses = address.body.data?.addresses || [];
  return { agent, write, addressId: String(addresses[addresses.length - 1]._id) };
}

describe('How many the storefront says you can buy', () => {
  /**
   * The catalogue used to publish `inStock` and nothing else, so the quantity
   * control was hard-coded to 1–10 — which offered ten of something we had
   * three of and refused to sell twelve of something we had two hundred of.
   */
  it('publishes a per-product ceiling, capped rather than raw', async () => {
    const plentiful = await createProduct({ name: 'Plentiful', sku: 'CAP-BIG', stockQty: 500 });
    const scarce = await createProduct({ name: 'Scarce', sku: 'CAP-SMALL', stockQty: 3 });

    const [big, small] = await Promise.all([
      api().get(`/api/shop/products/${plentiful._id}`),
      api().get(`/api/shop/products/${scarce._id}`),
    ]);

    // Plenty in stock reports the cap, not the count — "at least 20" is the
    // same non-answer the raw number was being withheld to give.
    expect(big.body.data.maxOrderQty).toBe(MAX_ORDER_QTY);
    // Scarce stock reports the truth, because a ceiling the shopper cannot meet
    // is what produced the error message this replaced.
    expect(small.body.data.maxOrderQty).toBe(3);

    // And the raw count is still never sent, on either.
    expect(big.body.data.stockQty).toBeUndefined();
    expect(small.body.data.stockQty).toBeUndefined();
  });

  it('gives each variant its own ceiling, not the product total', async () => {
    const product = await createProduct({
      sku: 'CAP-VAR',
      variants: [
        { color: { name: 'Midnight', hex: '#111827' }, stockQty: 6 },
        { color: { name: 'Sand', hex: '#d6c7a1' }, stockQty: 2 },
      ],
    });

    const res = await api().get(`/api/shop/products/${product._id}`);
    const byName = Object.fromEntries(
      res.body.data.variants.map((v) => [v.color.name, v.maxOrderQty])
    );

    expect(byName).toEqual({ Midnight: 6, Sand: 2 });
    // The product-level number is the total, which is exactly why the detail
    // page must read the variant's once a colour is chosen.
    expect(res.body.data.maxOrderQty).toBe(8);
  });
});

describe('The per-line ceiling is enforced, not just advertised', () => {
  /**
   * The check has to be on the RESULTING line rather than on the request, or
   * adding one at a time defeats it — which is also how a real shopper reaches
   * a large number.
   */
  it('refuses an add that would push a line over the limit, one at a time', async () => {
    const { write } = await buyerAgent();
    const product = await createProduct({ sku: 'LIM-1', stockQty: 999 });

    const first = await write('post', '/api/shop/cart/items').send({
      product: product._id,
      quantity: MAX_ORDER_QTY,
    });
    expect(first.status).toBe(201);

    const second = await write('post', '/api/shop/cart/items').send({
      product: product._id,
      quantity: 1,
    });

    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/up to 20 of one item/i);
  });

  it('refuses a direct update above the limit', async () => {
    const { write } = await buyerAgent();
    const product = await createProduct({ sku: 'LIM-2', stockQty: 999 });

    await write('post', '/api/shop/cart/items').send({ product: product._id, quantity: 1 });

    const res = await write('patch', `/api/shop/cart/items/${product._id}`).send({
      quantity: MAX_ORDER_QTY + 1,
    });

    expect(res.status).toBe(400);
  });

  /**
   * THE PATH THAT ACTUALLY MATTERS. A guest cart lives in the browser and is
   * posted straight to checkout, so it never meets the cart API's limit at all.
   * Enforcing it only there would leave the gate closed on the route that has a
   * lock and open on the one that does not.
   */
  it('refuses a checkout carrying a quantity that never went through the cart', async () => {
    const { write, addressId } = await buyerAgent();
    const product = await createProduct({ sku: 'LIM-3', stockQty: 999 });

    const res = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 400 }],
      addressId,
      paymentMethod: 'cod',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/up to 20 of one item/i);
  });

  /**
   * The merge CLAMPS where the others refuse, and the difference is deliberate:
   * it runs during login, and a guest cart holding 12 colliding with a server
   * cart holding 15 is the same shopper twice, not a request for 27. Failing
   * their login over that would be the worse answer.
   */
  it('clamps rather than fails when a guest cart is merged in at login', async () => {
    const { write } = await buyerAgent();
    const product = await createProduct({ sku: 'LIM-4', stockQty: 999 });

    await write('post', '/api/shop/cart/items').send({ product: product._id, quantity: 15 });

    const res = await write('post', '/api/shop/cart/merge').send({
      items: [{ product: product._id, quantity: 12 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].quantity).toBe(MAX_ORDER_QTY);
  });
});

describe('GET /api/shop/config', () => {
  /**
   * The endpoint exists because the checkout page used to assert what only the
   * server knows. `config/env.js` claimed the card button was "gated on this
   * rather than shown optimistically" — true of the API, false of the UI, which
   * offered card as the PRE-SELECTED default on a store with no Stripe key and
   * only admitted otherwise after the buyer pressed Pay.
   */
  const original = stripeService.isEnabled;
  afterEach(() => {
    stripeService.isEnabled = original;
  });

  it('is public — the checkout page needs it before anyone signs in', async () => {
    const res = await api().get('/api/shop/config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.paymentMethods)).toBe(true);
  });

  it('reports card as unavailable, with a reason, when Stripe is not configured', async () => {
    stripeService.isEnabled = () => false;

    const res = await api().get('/api/shop/config');
    const card = res.body.data.paymentMethods.find((m) => m.value === 'card');

    expect(card.available).toBe(false);
    // A reason, not just a flag: "we don't take cards" and "we take cards, not
    // right now" need different words on screen.
    expect(card.unavailableReason).toMatch(/not set up/i);
  });

  it('reports card as available when Stripe is configured', async () => {
    stripeService.isEnabled = () => true;

    const res = await api().get('/api/shop/config');
    const card = res.body.data.paymentMethods.find((m) => m.value === 'card');

    expect(card.available).toBe(true);
    expect(card.unavailableReason).toBeNull();
  });

  /**
   * An unavailable method is still LISTED. The client shows it disabled with
   * its reason rather than hiding it, for the same reason a sold-out size is
   * shown struck through — an absence silently asserts "we never do this".
   */
  it('lists cash on delivery and bank transfer as always available', async () => {
    const res = await api().get('/api/shop/config');
    const byValue = Object.fromEntries(
      res.body.data.paymentMethods.map((m) => [m.value, m.available])
    );

    expect(byValue.cod).toBe(true);
    expect(byValue.bank_transfer).toBe(true);
  });
});
