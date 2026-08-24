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

  const actors = [admin, manager, rep];
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
  console.log(pad('ROUTE', 38), pad('admin', 12), pad('manager', 12), 'sales_rep');
  console.log('-'.repeat(78));
  for (const r of rows) {
    console.log(pad(r.route, 38), pad(r.admin, 12), pad(r.manager, 12), r.sales_rep);
  }

  await mongoose.disconnect();
  await mongo.stop();
}

main().catch((e) => {
  console.error('audit failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
