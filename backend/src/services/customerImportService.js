const ExcelJS = require('exceljs');
const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const { CUSTOMER_STATUS_VALUES, MAX_CUSTOMER_IMPORT_ROWS } = require('../config/constants');

/**
 * Bringing a customer spreadsheet into the CRM — the reverse of
 * `contactExportService`, and deliberately narrower than it might be.
 *
 * WHY THE COLUMN SET MATCHES THE EXPORT'S CUSTOMER FIELDS, NOT THE CONTACT
 * EXPORT'S COLUMNS
 *
 * `/api/contacts/export` produces a MERGED marketing view — Customer and
 * Buyer records joined by email, with consent and computed segments. That is
 * not what this imports INTO: a bulk import creates plain `Customer` rows,
 * the same shape `POST /api/customers` accepts one at a time. So the expected
 * header row is Name / Email / Phone / Company / City / Address / Status —
 * every field the Customer model actually has, nothing from the marketing
 * layer that this endpoint has no business setting.
 *
 * WHY A DUPLICATE EMAIL IS SKIPPED RATHER THAN MERGED OR REJECTED WHOLESALE
 *
 * The Customer model has no uniqueness constraint on email — two customers
 * can legitimately share an address (a shared company inbox, a couple who
 * shops together) — so "duplicate" here means "already in the CRM", found by
 * a case-insensitive lookup, and the safe default is to leave that existing
 * record untouched rather than silently overwrite whatever a sales rep has
 * already been doing with it. One bad row must not abort the rows around it
 * either, which is why this returns a summary rather than throwing on the
 * first problem — an import of 200 rows where row 47 has no email should
 * still create the other 199.
 */

const REQUIRED_HEADERS = ['name', 'email'];

/** Header cell text -> the Customer field it maps to. Case/space-insensitive. */
const HEADER_MAP = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  company: 'company',
  city: 'city',
  address: 'address',
  status: 'status',
};

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase();
}

function cellText(cell) {
  if (cell == null) return '';
  // exceljs hands back a rich object for a hyperlink/formula cell rather than
  // a plain string; `.text` (or `.result` for a formula) is where the value a
  // human sees actually lives.
  if (typeof cell === 'object') return String(cell.text ?? cell.result ?? '').trim();
  return String(cell).trim();
}

/**
 * Read the uploaded workbook into plain row objects.
 *
 * Throws `ApiError.badRequest` for anything that makes the file itself
 * unusable — no readable worksheet, no header row, a header missing Name or
 * Email, or more rows than `MAX_CUSTOMER_IMPORT_ROWS`. A problem with one
 * ROW's data (a bad email, a missing name) is not one of these — that is
 * `importCustomers`'s job to report per-row, because the rest of the file is
 * still usable.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Array<{ rowNumber: number, name: string, email: string, phone: string, company: string, city: string, address: string, status: string }>>}
 */
async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    throw ApiError.badRequest(`That file could not be read as an Excel workbook: ${err.message}`);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 1) {
    throw ApiError.badRequest('The workbook has no worksheet with any rows in it.');
  }

  const headerRow = sheet.getRow(1);
  const columnForField = {}; // field name -> 1-based column index

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const field = HEADER_MAP[normalizeHeader(cell.value)];
    if (field) columnForField[field] = colNumber;
  });

  const missing = REQUIRED_HEADERS.filter((field) => !columnForField[field]);
  if (missing.length) {
    throw ApiError.badRequest(
      `The header row is missing required column(s): ${missing.join(', ')}. Expected Name, ` +
        'Email, and optionally Phone, Company, City, Address, Status.'
    );
  }

  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    // A wholly blank row (common at the end of a sheet someone hand-edited)
    // is not a data row to report on — it is simply not there.
    if (row.cellCount === 0 || row.values.every((v) => v == null || v === '')) continue;

    rows.push({
      rowNumber: r,
      name: cellText(row.getCell(columnForField.name).value),
      email: cellText(row.getCell(columnForField.email).value).toLowerCase(),
      phone: columnForField.phone ? cellText(row.getCell(columnForField.phone).value) : '',
      company: columnForField.company ? cellText(row.getCell(columnForField.company).value) : '',
      city: columnForField.city ? cellText(row.getCell(columnForField.city).value) : '',
      address: columnForField.address ? cellText(row.getCell(columnForField.address).value) : '',
      status: columnForField.status ? cellText(row.getCell(columnForField.status).value).toLowerCase() : '',
    });
  }

  if (rows.length > MAX_CUSTOMER_IMPORT_ROWS) {
    throw ApiError.badRequest(
      `This sheet has ${rows.length} rows, over the ${MAX_CUSTOMER_IMPORT_ROWS}-row limit for one ` +
        'import. Split it into smaller files.'
    );
  }

  return rows;
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * Create a `Customer` for each valid, non-duplicate row.
 *
 * Never throws for a per-row problem — every row is either created, skipped
 * (with a reason), or failed (with a reason), and the caller gets all three
 * counts back rather than the process stopping at the first bad line.
 *
 * @param {ReturnType<typeof parseWorkbook> extends Promise<infer T> ? T : never} rows
 * @param {{ _id: import('mongoose').Types.ObjectId }} actor
 */
async function importCustomers(rows, actor) {
  const created = [];
  const skipped = [];
  const failed = [];

  for (const row of rows) {
    if (!row.name) {
      failed.push({ row: row.rowNumber, email: row.email, reason: 'Missing name' });
      continue;
    }
    if (!EMAIL_RE.test(row.email)) {
      failed.push({ row: row.rowNumber, email: row.email, reason: 'Missing or invalid email' });
      continue;
    }

    // Case-insensitive: Customer.email is stored lowercase by the schema, and
    // `row.email` is already lowercased in parseWorkbook, so a plain equality
    // query is enough — no regex needed.
    //
    // Sequential rather than Promise.all across all rows on purpose: a bad row
    // must not abort the batch (see the module note), and running every
    // lookup and create one at a time is what makes that guarantee simple to
    // reason about, at the cost of speed a bulk import does not need.
    const existing = await Customer.findOne({ email: row.email }).select('_id');
    if (existing) {
      skipped.push({ row: row.rowNumber, email: row.email, reason: 'A customer with this email already exists' });
      continue;
    }

    const status = CUSTOMER_STATUS_VALUES.includes(row.status) ? row.status : undefined;

    try {
      const customer = await Customer.create({
        name: row.name,
        email: row.email,
        phone: row.phone,
        company: row.company,
        city: row.city,
        address: row.address,
        ...(status ? { status } : {}),
        assignedTo: actor._id,
        createdBy: actor._id,
      });
      created.push({ row: row.rowNumber, email: row.email, id: customer._id });
    } catch (err) {
      failed.push({ row: row.rowNumber, email: row.email, reason: err.message });
    }
  }

  return { created, skipped, failed, totalRows: rows.length };
}

module.exports = { parseWorkbook, importCustomers, REQUIRED_HEADERS, HEADER_MAP };
