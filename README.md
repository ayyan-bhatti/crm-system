# SimpleCRM

A full-stack CRM and inventory application: customers, products, orders, role-based access
control, and a natural-language search endpoint backed by the Anthropic API.

**Stack:** React (Vite) + Tailwind CSS + React Router · Node.js + Express · MongoDB +
Mongoose · JWT auth with bcrypt · Jest + Supertest with an in-memory MongoDB.

---

## Table of contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Architecture](#architecture)
- [Authentication and roles](#authentication-and-roles)
- [API reference](#api-reference)
- [How AI search works](#how-ai-search-works)
- [Order stock rules](#order-stock-rules)
- [Design system](#design-system)
- [Testing](#testing)
- [Design decisions](#design-decisions)
- [Known limitations](#known-limitations)

---

## Quick start

### Prerequisites

- **Node.js 20.19+** (Vite 7 requires it; developed on Node 24)
- **MongoDB** running locally, or a MongoDB Atlas connection string
- An **Anthropic API key** — optional. Without one the AI search endpoint still works, it
  just falls back to keyword search and says so.

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # then edit .env — see the table below
npm run seed              # optional: fills the database with demo data
npm run dev               # http://localhost:5000
```

At minimum, set `MONGO_URI` and `JWT_SECRET` in `.env`. Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

No frontend `.env` is needed for local development — the Vite dev server proxies `/api`
to `http://localhost:5000`, so the browser only ever talks to one origin.

### 3. Sign in

If you ran `npm run seed`, four accounts exist (password `password123` for all):

| Email | Role | Sees |
| --- | --- | --- |
| `admin@simplecrm.test` | admin | Everything, including user management |
| `manager@simplecrm.test` | manager | All CRM records; no user management |
| `sara@simplecrm.test` | sales_rep | Only her own customers and orders |
| `omar@simplecrm.test` | sales_rep | Only his own customers and orders |

Without seeding, register at `/register` — **the first account created on a fresh database
becomes the admin**, and every later public sign-up is a sales rep.

Once signed in, try the search box on the dashboard:
*"customers in Karachi with no orders in the last 30 days"*.

---

## Environment variables

### `backend/.env` (copy from `backend/.env.example`)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | no | `5000` | Express listen port |
| `NODE_ENV` | no | `development` | `development` · `production` · `test` |
| `MONGO_URI` | **yes** | `mongodb://127.0.0.1:27017/simplecrm` | Connection string |
| `JWT_SECRET` | **yes** | — | Server refuses to boot without it (except in tests) |
| `JWT_EXPIRES_IN` | no | `7d` | Token lifetime |
| `CLIENT_ORIGIN` | no | `http://localhost:5173` | Allowed CORS origin |
| `ANTHROPIC_API_KEY` | no | — | Blank ⇒ AI search falls back to keyword search |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-6` | Model used to translate queries |

Every one of these is read in exactly one file — `backend/src/config/env.js` — so the app's
full configuration surface is visible at a glance, and misconfiguration fails loudly at
boot rather than mysteriously at runtime.

### `frontend/.env` (optional, copy from `frontend/.env.example`)

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_API_URL` | `/api` | Only needed when the API is deployed on a different origin |

---

## Architecture

```
digisofts project/
├── backend/
│   ├── src/
│   │   ├── config/        env, database connection, shared enums
│   │   ├── models/        Mongoose schemas
│   │   ├── middleware/    auth, role checks, central error handler
│   │   ├── controllers/   request handling and business rules
│   │   ├── routes/        URL → controller wiring
│   │   ├── services/      AI search: schema, model call, query translation
│   │   ├── utils/         ApiError, asyncHandler, JWT, query helpers
│   │   ├── app.js         the Express app (no DB, no port)
│   │   ├── server.js      process entry point: connect, then listen
│   │   └── seed.js        development data
│   └── tests/             Jest + Supertest, in-memory MongoDB
└── frontend/
    └── src/
        ├── api/           axios client + one function per endpoint
        ├── context/       AuthContext — the signed-in user
        ├── components/    layout, route guards, shared UI, AI search bar
        ├── pages/         one folder per resource
        ├── hooks/         useFetch, useDebounced
        ├── constants.js   enums mirrored from the backend
        └── ui.js          shared Tailwind class strings and formatters
```

### A few structural choices worth knowing

**`app.js` is separate from `server.js`.** `app.js` builds the Express app and nothing
else — it never connects to a database or opens a port. `server.js` does both for real
runs. That split is what lets the test suite import the app and point it at an in-memory
MongoDB, with no server socket and no real database anywhere in the suite.

**Errors travel one path.** Controllers throw `ApiError.badRequest(...)` /
`.forbidden(...)` / `.notFound(...)`; `asyncHandler` catches rejected promises; a single
error handler turns everything into the same JSON envelope. Mongoose's three common
failures are translated to the status a client actually expects rather than a blanket 500:

| Mongoose failure | Response |
| --- | --- |
| `CastError` (malformed ObjectId in a URL) | `400` |
| `ValidationError` | `400`, with a `details` map of field → message |
| Duplicate key (`code: 11000`) | `409` |

**Every response has the same shape.** Success is `{ success: true, data }`; lists add
`{ count, total, page, pages }`; failure is `{ success: false, message, details? }`. The
frontend's `errorMessage()` helper relies on that consistency, which is why no component
in the app needs its own error-parsing logic.

**Role scoping is applied to the query, not to the results.** A sales rep's list request
gets an `$or` filter merged into the database query before it runs, so `total` and the
page count reflect what that user can actually see. Filtering after fetching would give
correct-looking rows with wrong pagination.

---

## Authentication and roles

### How auth works

JWTs are returned in the JSON body of `/auth/register` and `/auth/login`. The React app
stores the token in `localStorage` and sends it as `Authorization: Bearer <token>`.

The alternative — an httpOnly cookie — resists XSS token theft better, but needs CSRF
protection and cross-site cookie configuration. Bearer tokens keep the flow explicit and
easy to exercise from tests, which is the right trade-off for this codebase. See
[Known limitations](#known-limitations).

`protect` **re-loads the user from the database on every request** rather than trusting
the token's payload. A deleted account or a changed role therefore takes effect
immediately, instead of whenever the old token happens to expire.

### Role matrix

| Capability | admin | manager | sales_rep |
| --- | :---: | :---: | :---: |
| Read products | ✅ | ✅ | ✅ |
| Create / edit / delete products | ✅ | ✅ | ❌ 403 |
| Read **all** customers and orders | ✅ | ✅ | ❌ own only |
| Create customers and orders | ✅ | ✅ | ✅ (own) |
| Edit / delete customers and orders | ✅ | ✅ | ✅ (own only) |
| Reassign a customer to another user | ✅ | ✅ | ❌ 403 |
| List colleagues for an "assign to" dropdown | ✅ | ✅ | ✅ |
| User management (list / create / edit / delete) | ✅ | ❌ 403 | ❌ 403 |

**"Own" means** a customer the rep created *or* is assigned to; and an order they created
*or* whose customer is assigned to them.

That distinction is enforced in two layers, deliberately:

- **Coarse checks are route middleware** (`requireRole`, `requireManagerOrAdmin`) — they
  depend only on the role and the URL.
- **Record ownership is checked in the controller** (`canAccessCustomer`,
  `canAccessOrder`) — it depends on the specific document, which the router has not
  loaded yet.

---

## API reference

All routes are prefixed with `/api`. Every route except `register`, `login` and `health`
requires an `Authorization: Bearer <token>` header.

### Auth

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | public | Create an account. First account ⇒ admin, later ⇒ sales_rep. Returns `{ user, token }` |
| `POST` | `/auth/login` | public | Returns `{ user, token }` |
| `GET` | `/auth/me` | any | The signed-in user — used to restore a session after refresh |

### Users

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/users/assignable` | any | Trimmed list (id, name, email, role) for dropdowns |
| `GET` | `/users` | admin | Filters: `?role=` `?search=` |
| `POST` | `/users` | admin | Create a user **with a chosen role** |
| `GET` | `/users/:id` | admin | Single user |
| `PATCH` | `/users/:id` | admin | Update name / email / role / password |
| `DELETE` | `/users/:id` | admin | Blocks self-deletion (`400`) |

### Customers

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/customers` | any (scoped) | Filters: `?status=` `?assignedTo=` `?city=` `?search=` · Paging: `?page=` `?limit=` `?sort=` |
| `POST` | `/customers` | any | Defaults `assignedTo` to the creator |
| `GET` | `/customers/:id` | owner / manager / admin | |
| `PATCH` | `/customers/:id` | owner / manager / admin | `assignedTo` requires manager or admin |
| `DELETE` | `/customers/:id` | owner / manager / admin | |

`?search=` matches name, email or company, case-insensitively.

### Products

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/products` | any | Filters: `?category=` `?lowStock=true` `?search=` · Paging as above |
| `GET` | `/products/categories` | any | Distinct category list, for the filter dropdown |
| `GET` | `/products/:id` | any | |
| `POST` | `/products` | manager, admin | |
| `PATCH` | `/products/:id` | manager, admin | |
| `DELETE` | `/products/:id` | manager, admin | |

`?lowStock=true` compares each product against **its own** `lowStockThreshold`, not one
global number.

### Orders

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/orders` | any (scoped) | Filters: `?status=` `?customer=` `?from=` `?to=` · Paging as above |
| `POST` | `/orders` | any (own customers) | Optional `status: "completed"` to record an already-fulfilled sale |
| `GET` | `/orders/:id` | owner / manager / admin | |
| `PATCH` | `/orders/:id` | owner / manager / admin | Change `status`, or `items` while still pending |
| `DELETE` | `/orders/:id` | owner / manager / admin | Restores stock if the order was completed |

The date range is inclusive: `?to=2026-01-31` includes orders placed on the 31st.

### Dashboard and AI search

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/dashboard/summary` | any (scoped) | Customer count, revenue, low-stock count, status breakdown, 5 most recent orders |
| `POST` | `/ai-search` | any (scoped) | Body `{ query, entity? }` — see below |
| `GET` | `/health` | public | Liveness probe |

---

## How AI search works

`POST /api/ai-search` with `{ "query": "customers in Karachi with no orders in the last 30 days" }`.

```
natural language → Claude → JSON text → parse → validate → Mongoose query → results
                                                    │
                                              (any failure)
                                                    ↓
                                            keyword search
```

**1. The schema is the single source of truth.** `services/filterSchema.js` declares which
entities are searchable, which fields each has, and which operators each field type
accepts. Both the system prompt sent to the model *and* the validator that checks its reply
are generated from that one file. If they were written separately they would drift, and
every drift is either a rejected valid query or — worse — an accepted invalid one.

**2. The model's output is untrusted input.** It is treated exactly like a request body.
Field names and operators are matched against the schema's allow-lists before anything
reaches Mongoose, so a hallucinated or hostile response cannot inject an arbitrary Mongo
operator such as `$where`. The test suite verifies rejection of `$where`, `__proto__`,
`constructor`, cross-entity fields, and out-of-enum values.

**3. Parsing is defensive.** `claude-sonnet-4-6` cannot enforce a JSON schema server-side
(see [Design decisions](#design-decisions)), so the parser tolerates what actually happens
in practice: a ` ```json ` fence, or a sentence before or after the object. Braces are
counted while tracking string literals, so a `}` inside a customer note does not truncate
the parse.

**4. Role scoping still applies.** The AI-derived filter is combined with the caller's
scope using `$and`, never a merge — a sales rep's scope contains `$or`, and spreading one
object over the other would silently drop a clause. AI search is not a permission bypass;
there is a test asserting exactly that.

**5. Cross-collection questions.** Some conditions cannot be expressed as a field
comparison. These are declared as `special` conditions and implemented explicitly:

| Entity | Condition | Meaning |
| --- | --- | --- |
| customer | `orderActivity: { type: "none" \| "any", withinDays: N }` | Has / has not ordered in the last N days (cancelled orders don't count as activity) |
| product | `lowStock: true` | At or below the product's own threshold |

**6. It always returns results.** No API key, a network error, an unparseable reply, or a
filter that fails validation all collapse into the same graceful fallback: a keyword
search across the entity's text fields.

The fallback receives whole *questions*, not search terms, so it cannot match the query
literally — no customer record contains the sentence *"customers in Karachi with no orders
in the last 30 days"*. Instead it:

- **tokenises** the question and drops filler — question scaffolding (`show`, `with`,
  `find`), time language (`last`, `days`, `recent`), and entity nouns (`customers`,
  `orders`), leaving `["karachi"]`;
- **drops bare numbers**, which in a natural-language query are quantities or timeframes
  (`last 30 days`, `over 500`), not text found in a record — while keeping hyphens, dots
  and `@` inside tokens so SKUs (`FURN-001`) and emails survive;
- **infers the entity** from the same hint words, with the earliest-mentioned winning a
  tie — *"customers … with no orders"* is a question about customers, and the user said so
  first;
- **matches any remaining term**, then **ranks** by how many distinct terms each record
  matched, so *"karachi textiles"* puts the company of that name above everything merely
  in Karachi;
- returns the most recent records for an all-filler question (*"show me all the
  customers"*), and searches a single-token query literally, so a bare `001` still finds
  `FURN-001`.

The response reports the `terms` it actually searched for, and the UI shows them — the
difference between "no results" and "no results *for this*". The response says which path
ran:

```json
{
  "success": true,
  "mode": "ai",
  "entity": "customer",
  "filter": { "entity": "customer", "conditions": [ ... ], "special": { ... } },
  "count": 3,
  "data": [ ... ]
}
```

On fallback, `mode` is `"fallback"`, `filter` is `null`, `terms` lists the words searched,
and a `reason` string explains why. The UI surfaces all of it — an "AI filter" / "Keyword
fallback" badge, the matched terms, and a collapsible view of the exact filter that ran, so
a user can see how their question was interpreted.

**What the fallback cannot do** is semantics. *"products running low on stock"* tokenises to
`["running", "low"]`, which appears in no product name, so it returns nothing — that
question needs the `lowStock` special condition, which only the AI path produces. The
fallback answers the *identifying* part of a question (a name, a city, a category), not the
analytical part.

---

## Order stock rules

This is the only place in the app where one request mutates a second collection, so the
rules are worth stating plainly:

1. **On create**, every referenced product is loaded and checked. Duplicate lines for the
   same product are **merged before the check** — otherwise two lines of 6 against a stock
   of 10 would each pass individually and oversell.
2. **`priceAtOrder` is snapshotted** from the product's current price. Without it,
   changing a product's price would silently rewrite the value of every historical order.
3. **`total` is always recomputed server-side.** A `total` in the request body is ignored.
4. **Stock decrements only on `pending → completed`**, guarded by the `completedAt`
   timestamp rather than by status alone. Status can be written repeatedly with the same
   value; `completedAt` is what records that the decrement already happened. A retried
   request or a double-clicked button therefore cannot take stock twice.
5. **Decrements are conditional updates** (`{ stockQty: { $gte: quantity } }`), so two
   requests completing the same order concurrently cannot drive stock negative — the
   second matches nothing. If a later line fails, earlier lines are rolled back.
6. **Cancelling or deleting a completed order restores its stock.**
7. **Items can only be edited while an order is pending.**

---

## Design system

Every colour, font and spacing value lives in `frontend/src/index.css` as a Tailwind
`@theme` token. No component contains a raw hex value, so the palette can be changed in
one place — and the UI chrome and the charts are drawn from the same set, which is why a
status pill and a donut segment can never disagree about what "pending" looks like.

**Typeface — IBM Plex Sans.** A workhorse sans drawn for dense, data-heavy interfaces,
with genuinely good tabular figures, which a CRM full of tables, prices and axis ticks
leans on constantly. Loaded from Google Fonts with `display=swap` and a system-sans
fallback, so text paints immediately if the webfont is slow or blocked.

Figures follow one rule: `tabular-nums` on **columns** that align vertically (table cells,
axis ticks) and proportional figures everywhere else. Equal-width digits make a large
standalone number like `121` look gappy, so the stat tiles deliberately do not use them.

**Palette.** A warm-neutral base (`#f9f9f7` plane, `#fcfcfb` surfaces) rather than pure
grey, with a single blue accent that doubles as categorical slot 1 — so the interface and
the charts share one accent instead of competing.

| Group | Tokens |
| --- | --- |
| Surfaces | `plane` · `surface` · `raised` |
| Ink | `ink` · `ink-2` · `muted` |
| Lines | `hairline` (borders, gridlines) · `rule` (axes, dividers) |
| Brand | `brand` · `brand-strong` · `brand-ink` · `brand-soft` · `brand-wash` |
| Status *(reserved)* | `good` · `warning` · `serious` · `critical`, each with a `-wash` and `-ink` pair |
| Series | `series-1` … `series-8`, a fixed order |

The status tokens are **reserved**: they mean good / waiting / bad and are never reused as
a chart series colour, so a colour can't impersonate a state.

**The categorical order is a safety mechanism, not decoration.** Every adjacent pair in
`series-1…8` clears the colour-vision-deficiency separation threshold (ΔE ≥ 8 in OKLab
×100) and the normal-vision floor (≥ 15) against this surface — verified by running the
palette through a validator rather than by eye. Reordering the slots breaks the guarantee,
so new series are added at the end rather than inserted. Three slots sit below 3:1
contrast on this light surface, which is acceptable only because every chart that uses
them ships visible labels *and* a table view.

**Charts** (`frontend/src/components/charts.jsx`, built on Recharts) follow a few fixed
rules, because they are what separates a readable chart from a loud one:

- **Thin marks.** 2px lines, bars capped at 20px, area fills as a ~10% wash rather than a
  saturated block. The data is the only thing allowed to be loud.
- **Recessive chrome.** Gridlines and axes are solid 1px hairlines one step off the
  surface — never dashed, which reads as "projection" when it is just a grid.
- **Separation by negative space.** Touching marks are separated by a 2px gap in the
  surface colour, never by a border drawn around the mark.
- **Selective labels.** The revenue trend labels its final point only; a value beside
  every point is chaos and goes unread. The axis and tooltip carry the rest.
- **Text never wears the series colour.** Values and labels use ink tokens; a coloured dot
  beside them carries the identity. A light hue is illegible as text.
- **One colour per single-series chart.** Revenue-by-category bars are all one blue —
  shading them by value would double-encode length as hue, spending the only free channel
  on information the bar already shows.
- **Every chart has a table view.** The Chart/Table toggle on each card shows the same
  numbers as text. Colour and tooltips enhance; they never gate access to a value.

Which form carries which job:

| Chart | Job | Form | Colour |
| --- | --- | --- | --- |
| Revenue trend | change over time | area, single series, no legend | brand |
| Order status | part-to-whole, ≤ 3 slices | donut + labelled legend | **status** (means good/waiting/bad) |
| Customers by status | part-to-whole, identity | donut + labelled legend | **categorical** (a lead is not "bad") |
| Revenue by category | compare magnitude | horizontal bar | one hue |
| Stat tiles | a single current value | number + sparkline | brand |

**Performance.** Recharts is most of the app's JavaScript, so the authenticated pages are
lazy-loaded at the route boundary. Without that, every visitor downloads the charting
library before they can type a password. The initial bundle is ~302 kB (99 kB gzipped);
the 419 kB chart chunk arrives only when the dashboard does.

## Testing

```bash
cd backend
npm test              # 167 tests across 5 suites
npm run test:watch
```

Tests run against **mongodb-memory-server** — a real MongoDB, downloaded once and run in
memory. The suite never touches a configured database and leaves nothing behind. Each test
file gets its own instance; collections are cleared between individual tests (rather than
dropped) so unique indexes on `User.email` and `Product.sku` stay in place.

| Suite | Covers |
| --- | --- |
| `auth.test.js` | Registration, the admin-bootstrap rule, role-in-body being ignored, bcrypt hashing, login, identical messages for wrong-password vs unknown-email, token rejection cases |
| `roles.test.js` | The 403s — product writes by a rep, user management by manager and rep, cross-rep customer and order access, plus the positive cases that must keep working |
| `customer.test.js` | CRUD, pagination, every filter, regex-metacharacter escaping in search, search combined with rep scope, `createdBy` immutability |
| `order.test.js` | Server-side totals, price snapshotting, insufficient stock, duplicate-line merging, decrement on completion, **no double-decrement**, restore on cancel/delete, rollback on partial failure |
| `aiSearch.test.js` | JSON extraction edge cases, the validator's allow-list (including injection attempts), the flagship query, role scoping through the AI path, every fallback trigger, and the fallback's tokenising / entity inference / ranking |

**The Anthropic API is never called from the test suite.** `translateQuery` is stubbed, so
tests are fast, deterministic, and need no API key. What is tested is everything around the
model — parsing, validation, scoping, and degradation.

---

## Design decisions

Points where the implementation makes a deliberate choice, including two departures from
the original specification.

**Two fields were added to the `Customer` model.**

- **`createdBy`** — not optional. The sales_rep rule grants access to records they
  *created* or are assigned to; without recording the creator, half of that rule cannot be
  evaluated.
- **`city`** — the AI-search example is a location query (*"customers in Karachi…"*).
  Without a location field there is nothing for it to match, so the flagship feature would
  have had no meaningful demonstration.

**Registration ignores a `role` in the request body.** Taking the role from the request
would let anyone sign up as an admin. Instead the first account on a fresh database becomes
the admin (so a new install has someone who can manage everyone else) and all later public
sign-ups are sales reps — the least-privileged role. Admins assign roles afterwards.

**`claude-sonnet-4-6` with prompt-instructed JSON, not structured outputs.** The model
named in the specification is current and valid, but it does not support the API's
`output_config.format` feature, which would let the API guarantee schema-valid JSON. That
is exactly why the parser is defensive and the fallback exists. `ANTHROPIC_MODEL` is
configurable, so pointing it at a structured-outputs model later is a `.env` change plus
adding the `format` parameter. The request also sets `effort: "low"` — translating a
question into a filter is not deep reasoning, and low effort cuts both latency and cost —
with a 20-second timeout and one retry so a wedged API call falls back rather than holding
the request open.

**Login returns one message for both failure modes.** "No such email" and "wrong password"
are indistinguishable, so the endpoint cannot be used to enumerate which addresses have
accounts.

**Filter state lives in the URL, not in component state.** A filtered list can be
bookmarked, shared, and survives a refresh — and the dashboard tiles can link straight to
a pre-filtered view.

**Route guards in the frontend are a courtesy, not a security control.** `ProtectedRoute`
and `RoleGate` hide screens and buttons a user cannot use, so nobody is offered an action
the API would reject. The API enforces every rule independently.

---

## Known limitations

Things a production deployment would need, called out rather than left as surprises:

- **The token is in `localStorage`**, which is readable by any script running on the page.
  An httpOnly cookie plus CSRF protection would be the hardening step.
- **No rate limiting.** `/auth/login` and `/api/ai-search` are the two that most want it —
  the first against credential stuffing, the second because it costs money per request.
- **No refresh tokens.** When a JWT expires the user is signed out and must log in again.
- **Stock updates are not transactional.** Conditional updates plus explicit rollback make
  overselling impossible, but a process crash mid-rollback could leave stock inconsistent.
  MongoDB multi-document transactions would close that gap; they need a replica set, which
  a single-node local install does not provide.
- **The order form loads up to 100 customers and products** into its dropdowns. Beyond
  that, they need to become searchable async selects.
- **No frontend test suite.** The backend is covered; the React app is verified by a
  production build and manual use.
- **AI search reads one entity at a time.** A question spanning two entities ("customers
  and their overdue orders") returns whichever the model judged primary.
- **The keyword fallback matches terms, not meaning.** It answers the identifying part of a
  question (a name, city or category) but not the analytical part — "running low",
  "overdue", "top spenders" need the AI path. Its stop-word list is also English-only.
