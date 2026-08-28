const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const ChangeRequest = require('../models/ChangeRequest');
const asyncHandler = require('../utils/asyncHandler');
const {
  ORDER_STATUS,
  CUSTOMER_STATUS_VALUES,
  CHANGE_REQUEST_STATUS,
  USER_STATUS,
  ROLES,
} = require('../config/constants');
const { customerScopeFilter } = require('./customerController');
const { orderScopeFilter } = require('./orderController');

/** How many months of history the trend chart shows. */
const TREND_MONTHS = 6;

/**
 * Build the list of months the trend covers, oldest first.
 *
 * The series is generated from the calendar rather than from the data, so a
 * month with no orders renders as a zero instead of vanishing — a gap in a time
 * axis reads as "no data recorded", which is a different claim from "no sales".
 */
function buildMonthBuckets() {
  const buckets = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  cursor.setMonth(cursor.getMonth() - (TREND_MONTHS - 1));

  for (let i = 0; i < TREND_MONTHS; i += 1) {
    buckets.push({
      key: `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      label: cursor.toLocaleDateString('en-GB', { month: 'short' }),
      year: cursor.getFullYear(),
      revenue: 0,
      orders: 0,
      newCustomers: 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return buckets;
}

/** The earliest instant the trend covers — the start of the oldest bucket. */
function trendStartDate() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  start.setMonth(start.getMonth() - (TREND_MONTHS - 1));
  return start;
}

/**
 * GET /api/dashboard/summary
 *
 * Everything the dashboard renders, in a single round trip: four headline
 * figures, a monthly trend, two status breakdowns, revenue by product category,
 * and the most recent orders.
 *
 * Every figure respects the caller's role scope — a sales rep sees their own
 * customers and orders, managers and admins see the whole business. Product
 * stock is company-wide for everyone, since products have no per-user owner.
 */
const getSummary = asyncHandler(async (req, res) => {
  const customerFilter = customerScopeFilter(req.user);
  const orderFilter = await orderScopeFilter(req.user);
  const since = trendStartDate();

  const [
    totalCustomers,
    revenueResult,
    lowStockCount,
    recentOrders,
    ordersByStatus,
    customersByStatus,
    monthlyOrders,
    monthlyCustomers,
    categoryRevenue,
  ] = await Promise.all([
    Customer.countDocuments(customerFilter),

    // Revenue counts completed orders only — pending orders aren't money yet
    // and cancelled ones never will be.
    Order.aggregate([
      { $match: { ...orderFilter, status: ORDER_STATUS.COMPLETED } },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),

    Product.countDocuments({ $expr: { $lte: ['$stockQty', '$lowStockThreshold'] } }),

    Order.find(orderFilter)
      .populate('customer', 'name email company')
      .populate('createdBy', 'name role')
      .sort({ createdAt: -1 })
      .limit(5),

    Order.aggregate([
      { $match: orderFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    Customer.aggregate([
      { $match: customerFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    // Monthly revenue and order volume. Grouping on a formatted date string
    // keys the buckets the same way buildMonthBuckets() does, so the two merge
    // without any date parsing on the way back.
    Order.aggregate([
      { $match: { ...orderFilter, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          orders: { $sum: 1 },
          revenue: {
            // Only completed orders contribute revenue, but every order counts
            // toward volume — hence the conditional sum rather than a second query.
            $sum: {
              $cond: [{ $eq: ['$status', ORDER_STATUS.COMPLETED] }, '$total', 0],
            },
          },
        },
      },
    ]),

    Customer.aggregate([
      { $match: { ...customerFilter, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
    ]),

    // Revenue per product category. Orders store a product reference, so the
    // category has to be looked up: unwind the line items, join the product,
    // then total each line at the price recorded on the order.
    Order.aggregate([
      { $match: { ...orderFilter, status: ORDER_STATUS.COMPLETED } },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.product',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: '$product' },
      {
        $group: {
          _id: '$product.category',
          revenue: { $sum: { $multiply: ['$items.priceAtOrder', '$items.quantity'] } },
          units: { $sum: '$items.quantity' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 6 },
    ]),
  ]);

  // aggregate() returns an empty array when nothing matched, so default to zero.
  const revenue = revenueResult[0] || { total: 0, count: 0 };

  const statusCounts = { pending: 0, completed: 0, cancelled: 0 };
  ordersByStatus.forEach(({ _id, count }) => {
    if (_id in statusCounts) statusCounts[_id] = count;
  });

  const customerCounts = Object.fromEntries(CUSTOMER_STATUS_VALUES.map((s) => [s, 0]));
  customersByStatus.forEach(({ _id, count }) => {
    if (_id in customerCounts) customerCounts[_id] = count;
  });

  // Merge the aggregation results onto the generated calendar.
  const buckets = buildMonthBuckets();
  const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));

  monthlyOrders.forEach(({ _id, orders, revenue: monthRevenue }) => {
    if (byKey[_id]) {
      byKey[_id].orders = orders;
      byKey[_id].revenue = Math.round(monthRevenue * 100) / 100;
    }
  });
  monthlyCustomers.forEach(({ _id, count }) => {
    if (byKey[_id]) byKey[_id].newCustomers = count;
  });

  res.json({
    success: true,
    data: {
      // Echoed so the frontend renders the layout for the role the SERVER
      // resolved, not one inferred from a client-side token that may be stale.
      role: req.user.role,
      totalCustomers,
      totalRevenue: Math.round(revenue.total * 100) / 100,
      completedOrders: revenue.count,
      lowStockProducts: lowStockCount,
      ordersByStatus: statusCounts,
      customersByStatus: customerCounts,
      monthly: buckets,
      revenueByCategory: categoryRevenue.map(({ _id, revenue: r, units }) => ({
        category: _id || 'Uncategorised',
        revenue: Math.round(r * 100) / 100,
        units,
      })),
      recentOrders,
      ...(await roleExtras(req.user, orderFilter)),
    },
  });
});

/**
 * The figures only one role's dashboard has a use for.
 *
 * WHY THIS IS A SEPARATE QUERY SET RATHER THAN MORE FIELDS FOR EVERYONE.
 *
 * The three dashboards are genuinely different screens, not one screen with
 * different numbers in it — an admin is looking at the whole business, a
 * manager at the floor's operations, a rep at the handful of orders they
 * personally have to move today. Sending an admin's approval queue and user
 * counts to a rep would mean the client deciding what to hide, which is the
 * pattern that leaves an empty "Customers: 0" tile on a screen belonging to
 * someone who has no customer book at all. Nothing a role cannot act on is
 * computed for them, so nothing has to be hidden.
 */
async function roleExtras(user, orderFilter) {
  if (user.role === ROLES.SALES_REP) {
    // A rep's whole job on this screen: the orders assigned to them that are
    // still waiting to be moved. No revenue, no team data, no customer count
    // — see the note above.
    const myPendingOrders = await Order.find({ ...orderFilter, status: ORDER_STATUS.PENDING })
      .populate('customer', 'name company phone')
      .sort({ createdAt: 1 })
      .limit(10)
      .lean();

    return {
      myPendingOrders,
      myPendingCount: await Order.countDocuments({
        ...orderFilter,
        status: ORDER_STATUS.PENDING,
      }),
    };
  }

  // Admin and manager both get the approval queue; only an admin gets the
  // account-management figures, which are the things only they can act on.
  const [pendingApprovals, unassignedOrders] = await Promise.all([
    ChangeRequest.countDocuments({ status: CHANGE_REQUEST_STATUS.PENDING }),
    Order.countDocuments({ status: ORDER_STATUS.PENDING, assignedTo: null }),
  ]);

  if (user.role === ROLES.MANAGER) {
    return { pendingApprovals, unassignedOrders };
  }

  const [totalUsers, pendingAccounts] = await Promise.all([
    User.countDocuments({ status: USER_STATUS.ACTIVE }),
    User.countDocuments({ status: USER_STATUS.PENDING }),
  ]);

  return { pendingApprovals, unassignedOrders, totalUsers, pendingAccounts };
}

/**
 * GET /api/dashboard/digest — manager and admin.
 *
 * See services/teamDigestService.js — every figure is computed there before
 * the model is asked to narrate it.
 */
const getDigest = asyncHandler(async (req, res) => {
  const { getDigest: run } = require('../services/teamDigestService');
  const result = await run(req.user?._id?.toString() ?? null);

  res.json({
    success: true,
    data: { mode: result.mode, figures: result.figures, narrative: result.narrative },
  });
});

module.exports = { getSummary, getDigest };
