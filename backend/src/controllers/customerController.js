const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const {
  hasFullRecordAccess,
  canAccessCustomer,
  canWriteCustomers,
} = require('../middleware/roles');
const changeRequestService = require('../services/changeRequestService');
const { recordAudit } = require('../services/auditService');
const { applyConsent, consentFromBody } = require('../models/marketingConsent');
const { parseWorkbook, importCustomers: runImport } = require('../services/customerImportService');
const {
  containsRegex,
  getPagination,
  getSort,
  paginatedResponse,
  applyCursor,
  cursorResponse,
} = require('../utils/queryHelpers');

const SORTABLE_FIELDS = ['name', 'email', 'company', 'status', 'createdAt'];

/**
 * The slice of the customer collection a user is allowed to see.
 *
 * Admins and managers get `{}` — everything — and nobody else reaches these
 * routes at all: the router requires manager-or-admin before any handler runs.
 *
 * This used to narrow a sales rep to customers they owned. That rule is gone
 * along with a rep's access to the customer book; keeping a filter for a role
 * that cannot get here would be dead code pretending to be a safeguard.
 *
 * Still a function, and still applied to the QUERY rather than to fetched
 * results, because the order controller derives its own scope from it and the
 * `total` used for pagination has to reflect what the caller can actually see.
 */
function customerScopeFilter(user) {
  return hasFullRecordAccess(user) ? {} : { _id: null };
}

/**
 * GET /api/customers
 * Filters: ?status= ?assignedTo= ?city= ?search= (name / email / company)
 * Paging:  ?page= ?limit= ?sort=
 */
const listCustomers = asyncHandler(async (req, res) => {
  const { status, assignedTo, city, search } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  // Start from the caller's permitted scope, then narrow with their filters.
  const filter = { ...customerScopeFilter(req.user) };

  if (status) filter.status = status;
  if (assignedTo) filter.assignedTo = assignedTo;
  if (city) filter.city = containsRegex(city);

  if (search) {
    const rx = containsRegex(search);
    const searchClause = [{ name: rx }, { email: rx }, { company: rx }];

    // A sales rep's scope already uses $or. Combining the two with $and keeps
    // both conditions intact — a plain overwrite would silently drop the scope
    // filter and leak other reps' customers.
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchClause }];
      delete filter.$or;
    } else {
      filter.$or = searchClause;
    }
  }

  const sort = getSort(req.query, SORTABLE_FIELDS);

  /*
   * Two paging modes on one endpoint, chosen by whether `?cursor=` is present.
   *
   * Offset is the default because the UI wants page numbers and a total.
   * Cursor is there for deep traversal and for callers that cannot tolerate
   * drift — see the long note in utils/queryHelpers.js for the trade-off.
   */
  if (req.query.cursor !== undefined) {
    // limit + 1 so the response can say whether another page exists without a
    // second count query.
    const data = await Customer.find(applyCursor(filter, req.query.cursor, sort))
      .populate('assignedTo', 'name email role')
      .sort(sort)
      .limit(limit + 1);

    return res.json(cursorResponse({ data, limit, sort }));
  }

  const [data, total] = await Promise.all([
    Customer.find(filter)
      .populate('assignedTo', 'name email role')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Customer.countDocuments(filter),
  ]);

  return res.json(paginatedResponse({ data, total, page, limit }));
});

/**
 * GET /api/customers/options?search=&limit=
 *
 * A deliberately minimal endpoint for the searchable customer picker.
 *
 * WHY NOT JUST REUSE GET /api/customers
 *
 * It would work, and the temptation is real — one endpoint, one code path. But
 * a picker fires a request per pause in typing, and the list endpoint returns
 * whole customer documents WITH `assignedTo` populated. That is a second query
 * to the users collection and a payload of notes, phone numbers and timestamps,
 * per keystroke, to render a line of text.
 *
 * So this returns four fields, unpopulated, `.lean()` — plain objects with no
 * Mongoose document wrapper, which is measurably cheaper when the result is
 * about to be serialised straight to JSON and thrown away.
 *
 * The cost of the decision is one more endpoint to keep in step with the
 * permission rules. That is paid by reusing `customerScopeFilter`, the same
 * function the list endpoint uses — so a sales rep cannot discover customers
 * through the picker that the list would have hidden.
 */
const listCustomerOptions = asyncHandler(async (req, res) => {
  const { search } = req.query;

  /*
   * A tighter cap than the list endpoint's.
   *
   * A picker showing more than about twenty options is not helping anyone —
   * past that, the answer is to type more, not to scroll further. Capping here
   * rather than trusting `?limit=` also means the endpoint cannot be turned
   * into a bulk export of the customer table by a caller passing limit=10000.
   */
  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 25);

  const filter = { ...customerScopeFilter(req.user) };

  if (search) {
    const rx = containsRegex(search);
    const searchClause = [{ name: rx }, { email: rx }, { company: rx }];

    // Same $and dance as the list endpoint: a sales rep's scope is already an
    // $or, and overwriting it would leak other reps' customers.
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchClause }];
      delete filter.$or;
    } else {
      filter.$or = searchClause;
    }
  }

  const data = await Customer.find(filter)
    .select('name email company')
    .sort({ name: 1 })
    .limit(limit)
    .lean();

  res.json({ success: true, count: data.length, data });
});

/** GET /api/customers/:id */
const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id)
    .populate('assignedTo', 'name email role')
    .populate('createdBy', 'name email role');

  if (!customer) throw ApiError.notFound('Customer not found');

  if (!canAccessCustomer(req.user, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  res.json({ success: true, data: customer });
});

/**
 * POST /api/customers
 *
 * A sales rep who does not name an assignee is assigned the customer, so the
 * record they just created doesn't immediately fall outside their own scope.
 */
const createCustomer = asyncHandler(async (req, res) => {
  const { name, email, phone, address, company, city, status, notes, assignedTo } = req.body;

  const fields = {
    name,
    email,
    phone,
    address,
    company,
    city,
    status,
    notes,
    assignedTo: assignedTo || req.user._id,
    createdBy: req.user._id,
  };

  /*
   * MARKETING CONSENT, CAPTURED AT CREATION.
   *
   * Built by `applyConsent` onto a bare object rather than assigned as raw
   * booleans, so the timestamps are stamped by the same code that stamps them
   * everywhere else — a consent recorded here has to be indistinguishable from
   * one recorded at the storefront, or "when did they agree" gets a different
   * quality of answer depending on which form was used.
   *
   * A checkbox that is absent leaves the channel off, which is what the
   * schema defaults to anyway. There is no path through this handler that can
   * produce an opted-in customer without an explicit `true` in the body.
   */
  const consentChanges = consentFromBody(req.body);
  if (Object.keys(consentChanges).length) {
    const holder = { marketing: {} };
    applyConsent(holder, consentChanges);
    fields.marketing = holder.marketing;
  }

  /*
   * A manager PROPOSES; an admin DOES.
   *
   * Nothing is written here for a manager — the intended customer is held in a
   * change request and created on approval. Writing it now and deleting it on
   * rejection would be simpler and wrong: in between, the customer is live and
   * an order can be placed against it.
   *
   * The admin's own change applies immediately. Requiring them to approve
   * themselves would be theatre, and a queue that fills with your own requests
   * is a queue you stop reading.
   */
  if (!canWriteCustomers(req.user)) {
    const request = await changeRequestService.submit(
      { entity: 'customer', action: 'create', payload: fields, label: name || '(unnamed)' },
      req.user
    );

    return res.status(202).json({
      success: true,
      message: 'Sent to an administrator for approval. The customer is not created yet.',
      data: request,
    });
  }

  const customer = await Customer.create(fields);

  await customer.populate('assignedTo', 'name email role');

  await recordAudit(req, {
    action: 'create',
    entity: 'customer',
    entityId: customer._id,
    after: customer,
  });

  res.status(201).json({ success: true, data: customer });
});

/**
 * PATCH /api/customers/:id
 *
 * Loaded first, then permission-checked, then mutated — so a sales rep cannot
 * edit a customer that isn't theirs even though the route is open to them.
 */
const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');

  if (!canAccessCustomer(req.user, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  // Snapshotted BEFORE any field is touched. Taking it afterwards would record
  // the new values as the old ones and make the trail actively misleading.
  const before = customer.toObject();

  /*
   * Whitelisted fields only: `createdBy` must never be reassigned by a client,
   * and `assignedTo` is handled separately below because it is a decision about
   * people rather than a property of the record.
   */
  const editable = ['name', 'email', 'phone', 'address', 'company', 'city', 'status', 'notes'];

  const changes = {};
  editable.forEach((field) => {
    if (req.body[field] !== undefined) changes[field] = req.body[field];
  });

  if (req.body.assignedTo !== undefined) {
    changes.assignedTo = req.body.assignedTo || null;
  }

  /*
   * Consent, if the form sent any.
   *
   * Applied to a copy of the CURRENT block so `applyConsent` sees the existing
   * state and can tell a change from a no-op — that is what keeps `optInAt`
   * from being pushed forward every time somebody saves the form with the box
   * already ticked. Reconstructing it from scratch would reset the date
   * consent was given to the date the record was last edited, which is the
   * one field whose whole value is that it does not move.
   *
   * It goes through the same change-request queue as every other field below,
   * so a MANAGER ticking a consent box proposes it rather than writing it —
   * consistent with the rest of the customer book, and arguably more important
   * here than for a phone number.
   */
  const consentChanges = consentFromBody(req.body);
  if (Object.keys(consentChanges).length) {
    const holder = { marketing: customer.toObject().marketing || {} };
    applyConsent(holder, consentChanges);
    changes.marketing = holder.marketing;
  }

  /*
   * A manager's edit becomes a request rather than a write. The payload holds
   * only the fields that were actually sent, so approving it later changes
   * exactly what was proposed and nothing that has moved on since.
   */
  if (!canWriteCustomers(req.user)) {
    const request = await changeRequestService.submit(
      {
        entity: 'customer',
        entityId: customer._id,
        action: 'update',
        payload: changes,
        label: customer.name,
      },
      req.user
    );

    return res.status(202).json({
      success: true,
      message: 'Sent to an administrator for approval. Nothing has changed yet.',
      data: request,
    });
  }

  Object.assign(customer, changes);

  await customer.save();

  await recordAudit(req, {
    action: 'update',
    entity: 'customer',
    entityId: customer._id,
    before,
    after: customer,
  });

  await customer.populate('assignedTo', 'name email role');

  res.json({ success: true, data: customer });
});

/** DELETE /api/customers/:id */
const deleteCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');

  if (!canAccessCustomer(req.user, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  const before = customer.toObject();

  /*
   * Deletion is the one a manager is most likely to want and the one most worth
   * a second pair of eyes: it takes the record and, with it, the history of
   * every order that referenced it by name.
   */
  if (!canWriteCustomers(req.user)) {
    const request = await changeRequestService.submit(
      {
        entity: 'customer',
        entityId: customer._id,
        action: 'delete',
        label: customer.name,
      },
      req.user
    );

    return res.status(202).json({
      success: true,
      message: 'Sent to an administrator for approval. The customer has not been deleted.',
      data: request,
    });
  }

  await customer.deleteOne();

  // The label matters most here: once the record is gone, nothing can look up
  // what "customer 652f8a…" used to be called.
  await recordAudit(req, {
    action: 'delete',
    entity: 'customer',
    entityId: customer._id,
    label: before.name,
    before,
  });

  res.json({ success: true, message: 'Customer deleted', data: { id: req.params.id } });
});

/**
 * POST /api/customers/import — admin only.
 *
 * Body: multipart/form-data, one file field named `file`, an .xlsx workbook
 * with a header row of Name, Email, and optionally Phone, Company, City,
 * Address, Status — see services/customerImportService.js for the full
 * column mapping and duplicate-handling rules.
 *
 * WHY THIS IS ADMIN-ONLY RATHER THAN FOLLOWING createCustomer's
 * ADMIN-DIRECT/MANAGER-VIA-APPROVAL SPLIT
 *
 * `createCustomer` queues a MANAGER'S single new customer as one change
 * request for an admin to approve. A bulk import of, say, 200 rows does not
 * have an equivalent that is still a "change request" in any useful sense —
 * either every row becomes its own request (200 approvals for one upload,
 * which nobody is going to click through one at a time) or the whole batch
 * becomes one opaque request an admin approves blind, unable to see which of
 * the 200 rows they are actually agreeing to. Both are worse than the export
 * screen's already-established rule for exactly this shape of action: taking
 * a large, batch-level action on the customer book is admin-only, same as
 * downloading the whole filtered contact list is.
 */
const importCustomers = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw ApiError.badRequest('Attach an .xlsx file under the "file" field.');
  }

  const rows = await parseWorkbook(req.file.buffer);
  const result = await runImport(rows, req.user);

  /*
   * One entry for the whole upload, not one per row created — see the note on
   * the `import` action in models/AuditLog.js for why. `entityId` stays null:
   * there is no single record this action is "about".
   */
  await recordAudit(req, {
    action: 'import',
    entity: 'customer',
    label: req.file.originalname,
    note:
      `${result.created.length} created, ${result.skipped.length} skipped, ` +
      `${result.failed.length} failed, out of ${result.totalRows} rows`,
  });

  res.json({ success: true, data: result });
});

module.exports = {
  customerScopeFilter,
  listCustomers,
  listCustomerOptions,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  importCustomers,
};
