const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { hasFullRecordAccess, canAccessCustomer } = require('../middleware/roles');
const {
  containsRegex,
  getPagination,
  getSort,
  paginatedResponse,
} = require('../utils/queryHelpers');

const SORTABLE_FIELDS = ['name', 'email', 'company', 'status', 'createdAt'];

/**
 * The slice of the customer collection a user is allowed to see.
 *
 * Admins and managers get `{}` (everything). Sales reps get a filter limiting
 * them to customers they created or are assigned to.
 *
 * This is applied to the *query*, not to the results after fetching, so the
 * `total` count used for pagination reflects what the user can actually see.
 * Exported because the order controller needs the same rule.
 */
function customerScopeFilter(user) {
  if (hasFullRecordAccess(user)) return {};
  return { $or: [{ assignedTo: user._id }, { createdBy: user._id }] };
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

  const [data, total] = await Promise.all([
    Customer.find(filter)
      .populate('assignedTo', 'name email role')
      .sort(getSort(req.query, SORTABLE_FIELDS))
      .skip(skip)
      .limit(limit),
    Customer.countDocuments(filter),
  ]);

  res.json(paginatedResponse({ data, total, page, limit }));
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
  const { name, email, phone, company, city, status, notes, assignedTo } = req.body;

  const customer = await Customer.create({
    name,
    email,
    phone,
    company,
    city,
    status,
    notes,
    assignedTo: assignedTo || req.user._id,
    createdBy: req.user._id,
  });

  await customer.populate('assignedTo', 'name email role');

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

  // Whitelisted fields only: `createdBy` must never be reassigned by a client,
  // and reassigning `assignedTo` is a manager/admin decision.
  const editable = ['name', 'email', 'phone', 'company', 'city', 'status', 'notes'];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) customer[field] = req.body[field];
  });

  if (req.body.assignedTo !== undefined) {
    if (!hasFullRecordAccess(req.user)) {
      throw ApiError.forbidden('Only managers and admins can reassign a customer');
    }
    customer.assignedTo = req.body.assignedTo || null;
  }

  await customer.save();
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

  await customer.deleteOne();

  res.json({ success: true, message: 'Customer deleted', data: { id: req.params.id } });
});

module.exports = {
  customerScopeFilter,
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
