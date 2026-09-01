const Customer = require('../models/Customer');
const Buyer = require('../models/Buyer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const contactService = require('../services/contactService');
const messagingService = require('../services/messagingService');
const campaignContentService = require('../services/campaignContentService');
const messageDraftService = require('../services/messageDraftService');
const contactExportService = require('../services/contactExportService');
const { setConsentEverywhere } = require('../services/unsubscribeService');
const { computeCustomerMetrics } = require('../services/customerMetrics');
const { recordAudit } = require('../services/auditService');
const { canExportContacts } = require('../middleware/roles');
const {
  CONTACT_CHANNEL_VALUES,
  CONTACT_SOURCE_VALUES,
  AUTO_SEGMENT_VALUES,
  OUTBOUND_KIND,
  RECIPIENT_STATUS,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_CONTACT,
} = require('../config/marketing');

/**
 * The marketing contacts screen: one merged list of everyone reachable.
 *
 * Every read here is scoped by `contactService.visibleCustomerIds`, which
 * mirrors the record permissions that already exist rather than inventing a
 * second set. See that function for what each role sees and why.
 */

/** Pull the filter set out of the query string, rejecting anything unknown. */
function parseFilters(query) {
  const filters = {};

  if (query.source) {
    if (!CONTACT_SOURCE_VALUES.includes(query.source)) {
      throw ApiError.badRequest(`source must be one of: ${CONTACT_SOURCE_VALUES.join(', ')}`);
    }
    filters.source = query.source;
  }

  if (query.segment) {
    if (!AUTO_SEGMENT_VALUES.includes(query.segment)) {
      throw ApiError.badRequest(`segment must be one of: ${AUTO_SEGMENT_VALUES.join(', ')}`);
    }
    filters.segment = query.segment;
  }

  if (query.tag) filters.tag = String(query.tag).slice(0, MAX_TAG_LENGTH);
  if (query.search) filters.search = String(query.search).slice(0, 100);

  /*
   * The opt-in filter is TWO parameters that only mean anything together —
   * "opted in" is not a question until you say to what. Rejecting a channel
   * without a value (and the reverse) rather than silently ignoring half of it
   * is what stops a filter appearing to apply when it did not.
   */
  if (query.channel || query.optedIn) {
    if (!CONTACT_CHANNEL_VALUES.includes(query.channel)) {
      throw ApiError.badRequest(
        `channel must be one of: ${CONTACT_CHANNEL_VALUES.join(', ')} when filtering by opt-in`
      );
    }
    if (query.optedIn !== 'yes' && query.optedIn !== 'no') {
      throw ApiError.badRequest('optedIn must be "yes" or "no"');
    }
    filters.channel = query.channel;
    filters.optedIn = query.optedIn;
  }

  return filters;
}

/**
 * GET /api/contacts
 *
 * Returns the whole scoped, filtered list rather than a page of it, and that
 * is a considered choice. This list is a MERGE of two collections plus a
 * computed segment per row, so it cannot be paginated at the database — a
 * `skip`/`limit` on either half would produce a page whose contents change
 * depending on which collection happened to sort first. Bounded instead by the
 * scope query and by `MAX_CAMPAIGN_RECIPIENTS` on anything that acts on it.
 *
 * The response carries the FILTER OPTIONS as well as the rows, so the screen's
 * dropdowns come from the server. Same reasoning as `/api/shop/config`: a
 * client that hard-codes the segment list is a client that disagrees with the
 * server the day one is added.
 */
const listContacts = asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  const contacts = await contactService.listContacts(req.user, filters);

  res.json({
    success: true,
    count: contacts.length,
    data: contacts,
    options: {
      sources: CONTACT_SOURCE_VALUES,
      segments: AUTO_SEGMENT_VALUES,
      channels: CONTACT_CHANNEL_VALUES,
      /** Which channels this deployment can actually deliver on. */
      channelStatus: messagingService.channelStatus(),
      canExport: canExportContacts(req.user),
    },
  });
});

/**
 * Load a contact the caller is allowed to act on, or refuse.
 *
 * THE SCOPE CHECK IS THE SAME ONE THE LIST USES, run again here rather than
 * trusted from the fact that the client had the email. A rep who can see six
 * contacts can type a seventh address into a URL, and "they must have got it
 * from the list" is not an authorisation.
 */
async function loadPermittedContact(user, email) {
  const contact = await contactService.findContactByEmail(email);
  if (!contact) throw ApiError.notFound('No contact with that email address');

  const scope = await contactService.visibleCustomerIds(user);

  if (!scope.unrestricted) {
    const visible =
      contact.customerId && scope.customerIds.includes(String(contact.customerId));

    if (!visible) throw ApiError.forbidden('You do not have access to this contact');
  }

  return contact;
}

/** GET /api/contacts/:email */
const getContact = asyncHandler(async (req, res) => {
  const contact = await loadPermittedContact(req.user, req.params.email);

  res.json({ success: true, data: contact });
});

/**
 * PATCH /api/contacts/:email/consent — body: { emailOptIn, smsOptIn, whatsappOptIn }
 *
 * Staff recording a consent the customer gave them — over the phone, in
 * person, on a form. Written to EVERY record for that email, so a person's
 * consent cannot end up saying different things on their CRM record and their
 * storefront account. See services/unsubscribeService.setConsentEverywhere.
 *
 * Audited, because a consent flipped ON by a member of staff is exactly the
 * write somebody will need to account for later.
 */
const updateConsent = asyncHandler(async (req, res) => {
  const contact = await loadPermittedContact(req.user, req.params.email);

  const changes = {};
  for (const channel of CONTACT_CHANNEL_VALUES) {
    const key = `${channel}OptIn`;
    // Only a literal boolean counts — see `consentFromBody` on why the string
    // "false" must never be read as consent.
    if (typeof req.body[key] === 'boolean') changes[channel] = req.body[key];
  }

  if (!Object.keys(changes).length) {
    throw ApiError.badRequest(
      'Send at least one of emailOptIn, smsOptIn or whatsappOptIn as a boolean'
    );
  }

  const changed = await setConsentEverywhere(contact.email, changes);
  const updated = await contactService.findContactByEmail(contact.email);

  if (changed.length) {
    await recordAudit(req, {
      action: 'update',
      entity: 'customer',
      entityId: contact.customerId,
      label: contact.name || contact.email,
      note:
        `Marketing consent changed by staff: ` +
        changed.map((c) => `${c}=${changes[c] ? 'opted in' : 'opted out'}`).join(', '),
    });
  }

  res.json({ success: true, changed, data: updated });
});

/**
 * PUT /api/contacts/:email/tags — body: { tags: ['VIP'] }
 *
 * Replaces the hand-assigned tags. Written to every record for that email, the
 * same rule as consent, so the merged view cannot show a tag that only exists
 * on one half of a person.
 *
 * The COMPUTED segments are untouched by this and cannot be set from here —
 * they are arithmetic, recomputed on every read. A staff member who could
 * hand-write "healthy" onto a customer who has not ordered in a year would
 * make the whole column meaningless.
 */
const updateTags = asyncHandler(async (req, res) => {
  const contact = await loadPermittedContact(req.user, req.params.email);

  if (!Array.isArray(req.body.tags)) {
    throw ApiError.badRequest('tags must be an array of strings');
  }

  const tags = [
    ...new Set(
      req.body.tags
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => t.slice(0, MAX_TAG_LENGTH))
    ),
  ];

  if (tags.length > MAX_TAGS_PER_CONTACT) {
    throw ApiError.badRequest(`A contact cannot have more than ${MAX_TAGS_PER_CONTACT} tags`);
  }

  await Promise.all([
    Customer.updateMany({ email: contact.email }, { marketingTags: tags }),
    Buyer.updateMany({ email: contact.email }, { marketingTags: tags }),
  ]);

  res.json({ success: true, data: await contactService.findContactByEmail(contact.email) });
});

/**
 * POST /api/contacts/:email/message — body: { channel, tone?, subject?, body? }
 *
 * The individual send. This is the round's extension of the existing
 * AI-drafted follow-up from "text to copy elsewhere" into "text that actually
 * goes", and it runs through the same consent gate a bulk campaign does.
 *
 * WHY THE SAME GATE RATHER THAN A LIGHTER CHECK FOR A SINGLE MESSAGE
 *
 * Because a hundred single messages are a campaign, and the person sending the
 * hundredth would not feel differently about the ninety-ninth. Consent does
 * not scale with volume; it is a fact about one person and one channel, and
 * the gate is the same object either way. The UI disables a channel the
 * contact has not agreed to and says why — this is what enforces it.
 *
 * The body may be supplied (a staff member edited the draft) or drafted here
 * from a tone. Editing before sending is the point of the feature, so the
 * supplied text wins.
 */
const messageContact = asyncHandler(async (req, res) => {
  const contact = await loadPermittedContact(req.user, req.params.email);

  const { channel } = req.body;
  if (!CONTACT_CHANNEL_VALUES.includes(channel)) {
    throw ApiError.badRequest(`channel must be one of: ${CONTACT_CHANNEL_VALUES.join(', ')}`);
  }

  let subject = String(req.body.subject || '').slice(0, 200);
  let body = String(req.body.body || '');

  /*
   * Nothing supplied means "draft it and send it", which the UI does not
   * currently offer — it drafts, shows, then sends what was shown. Supported
   * anyway so the endpoint is complete on its own, and it reuses the existing
   * `messageDraftService` rather than a second drafting path.
   */
  if (!body) {
    if (!contact.customerId) {
      throw ApiError.badRequest(
        'This contact has no CRM record, so there is no history to draft from. Write the ' +
          'message yourself.'
      );
    }

    const customer = await Customer.findById(contact.customerId);
    const metrics = await computeCustomerMetrics(contact.customerId);
    const drafted = await messageDraftService.draft(
      customer,
      metrics,
      req.body.tone,
      req.user._id.toString()
    );

    subject = drafted.subject;
    body = drafted.body;
  }

  const outcome = await messagingService.sendToContact({
    contact,
    channel,
    kind: OUTBOUND_KIND.DIRECT,
    subject,
    body: campaignContentService.personalise(body, contact),
    actorId: req.user._id,
  });

  /*
   * A refusal is a 200 with an explanation, not a 4xx.
   *
   * The request was well-formed and the caller was allowed to make it; the
   * answer is that this person has not agreed to be messaged this way. That is
   * information the screen displays, not an error it reports — and returning
   * 403 would make a legitimate consent outcome indistinguishable from a
   * permissions bug in the client's error handling.
   */
  res.json({
    success: outcome.status === RECIPIENT_STATUS.SENT,
    data: {
      status: outcome.status,
      channel,
      transport: outcome.transport,
      reason: outcome.error,
    },
  });
});

/**
 * GET /api/contacts/export — admin only.
 *
 * Exports the CURRENTLY FILTERED view, which is why it parses exactly the same
 * query parameters the list does. A button that exported everything regardless
 * of what was on screen would be a different feature wearing the same label,
 * and the difference would only be discovered after the file was sent to
 * somebody.
 */
const exportContacts = asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  const contacts = await contactService.listContacts(req.user, filters);

  const describedFilters = contactExportService.describeFilters(filters);

  const buffer = await contactExportService.buildContactsWorkbook(contacts, {
    exportedBy: `${req.user.name} <${req.user.email}>`,
    filters: describedFilters,
  });

  /*
   * AUDITED BEFORE THE FILE IS SENT.
   *
   * If the write fails, `recordAudit` swallows it and logs loudly — it never
   * fails the request, by design. But doing it first means the ordinary
   * failure (the response is cut off mid-download) still leaves a trail
   * saying the export was generated, which is the safer way round for an
   * action whose entire risk is data leaving the building.
   */
  await recordAudit(req, {
    action: 'export',
    entity: 'contact',
    entityId: null,
    label: `${contacts.length} contacts`,
    note: `Exported ${contacts.length} contacts to Excel. Filters: ${describedFilters}`,
  });

  const filename = `contacts-${new Date().toISOString().slice(0, 10)}.xlsx`;

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
});

module.exports = {
  listContacts,
  getContact,
  updateConsent,
  updateTags,
  messageContact,
  exportContacts,
  parseFilters,
};
