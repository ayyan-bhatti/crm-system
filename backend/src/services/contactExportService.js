const ExcelJS = require('exceljs');
const {
  CONTACT_CHANNEL_VALUES,
  CONTACT_SOURCE_LABELS,
  AUTO_SEGMENT_LABELS,
} = require('../config/marketing');

/**
 * The contacts export: a real `.xlsx`, built from whatever the screen is
 * currently filtered to.
 *
 * WHY A REAL WORKBOOK AND NOT A CSV WITH A DIFFERENT EXTENSION
 *
 * That trick is common and it is a lie that Excel exposes: it opens with a
 * "the file format does not match the extension" warning, mangles a phone
 * number starting with a plus into a formula error, and turns any non-ASCII
 * name into mojibake unless the reader guesses the encoding. The brief asks
 * for a real xlsx, and a real xlsx is also the one that does not corrupt
 * Pakistani phone numbers and names, which this dataset is full of.
 *
 * WHY exceljs
 *
 * An xlsx is a ZIP of XML parts, and hand-rolling the container is genuinely
 * possible — but "a spreadsheet Excel opens without complaint" has a long tail
 * of details (shared strings, the content-types part, the exact relationship
 * ids) where being 95% right produces a file that will not open at all. This
 * is the one place in this round where a dependency buys certainty that
 * matters, so it is taken knowingly.
 *
 * The one audit note it carries: exceljs depends on `uuid` below 11.1.1, which
 * has a moderate advisory about a missing bounds check in v3/v5/v6 WHEN A
 * CALLER SUPPLIES ITS OWN `buf` ARGUMENT. exceljs never does, and nothing here
 * calls uuid at all, so the vulnerable path is not reachable from this
 * application. Written down rather than left for somebody to rediscover in an
 * `npm audit` and have to work out from scratch.
 *
 * WHY THE EXPORT IS ADMIN-ONLY
 *
 * Enforced at the route, but the reasoning belongs next to the thing being
 * exported. Reading contacts a page at a time and downloading the whole book
 * as a file are not the same act, even for the same rows: one is looking
 * something up, the other is a copy of the customer list leaving the building
 * on a laptop. Every export is written to the audit trail for the same reason.
 */

/**
 * The columns, in order.
 *
 * EXACTLY WHAT THE BRIEF ASKED FOR AND NOTHING MORE — no lifetime revenue, no
 * order counts, no assigned rep. Those were offered and declined, and the
 * reason to keep the file narrow is that a contact export is already the
 * largest single data exposure this application has. Every extra column is
 * more of the business's commercial position in a file that, by design, leaves
 * the system.
 *
 * The consent DATES are included alongside the booleans because they are the
 * half that answers a complaint. "Did this person agree" is a yes/no; "prove
 * it" is a date.
 */
const COLUMNS = [
  { header: 'Name', key: 'name', width: 28 },
  { header: 'Email', key: 'email', width: 34 },
  { header: 'Phone', key: 'phone', width: 18 },
  { header: 'Source', key: 'source', width: 16 },
  { header: 'Email opt-in', key: 'emailOptIn', width: 12 },
  { header: 'Email opt-in date', key: 'emailOptInAt', width: 18 },
  { header: 'SMS opt-in', key: 'smsOptIn', width: 12 },
  { header: 'SMS opt-in date', key: 'smsOptInAt', width: 18 },
  { header: 'WhatsApp opt-in', key: 'whatsappOptIn', width: 14 },
  { header: 'WhatsApp opt-in date', key: 'whatsappOptInAt', width: 20 },
  { header: 'Segments', key: 'segments', width: 30 },
  { header: 'Tags', key: 'tags', width: 26 },
];

/**
 * A date as a string rather than an Excel date cell.
 *
 * Deliberate. An Excel date is a number plus a locale-dependent format, and
 * the same file opened in two places shows 03/04 as two different days. An
 * ISO date is unambiguous everywhere and still sorts correctly as text.
 */
function isoDate(value) {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Neutralise a value that Excel would otherwise treat as a formula.
 *
 * A cell whose text begins with `=`, `+`, `-` or `@` is executed as a formula
 * when the file is opened. Names and tags in this export are typed by staff,
 * and a contact tagged `=HYPERLINK(...)` would become a live link in every
 * spreadsheet the file is opened in — CSV injection, which xlsx inherits.
 *
 * Prefixing a single quote is the standard fix: Excel treats the rest as
 * literal text and does not display the quote. Applied to every free-text
 * column rather than only the ones that look risky, because "which fields can
 * a user control" is a question that changes as the app grows.
 */
function safeText(value) {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** One contact as one row. */
function toRow(contact) {
  const row = {
    name: safeText(contact.name),
    email: safeText(contact.email),
    phone: safeText(contact.phone),
    source: CONTACT_SOURCE_LABELS[contact.source] || contact.source,
    segments: contact.segments.map((s) => AUTO_SEGMENT_LABELS[s] || s).join(', '),
    tags: safeText(contact.tags.join(', ')),
  };

  for (const channel of CONTACT_CHANNEL_VALUES) {
    const block = contact.consent?.[channel];
    // "Yes"/"No" rather than TRUE/FALSE: this file is read by people, and a
    // filter dropdown reading Yes/No needs no explaining.
    row[`${channel}OptIn`] = block?.optIn ? 'Yes' : 'No';
    row[`${channel}OptInAt`] = isoDate(block?.optInAt);
  }

  return row;
}

/**
 * Build the workbook.
 *
 * @param {object[]} contacts already filtered and scoped by the caller
 * @param {object} [meta] what the file should say about itself
 * @returns {Promise<Buffer>}
 */
async function buildContactsWorkbook(contacts, meta = {}) {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'SimpleCRM';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Contacts', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = COLUMNS;

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEFF1F5' },
  };

  for (const contact of contacts) {
    sheet.addRow(toRow(contact));
  }

  /*
   * An autofilter across the header row, so the file is usable as a working
   * list rather than a dump — the point of exporting a FILTERED view is that
   * somebody is about to work with it.
   */
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: COLUMNS.length },
  };

  /*
   * A second sheet recording what this file IS.
   *
   * An export is a snapshot that immediately begins going stale, and a
   * spreadsheet with no provenance gets forwarded, re-forwarded and eventually
   * acted on months later by somebody who assumes it is current. Naming the
   * filters, the moment and the person costs one sheet and answers every
   * question the file will be asked.
   */
  const about = workbook.addWorksheet('About this export');
  about.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 52 },
  ];
  about.getRow(1).font = { bold: true };

  about.addRows([
    { field: 'Exported at', value: new Date().toISOString() },
    { field: 'Exported by', value: safeText(meta.exportedBy || '') },
    { field: 'Rows', value: contacts.length },
    { field: 'Filters applied', value: safeText(meta.filters || 'none') },
    {
      field: 'Note',
      value:
        'Opt-in status is correct as at the export time above and can change at any ' +
        'moment — a contact may unsubscribe after this file was made. Check the live ' +
        'contacts screen before sending anything.',
    },
  ]);

  return workbook.xlsx.writeBuffer();
}

/** A human description of the filters, for the About sheet and the audit note. */
function describeFilters(filters = {}) {
  const parts = [
    filters.source ? `source: ${filters.source}` : '',
    filters.segment ? `segment: ${filters.segment}` : '',
    filters.tag ? `tag: ${filters.tag}` : '',
    filters.channel && filters.optedIn
      ? `${filters.channel} opt-in: ${filters.optedIn}`
      : '',
    filters.search ? `search: "${filters.search}"` : '',
  ].filter(Boolean);

  return parts.length ? parts.join('; ') : 'none';
}

module.exports = { buildContactsWorkbook, describeFilters, COLUMNS, safeText };
