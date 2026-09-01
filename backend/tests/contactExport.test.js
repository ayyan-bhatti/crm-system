const ExcelJS = require('exceljs');
const { api, createAdmin, createManager, createRep, createCustomer } = require('./helpers');
const Customer = require('../src/models/Customer');
const AuditLog = require('../src/models/AuditLog');
const { setConsentEverywhere } = require('../src/services/unsubscribeService');
const { safeText } = require('../src/services/contactExportService');

/**
 * Exporting the contact book.
 *
 * WHY THIS GETS ITS OWN SUITE RATHER THAN A LINE IN THE CONTACTS ONE
 *
 * An export is the largest single data exposure this application has, and it
 * has three properties that all have to hold at once: the file must be a real
 * spreadsheet, it must contain exactly the filtered view and no more, and it
 * must be restricted and recorded. Any one of those failing quietly is a
 * problem discovered after the file has been emailed to somebody.
 *
 * The workbook is READ BACK with a real xlsx parser rather than being checked
 * for a magic number. "Produces a real .xlsx" is the requirement, and a
 * corrupt archive with the right first four bytes would pass a byte check and
 * fail to open in Excel — which is the only test that actually matters and the
 * one that cannot be automated here. Parsing it is the closest honest proxy.
 */

/** Parse an xlsx response body back into a workbook. */
async function readWorkbook(body) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body);
  return workbook;
}

/** Every data row of the Contacts sheet, as objects keyed by header. */
function rowsOf(workbook) {
  const sheet = workbook.getWorksheet('Contacts');
  const headers = sheet.getRow(1).values.slice(1);
  const rows = [];

  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const values = row.values.slice(1);
    rows.push(Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ''])));
  });

  return rows;
}

describe('exporting contacts to Excel', () => {
  it('produces a file a real spreadsheet parser can open', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'exported@example.com', name: 'Exported Person' });

    const res = await api()
      .get('/api/contacts/export')
      .set(admin.headers)
      .buffer()
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="contacts-/);

    const workbook = await readWorkbook(res.body);
    const rows = rowsOf(workbook);

    expect(rows.some((r) => r.Email === 'exported@example.com')).toBe(true);
  });

  it('carries the columns the round asked for, and no commercial figures', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'columns@example.com' });

    const res = await exportAs(admin);
    const sheet = (await readWorkbook(res.body)).getWorksheet('Contacts');
    const headers = sheet.getRow(1).values.slice(1);

    expect(headers).toEqual([
      'Name',
      'Email',
      'Phone',
      'Source',
      'Email opt-in',
      'Email opt-in date',
      'SMS opt-in',
      'SMS opt-in date',
      'WhatsApp opt-in',
      'WhatsApp opt-in date',
      'Segments',
      'Tags',
    ]);

    /*
     * Explicitly NOT present. Lifetime revenue and order counts were offered
     * and declined — a contact export is already the biggest data exposure
     * here, and every extra column is more of the business's commercial
     * position in a file that by design leaves the system.
     */
    expect(headers).not.toContain('Lifetime value');
    expect(headers).not.toContain('Orders');
  });

  it('reports opt-in state as words a person can read', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'consented@example.com' });
    await setConsentEverywhere('consented@example.com', { email: true });

    const res = await exportAs(admin);
    const row = rowsOf(await readWorkbook(res.body)).find(
      (r) => r.Email === 'consented@example.com'
    );

    expect(row['Email opt-in']).toBe('Yes');
    expect(row['SMS opt-in']).toBe('No');
    expect(row['Email opt-in date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * THE FILE MUST MATCH WHAT IS ON SCREEN.
   *
   * A button that exported everything regardless of the active filters would
   * be a different feature wearing the same label, and the difference would
   * only be discovered after the file had been sent to somebody.
   */
  it('exports exactly the filtered view, not the whole book', async () => {
    const admin = await createAdmin();

    await createCustomer(admin, { email: 'in@example.com' });
    await createCustomer(admin, { email: 'out@example.com' });
    await setConsentEverywhere('in@example.com', { email: true });

    const res = await exportAs(admin, '?channel=email&optedIn=yes');
    const emails = rowsOf(await readWorkbook(res.body)).map((r) => r.Email);

    expect(emails).toContain('in@example.com');
    expect(emails).not.toContain('out@example.com');
  });

  it('records what the file was, on its own sheet', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'provenance@example.com' });

    const res = await exportAs(admin, '?source=crm');
    const about = (await readWorkbook(res.body)).getWorksheet('About this export');

    expect(about).toBeTruthy();

    const values = [];
    about.eachRow((row) => values.push(row.values.slice(1).join(' | ')));
    const text = values.join('\n');

    expect(text).toContain('Exported by');
    expect(text).toContain(admin.user.email);
    expect(text).toContain('source: crm');
  });

  /* ---- permissions ----------------------------------------------------- */

  /**
   * ADMIN ONLY, and deliberately stricter than viewing the same rows. Reading
   * contacts a page at a time and downloading the whole filtered book are
   * different acts even over identical data.
   */
  it('refuses a manager, who can see every one of these contacts on screen', async () => {
    const manager = await createManager();
    const res = await api().get('/api/contacts/export').set(manager.headers);
    expect(res.status).toBe(403);
  });

  it('refuses a sales rep', async () => {
    const rep = await createRep();
    expect((await api().get('/api/contacts/export').set(rep.headers)).status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    expect((await api().get('/api/contacts/export')).status).toBe(401);
  });

  /**
   * The route is declared before `/:email`, or "export" would be read as an
   * email address — the same trap `/orders/deliveries` sits in front of. A
   * manager hitting it would then get a 404 for a contact rather than the 403
   * the permission model intends, which is a confusing way to be told no.
   */
  it('is a route rather than a contact called "export"', async () => {
    const admin = await createAdmin();
    const res = await api().get('/api/contacts/export').set(admin.headers);
    expect(res.status).not.toBe(404);
  });

  /* ---- audit ----------------------------------------------------------- */

  it('writes the export to the audit trail, with the filters and the row count', async () => {
    const admin = await createAdmin();
    await createCustomer(admin, { email: 'audited@example.com' });

    await exportAs(admin, '?source=crm');

    const entry = await AuditLog.findOne({ action: 'export', entity: 'contact' });

    expect(entry).toBeTruthy();
    expect(entry.actor.email).toBe(admin.user.email);
    expect(entry.note).toMatch(/Exported \d+ contacts to Excel/);
    expect(entry.note).toContain('source: crm');
  });
});

describe('spreadsheet formula injection', () => {
  /**
   * A cell whose text begins with `=`, `+`, `-` or `@` is EXECUTED as a formula
   * when the file is opened. Names and tags here are typed by staff, so a
   * contact named `=HYPERLINK(...)` would become a live link in every
   * spreadsheet the file is opened in. This is CSV injection, which xlsx
   * inherits.
   */
  it('neutralises a value Excel would otherwise run as a formula', () => {
    expect(safeText('=HYPERLINK("http://evil","click")')).toMatch(/^'=/);
    expect(safeText('+1234')).toMatch(/^'\+/);
    expect(safeText('-1234')).toMatch(/^'-/);
    expect(safeText('@SUM(A1)')).toMatch(/^'@/);
  });

  it('leaves an ordinary value alone', () => {
    expect(safeText('Karachi Traders')).toBe('Karachi Traders');
    expect(safeText('ayesha@example.com')).toBe('ayesha@example.com');
  });

  it('escapes it in the actual file, not just in the helper', async () => {
    const admin = await createAdmin();
    const customer = await createCustomer(admin, { email: 'formula@example.com' });
    await Customer.updateOne({ _id: customer._id }, { name: '=1+1' });

    const res = await exportAs(admin);
    const row = rowsOf(await readWorkbook(res.body)).find((r) => r.Email === 'formula@example.com');

    expect(row.Name).toBe("'=1+1");
  });
});

/** Fetch the export as raw bytes — supertest otherwise decodes it as text. */
function exportAs(actor, query = '') {
  return api()
    .get(`/api/contacts/export${query}`)
    .set(actor.headers)
    .buffer()
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}
