const { api, createAdmin, createCustomer, createProduct, createRep } = require('./helpers');
const Order = require('../src/models/Order');
const OutboundMessage = require('../src/models/OutboundMessage');
const AutomationSettings = require('../src/models/AutomationSettings');
const postSaleService = require('../src/services/postSaleService');
const { setConsentEverywhere } = require('../src/services/unsubscribeService');
const { REVIEW_REQUEST_DELAY_DAYS, POST_SALE_WINDOW_DAYS } = require('../src/config/marketing');

/**
 * The two scheduled post-sale jobs.
 *
 * WHAT THESE ACTUALLY DEFEND IS IDEMPOTENCE. Everything else here is
 * straightforward; the one thing an automation must never do is send the same
 * message to the same person twice, and there are three separate ways that
 * happens if you do not design against each — a job that runs twice, a flag
 * written after the send rather than before it, and a first run that mails the
 * entire order archive. All three are tested below.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A delivered order, `daysAgo` days ago, for a consented customer. */
async function deliveredOrder(admin, { daysAgo, email = 'buyer@example.com', consent = { email: true } }) {
  const customer = await createCustomer(admin, { email });
  if (consent) await setConsentEverywhere(email, consent);

  const product = await createProduct({ price: 25, stockQty: 100, name: 'Kettle' });

  const res = await api()
    .post('/api/orders')
    .set(admin.headers)
    .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

  const when = new Date(Date.now() - daysAgo * DAY_MS);

  await Order.updateOne(
    { _id: res.body.data._id },
    { fulfilment: 'delivered', deliveredAt: when }
  );

  return { orderId: res.body.data._id, customer };
}

describe('the post-delivery review request', () => {
  it('asks the customer how it went, once the delay has passed', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });

    const result = await postSaleService.runReviewRequests();

    expect(result.sent).toBe(1);

    const message = await OutboundMessage.findOne({ kind: 'review_request' });
    expect(message.status).toBe('sent');
    expect(message.channel).toBe('email');
    // The name is substituted before sending — a literal {{name}} in somebody's
    // inbox is the classic broken mail-merge.
    expect(message.preview).not.toContain('{{name}}');
  });

  it('waits until the delay has actually elapsed', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: 1 });

    const result = await postSaleService.runReviewRequests();

    expect(result.considered).toBe(0);
    expect(await OutboundMessage.countDocuments({ kind: 'review_request' })).toBe(0);
  });

  /**
   * THE ARCHIVE GUARD, and it is the failure that would not show up in
   * testing — it shows up on the day the feature meets a real database.
   *
   * Every order ever placed has a null flag, so "delivered more than five days
   * ago and not yet asked" matches years of history the first time this runs.
   * The window is what stops the first run mailing every customer the business
   * has ever had.
   */
  it('never reaches back past the window, however old the order', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: POST_SALE_WINDOW_DAYS + 30 });

    const result = await postSaleService.runReviewRequests();

    expect(result.considered).toBe(0);
    expect(await OutboundMessage.countDocuments({ kind: 'review_request' })).toBe(0);
  });

  /**
   * IDEMPOTENCE. The job is scheduled daily, so it meets the same delivered
   * order every morning for a month. It must send once.
   */
  it('does not send a second time on a later run', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });

    await postSaleService.runReviewRequests();
    const second = await postSaleService.runReviewRequests();

    expect(second.considered).toBe(0);
    expect(await OutboundMessage.countDocuments({ kind: 'review_request' })).toBe(1);
  });

  /**
   * AND NOT WHEN TWO RUNS OVERLAP.
   *
   * A scheduler retries on a timeout it cannot tell from a failure, and a
   * serverless platform may wake two instances in the same minute. Both runs
   * read the flag as null; only one may send. That is what the conditional
   * claim buys, and running the two concurrently is the only way to prove it.
   */
  it('sends once even when two runs overlap', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });

    await Promise.all([
      postSaleService.runReviewRequests(),
      postSaleService.runReviewRequests(),
    ]);

    expect(await OutboundMessage.countDocuments({ kind: 'review_request' })).toBe(1);
  });

  /**
   * CONSENT APPLIES TO AUTOMATIONS TOO.
   *
   * It is tempting to class a review request as transactional — it is about an
   * order they placed, after all — and that reasoning is exactly how a consent
   * regime erodes one reasonable-sounding exception at a time. A message sent
   * because WE would like something from the customer is marketing.
   */
  it('does not message a customer who has not opted in', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1, consent: null });

    const result = await postSaleService.runReviewRequests();

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);

    // Recorded rather than silently dropped, so the log explains the gap.
    const message = await OutboundMessage.findOne({ kind: 'review_request' });
    expect(message.status).toBe('skipped_no_consent');
  });

  it('leaves an undelivered order alone', async () => {
    const admin = await createAdmin();
    const { orderId } = await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });
    await Order.updateOne({ _id: orderId }, { fulfilment: 'shipped' });

    const result = await postSaleService.runReviewRequests();
    expect(result.considered).toBe(0);
  });

  it('respects the configured delay rather than the default', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: 3 });

    // Three days old: nothing at the default of five.
    expect((await postSaleService.runReviewRequests()).considered).toBe(0);

    await AutomationSettings.findOneAndUpdate(
      { key: 'automation' },
      { reviewRequestDelayDays: 2 },
      { upsert: true }
    );

    expect((await postSaleService.runReviewRequests()).sent).toBe(1);
  });

  it('sends nothing at all when the job is switched off', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });

    await AutomationSettings.findOneAndUpdate(
      { key: 'automation' },
      { key: 'automation', reviewRequestEnabled: false },
      { upsert: true, setDefaultsOnInsert: true }
    );

    const result = await postSaleService.runReviewRequests();

    expect(result.disabled).toBe(true);
    expect(await OutboundMessage.countDocuments({ kind: 'review_request' })).toBe(0);
  });

  /**
   * A contact who has agreed to SMS but not email is reached on SMS.
   *
   * Email is preferred when several are available — it is the least intrusive
   * and the only one carrying a working unsubscribe link — but preference is
   * not a requirement.
   */
  it('falls back to a channel the customer did agree to', async () => {
    const admin = await createAdmin();
    const { customer } = await deliveredOrder(admin, {
      daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1,
      consent: { sms: true },
    });

    await require('../src/models/Customer').updateOne(
      { _id: customer._id },
      { phone: '+923001234567' }
    );

    const result = await postSaleService.runReviewRequests();

    expect(result.sent).toBe(1);
    expect((await OutboundMessage.findOne({ kind: 'review_request' })).channel).toBe('sms');
  });
});

describe('the reorder reminder', () => {
  /**
   * Two orders establish a cadence; the nudge fires between 0.8 and 1.2 of the
   * customer's own typical gap.
   */
  async function customerWithCadence(admin, { gapDays, sinceLastOrder, email }) {
    const customer = await createCustomer(admin, { email });
    await setConsentEverywhere(email, { email: true });

    const product = await createProduct({ price: 30, stockQty: 500, name: 'Coffee' });

    for (const daysAgo of [sinceLastOrder + gapDays, sinceLastOrder]) {
      const res = await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

      const when = new Date(Date.now() - daysAgo * DAY_MS);
      await Order.updateOne(
        { _id: res.body.data._id },
        { status: 'completed', completedAt: when, createdAt: when }
      );
    }

    return customer;
  }

  it('nudges a customer who is approaching their usual reorder point', async () => {
    const admin = await createAdmin();
    // Orders every 30 days; 27 days since the last is 0.9 of a cycle.
    await customerWithCadence(admin, {
      gapDays: 30,
      sinceLastOrder: 27,
      email: 'regular@example.com',
    });

    const result = await postSaleService.runReorderReminders();

    expect(result.sent).toBe(1);
    expect((await OutboundMessage.findOne({ kind: 'reorder_reminder' })).status).toBe('sent');
  });

  it('leaves alone somebody who only just ordered', async () => {
    const admin = await createAdmin();
    // 3 of 30 days elapsed — a tenth of a cycle.
    await customerWithCadence(admin, {
      gapDays: 30,
      sinceLastOrder: 3,
      email: 'justbought@example.com',
    });

    expect((await postSaleService.runReorderReminders()).sent).toBe(0);
  });

  /**
   * THE UPPER BOUND IS WHAT KEEPS THIS DISTINCT FROM CHURN RISK.
   *
   * Past 1.2 gaps the customer is LATE rather than due, and that is churn's
   * territory — a conversation a rep has, not a broadcast. A customer must
   * never be both "coming up for a reorder" and "going quiet" in the same
   * week; two automated messages a few days apart saying opposite things is
   * precisely how a CRM announces that nobody is reading it.
   */
  it('leaves alone somebody who is already overdue — that is churn, not a nudge', async () => {
    const admin = await createAdmin();
    // 60 of 30 days: two whole cycles missed.
    await customerWithCadence(admin, {
      gapDays: 30,
      sinceLastOrder: 60,
      email: 'lapsed@example.com',
    });

    expect((await postSaleService.runReorderReminders()).sent).toBe(0);
  });

  /**
   * One order establishes no cadence, and guessing one would mean nudging
   * somebody on a rhythm they have never demonstrated.
   */
  it('says nothing to a customer with only one order', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'once@example.com' });
    await setConsentEverywhere('once@example.com', { email: true });

    const product = await createProduct({ price: 20, stockQty: 50 });
    const res = await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

    const when = new Date(Date.now() - 40 * DAY_MS);
    await Order.updateOne(
      { _id: res.body.data._id },
      { status: 'completed', completedAt: when, createdAt: when }
    );

    expect((await postSaleService.runReorderReminders()).sent).toBe(0);
  });

  it('does not nudge the same customer twice', async () => {
    const admin = await createAdmin();
    await customerWithCadence(admin, {
      gapDays: 30,
      sinceLastOrder: 27,
      email: 'repeat@example.com',
    });

    await postSaleService.runReorderReminders();
    await postSaleService.runReorderReminders();

    expect(await OutboundMessage.countDocuments({ kind: 'reorder_reminder' })).toBe(1);
  });

  it('respects opt-out', async () => {
    const admin = await createAdmin();
    await customerWithCadence(admin, {
      gapDays: 30,
      sinceLastOrder: 27,
      email: 'nothanks@example.com',
    });
    await setConsentEverywhere('nothanks@example.com', { email: false });

    const result = await postSaleService.runReorderReminders();

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe('the scheduler endpoint', () => {
  const SECRET = 'test-cron-secret-value';

  /*
   * `env` is read at module load, so the secret is set on the loaded object
   * rather than through process.env — the same technique the rate-limit tests
   * use to switch their own flag on.
   */
  const env = require('../src/config/env');
  let original;

  beforeEach(() => {
    original = env.cronSecret;
    env.cronSecret = SECRET;
  });

  afterEach(() => {
    env.cronSecret = original;
  });

  it('runs both jobs for a caller with the secret', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });

    const res = await api().post('/api/cron/post-sale').set('x-cron-secret', SECRET);

    expect(res.status).toBe(200);
    expect(res.body.data.reviewRequests.sent).toBe(1);
    expect(res.body.data.reorderReminders).toBeDefined();
  });

  /** Vercel Cron sends the secret as a bearer token and cannot be configured. */
  it('accepts the secret as a bearer token too', async () => {
    const res = await api().get('/api/cron/post-sale').set('Authorization', `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
  });

  it('refuses a caller with the wrong secret', async () => {
    const res = await api().post('/api/cron/post-sale').set('x-cron-secret', 'not-it');
    expect(res.status).toBe(401);
  });

  it('refuses a caller with no secret at all', async () => {
    expect((await api().post('/api/cron/post-sale')).status).toBe(401);
  });

  /**
   * FAILS CLOSED WHEN UNCONFIGURED.
   *
   * An automation endpoint reachable without credentials is a URL anyone can
   * use to make the business send real messages to real people, repeatedly.
   * "Open when unconfigured" would mean a deployment that forgot one variable
   * has an open trigger and nothing to tell it so.
   */
  it('refuses everything when no secret is configured', async () => {
    env.cronSecret = '';

    expect((await api().post('/api/cron/post-sale').set('x-cron-secret', '')).status).toBe(401);
    expect((await api().post('/api/cron/post-sale').set('x-cron-secret', 'guess')).status).toBe(401);
  });

  /** A staff session is not a substitute — this is a machine credential. */
  it('does not accept a signed-in administrator instead of the secret', async () => {
    const admin = await createAdmin();

    expect((await api().post('/api/cron/post-sale').set(admin.headers)).status).toBe(401);
  });
});

describe('the automation log', () => {
  it('shows what the jobs have sent, and when they last ran', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });
    await postSaleService.runReviewRequests();

    const res = await api().get('/api/automation/log').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.lastRuns.review_request).toBeTruthy();
  });

  /**
   * Readable by any staff member, deliberately: a stopped automation has no
   * symptom other than a date that stopped moving, and the more people who can
   * notice that, the shorter the silence.
   */
  it('is readable by a sales rep', async () => {
    const rep = await createRep();
    expect((await api().get('/api/automation/log').set(rep.headers)).status).toBe(200);
  });

  it('lets only an administrator change the settings', async () => {
    const admin = await createAdmin();
    const rep = await createRep();

    expect(
      (await api().patch('/api/automation/settings').set(rep.headers).send({ reviewRequestDelayDays: 7 }))
        .status
    ).toBe(403);

    const ok = await api()
      .patch('/api/automation/settings')
      .set(admin.headers)
      .send({ reviewRequestDelayDays: 7 });

    expect(ok.status).toBe(200);
    expect(ok.body.data.reviewRequestDelayDays).toBe(7);
  });

  it('refuses a delay outside the sensible range', async () => {
    const admin = await createAdmin();

    const res = await api()
      .patch('/api/automation/settings')
      .set(admin.headers)
      .send({ reviewRequestDelayDays: 400 });

    expect(res.status).toBe(400);
  });

  /**
   * The manual trigger is safe to press twice, and that property is the reason
   * it can exist at all — otherwise it would be a button that mails people
   * again.
   */
  it('sends nothing extra when an admin runs the jobs by hand twice', async () => {
    const admin = await createAdmin();
    await deliveredOrder(admin, { daysAgo: REVIEW_REQUEST_DELAY_DAYS + 1 });

    await api().post('/api/automation/run').set(admin.headers);
    await api().post('/api/automation/run').set(admin.headers);

    expect(await OutboundMessage.countDocuments({ kind: 'review_request' })).toBe(1);
  });
});
