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

function validateAnswer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const answer = string(raw.answer, MAX_ANSWER);
  return answer ? { answer } : null;
}

function buildSystemPrompt() {
  return `You answer a shopper's plain-language question about their own orders on a
storefront. You are given a list of their orders as facts that are already correct —
never invent an order, a status, or a date that is not in the list. If the list does
not answer the question, say so plainly rather than guessing. Be brief and direct.

Respond with a JSON object only: {"answer": "<your answer, at most a few sentences>"}`;
}

function callModel(question, orders) {
  return aiClient.complete({
    feature: 'shop-order-assistant',
    system: buildSystemPrompt(),
    user: JSON.stringify({ question, orders: orders.map(orderFacts) }),
    maxTokens: 400,
  });
}

/** A plain-rule answer when the AI path is unavailable. */
function fallbackAnswer(question, orders) {
  if (!orders.length) {
    return "You don't have any orders yet.";
  }

  const numbered = String(question).match(/ord-?\s*0*(\d+)/i);
  if (numbered) {
    const match = orders.find((o) => (o.orderNumber || '').replace(/\D/g, '') === numbered[1]);
    if (match) {
      const facts = orderFacts(match);
      return `Order ${facts.orderNumber} is ${facts.status}.`;
    }
  }

  const latest = orderFacts(orders[0]);
  return (
    `Your most recent order (${latest.orderNumber}) is ${latest.status}, ` +
    `placed on ${new Date(latest.placedOn).toISOString().slice(0, 10)}.`
  );
}

/**
 * Answer a buyer's question about their own orders.
 *
 * @param {string} question
 * @param {string} buyerId
 * @returns {Promise<{mode: 'ai'|'fallback', answer: string}>} never throws.
 */
async function answer(question, buyerId) {
  const orders = await Order.find({ buyerId })
    .sort({ createdAt: -1 })
    .limit(MAX_ORDERS_IN_CONTEXT);

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', answer: fallbackAnswer(question, orders) };
  }

  let text;
  try {
    text = await callModel(question, orders);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the rule-based answer');
    return { mode: 'fallback', answer: fallbackAnswer(question, orders) };
  }

  const result = parseAndValidate(text, validateAnswer);
  if (!result.ok) return { mode: 'fallback', answer: fallbackAnswer(question, orders) };

  return { mode: 'ai', answer: result.value.answer };
}

module.exports = { answer, orderFacts, validateAnswer };
