const Customer = require('../models/Customer');
const { CUSTOMER_STATUS } = require('../config/constants');

/**
 * Match a storefront order to a CRM `Customer`, or create one.
 *
 * THIS IS THE WHOLE POINT OF BUILDING ON THE CRM.
 *
 * A guest checkout or a buyer's first order has to produce a `Customer` a
 * sales rep can actually follow up with — that is the entire reason this
 * isn't a generic cart plugin bolted on the side. A returning buyer's later
 * orders match the same record by email rather than piling up duplicates
 * every time they check out.
 *
 * ATOMIC MATCH-OR-CREATE, NOT FIND-THEN-CREATE.
 *
 * Two guest checkouts with the same email arriving at the same moment must
 * not create two `Customer` records — that is exactly the kind of race the
 * stock decrement elsewhere in this app is careful about, and the fix is the
 * same shape: push the decision into a single atomic operation the database
 * arbitrates, rather than a read in application code followed by a write.
 * `findOneAndUpdate` with `upsert: true` is that operation: MongoDB
 * guarantees exactly one of two simultaneous callers performs the insert.
 *
 * ONLY SETS FIELDS ON INSERT, NEVER ON MATCH.
 *
 * A returning buyer's later checkout might carry a different phone number or
 * address than the one on file — people move, numbers change. This
 * deliberately does not overwrite the existing `Customer` with whatever the
 * checkout form said: that record may since have been corrected, annotated
 * or enriched by a sales rep, and a checkout form is not the place changes
 * to it should come from unreviewed. Matching links the order to the right
 * account; keeping the CRM record accurate is still a person's job.
 */
async function matchOrCreateCustomer({ email, name, phone = '', address = '', city = '' }, session) {
  const normalizedEmail = String(email).toLowerCase().trim();

  const customer = await Customer.findOneAndUpdate(
    { email: normalizedEmail },
    {
      $setOnInsert: {
        email: normalizedEmail,
        name,
        phone,
        address,
        city,
        status: CUSTOMER_STATUS.LEAD,
        createdBy: null,
      },
    },
    { new: true, upsert: true, session }
  );

  return customer;
}

module.exports = { matchOrCreateCustomer };
