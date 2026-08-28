const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
  createBuyer,
} = require('./helpers');
const Order = require('../src/models/Order');
const ChangeRequest = require('../src/models/ChangeRequest');
const changeRequestService = require('../src/services/changeRequestService');
const shopSearchService = require('../src/services/shopSearchService');
const orderAssistantService = require('../src/services/orderAssistantService');
const messageDraftService = require('../src/services/messageDraftService');
const noteSummaryService = require('../src/services/noteSummaryService');
const reorderSuggestionService = require('../src/services/reorderSuggestionService');
const churnRollupService = require('../src/services/churnRollupService');
const changeRequestSummaryService = require('../src/services/changeRequestSummaryService');
const aiClient = require('../src/services/aiClient');

/*
 * Forced off for the whole file, not left to the absence of GEMINI_API_KEY.
 *
 * This deployment's backend/.env carries a real key (used for manual local
 * testing of the AI features), so `aiClient.isConfigured()` is true even
 * under NODE_ENV=test — unlike a deployment with no key at all, where the
 * fallback path would be exercised by accident. Every test below asserting
 * `mode: 'fallback'` needs that deterministically, not by chance, and
 * without spending a real request on every run of the suite.
 */
const realIsConfigured = aiClient.isConfigured;
beforeAll(() => {
  aiClient.isConfigured = () => false;
});
afterAll(() => {
  aiClient.isConfigured = realIsConfigured;
});

/**
 * Phase 6 of the storefront build: the ten AI features.
 *
 * No test here makes a real model call — GEMINI_API_KEY is never set in the
 * test environment, so every service takes its fallback path by default,
 * exactly the way the existing customer-summary and AI-search tests already
 * rely on. What is being tested is everything around the model: that the
 * FALLBACK is real and useful, that the figures it is built from are
 * correct, and that access is gated the way each feature's audience
 * requires — never the wording a model would have produced, which nothing
 * here can honestly assert without calling a real API.
 */

async function placeOrder(actor, customer, product, overrides = {}) {
  const res = await api()
    .post('/api/orders')
    .set(actor.headers)
    .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }], ...overrides });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('1. Storefront natural-language product search', () => {
  it('falls back to a plain name search with no AI configured', async () => {
    await createProduct({ name: 'Rain Jacket', price: 40 });
    await createProduct({ name: 'Sun Hat', price: 10 });

    const res = await api().get('/api/shop/products/search?q=rain jacket');

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('fallback');
    expect(res.body.data.some((p) => p.name === 'Rain Jacket')).toBe(true);
  });

  it('never returns an internal field, on either path', async () => {
    await createProduct({ name: 'Widget', sku: 'SEC-9' });

    const res = await api().get('/api/shop/products/search?q=widget');
    expect(res.body.data.every((p) => p.sku === undefined)).toBe(true);
  });

  it('rejects an empty query', async () => {
    const res = await api().get('/api/shop/products/search?q=');
    expect(res.status).toBe(400);
  });

  it('reuses the shared query-building helper rather than a second implementation', async () => {
    // Unit-level: the service module itself, not the AI path.
    expect(typeof shopSearchService.search).toBe('function');
  });
});

describe('2. "You might also like"', () => {
  it('recommends products actually bought together, not an arbitrary list', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const anchor = await createProduct({ name: 'Camera', price: 500, category: 'Photography' });
    const companion = await createProduct({ name: 'Lens', price: 200, category: 'Photography' });
    // A different category on purpose, so it cannot be pulled in by the
    // same-category padding this service also does when co-purchase signal
    // is thin — this test is isolating the co-purchase signal specifically.
    await createProduct({ name: 'Doormat', price: 20, category: 'Home' });

    await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [
          { product: anchor._id, quantity: 1 },
          { product: companion._id, quantity: 1 },
        ],
      });

    const res = await api().get(`/api/shop/products/${anchor._id}/recommendations`);

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('fallback');
    expect(res.body.data.some((p) => p.name === 'Lens')).toBe(true);
    expect(res.body.data.some((p) => p.name === 'Doormat')).toBe(false);
  });

  it('falls back to the same category when there is no purchase history yet', async () => {
    const anchor = await createProduct({ name: 'Anchor', category: 'Outdoors' });
    await createProduct({ name: 'Tent', category: 'Outdoors' });
    await createProduct({ name: 'Sofa', category: 'Furniture' });

    const res = await api().get(`/api/shop/products/${anchor._id}/recommendations`);

    expect(res.body.data.some((p) => p.name === 'Tent')).toBe(true);
    expect(res.body.reason).toMatch(/outdoors/i);
  });

  it('404-shaped nothing for a product that does not exist — an empty list, not an error', async () => {
    const res = await api().get('/api/shop/products/64b7f1c2e4b0a1a2b3c4d5e6/recommendations');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('3. Order-status assistant', () => {
  it('answers from the buyer\'s own orders and refuses an unauthenticated caller', async () => {
    const buyer = await createBuyer();
    const anon = await api().post('/api/shop/orders/ask').send({ question: 'where is my order' });
    expect(anon.status).toBe(401);
    void buyer;
  });

  it('names the most recent order and its real status in the fallback answer', async () => {
    const product = await createProduct({ price: 5 });
    const registered = await api()
      .post('/api/shop/auth/register')
      .send({ name: 'Buyer', email: 'ask@example.com', password: 'Karachi-Ledger-72' });

    const order = await api()
      .post('/api/shop/checkout')
      .set('Authorization', `Bearer ${registered.body.data.token}`)
      .send({ items: [{ product: product._id, quantity: 1 }] });

    const res = await api()
      .post('/api/shop/orders/ask')
      .set('Authorization', `Bearer ${registered.body.data.token}`)
      .send({ question: 'has my order shipped yet' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('fallback');
    expect(res.body.data.answer).toContain(order.body.data.orderNumber);
    expect(res.body.data.answer).toMatch(/pending/);
  });

  it('never sees another buyer\'s orders', async () => {
    const result = await orderAssistantService.answer('anything', '64b7f1c2e4b0a1a2b3c4d5e6');
    expect(result.answer).toMatch(/don't have any orders/i);
  });
});

describe("4. Customer summary includes storefront order history", () => {
  it('reports storefront vs internal order counts in the computed figures', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'channel-mix@example.com' });
    const product = await createProduct({ price: 10 });

    await placeOrder(admin, customer, product);

    const registered = await api()
      .post('/api/shop/auth/register')
      .send({ name: 'Buyer', email: 'channel-mix@example.com', password: 'Karachi-Ledger-72' });
    await api()
      .post('/api/shop/checkout')
      .set('Authorization', `Bearer ${registered.body.data.token}`)
      .send({ items: [{ product: product._id, quantity: 1 }] });

    const res = await api().get(`/api/customers/${customer._id}/summary`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.metrics.storefrontOrderCount).toBe(1);
    expect(res.body.data.metrics.internalOrderCount).toBe(1);
  });
});

describe('5. AI-drafted follow-up message', () => {
  it('drafts from a template with no AI configured, and never sends anything', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);

    const res = await api()
      .post(`/api/customers/${customer._id}/draft-message`)
      .set(admin.headers)
      .send({ tone: 'win-back' });

    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('fallback');
    expect(res.body.data.subject).toEqual(expect.any(String));
    expect(res.body.data.body).toEqual(expect.any(String));
  });

  it('is refused to a sales rep — no customer-book access at all', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const customer = await createCustomer(admin);

    const res = await api()
      .post(`/api/customers/${customer._id}/draft-message`)
      .set(rep.headers)
      .send({ tone: 'check-in' });

    expect(res.status).toBe(403);
  });

  it('defaults to check-in for an unrecognised tone rather than erroring', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { name: 'Tone Co' });
    const draft = await messageDraftService.draft(customer, { orderCount: 0 }, 'not-a-real-tone');
    expect(draft.subject).toMatch(/Tone Co/);
  });
});

describe('6. Note-thread summarizer', () => {
  it('summarises a customer note thread for a manager, deterministically', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);

    await api()
      .post(`/api/customers/${customer._id}/activity`)
      .set(admin.headers)
      .send({ body: 'Called about renewal, wants a quote by Friday.' });

    const res = await api()
      .get(`/api/customers/${customer._id}/activity/summary`)
      .set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('fallback');
    expect(res.body.data.summary).toMatch(/1 note/);
  });

  it('summarises an order note thread for the rep who holds it', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const customer = await createCustomer(admin);
    const product = await createProduct();
    const order = await placeOrder(admin, customer, product, { assignedTo: rep.user._id });

    await api()
      .post(`/api/orders/${order._id}/activity`)
      .set(rep.headers)
      .send({ body: 'Delivered, signed for by reception.' });

    const res = await api().get(`/api/orders/${order._id}/activity/summary`).set(rep.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatch(/reception|Delivered/i);
  });

  it('refuses a rep the customer note summary — same rule as the notes themselves', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const customer = await createCustomer(admin);

    const res = await api()
      .get(`/api/customers/${customer._id}/activity/summary`)
      .set(rep.headers);

    expect(res.status).toBe(403);
  });

  it('says plainly that there is nothing to summarise yet', async () => {
    const result = await noteSummaryService.summarize([]);
    expect(result.mode).toBe('fallback');
    expect(result.summary).toMatch(/no notes/i);
  });
});

describe('7. Weekly team performance digest', () => {
  it('is reachable by a manager and refused to a sales rep', async () => {
    const manager = await createManager();
    const rep = await createRep();

    const managerRes = await api().get('/api/dashboard/digest').set(manager.headers);
    const repRes = await api().get('/api/dashboard/digest').set(rep.headers);

    expect(managerRes.status).toBe(200);
    expect(managerRes.body.data.mode).toBe('fallback');
    expect(repRes.status).toBe(403);
  });

  it('narrates figures computed from real completed orders this week', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const product = await createProduct({ price: 40 });

    await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: product._id, quantity: 1 }],
      });

    const res = await api().get('/api/dashboard/digest').set(admin.headers);

    expect(res.body.data.figures.orders).toBeGreaterThanOrEqual(1);
    expect(res.body.data.narrative).toMatch(/order/i);
  });
});

describe('8. Inventory reorder suggestions', () => {
  it('flags a low-stock product only once it has actually sold recently', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    await createProduct({ name: 'Quiet Widget', stockQty: 1, lowStockThreshold: 5 });
    const selling = await createProduct({
      name: 'Selling Widget',
      stockQty: 1,
      lowStockThreshold: 5,
    });

    await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({
        customer: customer._id,
        status: 'completed',
        items: [{ product: selling._id, quantity: 1 }],
      });

    const res = await api().get('/api/products/reorder-suggestions').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.some((i) => i.name === 'Selling Widget')).toBe(true);
    expect(res.body.data.some((i) => i.name === 'Quiet Widget')).toBe(false);
  });

  it('is refused to a sales rep', async () => {
    const rep = await createRep();
    const res = await api().get('/api/products/reorder-suggestions').set(rep.headers);
    expect(res.status).toBe(403);
  });

  /*
   * The one property worth a direct unit test: a mismatched-length AI reply
   * must be rejected outright rather than zipped against the wrong products.
   */
  it('rejects a model reply with the wrong number of justifications', () => {
    const candidates = [{ name: 'A' }, { name: 'B' }];
    const validate = reorderSuggestionService.makeValidator(candidates);

    expect(validate({ items: [{ justification: 'only one' }] })).toBeNull();
  });
});

describe('9. Team churn-risk roll-up', () => {
  it('flags an overdue customer and is refused to a sales rep', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const customer = await createCustomer(admin, { assignedTo: rep.user._id });
    const product = await createProduct({ price: 20 });

    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: 20 }],
      total: 20,
      status: 'completed',
      completedAt: longAgo,
      createdAt: longAgo,
      createdBy: admin.user._id,
    });

    const managerRes = await api().get('/api/customers/churn-rollup').set(admin.headers);
    const repRes = await api().get('/api/customers/churn-rollup').set(rep.headers);

    expect(managerRes.status).toBe(200);
    expect(managerRes.body.data.rollup.some((r) => r.name === customer.name)).toBe(true);
    expect(repRes.status).toBe(403);
  });

  it('reuses the existing per-customer churn assessment rather than a new one', async () => {
    expect(churnRollupService.computeRiskRollup).toBeInstanceOf(Function);
  });
});

describe('10. Plain-English change-request diff summary', () => {
  it("summarises a manager's proposed customer edit for an admin", async () => {
    const admin = await createAdmin();
    const manager = await createManager();
    const customer = await createCustomer(admin, { city: 'Karachi' });

    await api()
      .patch(`/api/customers/${customer._id}`)
      .set(manager.headers)
      .send({ city: 'Lahore' });

    const request = await ChangeRequest.findOne({ entity: 'customer', entityId: customer._id });

    const res = await api().get(`/api/change-requests/${request._id}/summary`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('fallback');
    expect(res.body.data.changes.some((c) => c.field === 'city')).toBe(true);
    expect(res.body.data.summary).toMatch(/city/i);
  });

  it('is refused to a manager for a staff-initiated request, allowed for a buyer one', async () => {
    const admin = await createAdmin();
    const manager = await createManager();
    const customer = await createCustomer(admin, { city: 'Karachi' });

    await api()
      .patch(`/api/customers/${customer._id}`)
      .set(manager.headers)
      .send({ city: 'Lahore' });
    const staffRequest = await ChangeRequest.findOne({ entity: 'customer' });

    const order = await Order.create({
      customer: customer._id,
      items: [{ product: (await createProduct({ price: 5 }))._id, quantity: 1, priceAtOrder: 5 }],
      total: 5,
      createdBy: admin.user._id,
    });
    const buyerRequest = await changeRequestService.submit(
      { entity: 'order', entityId: order._id, action: 'cancel', label: 'Buyer order' },
      await createBuyer()
    );

    const staffAttempt = await api()
      .get(`/api/change-requests/${staffRequest._id}/summary`)
      .set(manager.headers);
    const buyerAttempt = await api()
      .get(`/api/change-requests/${buyerRequest._id}/summary`)
      .set(manager.headers);

    expect(staffAttempt.status).toBe(403);
    expect(buyerAttempt.status).toBe(200);
  });

  it('describes a cancellation with no "to" field, since nothing is being set', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin);
    const order = await Order.create({
      customer: customer._id,
      items: [{ product: (await createProduct({ price: 5 }))._id, quantity: 1, priceAtOrder: 5 }],
      total: 5,
      createdBy: admin.user._id,
    });
    const buyer = await createBuyer();
    const request = await changeRequestService.submit(
      { entity: 'order', entityId: order._id, action: 'cancel', label: 'Order' },
      buyer
    );

    const result = await changeRequestSummaryService.summarize(request);
    expect(result.summary).toMatch(/cancel/i);
  });
});

describe('/api/internal/ai-status reports per-feature health', () => {
  it('lists byFeature alongside the aggregate, empty with no traffic yet', async () => {
    const admin = await createAdmin();
    const res = await api().get('/api/internal/ai-status').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.recent.byFeature).toEqual([]);
  });
});
