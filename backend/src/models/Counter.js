const mongoose = require('mongoose');

/**
 * Monotonic sequence numbers, one document per named sequence.
 *
 * WHY THIS EXISTS RATHER THAN COUNTING DOCUMENTS.
 *
 * The obvious way to number orders is `count() + 1`. It is also wrong, and
 * wrong in the same way the stock decrement was before it was made atomic:
 *
 *     const n = await Order.countDocuments();   // both requests read 41
 *     await Order.create({ orderNumber: n + 1 }); // both write ORD-000042
 *
 * Two orders placed in the same moment both read 41 and both write 42. The
 * window is small and entirely real — it is exactly the interval between the
 * read and the write, which is where every race of this shape lives. Under
 * normal load you would see it once a month and conclude it was a mystery.
 *
 * Worse, `count()` is not even a correct sequence on its own terms: delete
 * order 42 and the next order created is numbered 42 again, so the number
 * stops identifying anything. A human-readable id that can be reused is a
 * human-readable id that cannot be used in a conversation, which defeats the
 * entire purpose.
 *
 * `findOneAndUpdate` with `$inc` is a single atomic document update. MongoDB
 * guarantees no two callers receive the same result, because the read and the
 * write are the same operation — there is no window between them for a second
 * caller to occupy. Numbers are never reused, because the counter only ever
 * moves forward and knows nothing about deletions.
 *
 * THE TRADE-OFF, STATED.
 *
 * Every order creation now writes to one shared document, which is a
 * contention point by construction. For a CRM at any plausible scale that is
 * irrelevant — a single-document `$inc` is one of the cheapest operations
 * MongoDB performs, and orders are created by humans clicking a button. A
 * system minting thousands per second would want ranges handed out in blocks,
 * or an id that does not need to be dense. This one does not.
 */
const counterSchema = new mongoose.Schema({
  /** The sequence's name, e.g. `order`. The document id, so lookups are direct. */
  _id: {
    type: String,
    required: true,
  },

  /**
   * The last number handed out. Starts at 0, so the first caller receives 1.
   */
  seq: {
    type: Number,
    required: true,
    default: 0,
  },
});

/**
 * Take the next number in a sequence.
 *
 * `upsert` so a fresh database needs no seeding step: the first call creates
 * the counter and returns 1. `returnDocument: 'after'` because the value we
 * want is the one that was just written — asking for the previous value would
 * reintroduce the read-then-write gap this exists to close.
 *
 * @param {string} name    the sequence, e.g. 'order'
 * @param {object} [options]
 * @param {import('mongoose').ClientSession} [options.session]
 * @returns {Promise<number>} a number no other caller will receive
 */
counterSchema.statics.next = async function next(name, { session } = {}) {
  const counter = await this.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    {
      new: true,
      upsert: true,
      session,
      setDefaultsOnInsert: true,
    }
  );

  return counter.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
