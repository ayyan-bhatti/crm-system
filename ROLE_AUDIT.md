# Role-by-role audit

Every route hit as each role with a real session, against the real backend, with the
database reset before each individual call. The API is the only trustworthy source here: a
hidden button with no backend check behind it is the same bug as a visible one.

Reproduce with `npm run audit-roles` in `backend/`.

**Headline: role separation holds.** Every denial is a proper `403`. There is no
`200`-with-filtered-data where a refusal was intended, and no `500`s. Three findings below,
none of them a privilege escalation.

---

## The matrix

`(n)` is the number of records returned. `202` means the write was accepted as a change
request rather than applied.

| Route | admin | manager | sales_rep | Verdict |
| --- | --- | --- | --- | --- |
| `GET /api/customers` | 200 (1) | 200 (1) | **403** | pass |
| `GET /api/customers/options` | 200 (1) | 200 (1) | **403** | pass |
| `GET /api/customers/:id` | 200 | 200 | **403** | pass |
| `GET /api/customers/:id/summary` | 200 | 200 | **403** | pass |
| `POST /api/customers` | 201 | **202** | **403** | pass |
| `PATCH /api/customers/:id` | 200 | **202** | **403** | pass |
| `DELETE /api/customers/:id` | 200 | **202** | **403** | pass |
| `GET /api/products` | 200 (1) | 200 (1) | 200 (1) | pass |
| `GET /api/products/options` | 200 (1) | 200 (1) | 200 (1) | pass |
| `POST /api/products` | 201 | 201 | **403** | pass |
| `PATCH /api/products/:id` | 200 | 200 | **403** | pass |
| `DELETE /api/products/:id` | 200 | 200 | **403** | pass |
| `GET /api/orders` | 200 (2) | 200 (2) | **200 (1)** | pass — scoped |
| `GET /api/orders/:id` *(rep's own)* | 200 | 200 | 200 | pass |
| `GET /api/orders/:id` *(another rep's)* | 200 | 200 | **403** | pass |
| `POST /api/orders` | 201 | 201 | **403** | pass |
| `PATCH /api/orders/:id` *(status)* | 200 | 200 | **200** | pass — rep may complete |
| `PATCH /api/orders/:id` *(items)* | 200 | **202** | **403** | pass |
| `PATCH /api/orders/:id/assign` | 200 | 200 | **403** | pass |
| `POST /api/orders/:id/transfer-request` | 202 | 202 | 202 | **F2** |
| `DELETE /api/orders/:id` | 200 | **202** | **403** | pass |
| `GET /api/users` | 200 (4) | **403** | **403** | pass |
| `GET /api/users/assignable` | 200 (4) +email | 200 (4) +email | **200 (4) no-email** | **F1** — fixed |
| `GET /api/users/pending` | 200 (0) | **403** | **403** | pass |
| `POST /api/users/invite` | 201 | 201 | **403** | pass |
| `POST /api/users/invite` *(as admin)* | 201 | **403** | **403** | pass — escalation blocked |
| `PATCH /api/users/:id` | 200 | **403** | **403** | pass |
| `PATCH /api/users/:id/status` | 200 | **403** | **403** | pass |
| `DELETE /api/users/:id` | 200 | **403** | **403** | pass |
| `GET /api/change-requests` | 200 (0) | **200 (0)** | **403** | pass — manager sees buyer requests only |
| `GET /api/audit-logs` | 200 (25) | **403** | **403** | pass |
| `GET /api/internal/metrics` | 200 | **403** | **403** | pass |
| `GET /api/internal/ai-status` | 200 | **403** | **403** | pass |
| `GET /api/internal/ai-usage` | 200 | **403** | **403** | pass |
| `GET /api/dashboard/summary` | 200 | 200 | 200 | **F3** — scoped, but same shape |
| `POST /api/ai-search` | 200 (1) | 200 (1) | **200 (0)** | pass — scoped |

---

## Per role

### sales_rep

**Reaches:** products (read-only), the orders assigned to them, their own account page, AI
search (scoped), the dashboard.

**Correctly refused:** the entire customer book including the picker and the AI summary;
creating, editing, deleting or reassigning any order; another rep's order; user management;
the approvals queue; the audit trail; every internal endpoint.

**Correctly allowed:** completing or cancelling an order they hold, and requesting a
transfer. Verified that a rep's order list returns 1 of 2 orders and that the hidden one
`403`s when addressed directly — the list and the detail endpoint agree, so a rep never sees
a row they cannot open.

**Data scoping verified, not assumed:** AI search for customers returns `0` for a rep and
`1` for a manager against identical data, so the natural-language route into the customer
collection is closed too.

### manager

**Reads the whole customer book, writes none of it directly** — create, edit and delete all
come back `202` with nothing written. Products and orders they run directly. Order items and
order deletion queue for approval.

**Correctly refused:** user management, the audit trail, all internal endpoints — and,
importantly, **inviting an admin** (`403`) while an ordinary invite succeeds. The escalation
guard holds.

**Opened since the storefront was added:** `GET /api/change-requests` now answers `200` for a
manager rather than `403` — but filtered. A manager sees only buyer-initiated requests (a
customer's own cancellation or edit ask); a colleague's customer-edit or order-deletion request
stays invisible to them, same as before. Verified by seeding one of each kind and confirming
the manager's list contains the buyer one and not the staff one — see the storefront section
below and `BUILD_LOG.md`'s phase 4 entry for the reasoning behind opening this at all.

### admin

Everything direct, nothing queued. The approvals queue, audit trail and internal endpoints
are theirs alone.

---

## Findings

### F1 — a sales rep can enumerate every colleague, with email addresses

**Severity: low.** Not an escalation; internal staff directory rather than customer data.

`GET /api/users/assignable` returns `name`, `email` and `role` for every active user, to any
authenticated caller including a sales rep.

**Reproduce:** sign in as `sara@simplecrm.test`, then
`curl -b cookies /api/users/assignable` — the full staff list comes back.

There **is** a legitimate need: the transfer-request picker has to list colleagues, and that
is a rep-facing feature. So the fix is to narrow what is returned rather than to close the
route — a rep needs a name to pick from, and has no use for anybody's email address.

**Fixed** in `backend/src/controllers/userController.js` — the projection is now
role-dependent. A rep gets `name` and `role`, which is all the picker displays; anyone who can
actually manage people still gets `email`, because the screens that identify a colleague by
address are theirs. Covered by four tests in `backend/tests/roles.test.js`, and visible in the
matrix above: the audit now records whether addresses came back, not just the row count.

### F2 — admins and managers can file a transfer request instead of just assigning

**Severity: cosmetic, but it can block a real action.**

`POST /api/orders/:id/transfer-request` has no role middleware — the handler checks access to
the *record*, which an admin and a manager both have. They can therefore queue a transfer
request for an order they could simply reassign.

Nothing leaks. The consequence is that the resulting pending request then `409`s a subsequent
direct assignment on the same order ("there is already a change waiting"), so a manager could
accidentally block themselves.

**Left as-is deliberately** — the frontend only offers this control to a rep, the API
behaviour is harmless, and adding a role check to refuse a strictly-less-powerful action
would be a rule with an edge case for no gain. Recorded so it is a known choice rather than
an oversight.

### F3 — the dashboard is scoped correctly but shaped identically for everyone

**Severity: not a security issue.** Task 4 asked whether the dashboard is scoped
server-side or merely hidden with a frontend conditional. **It is scoped server-side**,
verified decisively: with two completed orders of £100 where only one is the rep's, the rep's
`totalRevenue` is `100` and the admin's is `200`. Customers and recent orders are scoped the
same way.

What is wrong is the **shape**. All three roles receive the identical payload —
`totalCustomers`, `customersByStatus`, `revenueByCategory`, `lowStockProducts` — and the
frontend renders the same widgets for all of them. A sales rep is shown a "Total customers"
tile reading `0`, because they have no customer access at all. That is not a leak; it is a
screen telling somebody the business has no customers.

This is the substance of Task 4 and is handled there.

---

## The buyer role

A fourth account kind, added with the storefront — and deliberately not a fourth value in the
staff `role` enum above. The claim being audited here is the one the buyer-auth build-log entry
makes: a buyer reaches **none** of the internal routes above, and is correctly scoped to their
own cart, order history, and requests on the storefront's own routes.

### Against the internal matrix, using the same bearer-token mechanism as every staff role

Every route in the matrix above was also called as a signed-in buyer, using
`Authorization: Bearer <buyer token>` exactly as the three staff roles are. **Every single one
answers `401`** — not `403`, which matters: `protect` never gets far enough to make an access
decision, because a buyer token's id does not resolve in the `User` collection at all. This is
isolation by construction, not by a role check somebody could get wrong; the audit exercises it
end to end rather than trusting the source.

### The storefront's own routes

| Route | guest | buyer | buyer (colleague) | Verdict |
| --- | --- | --- | --- | --- |
| `GET /api/shop/products` | 200 (n) | 200 (n) | 200 (n) | pass — public |
| `GET /api/shop/products/:id` | 200 | 200 | 200 | pass — public |
| `GET /api/shop/cart` | **401** | 200 | 200 *(their own)* | pass |
| `GET /api/shop/orders` | **401** | 200 (1) | **200 (0)** | pass — scoped |
| `GET /api/shop/orders/:id` *(the first buyer's)* | **401** | 200 | **404** | pass |
| `GET /api/shop/auth/me` | **401** | 200 | 200 | pass |
| `GET /api/shop/cart` *(as a staff admin!)* | — | — | **401** | pass — tracks fully separate |

The order-detail row is the one worth reading carefully: a second buyer gets `404`, not `403`,
on an order that is not theirs — the same "can't tell not-yours from doesn't-exist" rule every
sub-resource in this app follows, so a buyer probing order ids learns nothing.

**Reproduce:** `npm run audit-roles` in `backend/` — the storefront table now prints
immediately after the internal one, from the same run.

**Verdict: role separation holds for the buyer track too**, on both sides of the boundary — a
buyer cannot reach a single internal route, and a staff session cannot reach a single buyer-only
one either.

---

## What was explicitly tried and could not be broken

- A rep calling every admin-only and manager-only endpoint directly with a valid session:
  **all `403`**, none returned `200` with filtered data, none `500`d.
- A manager inviting an admin: `403`, while an ordinary invite succeeds.
- A rep reading another rep's order by id: `403`, consistent with it being absent from
  their list.
- A rep reaching the customer book through the AI search endpoint: `0` results where a
  manager gets `1`.
- A manager's customer write: `202` with the record verified unchanged in the database
  afterwards, not a `200` that quietly applied.
- A buyer's session token, presented to every route in the internal matrix: **all `401`**.
- A staff session token, presented to a buyer-only storefront route: **`401`**.
- A buyer reading another buyer's order by id: `404`, consistent with it being absent from
  their own order list.
