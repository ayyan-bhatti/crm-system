const request = require('supertest');
const app = require('../src/app');
const {
  api,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createBuyer,
} = require('./helpers');

const SHOP_CSRF_COOKIE = 'shop_csrf';
const SHOP_CSRF_HEADER = 'x-csrf-token';

function cookieValue(res, name) {
  const raw = res.headers['set-cookie']?.find((c) => c.startsWith(`${name}=`));
  return raw ? decodeURIComponent(raw.split(';')[0].split('=')[1]) : '';
}

/** A signed-in buyer with a saved address, ready to check out. Mirrors the
 * identical helper in shopStorefront.test.js. */
async function buyerAgent(overrides = {}) {
  const agent = request.agent(app);
  const res = await agent.post('/api/shop/auth/register').send({
    name: 'Checkout Buyer',
    email: 'checkout-buyer@example.com',
    password: 'Faisalabad-Kettle-41',
    ...overrides,
  });

  const csrf = cookieValue(res, SHOP_CSRF_COOKIE);
  const write = (method, url) => agent[method](url).set(SHOP_CSRF_HEADER, csrf);

  const address = await write('post', '/api/shop/auth/addresses').send({
    label: 'Home',
    address: '12 Canal Road',
    city: 'Lahore',
    phone: '0300-1234567',
  });

  const addresses = address.body.data?.addresses || [];
  const addressId = addresses.length ? String(addresses[addresses.length - 1]._id) : null;

  return { write, addressId };
}
const Customer = require('../src/models/Customer');
const Buyer = require('../src/models/Buyer');
const OutboundMessage = require('../src/models/OutboundMessage');
const Campaign = require('../src/models/Campaign');
const messagingService = require('../src/services/messagingService');
const contactService = require('../src/services/contactService');
const campaignService = require('../src/services/campaignService');
const {
  signToken,
  unsubscribe,
  setConsentEverywhere,
} = require('../src/services/unsubscribeService');

/**
 * THE RULE THIS ROUND IS BUILT AROUND.
 *
 * Nobody is messaged on a channel they have not opted in to. Everything else
 * in the marketing layer is a convenience; this is the part that is a legal
 * obligation, and the part whose failure is discovered from the recipient.
 *
 * These tests attack it from every direction a message can leave the system:
 * a bulk campaign, a staff member's individual send, and the two scheduled
 * automations (the last of those in postSaleAutomation.test.js). All four go
 * through `messagingService.sendToContact`, which is the point — one gate
 * means one thing to prove rather than four things to remember.
 */

/** A contact with no consent anywhere: the default state of every record. */
async function optedOutContact(owner) {
  const customer = await createCustomer(owner, { email: 'quiet@example.com' });
  return { customer, contact: await contactService.findContactByEmail(customer.email) };
}

/** The same, having agreed to one channel. */
async function optedInContact(owner, channels = { email: true }) {
  const customer = await createCustomer(owner, { email: 'keen@example.com' });
  await setConsentEverywhere(customer.email, channels);
  return { customer, contact: await contactService.findContactByEmail(customer.email) };
}

describe('consent is required before anything is sent', () => {
  it('refuses to send to a contact who has not opted in, and records why', async () => {
    const admin = await createAdmin();
    const { contact } = await optedOutContact(admin);

    const outcome = await messagingService.sendToContact({
      contact,
      channel: 'email',
      kind: 'direct',
      subject: 'Hello',
      body: 'Anyone there?',
    });

    expect(outcome.status).toBe('skipped_no_consent');

    /*
     * THE ROW IS AS IMPORTANT AS THE REFUSAL. A contact who was considered and
     * skipped has to leave evidence — filtered out silently, a campaign
     * reports "sent to 40" of 60 and nobody can tell whether the other twenty
     * were unconsented, unreachable, or a bug in the query.
     */
    const logged = await OutboundMessage.findOne({ toAddress: contact.email });
    expect(logged.status).toBe('skipped_no_consent');
    expect(logged.error).toMatch(/no email opt-in/i);
  });

  it('sends once the contact has opted in to that exact channel', async () => {
    const admin = await createAdmin();
    const { contact } = await optedInContact(admin, { email: true });

    const outcome = await messagingService.sendToContact({
      contact,
      channel: 'email',
      kind: 'direct',
      subject: 'Hello',
      body: 'Good to hear from you',
    });

    expect(outcome.status).toBe('sent');
  });

  /**
   * THE POINT OF PER-CHANNEL CONSENT, stated as a test.
   *
   * Somebody who agreed to email has not thereby agreed to a WhatsApp message
   * on a Sunday evening. A single `marketingOptIn` boolean would pass every
   * other test in this file and fail this one.
   */
  it('does not let consent for one channel authorise another', async () => {
    const admin = await createAdmin();
    const { contact } = await optedInContact(admin, { email: true });

    const bySms = await messagingService.sendToContact({
      contact,
      channel: 'sms',
      kind: 'direct',
      body: 'A text you did not ask for',
    });

    expect(bySms.status).toBe('skipped_no_consent');
  });

  it('blocks an individual send through the API, without failing the request', async () => {
    const admin = await createAdmin();
    const { customer } = await optedOutContact(admin);

    const res = await api()
      .post(`/api/contacts/${encodeURIComponent(customer.email)}/message`)
      .set(admin.headers)
      .send({ channel: 'email', subject: 'Hi', body: 'Hello there' });

    /*
     * 200, NOT 4xx, and deliberately. The request was well formed and the
     * caller was allowed to make it; the answer is that this person has not
     * agreed. An error status would make a legitimate consent outcome
     * indistinguishable from a permissions bug in the client's error handling.
     */
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.data.status).toBe('skipped_no_consent');
  });

  /**
   * The campaign path, which is where the volume is.
   *
   * Two contacts, one consented. The campaign must reach exactly one of them
   * and must SAY that it skipped the other.
   */
  it('filters a campaign down to the contacts who agreed, and counts the rest', async () => {
    const admin = await createAdmin();
    await optedInContact(admin, { email: true });
    await optedOutContact(admin);

    const campaign = await Campaign.create({
      name: 'Spring news',
      channel: 'email',
      audience: { preset: 'all' },
      content: { subject: 'Hello {{name}}', body: 'Something new is in.' },
      createdBy: admin.user._id,
    });

    const sent = await campaignService.dispatch(campaign, admin.user);

    expect(sent.status).toBe('sent');
    expect(sent.sentCount).toBe(1);
    expect(sent.skippedNoConsentCount).toBe(1);

    // The counters are a cache of the rows; they must agree with them.
    expect(sent.audienceCount).toBe(sent.sentCount + sent.skippedNoConsentCount);

    const rows = await OutboundMessage.find({ campaign: campaign._id });
    expect(rows).toHaveLength(2);
  });

  /**
   * AN APPROVAL IS NOT A CONSENT.
   *
   * An admin agreeing that a campaign should go out is agreeing it should go
   * to the people who agreed to receive it. Nothing in the approval path may
   * widen that — this is the test that would fail if somebody ever "helpfully"
   * made an approved campaign bypass the gate.
   */
  it('does not let an administrator override a contact who opted out', async () => {
    const admin = await createAdmin();
    const { contact } = await optedOutContact(admin);

    const outcome = await messagingService.sendToContact({
      contact,
      channel: 'email',
      kind: 'campaign',
      subject: 'Approved by an admin',
      body: 'Still not going anywhere',
      actorId: admin.user._id,
    });

    expect(outcome.status).toBe('skipped_no_consent');
  });
});

describe('recording consent', () => {
  it('defaults every channel to off on a customer created through the API', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/customers')
      .set(admin.headers)
      .send({ name: 'No Boxes Ticked', email: 'default@example.com' });

    expect(res.status).toBe(201);

    const customer = await Customer.findById(res.body.data._id);
    expect(customer.marketing.email.optIn).toBe(false);
    expect(customer.marketing.sms.optIn).toBe(false);
    expect(customer.marketing.whatsapp.optIn).toBe(false);
  });

  it('records the consent a creation form actually ticked, with a timestamp', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/customers')
      .set(admin.headers)
      .send({
        name: 'Agreed To Email',
        email: 'agreed@example.com',
        emailOptIn: true,
        smsOptIn: false,
      });

    const customer = await Customer.findById(res.body.data._id);

    expect(customer.marketing.email.optIn).toBe(true);
    expect(customer.marketing.email.optInAt).toBeTruthy();
    expect(customer.marketing.sms.optIn).toBe(false);
  });

  /**
   * ONLY A LITERAL `true` COUNTS.
   *
   * A checkbox that arrives as the string "false" is truthy in JavaScript, and
   * that single coercion would opt in everybody who left the box alone on a
   * form that posts its default. This is the one place worth being pedantic
   * about types, so it is pinned.
   */
  it('does not read the string "false" as consent', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/customers')
      .set(admin.headers)
      .send({ name: 'Stringly Typed', email: 'string@example.com', emailOptIn: 'false' });

    const customer = await Customer.findById(res.body.data._id);
    expect(customer.marketing.email.optIn).toBe(false);
  });

  /**
   * The other of the two places consent is collected on the storefront —
   * checkout itself, for a buyer who registered before these boxes existed.
   * See the long note in shopCheckoutController.js on why checkout is the
   * closest thing this app has to "guest checkout" now that an account is
   * mandatory before buying.
   */
  it('accepts consent at checkout, without blocking the order if it fails', async () => {
    const { createProduct } = require('./helpers');
    const product = await createProduct({ price: 15, stockQty: 10 });
    const { write, addressId } = await buyerAgent();

    const res = await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'cod',
      addressId,
      emailOptIn: true,
    });

    expect(res.status).toBe(201);

    const contact = await contactService.findContactByEmail('checkout-buyer@example.com');
    expect(contact.consent.email.optIn).toBe(true);
  });

  /** An untouched checkbox must not silently withdraw a consent given elsewhere. */
  it('does not withdraw consent the checkout form never showed a box for', async () => {
    const { createProduct } = require('./helpers');
    const product = await createProduct({ price: 15, stockQty: 10 });
    const { write, addressId } = await buyerAgent({ email: 'wa-consented@example.com' });

    await setConsentEverywhere('wa-consented@example.com', { whatsapp: true });

    await write('post', '/api/shop/checkout').send({
      items: [{ product: product._id, quantity: 1 }],
      paymentMethod: 'cod',
      addressId,
      emailOptIn: true,
      // No whatsappOptIn field at all — as if the form never rendered one.
    });

    const contact = await contactService.findContactByEmail('wa-consented@example.com');
    expect(contact.consent.whatsapp.optIn).toBe(true);
  });

  it('accepts consent at storefront registration', async () => {
    const res = await api()
      .post('/api/shop/auth/register')
      .send({
        name: 'Keen Shopper',
        email: 'shopper@example.com',
        password: 'Islamabad-Harbour-91',
        emailOptIn: true,
      });

    expect(res.status).toBe(201);

    const buyer = await Buyer.findOne({ email: 'shopper@example.com' });
    expect(buyer.marketing.email.optIn).toBe(true);
  });

  /**
   * Re-saving a form with a box already ticked must NOT move the date.
   *
   * `optInAt` answers "when did they agree", and that is the one field whose
   * whole value is that it does not move. Refreshing it on every save would
   * quietly replace the date consent was given with the date the record was
   * last edited — leaving no evidence at all of when the relationship started.
   */
  it('does not push the opt-in date forward when nothing changed', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'stable@example.com' });

    await setConsentEverywhere(customer.email, { email: true });
    const first = (await Customer.findById(customer._id)).marketing.email.optInAt;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await setConsentEverywhere(customer.email, { email: true });

    const second = (await Customer.findById(customer._id)).marketing.email.optInAt;
    expect(second.getTime()).toBe(first.getTime());
  });
});

describe('the unsubscribe link', () => {
  it('genuinely turns the opt-in off', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'leaving@example.com' });
    await setConsentEverywhere(customer.email, { email: true });

    const result = await unsubscribe(signToken(customer.email, 'email'));

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const after = await Customer.findById(customer._id);
    expect(after.marketing.email.optIn).toBe(false);
    expect(after.marketing.email.optOutAt).toBeTruthy();
    // The record of having once agreed survives — see the field's own note.
    expect(after.marketing.email.optInAt).toBeTruthy();
  });

  /**
   * AND IT REACHES BOTH RECORDS FOR ONE PERSON.
   *
   * This is the half a per-record implementation gets wrong. Somebody who is a
   * CRM customer AND a storefront buyer has two documents carrying their
   * consent; turning it off on one leaves the other saying yes, the merged
   * contact still resolves as consented, and the next campaign reaches them —
   * so the unsubscribe appears to work and does nothing.
   */
  it('reaches every record belonging to that person, not just one', async () => {
    const admin = await createAdmin();
    const email = 'twice@example.com';

    const customer = await createCustomer(admin, { email });
    const buyer = await createBuyer({ email });
    await setConsentEverywhere(email, { email: true });

    await unsubscribe(signToken(email, 'email'));

    expect((await Customer.findById(customer._id)).marketing.email.optIn).toBe(false);
    expect((await Buyer.findById(buyer._id)).marketing.email.optIn).toBe(false);

    // And the merged view — what a campaign actually reads — agrees.
    const contact = await contactService.findContactByEmail(email);
    expect(contact.consent.email.optIn).toBe(false);
  });

  it('only unsubscribes the channel the link was for', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'partial@example.com' });
    await setConsentEverywhere(customer.email, { email: true, sms: true });

    await unsubscribe(signToken(customer.email, 'email'));

    const after = await Customer.findById(customer._id);
    expect(after.marketing.email.optIn).toBe(false);
    // They deliberately agreed to texts. Stopping those too would be us
    // deciding on their behalf.
    expect(after.marketing.sms.optIn).toBe(true);
  });

  it('rejects a tampered token without changing anything', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'safe@example.com' });
    await setConsentEverywhere(customer.email, { email: true });

    const token = signToken(customer.email, 'email');
    const tampered = `${token.slice(0, -4)}0000`;

    const result = await unsubscribe(tampered);

    expect(result.ok).toBe(false);
    expect((await Customer.findById(customer._id)).marketing.email.optIn).toBe(true);
  });

  /**
   * A second click succeeds and changes nothing.
   *
   * Mail clients pre-fetch links and people click them twice. Reporting a
   * failure to somebody who is already unsubscribed would send them looking
   * for a way to unsubscribe.
   */
  it('is idempotent', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'again@example.com' });
    await setConsentEverywhere(customer.email, { email: true });

    const token = signToken(customer.email, 'email');
    await unsubscribe(token);
    const second = await unsubscribe(token);

    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
  });

  it('works over HTTP with no session at all', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'public@example.com' });
    await setConsentEverywhere(customer.email, { email: true });

    const res = await api()
      .post('/api/unsubscribe')
      .send({ token: signToken(customer.email, 'email') });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect((await Customer.findById(customer._id)).marketing.email.optIn).toBe(false);
  });

  /**
   * The GET is a READ. Mail clients and security scanners fetch every link in
   * a message before a human sees it, and an unsubscribe that happened on GET
   * would be an unsubscribe nobody asked for.
   */
  it('does not unsubscribe anybody when the link is merely prefetched', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'prefetch@example.com' });
    await setConsentEverywhere(customer.email, { email: true });

    const res = await api().get(
      `/api/unsubscribe/${encodeURIComponent(signToken(customer.email, 'email'))}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect((await Customer.findById(customer._id)).marketing.email.optIn).toBe(true);
  });

  /** Every marketing email carries the link, because nobody has to remember to add it. */
  it('appends an unsubscribe link to every marketing email body', async () => {
    const admin = await createAdmin();
    const { contact } = await optedInContact(admin, { email: true });

    const body = messagingService.withUnsubscribeFooter('Hello there', contact.email);

    expect(body).toContain('/unsubscribe?token=');
    expect(body).toContain('Hello there');
  });
});

describe('who can see which contacts', () => {
  it('shows an administrator everybody', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'one@example.com' });
    await createCustomer(admin, { email: 'two@example.com' });

    const res = await api().get('/api/contacts').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('shows a manager everybody too, matching their customer-book access', async () => {
    const admin = await createAdmin();
    const manager = await createManager();
    await createCustomer(admin, { email: 'somebody@example.com' });

    const res = await api().get('/api/contacts').set(manager.headers);

    expect(res.body.data.map((c) => c.email)).toContain('somebody@example.com');
  });

  /**
   * THE NARROW ONE. A rep has no customer book at all in this system, and this
   * screen must not become one — it is the endpoint most likely to
   * accidentally hand a rep the whole list, exactly as the delivery board was.
   */
  it('shows a sales rep only the customers on orders assigned to them', async () => {
    const admin = await createAdmin();
    const rep = await createRep();

    const mine = await createCustomer(admin, { email: 'mine@example.com' });
    await createCustomer(admin, { email: 'theirs@example.com' });

    const product = await require('./helpers').createProduct({ price: 10, stockQty: 5 });
    const order = await api()
      .post('/api/orders')
      .set(admin.headers)
      .send({ customer: mine._id, items: [{ product: product._id, quantity: 1 }] });

    await require('../src/models/Order').updateOne(
      { _id: order.body.data._id },
      { assignedTo: rep.user._id }
    );

    const res = await api().get('/api/contacts').set(rep.headers);
    const emails = res.body.data.map((c) => c.email);

    expect(emails).toContain('mine@example.com');
    expect(emails).not.toContain('theirs@example.com');
  });

  it('refuses a rep who asks for a contact by email that is not theirs', async () => {
    const admin = await createAdmin();
    const rep = await createRep();
    const other = await createCustomer(admin, { email: 'notyours@example.com' });

    const res = await api()
      .get(`/api/contacts/${encodeURIComponent(other.email)}`)
      .set(rep.headers);

    expect(res.status).toBe(403);
  });

  it('is not reachable without a session', async () => {
    expect((await api().get('/api/contacts')).status).toBe(401);
  });
});
