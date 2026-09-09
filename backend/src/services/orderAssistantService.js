const Order = require('../models/Order');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');

const log = componentLogger('ai-order-assistant');

const MAX_ANSWER = 500;
const MAX_ORDERS_IN_CONTEXT = 20;

/**
 * "Where's my order" — a logged-in buyer's own orders, answered in prose.
 *
 * SCOPED BEFORE THE MODEL EVER SEES ANYTHING.
 *
 * The facts handed to the model are pre-filtered to `buyerId` by the caller
 * — see `shopOrderController.askAboutOrders` — so there is no question this
 * can be asked that reaches another buyer's data; the model has nothing to
 * leak because it is never given anything to leak. It answers from a plain
 * list of order facts, exactly the "figures come from code" rule every
 * other AI feature in this app follows — an order's status is a fact, not
 * something to interpret.
 */

/** The facts about one order the assistant is allowed to discuss. */
function orderFacts(order) {
  return {
    orderNumber: order.orderNumber || String(order._id),
    status: order.status,
    placedOn: order.createdAt,
    completedOn: order.completedAt,
    itemCount: order.items.length,
    total: order.total,
  };
}

/**
 * The structured shape a reply may point back at.
 *
 * This is what makes the answer renderable as an actual order row instead of
 * an id flattened into a sentence — the frontend gets a real order to link
 * to and a real status to colour, not text to parse back out.
 */
function referenceFromOrder(order) {
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber || String(order._id),
    status: order.status,
    fulfilment: order.fulfilment,
    total: order.total,
    createdAt: order.createdAt,
    estimatedDeliveryAt: order.estimatedDeliveryAt || null,
  };
}

/**
 * `orders` is the SAME list already fetched for this buyer, so `references`
 * is an allow-list check rather than a lookup — a reply naming an order
 * number outside that list is not "an order we don't have handy", it is the
 * model inventing one, and it is dropped rather than trusted. Capped at the
 * same size as the context itself; there is no way for a real answer to cite
 * more orders than it was shown.
 */
function validateAnswer(raw, orders) {
  if (!raw || typeof raw !== 'object') return null;
  const answer = string(raw.answer, MAX_ANSWER);
  if (!answer) return null;

  const byNumber = new Map(orders.map((o) => [o.orderNumber || String(o._id), o]));
  const rawRefs = Array.isArray(raw.references) ? raw.references : [];
  const references = rawRefs
    .filter((ref) => typeof ref === 'string' && byNumber.has(ref))
    .slice(0, MAX_ORDERS_IN_CONTEXT)
    .map((ref) => referenceFromOrder(byNumber.get(ref)));

  return { answer, references };
}

function buildSystemPrompt() {
  return `You answer a shopper's plain-language question about their own orders on a
storefront. You are given a list of their orders as facts that are already correct —
never invent an order, a status, or a date that is not in the list. If the list does
not answer the question, say so plainly rather than guessing. Be brief and direct.

Respond with a JSON object only:
{"answer": "<your answer, at most a few sentences>", "references": ["<orderNumber>", ...]}

"references" is the orderNumber of every order from the list your answer is actually
about — empty if none, never a number that is not in the list.`;
}

function callModel(question, orders) {
  return aiClient.complete({
    feature: 'shop-order-assistant',
    system: buildSystemPrompt(),
    user: JSON.stringify({ question, orders: orders.map(orderFacts) }),
    maxTokens: 400,
  });
}

/**
 * A plain-rule answer when the AI path is unavailable.
 *
 * Returns the same `{ answer, references }` shape the AI path does, so the
 * frontend never has to know which mode produced a reply to render it.
 */
function fallbackAnswer(question, orders) {
  if (!orders.length) {
    return { answer: "You don't have any orders yet.", references: [] };
  }

  const numbered = String(question).match(/ord-?\s*0*(\d+)/i);
  if (numbered) {
    const match = orders.find((o) => (o.orderNumber || '').replace(/\D/g, '') === numbered[1]);
    if (match) {
      const facts = orderFacts(match);
      return {
        answer: `Order ${facts.orderNumber} is ${facts.status}.`,
        references: [referenceFromOrder(match)],
      };
    }
  }

  const latest = orders[0];
  const facts = orderFacts(latest);
  return {
    answer:
      `Your most recent order (${facts.orderNumber}) is ${facts.status}, ` +
      `placed on ${new Date(facts.placedOn).toISOString().slice(0, 10)}.`,
    references: [referenceFromOrder(latest)],
  };
}

/**
 * Answer a buyer's question about their own orders.
 *
 * @param {string} question
 * @param {string} buyerId
 * @returns {Promise<{mode: 'ai'|'fallback', answer: string, references: object[]}>}
 *   never throws.
 */
async function answer(question, buyerId) {
  const orders = await Order.find({ buyerId })
    .sort({ createdAt: -1 })
    .limit(MAX_ORDERS_IN_CONTEXT);

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', ...fallbackAnswer(question, orders) };
  }

  let text;
  try {
    text = await callModel(question, orders);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the rule-based answer');
    return { mode: 'fallback', ...fallbackAnswer(question, orders) };
  }

  const result = parseAndValidate(text, (raw) => validateAnswer(raw, orders));
  if (!result.ok) return { mode: 'fallback', ...fallbackAnswer(question, orders) };

  return { mode: 'ai', ...result.value };
}

module.exports = { answer, orderFacts, referenceFromOrder, validateAnswer };
