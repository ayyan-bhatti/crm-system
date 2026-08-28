/**
 * Role-by-role audit against the REAL backend.
 *
 * Every route is hit as each of the three roles with a genuine session, and the
 * status recorded. This is point 5 of the brief done exhaustively rather than by
 * sampling: a hidden button with no backend check behind it is the same bug as a
 * visible one, so the only trustworthy source is the API itself.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'x'.repeat(48);

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../src/models/User');
const Customer = require('../src/models/Customer');
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');
const ChangeRequest = require('../src/models/ChangeRequest');

const PW = 'Karachi-Ledger-72';

async function main() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());

  const app = require('../src/app');
  const api = () => request(app);

  // ---- three real accounts -------------------------------------------
  const make = async (name, email, role) => {
    const user = await User.create({ name, email, password: PW, role, status: 'active' });
    const res = await api().post('/api/auth/login').send({ email, password: PW });
    return { user, headers: { Authorization: `Bearer ${res.body.data.token}` }, role };
  };

  const admin = await make('Ayyan', 'admin@t.com', 'admin');
  const manager = await make('Bilal', 'manager@t.com', 'manager');
  const rep = await make('Sara', 'sara@t.com', 'sales_rep');
  const otherRep = await make('Omar', 'omar@t.com', 'sales_rep');

  /*
   * A buyer, exercised against the INTERNAL routes below with the SAME
   * Authorization-header mechanism the staff actors use. A buyer token
   * carries `kind: 'buyer'` and an id from a different collection entirely
   * — `protect` looks it up in `User`, which cannot resolve it — so this
   * proves the isolation the storefront's auth design claims rather than
   * assuming it from reading the code.
   */
  const makeBuyer = async (name, email) => {
    const res = await api()
      .post('/api/shop/auth/register')
      .send({ name, email, password: PW });
    return { role: 'buyer', headers: { Authorization: `Bearer ${res.body.data.token}` } };
  };

  const buyer = await makeBuyer('Sana', 'sana@shop.t.com');
  // Same shape as `buyer`, but tracked under its own table key ('buyer2')
  // rather than sharing 'buyer' — otherwise two rows would collide under one
  // column when the storefront audit below runs both at once.
  const otherBuyer = { ...(await makeBuyer('Zainab', 'zainab@shop.t.com')), role: 'buyer2' };

  // ---- data ------------------------------------------------------------
  const customer = await Customer.create({
    name: 'Karachi Traders', email: 'kt@t.com', city: 'Karachi',
    phone: '+92 300 1234567', address: '5 Ledger Road',
    createdBy: admin.user._id, assignedTo: admin.user._id,
  });
  const product = await Product.create({
    name: 'Widget', sku: 'WID-1', price: 100, stockQty: 500, category: 'Parts',
  });

  const placed = await api().post('/api/orders').set(admin.headers).send({
    customer: customer._id,
    items: [{ product: product._id, quantity: 1 }],
    assignedTo: rep.user._id,
  });
  const myOrder = placed.body.data;

  const theirs = await api().post('/api/orders').set(admin.headers).send({
    customer: customer._id,
    items: [{ product: product._id, quantity: 1 }],
    assignedTo: otherRep.user._id,
  });
  const otherOrder = theirs.body.data;

  // ---- the matrix ------------------------------------------------------
  const ROUTES = [
    ['GET   /api/customers',                 (a) => api().get('/api/customers').set(a.headers)],
    ['GET   /api/customers/options',         (a) => api().get('/api/customers/options').set(a.headers)],
    ['GET   /api/customers/:id',             (a) => api().get(`/api/customers/${customer._id}`).set(a.headers)],
    ['GET   /api/customers/:id/summary',     (a) => api().get(`/api/customers/${customer._id}/summary`).set(a.headers)],
    ['POST  /api/customers',                 (a) => api().post('/api/customers').set(a.headers).send({ name: `C ${a.role}`, email: `c-${a.role}@t.com` })],
    ['PATCH /api/customers/:id',             (a) => api().patch(`/api/customers/${customer._id}`).set(a.headers).send({ city: 'Lahore' })],
    ['DEL   /api/customers/:id',             (a) => api().delete(`/api/customers/${customer._id}`).set(a.headers)],

    ['GET   /api/products',                  (a) => api().get('/api/products').set(a.headers)],
    ['GET   /api/products/options',          (a) => api().get('/api/products/options').set(a.headers)],
    ['POST  /api/products',                  (a) => api().post('/api/products').set(a.headers).send({ name: `P ${a.role}`, sku: `SKU-${a.role}`, price: 5, stockQty: 5 })],
    ['PATCH /api/products/:id',              (a) => api().patch(`/api/products/${product._id}`).set(a.headers).send({ price: 101 })],
    ['DEL   /api/products/:id',              (a) => api().delete(`/api/products/${product._id}`).set(a.headers)],

    ['GET   /api/orders',                    (a) => api().get('/api/orders').set(a.headers)],
    ['GET   /api/orders/:id (rep owns)',     (a) => api().get(`/api/orders/${myOrder._id}`).set(a.headers)],
    ['GET   /api/orders/:id (other rep)',    (a) => api().get(`/api/orders/${otherOrder._id}`).set(a.headers)],
    ['POST  /api/orders',                    (a) => api().post('/api/orders').set(a.headers).send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] })],
    ['PATCH /api/orders/:id (status)',       (a) => api().patch(`/api/orders/${myOrder._id}`).set(a.headers).send({ status: 'completed' })],
    ['PATCH /api/orders/:id (items)',        (a) => api().patch(`/api/orders/${myOrder._id}`).set(a.headers).send({ items: [{ product: product._id, quantity: 2 }] })],
    ['PATCH /api/orders/:id/assign',         (a) => api().patch(`/api/orders/${myOrder._id}/assign`).set(a.headers).send({ assignedTo: otherRep.user._id })],
    ['POST  /api/orders/:id/transfer-req',   (a) => api().post(`/api/orders/${myOrder._id}/transfer-request`).set(a.headers).send({ assignedTo: otherRep.user._id })],
    ['DEL   /api/orders/:id',                (a) => api().delete(`/api/orders/${myOrder._id}`).set(a.headers)],

    ['GET   /api/users',                     (a) => api().get('/api/users').set(a.headers)],
    ['GET   /api/users/assignable',          (a) => api().get('/api/users/assignable').set(a.headers)],
    ['GET   /api/users/pending',             (a) => api().get('/api/users/pending').set(a.headers)],
    ['POST  /api/users/invite',              (a) => api().post('/api/users/invite').set(a.headers).send({ name: `Inv ${a.role}`, email: `inv-${a.role}@t.com`, role: 'sales_rep' })],
    ['POST  /api/users/invite (as admin!)',  (a) => api().post('/api/users/invite').set(a.headers).send({ name: `Esc ${a.role}`, email: `esc-${a.role}@t.com`, role: 'admin' })],
    ['PATCH /api/users/:id',                 (a) => api().patch(`/api/users/${otherRep.user._id}`).set(a.headers).send({ name: 'Renamed' })],
    ['PATCH /api/users/:id/status',          (a) => api().patch(`/api/users/${otherRep.user._id}/status`).set(a.headers).send({ status: 'active' })],
    ['DEL   /api/users/:id',                 (a) => api().delete(`/api/users/${otherRep.user._id}`).set(a.headers)],

    ['GET   /api/change-requests',           (a) => api().get('/api/change-requests').set(a.headers)],
    ['GET   /api/audit-logs',                (a) => api().get('/api/audit-logs').set(a.headers)],
    ['GET   /api/internal/metrics',          (a) => api().get('/api/internal/metrics').set(a.headers)],
    ['GET   /api/internal/ai-status',        (a) => api().get('/api/internal/ai-status').set(a.headers)],
    ['GET   /api/internal/ai-usage',         (a) => api().get('/api/internal/ai-usage').set(a.headers)],
    ['GET   /api/dashboard/summary',         (a) => api().get('/api/dashboard/summary').set(a.headers)],
    ['POST  /api/ai-search',                 (a) => api().post('/api/ai-search').set(a.headers).send({ query: 'customers in Karachi' })],
  ];

  /*
   * The buyer rides along on the SAME internal matrix as the three staff
   * roles, rather than a separate pass — the claim being audited is "a
   * buyer reaches none of this", and running it through the identical loop
   * as everyone else is what makes that comparable rather than asserted.
   */
  const actors = [admin, manager, rep, buyer];
  const rows = [];


  /*
   * Fresh world before every single call.
   *
   * The first version of this audit ran the routes in order against one shared
   * fixture, and the destructive ones poisoned everything after them: the admin
   * deleted the customer, so POST /api/orders then answered 404 for all three
   * roles and looked like a permission bug. The 403s were still trustworthy —
   * they are decided before any data is touched — but nothing else was.
   */
  const reset = async () => {
    await Promise.all([
      Customer.deleteMany({}),
      Product.deleteMany({}),
      Order.deleteMany({}),
      ChangeRequest.deleteMany({}),
    ]);

    Object.assign(customer, (await Customer.create({
      name: 'Karachi Traders', email: 'kt@t.com', city: 'Karachi',
      phone: '+92 300 1234567', address: '5 Ledger Road',
      createdBy: admin.user._id, assignedTo: admin.user._id,
    })).toObject());

    Object.assign(product, (await Product.create({
      name: 'Widget', sku: 'WID-1', price: 100, stockQty: 500, category: 'Parts',
    })).toObject());

    const mine = await api().post('/api/orders').set(admin.headers).send({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1 }],
      assignedTo: rep.user._id,
    });
    Object.assign(myOrder, mine.body.data);

    const other = await api().post('/api/orders').set(admin.headers).send({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1 }],
      assignedTo: otherRep.user._id,
    });
    Object.assign(otherOrder, other.body.data);
  };

  for (const [label, call] of ROUTES) {
    const row = { route: label };

    for (const actor of actors) {
      try {
        await reset();
        const res = await call(actor);
        let note = String(res.status);

        // Record the shape of a success, since "200 with everything" and
        // "200 with nothing" are completely different answers.
        if (res.status < 300) {
          const body = res.body?.data;
          if (Array.isArray(body)) note += ` (${body.length})`;
          else if (typeof res.body?.total === 'number') note += ` (${res.body.total})`;

          // A 200 is not the whole answer when the question is what came back
          // in it. The colleague picker is reachable by every role on purpose;
          // whether it hands out email addresses is the part worth recording.
          if (Array.isArray(body) && label.includes('assignable')) {
            note += body.some((u) => u.email) ? ' +email' : ' no-email';
          }
        }
        row[actor.role] = note;
      } catch (err) {
        row[actor.role] = `ERR ${err.message.slice(0, 20)}`;
      }
    }
    rows.push(row);
  }

  // ---- print -----------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  const roleColumns = [...new Set(actors.map((a) => a.role))];

  console.log('-- internal routes --');
  console.log(pad('ROUTE', 38), roleColumns.map((r) => pad(r, 12)).join(''));
  console.log('-'.repeat(38 + roleColumns.length * 12));
  for (const r of rows) {
    console.log(pad(r.route, 38), roleColumns.map((role) => pad(r[role], 12)).join(''));
  }

  await auditShopRoutes({ api, admin, buyer, otherBuyer, pad });

  await mongoose.disconnect();
  await mongo.stop();
}

/**
 * The storefront's OWN routes, audited separately from the internal matrix
 * above rather than folded into it — a public product endpoint answering
 * `200` to a guest is correct there and would be a finding on every other
 * row in this file, so the two need different callers and different
 * expectations rather than one table trying to mean both.
 *
 * Three callers: a guest (no session at all — the majority of the public
 * storefront's actual traffic), a buyer, and the SAME buyer's colleague, to
 * prove order/cart scoping the same way `otherRep` proves it internally.
 */
async function auditShopRoutes({ api, admin, buyer, otherBuyer, pad }) {
  const Product = require('../src/models/Product');
  const product = await Product.create({
    name: 'Shop Widget',
    sku: 'SHOP-1',
    price: 25,
    stockQty: 50,
    category: 'Storefront',
  });

  const myOrder = await api()
    .post('/api/shop/checkout')
    .set(buyer.headers)
    .send({ items: [{ product: product._id, quantity: 1 }] });

  const guest = { role: 'guest', headers: {} };

  const SHOP_ROUTES = [
    ['GET  /shop/products', (a) => api().get('/api/shop/products').set(a.headers)],
    ['GET  /shop/products/:id', (a) => api().get(`/api/shop/products/${product._id}`).set(a.headers)],
    ['GET  /shop/cart', (a) => api().get('/api/shop/cart').set(a.headers)],
    ['GET  /shop/orders', (a) => api().get('/api/shop/orders').set(a.headers)],
    ['GET  /shop/orders/:id (own)', (a) => api().get(`/api/shop/orders/${myOrder.body.data._id}`).set(a.headers)],
    ['GET  /shop/auth/me', (a) => api().get('/api/shop/auth/me').set(a.headers)],
    // A staff bearer token, tried against a buyer-only route — the reverse
    // of the internal matrix's question, and just as load-bearing.
    ['GET  /shop/cart (as admin!)', () => api().get('/api/shop/cart').set(admin.headers)],
  ];

  const actors = [guest, buyer, otherBuyer];
  const rows = [];

  for (const [label, call] of SHOP_ROUTES) {
    const row = { route: label };
    for (const actor of actors) {
      try {
        const res = await call(actor);
        let note = String(res.status);
        if (res.status < 300 && Array.isArray(res.body?.data)) note += ` (${res.body.data.length})`;
        row[actor.role] = note;
      } catch (err) {
        row[actor.role] = `ERR ${err.message.slice(0, 20)}`;
      }
    }
    rows.push(row);
  }

  console.log('');
  console.log('-- storefront routes (buyer + guest) --');
  console.log(pad('ROUTE', 30), pad('guest', 12), pad('buyer', 12), 'buyer (colleague)');
  console.log('-'.repeat(66));
  for (const r of rows) {
    console.log(pad(r.route, 30), pad(r.guest, 12), pad(r.buyer, 12), r.buyer2);
  }
}

main().catch((e) => {
  console.error('audit failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
