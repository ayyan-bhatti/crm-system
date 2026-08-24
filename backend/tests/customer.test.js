const { api, createAdmin, createManager, createRep, createCustomer } = require('./helpers');
const Customer = require('../src/models/Customer');

describe('Customer CRUD', () => {
  describe('POST /api/customers', () => {
    it('creates a customer', async () => {
      const admin = await createAdmin();

      const res = await api().post('/api/customers').set(admin.headers).send({
        name: 'Karachi Textiles',
        email: 'hello@karachitextiles.com',
        company: 'Karachi Textiles Ltd',
        city: 'Karachi',
        status: 'active',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Karachi Textiles');
      expect(res.body.data.status).toBe('active');
    });

    it('defaults the status to lead', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/customers')
        .set(admin.headers)
        .send({ name: 'A', email: 'a@test.com' });

      expect(res.body.data.status).toBe('lead');
    });

    it('records who created it and assigns it to them by default', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/customers')
        .set(admin.headers)
        .send({ name: 'A', email: 'a@test.com' });

      expect(String(res.body.data.assignedTo._id)).toBe(String(admin.user._id));

      const stored = await Customer.findById(res.body.data._id);
      expect(String(stored.createdBy)).toBe(String(admin.user._id));
    });

    it('rejects a missing name with 400', async () => {
      const admin = await createAdmin();

      const res = await api().post('/api/customers').set(admin.headers).send({ email: 'a@test.com' });

      expect(res.status).toBe(400);
    });

    it('rejects an invalid email with 400', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/customers')
        .set(admin.headers)
        .send({ name: 'A', email: 'nope' });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown status with 400', async () => {
      const admin = await createAdmin();

      const res = await api()
        .post('/api/customers')
        .set(admin.headers)
        .send({ name: 'A', email: 'a@test.com', status: 'vip' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/customers', () => {
    it('returns a paginated envelope', async () => {
      const admin = await createAdmin();
      await createCustomer(admin);

      const res = await api().get('/api/customers').set(admin.headers);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        count: 1,
        total: 1,
        page: 1,
        pages: 1,
      });
    });

    it('paginates', async () => {
      const admin = await createAdmin();
      for (let i = 0; i < 5; i += 1) await createCustomer(admin);

      const res = await api().get('/api/customers?page=2&limit=2').set(admin.headers);

      expect(res.body.total).toBe(5);
      expect(res.body.pages).toBe(3);
      expect(res.body.data).toHaveLength(2);
    });

    it('filters by status', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { status: 'active' });
      await createCustomer(admin, { status: 'lead' });

      const res = await api().get('/api/customers?status=active').set(admin.headers);

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].status).toBe('active');
    });

    it('filters by assignedTo', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      await createCustomer(admin, { assignedTo: rep.user._id });
      await createCustomer(admin);

      const res = await api()
        .get(`/api/customers?assignedTo=${rep.user._id}`)
        .set(admin.headers);

      expect(res.body.total).toBe(1);
    });

    it('filters by city', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { city: 'Karachi' });
      await createCustomer(admin, { city: 'Lahore' });

      const res = await api().get('/api/customers?city=lahore').set(admin.headers);

      expect(res.body.total).toBe(1);
    });

    it('searches name, email and company', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Zainab Traders', email: 'z@test.com' });
      await createCustomer(admin, { name: 'Other', email: 'other@test.com', company: 'Zainab Co' });
      await createCustomer(admin, { name: 'Unrelated', email: 'u@test.com' });

      const res = await api().get('/api/customers?search=zainab').set(admin.headers);

      expect(res.body.total).toBe(2);
    });

    it('is case-insensitive when searching', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Zainab Traders' });

      const res = await api().get('/api/customers?search=ZAINAB').set(admin.headers);

      expect(res.body.total).toBe(1);
    });

    /**
     * A search term with regex metacharacters must be treated as text. Without
     * escaping, "a.c" would match "abc" — and a pathological pattern could hang
     * the query.
     */
    it('treats regex characters in the search term literally', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'abc' });
      await createCustomer(admin, { name: 'a.c' });

      const res = await api().get('/api/customers?search=a.c').set(admin.headers);

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].name).toBe('a.c');
    });

    /**
     * There is no longer a sales-rep scope on customers to combine a search
     * with, because there is no sales-rep ACCESS to customers. The test that
     * used to live here checked that a search narrowed within a rep's own
     * records; the rule it was testing has been replaced by a flat refusal,
     * which is asserted in roles.test.js.
     *
     * What is still worth pinning is that a search narrows a MANAGER's view
     * without widening it beyond the book they are allowed to read.
     */
    it('narrows a search without escaping the caller’s permitted scope', async () => {
      const admin = await createAdmin();
      const manager = await createManager();
      await createCustomer(admin, { name: 'Shared Name' });
      await createCustomer(admin, { name: 'Shared Name' });
      await createCustomer(admin, { name: 'Something Else' });

      const res = await api().get('/api/customers?search=Shared').set(manager.headers);

      expect(res.body.total).toBe(2);
    });

    it('sorts by an allowed field', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Beta' });
      await createCustomer(admin, { name: 'Alpha' });

      const res = await api().get('/api/customers?sort=name').set(admin.headers);

      expect(res.body.data[0].name).toBe('Alpha');
    });

    it('ignores a sort on a field that is not allow-listed', async () => {
      const admin = await createAdmin();
      await createCustomer(admin);

      const res = await api().get('/api/customers?sort=notAField').set(admin.headers);

      expect(res.status).toBe(200);
    });

    it('caps the page size', async () => {
      const admin = await createAdmin();
      await createCustomer(admin);

      const res = await api().get('/api/customers?limit=5000').set(admin.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(100);
    });
  });

  describe('GET /api/customers/:id', () => {
    it('returns a single customer with the assignee populated', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api().get(`/api/customers/${customer._id}`).set(admin.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.assignedTo.name).toEqual(expect.any(String));
    });

    it('returns 404 for an id that does not exist', async () => {
      const admin = await createAdmin();

      const res = await api()
        .get('/api/customers/507f1f77bcf86cd799439011')
        .set(admin.headers);

      expect(res.status).toBe(404);
    });

    it('returns 400 for a malformed id', async () => {
      const admin = await createAdmin();

      const res = await api().get('/api/customers/not-an-id').set(admin.headers);

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/customers/:id', () => {
    it('updates the supplied fields', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin, { name: 'Before', city: 'Karachi' });

      const res = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(admin.headers)
        .send({ name: 'After', status: 'active' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('After');
      expect(res.body.data.status).toBe('active');
      // Untouched fields survive.
      expect(res.body.data.city).toBe('Karachi');
    });

    it('ignores an attempt to change createdBy', async () => {
      const admin = await createAdmin();
      const other = await createRep();
      const customer = await createCustomer(admin);

      await api()
        .patch(`/api/customers/${customer._id}`)
        .set(admin.headers)
        .send({ createdBy: other.user._id });

      const stored = await Customer.findById(customer._id);
      expect(String(stored.createdBy)).toBe(String(admin.user._id));
    });

    it('rejects an invalid status with 400', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api()
        .patch(`/api/customers/${customer._id}`)
        .set(admin.headers)
        .send({ status: 'nonsense' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for an id that does not exist', async () => {
      const admin = await createAdmin();

      const res = await api()
        .patch('/api/customers/507f1f77bcf86cd799439011')
        .set(admin.headers)
        .send({ name: 'X' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/customers/:id', () => {
    // Admin, not manager: deleting a customer is a write to the customer book,
    // and a manager may read it and propose changes to it but not change it.
    it('deletes the customer', async () => {
      const admin = await createAdmin();
      const customer = await createCustomer(admin);

      const res = await api().delete(`/api/customers/${customer._id}`).set(admin.headers);

      expect(res.status).toBe(200);
      expect(await Customer.findById(customer._id)).toBeNull();
    });

    it('returns 404 for an id that does not exist', async () => {
      const admin = await createAdmin();

      const res = await api()
        .delete('/api/customers/507f1f77bcf86cd799439011')
        .set(admin.headers);

      expect(res.status).toBe(404);
    });
  });
});
