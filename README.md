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
- [Security](#security)
- [API reference](#api-reference)
- [How AI search works](#how-ai-search-works)
- [AI customer insights](#ai-customer-insights)
- [Order stock rules](#order-stock-rules)
- [Pagination and indexes](#pagination-and-indexes)
- [Design system](#design-system)
- [Deploying to Vercel](#deploying-to-vercel)
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

If you ran `npm run seed`, four accounts exist (password `Karachi-Ledger-72` for all —
`password123` is now rejected by the password policy, see [Security](#security)):

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
| `ACCESS_TOKEN_TTL` | no | `15m` | Access-token lifetime. Short by design — it cannot be revoked |
| `REFRESH_TOKEN_TTL` | no | `7d` | How long "stay signed in" lasts. This one *is* revocable |
| `COOKIE_SAME_SITE` | no | `lax` | `lax` · `strict` · `none`. Only change if the API and frontend are on genuinely different sites (`none` requires HTTPS) |
| `CLIENT_ORIGIN` | no | `http://localhost:5173` | Allowed CORS origin |
| `RATE_LIMIT_DISABLED` | no | — | `true` turns the per-IP limiters off, for local load testing |
| `ANTHROPIC_API_KEY` | no | — | Blank ⇒ AI search falls back to keyword search |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-6` | Model used to translate queries |

`JWT_EXPIRES_IN` is **no longer read**. It was the single-token lifetime from before the
session was split into an access and a refresh token; `ACCESS_TOKEN_TTL` replaced it.

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

The session is **two httpOnly cookies**. The frontend never handles a token and never
writes one to `localStorage`.

| | access token | refresh token |
| --- | --- | --- |
| what it is | signed JWT | 32 random bytes, no claims |
| lifetime | 15 minutes | 7 days |
| stored server-side? | no | yes, SHA-256 hashed |
| revocable? | no | **yes** |
| cookie path | `/` | `/api/auth` |

The split is the point. The access token is stateless, so verifying it is one signature
check and no database round trip — affordable only because it expires in minutes. The
refresh token is the long-lived half, so it is the one that has to be revocable, which
means storing it (hashed: a database leak must not hand over live sessions).

**Rotation and reuse detection.** Every call to `POST /api/auth/refresh` consumes the
presented token and issues a new one. All tokens descended from one login share a family
id; if an already-consumed token is presented again, either the user's copy or a thief's is
being replayed and there is no way to tell which — so the whole family is revoked. That
caps the value of a stolen refresh token at "until the real user next refreshes".

**`Authorization: Bearer` is still accepted** for scripts, the test suite and any future
mobile client. That is not a hole in the cookie story: an attacker's page cannot set a
header on a cross-site request, so bearer calls are inherently CSRF-immune.

`protect` **re-loads the user from the database on every request** rather than trusting
the token's payload. A deleted account or a changed role therefore takes effect
immediately, instead of whenever the old token happens to expire.

### Client requirements

- Send credentials (`withCredentials: true`, or `credentials: 'include'`).
- Send `X-CSRF-Token` on every **state-changing** request, read from the readable
  `simplecrm_csrf` cookie. Bearer-authenticated clients are exempt.
- Handle a `401` by calling `POST /api/auth/refresh` once and replaying the request. If
  several requests fail at once, share **one** refresh — because refresh rotates, parallel
  refreshes present an already-consumed token and trip reuse detection against the real
  user.

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

## Security

Everything below was added in response to a review. Each item says what it defends against
and what it costs, because a control nobody can explain is a control nobody maintains.

### Rate limiting and account lockout

Two independent defences, because either alone has a hole.

| endpoint | per-IP limit |
| --- | --- |
| `POST /auth/login` | 10 / 15 min |
| `POST /auth/register` | 5 / hour |
| `POST /auth/change-password` | 5 / hour |
| AI endpoints | 20 / 5 min per IP, **and** 30 / 5 min per user |

Per-IP limits stop credential stuffing, sign-up spam and runaway scripts. They do **not**
stop a botnet, where each address stays under the limit while one account absorbs thousands
of guesses. So login is also protected per *account*: from the fifth consecutive failure,
each further one doubles the wait (1, 2, 4, 8 minutes) capped at 15.

Exponential rather than flat, so someone who genuinely forgot their password is not
punished as hard as an attacker. **Capped**, because an uncapped backoff is a weapon: anyone
could fail logins against a known address and lock that person out of their own account
permanently.

A locked account is refused *before* bcrypt runs (so it costs no CPU) and refuses the
**correct** password too - a lockout that lets the right password through protects nothing.

The AI endpoints carry both limits because the IP limiter is wrong in *both* directions on
its own: an office behind one NAT shares a quota between colleagues, while a user on a phone
hotspot changes address freely.

### CSRF

Moving the session into cookies *created* this problem - cookies are attached automatically,
including on a request triggered by another site - so the protection is part of that change
rather than an extra.

Double-submit: the server plants a random value in a **readable** cookie, the frontend
echoes it in `X-CSRF-Token`, and the server requires the two to match in constant time. An
attacker's page can make the browser *send* our cookies but the same-origin policy stops it
*reading* them, so it cannot produce the header.

That one cookie is deliberately not httpOnly - the frontend has to read it, and the value is
not a credential; it only proves the request came from our own origin.

Written here rather than using `csurf`, which has been deprecated and unmaintained since
2022.

### Password policy

Deliberately **not** "8 characters with a capital and a number" - the rule NIST SP 800-63B
advises against, because it produces `Password1!` rather than unpredictability.

| rule | reasoning |
| --- | --- |
| at least 10 characters | the floor |
| 14+ needs no variety | a passphrase beats a short symbol-soup password and should not be rejected for lacking a digit |
| 10-13 needs 3 of 4 character classes | a short password has to buy its entropy from variety |
| not on the common list | credential stuffing tries those first |
| nothing built from the name or email | guessed first by exactly the person attacking the account |
| at most 72 bytes | **not style - a real bug.** bcrypt silently truncates there, so a longer password would be accepted, quietly shortened, and any other password sharing its first 72 bytes would open the account |

The blocklist is compared against several normalised forms of the input, because people bolt
digits on (`password123`) and substitute characters (`P@ssw0rd`).

### Security headers

Set in **two places**, and the split is easy to get silently wrong. The API and the static
frontend are separate Vercel services, so a header set by Express only ever lands on a JSON
response - it never reaches the HTML the browser executes scripts in.

- **helmet, in `app.js`** - for API responses. `default-src 'none'`, `frame-ancestors
  'none'`, HSTS in production only, and a referrer policy that stops record ids leaking
  through `Referer`.
- **`vercel.json` `headers`** - the real app CSP, with every directive commented in place.

One deliberate weakening: `style-src` allows `'unsafe-inline'`, because Recharts sets style
attributes at runtime and offers no nonce hook. Inline *style* risks defacement; inline
*script* risks code execution, and `script-src 'self'` stays strict. `connect-src 'self'`
means even a script that somehow ran could not exfiltrate anywhere.

### Audit trail

Every create, update and delete on customers, products, orders and users records who did it,
the before and after values, which fields changed, and the request metadata. Admin-only and
read-only - see [API reference](#api-reference).

The actor is **denormalised** (id plus a snapshot of name, email and role). An audit trail
whose contents change when someone is renamed or deleted is not an audit trail.

Password hashes and session tokens are redacted: the trail is kept indefinitely and read by
administrators, which makes it the wrong place to accumulate credentials.

---

## API reference

All routes are prefixed with `/api`. Every route except `register`, `login`, `refresh`,
`logout` and `health` requires a session — either the auth cookies or an
`Authorization: Bearer <token>` header.

Every **state-changing** request authenticated by cookie must also send `X-CSRF-Token`.

### Auth

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | public | Create an account. First account ⇒ admin, later ⇒ sales_rep. Sets session cookies; returns `{ user, token }`. Rate limited: 5/hour per IP |
| `POST` | `/auth/login` | public | Sets session cookies; returns `{ user, token }`. Rate limited: 10/15min per IP, plus per-account lockout |
| `POST` | `/auth/refresh` | refresh cookie | Rotates the session and reissues both cookies |
| `POST` | `/auth/logout` | any | Clears the cookies **and revokes the refresh token**. Always `200` |
| `POST` | `/auth/change-password` | any | Requires the current password. Revokes every *other* session. Rate limited: 5/hour |
| `GET` | `/auth/me` | any | The signed-in user — used to restore a session after a page refresh |

The refresh token is **never** in a response body; it exists only as a cookie.

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
| `GET` | `/customers` | any (scoped) | Filters: `?status=` `?assignedTo=` `?city=` `?search=` · Paging: `?page=` `?limit=` `?sort=` or `?cursor=` |
| `GET` | `/customers/options` | any (scoped) | Minimal id/label rows for the searchable picker. `?search=`, capped at 25 |
| `POST` | `/customers` | any | Defaults `assignedTo` to the creator |
| `GET` | `/customers/:id` | owner / manager / admin | |
| `GET` | `/customers/:id/summary` | owner / manager / admin | Computed figures + health score + an AI narrative. Rate limited |
| `PATCH` | `/customers/:id` | owner / manager / admin | `assignedTo` requires manager or admin |
| `DELETE` | `/customers/:id` | owner / manager / admin | |

`?search=` matches name, email or company, case-insensitively.

### Products

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/products` | any | Filters: `?category=` `?lowStock=true` `?search=` · Paging as above |
| `GET` | `/products/categories` | any | Distinct category list, for the filter dropdown |
| `GET` | `/products/options` | any | Minimal rows for the searchable picker. `?search=`, capped at 25 |
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
| `POST` | `/orders` | any (own customers) | Optional `status: "completed"` to record an already-fulfilled sale. Accepts an optional `Idempotency-Key` header |
| `GET` | `/orders/:id` | owner / manager / admin | |
| `PATCH` | `/orders/:id` | owner / manager / admin | Change `status`, or `items` while still pending |
| `DELETE` | `/orders/:id` | owner / manager / admin | Restores stock if the order was completed |

The date range is inclusive: `?to=2026-01-31` includes orders placed on the 31st.

**`Idempotency-Key`** makes order creation safe to retry. Send a fresh id per logical
submission and reuse it on every retry; the server executes at most once per key and
replays the stored response afterwards (marked `Idempotent-Replay: true`). Reusing a key
with a *different* body is a `409` — that is a client bug, not a retry.

### Dashboard and AI search

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/dashboard/summary` | any (scoped) | Customer count, revenue, low-stock count, status breakdown, 5 most recent orders |
| `POST` | `/ai-search` | any (scoped) | Body `{ query, entity? }` — see below. Rate limited per IP *and* per user |
| `GET` | `/audit-logs` | **admin** | Filters: `?entity=` `?action=` `?actor=` `?entityId=` `?from=` `?to=` |
| `GET` | `/audit-logs/:id` | **admin** | One entry with full before/after documents |
| `GET` | `/health` | public | Liveness probe |

The audit endpoints are admin-only and **read-only**. They hold a copy of every field of
every record, so anyone who could read them would bypass every other permission rule — and
an audit trail that can be edited through the API is not evidence of anything.

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

## AI customer insights

`GET /api/customers/:id/summary` returns three things: computed **figures**, a computed
**health score**, and an AI-written **narrative** about them.

### The model never does arithmetic

The tempting design is to hand the model the order history and ask it to summarise. That is
the design that produces a CRM confidently reporting the wrong revenue - language models are
not arithmetic engines, and a plausible wrong total is invisible to the person reading it.

So `services/customerMetrics.js` computes every figure in one MongoDB aggregation, and the
model only writes prose about them.

**Enforced twice.** The prompt says the figures are authoritative - but a prompt instruction
is a request. The guarantee is the response schema, which has **no numeric fields at all**,
so an invented figure has nowhere to land. A test pushes `totalRevenue: 999999` through the
validator and asserts it is dropped.

### The health score is a formula, not a judgement

Recency 40% / Frequency 35% / Monetary 25%, banded into healthy / stable / at-risk /
dormant.

Computed rather than generated for three reasons: the same customer must score the same
tomorrow (a score that drifts on refresh is a mood, not a metric); a formula can be unit
tested, so *"is 82 right?"* has an answer; and a rep asking *"why is this account at 41?"*
deserves *"the last order was 140 days ago"*, not a paraphrase of a hidden judgement. The
breakdown ships with the score and is rendered under it.

Revenue is weighted **lowest** on purpose - it is the most visible number and the most
misleading alone. A test pins that: a steady small customer (6 orders, $3k, 25 days ago)
must outrank a lapsed big spender (1 order, $30k, 300 days ago). They score 82 and 42.

Monetary value uses a fixed ladder rather than a percentile against the customer base. A
percentile is more respectable statistically and worse in practice: a customer's score would
move because *somebody else* placed an order.

### Reliability and cost

All AI calls go through `services/aiClient.js`: a 10s timeout per attempt, three attempts,
250ms backoff doubling with jitter, and one usage log line per call (feature, tokens each
way, duration, attempts, outcome).

Only retryable failures are retried. A `400` will fail identically every time; not retrying
a `429` throws away a request that would likely have succeeded a moment later.

The SDK's own `maxRetries` is set to **0**, because leaving it on inside a retry loop
multiplies them - up to nine calls at nine times the cost for one request, with the logs
showing one attempt.

Both AI features **degrade rather than fail**: if the model is unavailable the summary is
written from the same figures by a template, and the response says `mode: "fallback"` so the
UI can label it honestly. A generated sentence and a templated one look identical on screen.

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

## Pagination and indexes

### Two paging styles, chosen by the caller

Every list endpoint accepts either. `?cursor=` present means cursor paging; absent means
offset.

| | offset (`?page=3`) | cursor (`?cursor=...`) |
| --- | --- | --- |
| page numbers, jump to page 7 | **yes** | no, only "next" |
| total count | **yes** | no |
| cost at depth | **O(n)** - `skip` walks and discards every skipped document | **O(log n)** with an index |
| stable while rows are inserted | **no** | **yes** |

The UI uses **offset**, because page numbers and "312 results" are what people expect and
the collections a human pages by hand are small. **Cursor** exists for what breaks offset:
the audit log (append-only, unbounded, written at the top) and any script walking a whole
collection.

Drift is the column that matters. Insert a record while someone is paging and everything
shifts down by one, so the last row of page 1 reappears at the top of page 2 while another
is skipped. Two tests sit side by side: one asserting cursor paging does not repeat a row in
that situation, and one asserting **offset paging does** - documenting the trade-off rather
than pretending it away.

### Sorting is deterministic

`getSort` appends `_id` to every sort. Without it, sorting by a non-unique field leaves
MongoDB free to order tied documents differently between two queries - and ties are common,
since any bulk import stamps many rows with the same `createdAt`. The symptom is silent: a
record appears on two pages while another never appears, and the total still reads correctly.

### Indexes

Each index sits next to a comment naming the query it serves. Three findings came out of
reviewing them:

- **Two text indexes served nothing.** Nothing in the codebase issues a `$text` query - both
  the lists and the AI keyword fallback build regexes. They could not have helped anyway:
  `$text` matches whole words with stemming, so it finds "trading" from "trade" but not
  "rach" inside "Karachi".
- **`createdBy` had no index**, despite appearing in both scope filters. MongoDB cannot serve
  an `$or` from one compound index - it evaluates each branch separately - so every sales
  rep's list was scanning the collection.
- **Adding `_id` to every sort invalidated the sorting indexes.** An index on
  `{ createdAt: -1 }` does *not* satisfy a sort of `{ createdAt: -1, _id: -1 }`; MongoDB
  falls back to an in-memory sort. Right answer, just slower. Every sorting index now carries
  `_id` in a matching direction.

The tests assert **usage, not existence** - `explain()` must show an `IXSCAN` with no
in-memory `SORT` stage. Asserting an index exists passes just as happily when it is unused,
which is how the third finding would have been missed.

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

## Deploying to Vercel

Both halves deploy as a **single Vercel project** using [Vercel Services](https://vercel.com/docs/services),
sharing one domain. `vercel.json` at the repo root defines them:

```json
{
  "services": {
    "frontend": { "root": "frontend/", "framework": "vite" },
    "backend":  { "root": "backend/",  "framework": "express", "entrypoint": "src/app.js" }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": { "service": "backend" } },
    { "source": "/(.*)",     "destination": { "service": "frontend" } }
  ]
}
```

Two details make this work:

- **Services are internal by default.** Neither receives public traffic until a top-level
  rewrite targets it — the two rewrites are what expose them. Order matters: the `/api`
  rule must come first, or the catch-all would swallow it.
- **The service receives the original path.** `/api/customers` arrives at the backend as
  `/api/customers`, not `/customers`, which is exactly how the Express routes are already
  mounted. Nothing needs rewriting.

Because the frontend and API share an origin, `VITE_API_URL` stays unset — the client's
default relative `/api` is correct in production, and CORS never enters the picture.

### Required environment variables

Set these in **Project → Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `MONGO_URI` | A MongoDB Atlas connection string. Local MongoDB is unreachable from Vercel. |
| `JWT_SECRET` | A long random string — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `NODE_ENV` | `production` |
| `ANTHROPIC_API_KEY` | Optional. Without it, AI search falls back to keyword search. |

In Atlas, allow Vercel's egress under **Network Access** (`0.0.0.0/0` for a quick start;
tighten it for anything real).

### What had to change for serverless

A long-running server and a serverless function have different lifecycles, and two
assumptions in the original code did not survive the move:

- **Connection reuse.** `config/db.js` now caches the connection promise. A cold instance
  opens one connection and reuses it across every request it serves; concurrent requests
  during startup await the same promise instead of racing to open their own. Calling
  `mongoose.connect()` per request would exhaust Atlas's connection limit in minutes.
- **No `process.exit` on a failed connection.** `connectDB()` throws instead. A serverless
  function that exits takes its whole instance down, turning a recoverable database blip
  into an outage; `server.js` still exits on failure, because a local server that cannot
  reach its database is useless.

`middleware/ensureDb.js` bridges the two: on a long-running server it is a no-op (the
connection already exists), and on serverless it opens the connection on the first request
into a cold instance. `/api/health` is registered *before* it deliberately, so it answers
even when the database is down and reports `"database": "connected" | "disconnected"` —
a health check that fails for the same reason as everything else tells you nothing.

`.vercelignore` keeps `backend/tests` out of the bundle, since they pull in
`mongodb-memory-server`, which downloads a real MongoDB binary.

### Deploy

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Or connect the Git repository at [vercel.com/new](https://vercel.com/new) — the root
`vercel.json` is picked up automatically. Verify with `/api/health` before anything else:
it confirms the backend service is routed and whether it reached the database.

## Testing

Three layers, each doing a job the others cannot.

```bash
cd backend   && npm test          # 442 tests, 19 suites
cd frontend  && npm test          # 60 component tests, 7 files
cd frontend  && npm run test:e2e  # 11 end-to-end tests (real stack, real browser)
```

Lint runs in both packages with `npm run lint`. All of it runs in CI on every push and pull
request - see `.github/workflows/ci.yml`.

### Backend - Jest + Supertest, 442 tests

Run against **mongodb-memory-server**: a real MongoDB, downloaded once and run in memory.
The suite never touches a configured database and leaves nothing behind.

It runs as a **single-node replica set**, not a standalone server. That matters: standalone
MongoDB does not support transactions at all, so the order tests would either fail or -
worse - silently exercise the non-transactional fallback and report success. One test
asserts the harness really is a replica set, for exactly that reason.

| Suite | Covers |
| --- | --- |
| `auth.test.js` | Registration, the admin-bootstrap rule, role-in-body being ignored, bcrypt hashing, login, identical messages for wrong-password vs unknown-email |
| `session.test.js` | Cookie flags (httpOnly, SameSite, Path), short access-token lifetime, refresh token absent from bodies and stored only hashed, rotation, replay rejection, family revocation on reuse, logout revoking a captured token |
| `csrf.test.js` | The attack reproduced directly - session cookie, no header, must fail - plus every exemption |
| `password.test.js` | The policy rules, registration and change-password enforcement, other sessions revoked on change, security headers |
| `rateLimit.test.js` | Per-IP limits and the per-account lockout, including that a locked account refuses the *correct* password |
| `roles.test.js` | The 403s, plus the positive cases that must keep working |
| `customer.test.js` | CRUD, pagination, filters, regex escaping, search combined with rep scope |
| `order.test.js` | Server-side totals, price snapshotting, stock rules, no double-decrement |
| `orderTransaction.test.js` | Partial-write rollback, including a test that writes to two collections then throws from a point no compensation covers - the case only a real transaction survives |
| `orderConcurrency.test.js` | Two simultaneous buyers of the last unit, a burst of ten against a stock of five, and idempotent creation |
| `audit.test.js` | Every write logged, before/after values, actor snapshotting surviving account deletion, redaction, admin-only access |
| `pagination.test.js` | Sort determinism, cursor traversal, and a pair of tests showing cursor paging does not repeat a row mid-insert **while offset paging does** |
| `indexes.test.js` | `explain()` assertions that the real queries use the indexes, with no in-memory sort |
| `aiSearch` / `aiJson` / `aiClient` / `customerSummary` / `leadScore` | Parsing, allow-list validation, retry policy, degradation, and the scoring formula |
| `options.test.js` | The picker endpoints, including that they cannot be used to see another rep's customers |

**The Anthropic API is never called from the test suite.** The service functions are
stubbed, so tests are fast, deterministic, and need no API key. What is tested is everything
around the model - parsing, validation, scoping, and degradation.

### Frontend - Vitest + React Testing Library, 60 tests

Login, protected routes, customer create/edit, order creation, AI search, the error
boundary and the toast system.

Tests find things **the way a user does** - by label, by role, by visible text - never by
reaching into state or props. A test that asserts on internals breaks when the component is
refactored and passes when the screen is broken.

That approach found two real bugs: form labels that were not programmatically associated
with their inputs (so screen readers announced every field as unlabelled), and a form that
rendered blank when its record failed to load - where pressing Save would have written the
blank fields over the record.

### End-to-end - Playwright, 11 tests

These start the **real backend** against a throwaway in-memory replica set, the real
frontend, and a real browser. Nothing is mocked.

That is deliberate. The riskiest work here - httpOnly cookies, the CSRF header, refresh
rotation, the order transaction - is all interaction *between* browser and server. A
component test mocks the server; an API test has no browser. Only this layer can confirm the
cookie was accepted and the header actually sent.

The headline test is login, search the picker, create an order, land on its detail page.
Another verifies in a real browser that `document.cookie` cannot see the session and both
web storages are empty.

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

- **The per-IP rate-limit counters are in process memory.** On Vercel each function
  instance has its own, so the effective limit is roughly (limit x warm instances) and
  counters reset when an instance recycles. A shared store (Redis, or Mongo-backed) is the
  fix. The defence that actually protects an account, the per-account lockout, *is* in
  MongoDB and therefore shared across every instance.
- **The password blocklist is a small in-repo list.** Production should check against a real
  breach corpus, such as the Have I Been Pwned k-anonymity API.
- **No "forgot password" flow.** No email provider is configured, so the reset surface is
  `POST /auth/change-password`, which requires the current password. A one-time-link flow
  would need an email service.
- **Substring search cannot use an index.** An unanchored `/karachi/i` has no prefix to seek
  to, so MongoDB scans the whole index range. Fine at this size; MongoDB Atlas Search is the
  answer at scale.
- **The audit log has no retention policy.** Deliberately no TTL, since logs that delete
  themselves are useless on the day you need them, so the collection grows and pruning is a
  decision for whoever runs the system.
- **Schema indexes are built lazily**, on the app's first use of each collection, so the
  first queries after a deploy can run unindexed. `syncIndexes()` as a deploy step would
  make that deterministic.
- **AI search reads one entity at a time.** A question spanning two entities ("customers
  and their overdue orders") returns whichever the model judged primary.
- **The keyword fallback matches terms, not meaning.** It answers the identifying part of a
  question (a name, city or category) but not the analytical part — "running low",
  "overdue", "top spenders" need the AI path. Its stop-word list is also English-only.
