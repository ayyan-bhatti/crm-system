const { api, createAdmin, createManager, createRep, createCustomer } = require('./helpers');
const Campaign = require('../src/models/Campaign');
const ChangeRequest = require('../src/models/ChangeRequest');
const OutboundMessage = require('../src/models/OutboundMessage');
const { setConsentEverywhere } = require('../src/services/unsubscribeService');

/**
 * WHO MAY SEND A CAMPAIGN, AND WHO HAS TO ASK FIRST.
 *
 * The rule: an admin's campaign sends immediately; a manager's sends
 * immediately if every recipient is inside their own scope, and otherwise
 * queues for an admin through the SAME change-request model that already
 * carries customer and order edits.
 *
 * "Their own scope" needed defining, because THIS CODEBASE HAS NO TEAM MODEL —
 * no `managerId` on `User`, no reporting line. Managers see every record and
 * own none of them, by design from earlier rounds. So it is read as the
 * contacts they are personally connected to: assigned to them, or created by
 * them. That keeps the rule's intent (act freely in your own patch, ask to
 * reach beyond it) without inventing an org chart nothing else maintains.
 *
 * WHY THE CHECK HAPPENS AT SEND TIME. An audience is a filter, not a list:
 * "at-risk customers" is a different set of people this morning from last
 * Tuesday. Deciding at draft time would let a campaign approved when it matched
 * forty of the manager's own contacts go out a week later to four hundred
 * strangers, having passed the check honestly.
 */

/** A campaign draft owned by `actor`. */
async function draftFor(actor, audience = { preset: 'all' }) {
  return Campaign.create({
    name: 'Test campaign',
    goal: 'Say hello',
    channel: 'email',
    audience,
    content: { subject: 'Hello {{name}}', body: 'Just checking in.' },
    createdBy: actor.user._id,
  });
}

/** A consented contact, so it is consent that never explains a skip here. */
async function reachableCustomer(owner, email, overrides = {}) {
  const customer = await createCustomer(owner, { email, ...overrides });
  await setConsentEverywhere(email, { email: true });
  return customer;
}

describe('who may launch a campaign', () => {
  it('lets an administrator send immediately', async () => {
    const admin = await createAdmin();
    await reachableCustomer(admin, 'reader@example.com');

    const campaign = await draftFor(admin);

    const res = await api().post(`/api/campaigns/${campaign._id}/send`).set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(res.body.data.status).toBe('sent');
    expect(res.body.data.sentCount).toBe(1);
  });

  /**
   * A manager sending only to their OWN contacts does not need permission.
   * Otherwise "manager" would be a job title with no authority attached, and
   * the approval queue would fill with routine work until nobody read it.
   */
  it('lets a manager send to their own contacts without asking', async () => {
    const manager = await createManager();
    await reachableCustomer(manager, 'mine@example.com');

    const campaign = await draftFor(manager, { preset: 'mine' });

    const res = await api().post(`/api/campaigns/${campaign._id}/send`).set(manager.headers);

    expect(res.body.queued).toBe(false);
    expect(res.body.data.status).toBe('sent');
  });

  /**
   * THE CENTRAL CASE. A manager reaching past their own contacts queues, and
   * NOTHING IS SENT while it waits.
   */
  it('queues a manager campaign that reaches beyond their own contacts', async () => {
    const admin = await createAdmin();
    const manager = await createManager();

    await reachableCustomer(manager, 'mine@example.com');
    await reachableCustomer(admin, 'somebody-elses@example.com');

    const campaign = await draftFor(manager, { preset: 'all' });

    const res = await api().post(`/api/campaigns/${campaign._id}/send`).set(manager.headers);

    expect(res.body.queued).toBe(true);
    expect(res.body.outsideScope).toBeGreaterThan(0);

    const stored = await Campaign.findById(campaign._id);
    expect(stored.status).toBe('pending_approval');
    expect(stored.sentCount).toBe(0);

    // Nothing left the building.
    expect(await OutboundMessage.countDocuments({ campaign: campaign._id })).toBe(0);

    // And it is in the SAME queue as customer and order edits, not a second one.
    const request = await ChangeRequest.findOne({ entity: 'campaign', action: 'send' });
    expect(request).toBeTruthy();
    expect(String(request.entityId)).toBe(String(campaign._id));
  });

  it('sends it once an administrator approves, and only then', async () => {
    const admin = await createAdmin();
    const manager = await createManager();

    await reachableCustomer(manager, 'mine@example.com');
    await reachableCustomer(admin, 'theirs@example.com');

    const campaign = await draftFor(manager, { preset: 'all' });
    await api().post(`/api/campaigns/${campaign._id}/send`).set(manager.headers);

    const request = await ChangeRequest.findOne({ entity: 'campaign' });

    const res = await api()
      .patch(`/api/change-requests/${request._id}/approve`)
      .set(admin.headers);

    expect(res.status).toBe(200);

    const sent = await Campaign.findById(campaign._id);
    expect(sent.status).toBe('sent');
    expect(sent.sentCount).toBe(2);
    expect(sent.approvedBy).toBeTruthy();
  });

  /**
   * A rejection puts the draft back where its author can fix it.
   *
   * Left in `pending_approval` it would be unsendable AND uneditable — a dead
   * record rather than a rejected proposal.
   */
  it('returns a rejected campaign to draft, having sent nothing', async () => {
    const admin = await createAdmin();
    const manager = await createManager();

    await reachableCustomer(manager, 'mine@example.com');
    await reachableCustomer(admin, 'theirs@example.com');

    const campaign = await draftFor(manager, { preset: 'all' });
    await api().post(`/api/campaigns/${campaign._id}/send`).set(manager.headers);

    const request = await ChangeRequest.findOne({ entity: 'campaign' });

    await api()
      .patch(`/api/change-requests/${request._id}/reject`)
      .set(admin.headers)
      .send({ note: 'Too broad — narrow it to your own customers.' });

    const after = await Campaign.findById(campaign._id);
    expect(after.status).toBe('draft');
    expect(await OutboundMessage.countDocuments({ campaign: campaign._id })).toBe(0);
  });

  /**
   * A sales rep cannot launch a bulk send at all — the same reasoning as
   * `writeOrders`: a campaign is a commitment made in the business's name to
   * many people at once. They CAN still message one contact of their own,
   * which is covered in marketingConsent.test.js.
   */
  it('refuses a sales rep the campaigns API entirely', async () => {
    const rep = await createRep();

    expect((await api().get('/api/campaigns').set(rep.headers)).status).toBe(403);
    expect((await api().post('/api/campaigns').set(rep.headers).send({})).status).toBe(403);
  });

  it('shows a manager their own campaigns and not a colleague’s', async () => {
    const admin = await createAdmin();
    const manager = await createManager();

    await draftFor(admin);
    await draftFor(manager);

    const res = await api().get('/api/campaigns').set(manager.headers);

    expect(res.body.data).toHaveLength(1);
    expect(String(res.body.data[0].createdBy._id)).toBe(String(manager.user._id));
  });
});

describe('sending a campaign twice', () => {
  /**
   * `sent` is terminal, and refusing is the whole point. "It looked like it
   * failed so I pressed it again" is exactly how a list gets messaged twice.
   */
  it('refuses to re-send one that has already gone', async () => {
    const admin = await createAdmin();
    await reachableCustomer(admin, 'once@example.com');

    const campaign = await draftFor(admin);
    await api().post(`/api/campaigns/${campaign._id}/send`).set(admin.headers);

    const again = await api().post(`/api/campaigns/${campaign._id}/send`).set(admin.headers);

    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already been sent/i);

    expect(await OutboundMessage.countDocuments({ campaign: campaign._id })).toBe(1);
  });

  it('refuses to edit a campaign that is no longer a draft', async () => {
    const admin = await createAdmin();
    await reachableCustomer(admin, 'locked@example.com');

    const campaign = await draftFor(admin);
    await api().post(`/api/campaigns/${campaign._id}/send`).set(admin.headers);

    const res = await api()
      .patch(`/api/campaigns/${campaign._id}`)
      .set(admin.headers)
      .send({ name: 'Renamed after the fact' });

    expect(res.status).toBe(400);
  });

  it('refuses to send to an audience that matches nobody', async () => {
    const admin = await createAdmin();
    const campaign = await draftFor(admin, { preset: 'high_value' });

    const res = await api().post(`/api/campaigns/${campaign._id}/send`).set(admin.headers);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/matches nobody/i);
  });
});

describe('previewing an audience before writing anything', () => {
  /**
   * The preview reports two numbers that differ, often by a lot. Discovering
   * that gap AFTER pressing send makes the skipped count read as a bug in the
   * sender rather than a list that needs consent collecting.
   */
  it('separates who matches from who can actually be reached', async () => {
    const admin = await createAdmin();

    await reachableCustomer(admin, 'consented@example.com');
    await createCustomer(admin, { email: 'silent@example.com' });

    const res = await api()
      .post('/api/campaigns/preview')
      .set(admin.headers)
      .send({ audience: { preset: 'all' } });

    expect(res.body.data.total).toBe(2);
    expect(res.body.data.reachable.email).toBe(1);
  });

  /** And warns a manager BEFORE they write the copy, not at the moment of sending. */
  it('tells a manager in advance that a send will need approval', async () => {
    const admin = await createAdmin();
    const manager = await createManager();

    await reachableCustomer(manager, 'mine@example.com');
    await reachableCustomer(admin, 'theirs@example.com');

    const res = await api()
      .post('/api/campaigns/preview')
      .set(manager.headers)
      .send({ audience: { preset: 'all' } });

    expect(res.body.data.needsApproval).toBe(true);
    expect(res.body.data.outsideScope).toBeGreaterThan(0);
  });

  it('never asks an administrator for approval', async () => {
    const admin = await createAdmin();
    await reachableCustomer(admin, 'anyone@example.com');

    const res = await api()
      .post('/api/campaigns/preview')
      .set(admin.headers)
      .send({ audience: { preset: 'all' } });

    expect(res.body.data.needsApproval).toBe(false);
  });
});
