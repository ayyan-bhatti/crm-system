#!/usr/bin/env node
/**
 * Give existing orders a human-readable number.
 *
 * Orders created before `orderNumber` existed have none. That is handled
 * gracefully everywhere — the field is optional and the UI falls back to a
 * short `_id` — but a CRM where half the orders can be quoted by number and
 * half cannot is worse than either, so this closes the gap once.
 *
 * ORDER MATTERS, WHICH IS WHY THIS IS NOT A BULK UPDATE.
 *
 * Numbers are assigned oldest first, so the sequence agrees with the order the
 * orders were actually placed in. A bulk update would assign them in whatever
 * order the storage engine returned rows, and a "sequential" id that does not
 * follow time is a small lie that will confuse somebody eventually.
 *
 * It is also deliberately serial rather than concurrent. The counter is atomic,
 * so a parallel version would be correct — but it would interleave, and the
 * numbers would no longer follow `createdAt`. Slower and right beats faster and
 * arbitrary for a one-off.
 *
 *   node scripts/backfillOrderNumbers.js          # report what would change
 *   node scripts/backfillOrderNumbers.js --yes    # do it
 *
 * Safe to run more than once: it only touches orders that have no number, so a
 * second run finds nothing and an interrupted run can simply be repeated.
 */
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Order = require('../src/models/Order');
const { nextOrderNumber } = require('../src/services/orderNumber');

const APPLY = process.argv.includes('--yes');

async function main() {
  if (!env.mongoUri) {
    console.error('[backfill] MONGO_URI is not set.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(env.mongoUri);

  // `$in: [null]` also matches documents where the field is absent entirely,
  // which is what every pre-existing order looks like.
  const filter = { orderNumber: { $in: [null] } };
  const total = await Order.countDocuments(filter);

  if (total === 0) {
    console.log('[backfill] Every order already has a number. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    const oldest = await Order.findOne(filter).sort({ createdAt: 1 }).select('createdAt');
    console.log(`[backfill] ${total} order(s) have no number.`);
    console.log(`[backfill] Oldest was placed ${oldest?.createdAt?.toISOString() ?? 'unknown'}.`);
    console.log('[backfill] Re-run with --yes to assign them, oldest first.');
    await mongoose.disconnect();
    return;
  }

  /*
   * A cursor rather than loading every order: this runs against a production
   * database whose order count is unknown, and holding all of them in memory to
   * write one field each would be a poor reason to run out of it.
   */
  const cursor = Order.find(filter).sort({ createdAt: 1 }).select('_id').cursor();

  let done = 0;

  for (let order = await cursor.next(); order; order = await cursor.next()) {
    const orderNumber = await nextOrderNumber();

    // updateOne rather than save(): nothing else about the document is being
    // changed, and a full save would run validators over historical rows that
    // may predate constraints added since.
    await Order.updateOne({ _id: order._id }, { $set: { orderNumber } });

    done += 1;
    if (done % 100 === 0) console.log(`[backfill] ${done}/${total}…`);
  }

  console.log(`[backfill] Assigned numbers to ${done} order(s).`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[backfill] Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
