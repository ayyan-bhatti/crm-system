const { api, createAdmin, createCustomer, createBuyer } = require('./helpers');
const Customer = require('../src/models/Customer');
const Buyer = require('../src/models/Buyer');
const Order = require('../src/models/Order');
const contactService = require('../src/services/contactService');
const { setConsentEverywhere } = require('../src/services/unsubscribeService');
const { createProduct } = require('./helpers');

/**
 * Merging two records into one person.
 *
 * WHY THIS IS THE RISKIEST PART OF THE CONTACTS SCREEN
 *
 * A duplicate here is not a cosmetic problem: it is somebody receiving the same
 * marketing email twice, from a list that looks correct. And the failure is
 * asymmetric — merging too little sends twice, merging too much sends somebody
 * else's mail to the wrong address. Both are worth a test each.
 */

/** A completed order, so a contact has metrics and therefore segments. */
async function orderFor(admin, customer, { daysAgo = 0, total = 50 } = {}) {
  const product = await createProduct({ price: total, stockQty: 500 });

  const res = await api()
    .post('/api/orders')
    .set(admin.headers)
    .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });

  const when = new Date();
  when.setDate(when.getDate() - daysAgo);

  await Order.updateOne(
    { _id: res.body.data._id },
    { status: 'completed', completedAt: when, createdAt: when }
  );

  return res.body.data._id;
}

describe('merging contacts', () => {
  it('shows one row for a person who is both a CRM customer and a storefront buyer', async () => {
    const admin = await createAdmin();
    const email = 'both@example.com';

    await createCustomer(admin, { email, name: 'From The CRM' });
    await createBuyer({ email, name: 'From The Shop' });

    const contacts = await contactService.listContacts(admin.user, {});
    const matching = contacts.filter((c) => c.email === email);

    expect(matching).toHaveLength(1);
    expect(matching[0].source).toBe('both');
    expect(matching[0].customerId).toBeTruthy();
    expect(matching[0].buyerId).toBeTruthy();
  });

  /**
   * The merge is on EMAIL, not on `linkedCustomerId`.
   *
   * `linkedCustomerId` is set at a buyer's FIRST CHECKOUT, so a buyer who
   * registered and never ordered has none — and that person is exactly who a
   * welcome campaign is for. Merging on the link alone would show them as a
   * separate contact from their own CRM record the moment a rep created one.
   */
  it('merges a buyer who has never ordered and therefore has no linked customer', async () => {
    const admin = await createAdmin();
    const email = 'browsing@example.com';

    await createCustomer(admin, { email });
    const buyer = await createBuyer({ email });

    expect(buyer.linkedCustomerId).toBeNull();

    const contacts = await contactService.listContacts(admin.user, {});
    expect(contacts.filter((c) => c.email === email)).toHaveLength(1);
  });

  it('keeps two different people apart', async () => {
    const admin = await createAdmin();

    await createCustomer(admin, { email: 'ayesha@example.com' });
    await createBuyer({ email: 'bilal@example.com' });

    const contacts = await contactService.listContacts(admin.user, {});
    const emails = contacts.map((c) => c.email);

    expect(emails).toContain('ayesha@example.com');
    expect(emails).toContain('bilal@example.com');
  });

  it('matches regardless of the case the address was typed in', async () => {
    const admin = await createAdmin();

    await createCustomer(admin, { email: 'Mixed.Case@Example.com' });
    await createBuyer({ email: 'mixed.case@example.com' });

    const contacts = await contactService.listContacts(admin.user, {});
    expect(contacts.filter((c) => c.email === 'mixed.case@example.com')).toHaveLength(1);
  });

  /**
   * Two `Customer` records CAN share an email — nothing in the schema forbids
   * it, and duplicates predate the upsert that now prevents them. Whichever is
   * chosen, there must be ONE row.
   */
  it('collapses two customer records that share an address into one contact', async () => {
    const admin = await createAdmin();

    await createCustomer(admin, { email: 'dupe@example.com', name: 'First' });
    await Customer.create({
      name: 'Second',
      email: 'dupe@example.com',
      createdBy: admin.user._id,
    });

    const contacts = await contactService.listContacts(admin.user, {});
    expect(contacts.filter((c) => c.email === 'dupe@example.com')).toHaveLength(1);
  });
});

describe('where a contact came from', () => {
  it('calls a staff-created customer a CRM contact', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'typed-in@example.com' });

    const contact = await contactService.findContactByEmail('typed-in@example.com');
    expect(contact.source).toBe('crm');
  });

  it('calls a buyer with no CRM record a storefront contact', async () => {
    await createBuyer({ email: 'shop-only@example.com' });

    const contact = await contactService.findContactByEmail('shop-only@example.com');
    expect(contact.source).toBe('storefront');
  });

  /**
   * A `Customer` with no `createdBy` was not entered by staff — it was
   * upserted by `matchOrCreateCustomer` from a storefront checkout. With no
   * `Buyer` for that address either, the person never had an account: a guest.
   *
   * No new ones are created (checkout now requires an account), but the ones
   * that exist are real people who still have to be filterable and,
   * particularly, EXCLUDABLE.
   */
  it('calls a checkout-created customer with no account a guest', async () => {
    await Customer.create({ name: 'Walk In', email: 'guest@example.com', createdBy: null });

    const contact = await contactService.findContactByEmail('guest@example.com');
    expect(contact.source).toBe('guest');
  });
});

describe('segments', () => {
  /**
   * A contact with no orders gets NO segment rather than a "dormant" one.
   *
   * There is no pattern to describe, and calling somebody dormant on the
   * strength of never having bought anything is the false positive that
   * teaches people to ignore the column.
   */
  it('gives a contact with no order history no segments at all', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'never@example.com' });

    const contact = await contactService.findContactByEmail('never@example.com');
    expect(contact.segments).toEqual([]);
  });

  it('tags a first-time buyer as new', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'fresh@example.com' });
    await orderFor(admin, customer, { daysAgo: 2 });

    const contact = await contactService.findContactByEmail('fresh@example.com');
    expect(contact.segments).toContain('new');
  });

  it('tags a big spender as high value', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'whale@example.com' });
    await orderFor(admin, customer, { daysAgo: 1, total: 2000 });

    const contact = await contactService.findContactByEmail('whale@example.com');
    expect(contact.segments).toContain('high_value');
  });

  /**
   * The segments are ARITHMETIC, reusing the existing churn rule — so a
   * customer who has missed several of their own cycles is at risk here and on
   * their own summary page, and the two screens cannot disagree.
   */
  it('tags a customer who has missed several of their own cycles as at risk', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'gone@example.com' });

    // Two orders ten days apart establish a cadence; the last was 200 days
    // ago, which is many cycles missed.
    await orderFor(admin, customer, { daysAgo: 210 });
    await orderFor(admin, customer, { daysAgo: 200 });

    const contact = await contactService.findContactByEmail('gone@example.com');
    expect(contact.segments).toContain('at_risk');
  });
});

describe('filtering the contact list', () => {
  it('filters by opt-in state for one channel', async () => {
    const admin = await createAdmin();

    await createCustomer(admin, { email: 'yes@example.com' });
    await createCustomer(admin, { email: 'no@example.com' });
    await setConsentEverywhere('yes@example.com', { email: true });

    const optedIn = await contactService.listContacts(admin.user, {
      channel: 'email',
      optedIn: 'yes',
    });

    expect(optedIn.map((c) => c.email)).toContain('yes@example.com');
    expect(optedIn.map((c) => c.email)).not.toContain('no@example.com');
  });

  /**
   * `both` is a real value a contact can have, so filtering for `crm` has to
   * decide whether a CRM-and-storefront contact counts. It does — they ARE a
   * CRM contact, plus something else. Anything stricter would make the three
   * source filters fail to add up to the whole list, which is arithmetic a
   * user notices and cannot explain.
   */
  it('includes a dual-source contact under either of its sources', async () => {
    const admin = await createAdmin();
    const email = 'dual@example.com';

    await createCustomer(admin, { email });
    await createBuyer({ email });

    const asCrm = await contactService.listContacts(admin.user, { source: 'crm' });
    const asShop = await contactService.listContacts(admin.user, { source: 'storefront' });

    expect(asCrm.map((c) => c.email)).toContain(email);
    expect(asShop.map((c) => c.email)).toContain(email);
  });

  it('filters by a hand-assigned tag', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'vip@example.com' });
    await Customer.updateOne({ _id: customer._id }, { marketingTags: ['VIP'] });
    await createCustomer(admin, { email: 'ordinary@example.com' });

    const tagged = await contactService.listContacts(admin.user, { tag: 'vip' });

    expect(tagged.map((c) => c.email)).toEqual(['vip@example.com']);
  });

  it('rejects a segment it does not recognise rather than ignoring it', async () => {
    const admin = await createAdmin();

    const res = await api().get('/api/contacts?segment=made_up').set(admin.headers);

    expect(res.status).toBe(400);
  });

  /**
   * The opt-in filter is TWO parameters that only mean something together.
   * Half of it must be refused rather than silently dropped — a filter that
   * appears to apply and does not is worse than one that errors.
   */
  it('refuses an opt-in filter with no channel', async () => {
    const admin = await createAdmin();

    const res = await api().get('/api/contacts?optedIn=yes').set(admin.headers);

    expect(res.status).toBe(400);
  });
});

describe('consent when the two records disagree', () => {
  /**
   * Every write path propagates to both records, so this state is only
   * reachable for data predating this round or edited directly in the
   * database. The reconciliation is THE MOST RECENT DECISION WINS.
   */
  it('takes the more recent decision when one record says yes and the other no', async () => {
    const admin = await createAdmin();
    const email = 'split@example.com';

    const customer = await createCustomer(admin, { email });
    const buyer = await createBuyer({ email });

    const older = new Date('2024-01-01');
    const newer = new Date('2025-01-01');

    // The CRM record says they agreed, a year ago.
    await Customer.updateOne(
      { _id: customer._id },
      { 'marketing.email.optIn': true, 'marketing.email.optInAt': older }
    );
    // The shop record says they withdrew it, more recently.
    await Buyer.updateOne(
      { _id: buyer._id },
      { 'marketing.email.optIn': false, 'marketing.email.optOutAt': newer }
    );

    const contact = await contactService.findContactByEmail(email);

    expect(contact.consent.email.optIn).toBe(false);
  });

  /**
   * And the other way round, which is the case a naive "any opt-out wins"
   * implementation would get wrong — permanently silencing anybody who ever
   * unsubscribed and later deliberately opted back in.
   */
  it('honours a later opt-in over an earlier opt-out', async () => {
    const admin = await createAdmin();
    const email = 'returned@example.com';

    const customer = await createCustomer(admin, { email });
    const buyer = await createBuyer({ email });

    await Customer.updateOne(
      { _id: customer._id },
      { 'marketing.email.optIn': false, 'marketing.email.optOutAt': new Date('2024-01-01') }
    );
    await Buyer.updateOne(
      { _id: buyer._id },
      { 'marketing.email.optIn': true, 'marketing.email.optInAt': new Date('2025-06-01') }
    );

    const contact = await contactService.findContactByEmail(email);
    expect(contact.consent.email.optIn).toBe(true);
  });
});
