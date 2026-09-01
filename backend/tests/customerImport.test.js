const ExcelJS = require('exceljs');
const { api, createAdmin, createManager, createRep, createCustomer } = require('./helpers');
const Customer = require('../src/models/Customer');
const AuditLog = require('../src/models/AuditLog');

/**
 * Importing customers from an Excel sheet.
 *
 * THE CENTRAL CLAIM: ONE BAD ROW MUST NOT COST THE REST OF THE FILE.
 *
 * A real spreadsheet someone hand-edited has typos, blank rows, and the
 * occasional duplicate of a customer already in the CRM. An import that
 * aborted on the first problem would be worse than useless — the caller has
 * no way to know how far it got. Every test that mixes a good row with a bad
 * one is checking that the good row still lands.
 */

/** Build a real .xlsx buffer with the given header labels and rows. */
async function buildWorkbook(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customers');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

const FULL_HEADERS = ['Name', 'Email', 'Phone', 'Company', 'City', 'Address', 'Status'];

describe('POST /api/customers/import', () => {
  it('creates a customer for every valid row', async () => {
    const admin = await createAdmin();
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ['Amina Raza', 'amina@karachitraders.example', '0300', 'Karachi Traders', 'Karachi', '', 'lead'],
      ['Bilal Ahmed', 'bilal@lahoregoods.example', '', 'Lahore Goods', 'Lahore', '', 'active'],
    ]);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.created).toHaveLength(2);
    expect(res.body.data.totalRows).toBe(2);

    const stored = await Customer.findOne({ email: 'amina@karachitraders.example' });
    expect(stored.name).toBe('Amina Raza');
    expect(stored.company).toBe('Karachi Traders');
    expect(stored.status).toBe('lead');
    // Attributed to whoever ran the import, the same as a single created customer.
    expect(String(stored.createdBy)).toBe(String(admin.user._id));
  });

  it('skips a row whose email already belongs to a customer, and says so, without touching the existing record', async () => {
    const admin = await createAdmin();
    const existing = await createCustomer(admin, {
      email: 'already-here@example.com',
      name: 'Original Name',
      company: 'Original Co',
    });

    const buffer = await buildWorkbook(FULL_HEADERS, [
      ['Overwrite Attempt', 'already-here@example.com', '', 'New Co', '', '', ''],
      ['New Person', 'genuinely-new@example.com', '', '', '', '', ''],
    ]);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.skipped).toHaveLength(1);
    expect(res.body.data.skipped[0].email).toBe('already-here@example.com');

    const unchanged = await Customer.findById(existing._id);
    expect(unchanged.name).toBe('Original Name');
    expect(unchanged.company).toBe('Original Co');
  });

  it('is case-insensitive when matching an existing email', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'reader@example.com' });

    const buffer = await buildWorkbook(FULL_HEADERS, [
      ['Someone', 'READER@EXAMPLE.COM', '', '', '', '', ''],
    ]);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.body.data.skipped).toHaveLength(1);
  });

  it('reports a row with no name or an invalid email as failed, and still creates the rest', async () => {
    const admin = await createAdmin();
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ['', 'no-name@example.com', '', '', '', '', ''],
      ['No Email Here', 'not-an-email', '', '', '', '', ''],
      ['Good Row', 'good@example.com', '', '', '', '', ''],
    ]);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.failed).toHaveLength(2);
    expect(res.body.data.failed.map((f) => f.reason)).toEqual([
      expect.stringMatching(/name/i),
      expect.stringMatching(/email/i),
    ]);
  });

  it('ignores a wholly blank row rather than reporting it as a failure', async () => {
    const admin = await createAdmin();
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ['Real Row', 'real@example.com', '', '', '', '', ''],
      [],
    ]);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.body.data.totalRows).toBe(1);
    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.failed).toHaveLength(0);
  });

  it('works with only Name and Email columns — everything else is optional', async () => {
    const admin = await createAdmin();
    const buffer = await buildWorkbook(['Name', 'Email'], [['Minimal Row', 'minimal@example.com']]);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.created).toHaveLength(1);
  });

  it('refuses a workbook with no Email column', async () => {
    const admin = await createAdmin();
    const buffer = await buildWorkbook(['Name', 'Phone'], [['Someone', '0300']]);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email/i);
    expect(await Customer.countDocuments({})).toBe(0);
  });

  it('refuses a request with no file attached', async () => {
    const admin = await createAdmin();

    const res = await api().post('/api/customers/import').set(admin.headers);

    expect(res.status).toBe(400);
  });

  it('is admin-only — a manager is refused', async () => {
    const manager = await createManager();
    const buffer = await buildWorkbook(FULL_HEADERS, [['Someone', 'someone@example.com', '', '', '', '', '']]);

    const res = await api()
      .post('/api/customers/import')
      .set(manager.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.status).toBe(403);
    expect(await Customer.countDocuments({})).toBe(0);
  });

  it('is admin-only — a sales rep is refused', async () => {
    const rep = await createRep();
    const buffer = await buildWorkbook(FULL_HEADERS, [['Someone', 'someone@example.com', '', '', '', '', '']]);

    const res = await api()
      .post('/api/customers/import')
      .set(rep.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const buffer = await buildWorkbook(FULL_HEADERS, [['Someone', 'someone@example.com', '', '', '', '', '']]);

    const res = await api().post('/api/customers/import').attach('file', buffer, 'customers.xlsx');

    expect(res.status).toBe(401);
  });

  it('records one audit entry for the whole upload, not one per row', async () => {
    const admin = await createAdmin();
    const buffer = await buildWorkbook(FULL_HEADERS, [
      ['Row One', 'row1@example.com', '', '', '', '', ''],
      ['Row Two', 'row2@example.com', '', '', '', '', ''],
    ]);

    await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    const entries = await AuditLog.find({ action: 'import', 'actor.user': admin.user._id });

    expect(entries).toHaveLength(1);
    expect(entries[0].note).toMatch(/2 created/);
    expect(entries[0].entityId).toBeNull();
  });

  it('refuses a sheet over the row limit', async () => {
    const admin = await createAdmin();
    const rows = Array.from({ length: 1001 }, (_, i) => [`Row ${i}`, `row${i}@example.com`, '', '', '', '', '']);
    const buffer = await buildWorkbook(FULL_HEADERS, rows);

    const res = await api()
      .post('/api/customers/import')
      .set(admin.headers)
      .attach('file', buffer, 'customers.xlsx');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/1000-row limit/i);
    expect(await Customer.countDocuments({})).toBe(0);
  }, 20000);
});
