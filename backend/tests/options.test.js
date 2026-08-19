const { api, createManager, createRep, createCustomer, createProduct } = require('./helpers');

/**
 * The searchable picker endpoints.
 *
 * These replaced a `limit=100` dropdown, and the bug that motivated them is the
 * one worth keeping in mind while reading: with 101 customers, the hundred-and-
 * first could not be selected AT ALL — no error, no "showing 100 of 4,000", the
 * user simply could not find them. So the tests below care most about two
 * things: that search actually reaches the whole collection, and that it does
 * not become a way around the permission rules.
 */

describe('GET /api/customers/options', () => {
  let manager;

  beforeEach(async () => {
    manager = await createManager();
  });

  it('returns matches for a name search', async () => {
    await createCustomer(manager, { name: 'Karachi Traders' });
    await createCustomer(manager, { name: 'Lahore Supplies' });

    const res = await api()
      .get('/api/customers/options?search=karachi')
      .set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Karachi Traders');
  });

  it('searches company and email as well as name', async () => {
    await createCustomer(manager, { name: 'Acme', company: 'Globex Ltd' });
    await createCustomer(manager, { name: 'Beta', email: 'hello@globex.com' });

    const res = await api()
      .get('/api/customers/options?search=globex')
      .set(manager.headers);

    expect(res.body.data).toHaveLength(2);
  });

  it('is case insensitive', async () => {
    await createCustomer(manager, { name: 'Karachi Traders' });

    const res = await api()
      .get('/api/customers/options?search=KARACHI')
      .set(manager.headers);

    expect(res.body.data).toHaveLength(1);
  });

  /**
   * The point of the whole exercise. Search runs against the collection, not
   * against a pre-fetched page of it, so a record well past any client-side
   * limit is still findable.
   */
  it('finds a record that a fixed-limit dropdown would never have shown', async () => {
    for (let i = 0; i < 30; i += 1) {
      await createCustomer(manager, { name: `Filler Customer ${i}` });
    }
    await createCustomer(manager, { name: 'Zzz Last Alphabetically' });

    const res = await api()
      .get('/api/customers/options?search=Zzz')
      .set(manager.headers);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Zzz Last Alphabetically');
  });

  it('returns only the fields a picker needs', async () => {
    await createCustomer(manager, { name: 'Acme', notes: 'a long internal note' });

    const res = await api().get('/api/customers/options').set(manager.headers);

    // Small payload per keystroke is the reason this endpoint exists at all.
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['_id', 'company', 'email', 'name']);
  });

  /**
   * A picker must not be a back door. A sales rep searching here sees exactly
   * what the list endpoint would have shown them and nothing more.
   */
  it('applies the same scope rules as the customer list', async () => {
    const rep = await createRep();
    await createCustomer(manager, { name: 'Someone Elses Customer' });
    await createCustomer(rep, { name: 'My Own Customer' });

    const res = await api().get('/api/customers/options').set(rep.headers);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('My Own Customer');
  });

  it('does not let a rep find another rep’s customer by searching for it', async () => {
    const rep = await createRep();
    await createCustomer(manager, { name: 'Secret Account' });

    const res = await api()
      .get('/api/customers/options?search=Secret')
      .set(rep.headers);

    expect(res.body.data).toHaveLength(0);
  });

  /**
   * The cap is enforced server-side rather than trusted from the query string,
   * so the endpoint cannot be turned into a bulk export of the customer table.
   */
  it('caps the result count however large a limit is requested', async () => {
    for (let i = 0; i < 40; i += 1) {
      await createCustomer(manager, { name: `Customer ${i}` });
    }

    const res = await api()
      .get('/api/customers/options?limit=10000')
      .set(manager.headers);

    expect(res.body.data.length).toBeLessThanOrEqual(25);
  });

  it('returns results with no search term, for the initial open', async () => {
    await createCustomer(manager, { name: 'Acme' });

    const res = await api().get('/api/customers/options').set(manager.headers);

    expect(res.body.data).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const res = await api().get('/api/customers/options');
    expect(res.status).toBe(401);
  });

  /** Route ordering: "options" must not be parsed as a customer id. */
  it('is not mistaken for a customer id', async () => {
    const res = await api().get('/api/customers/options').set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('GET /api/products/options', () => {
  let manager;

  beforeEach(async () => {
    manager = await createManager();
  });

  it('searches by name', async () => {
    await createProduct({ name: 'Blue Widget', sku: 'BW-1' });
    await createProduct({ name: 'Red Gadget', sku: 'RG-1' });

    const res = await api()
      .get('/api/products/options?search=widget')
      .set(manager.headers);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Blue Widget');
  });

  it('searches by SKU, which is how people actually look products up', async () => {
    await createProduct({ name: 'Blue Widget', sku: 'BW-77' });

    const res = await api()
      .get('/api/products/options?search=BW-77')
      .set(manager.headers);

    expect(res.body.data).toHaveLength(1);
  });

  /**
   * Price and stock come back with the option even though they are not the
   * label — the order form shows both and totals the order from them, so
   * including them here saves a follow-up request per line.
   */
  it('includes the price and stock the order form needs', async () => {
    await createProduct({ name: 'Blue Widget', sku: 'BW-1', price: 25, stockQty: 7 });

    const res = await api().get('/api/products/options').set(manager.headers);

    expect(res.body.data[0]).toMatchObject({ price: 25, stockQty: 7, sku: 'BW-1' });
  });

  /** Sales reps have read-only access to products, so the picker must work for them. */
  it('is available to a sales rep', async () => {
    const rep = await createRep();
    await createProduct({ name: 'Blue Widget' });

    const res = await api().get('/api/products/options').set(rep.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('caps the result count', async () => {
    for (let i = 0; i < 40; i += 1) {
      await createProduct({ name: `Product ${i}`, sku: `SKU-OPT-${i}` });
    }

    const res = await api()
      .get('/api/products/options?limit=999')
      .set(manager.headers);

    expect(res.body.data.length).toBeLessThanOrEqual(25);
  });

  it('requires authentication', async () => {
    const res = await api().get('/api/products/options');
    expect(res.status).toBe(401);
  });

  /** Route ordering again — "options" sits alongside "categories" before "/:id". */
  it('is not mistaken for a product id', async () => {
    const res = await api().get('/api/products/options').set(manager.headers);
    expect(res.status).toBe(200);
  });

  /**
   * A search that escapes regex characters rather than interpreting them. "C++"
   * would otherwise be an invalid pattern and 500 the endpoint.
   */
  it('treats regex characters in the search as literal text', async () => {
    await createProduct({ name: 'C++ Handbook', sku: 'BOOK-1' });

    const res = await api()
      .get('/api/products/options?search=' + encodeURIComponent('C++'))
      .set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
