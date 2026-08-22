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
- [Observability](#observability)
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
| `BREACH_CHECK_DISABLED` | no | — | `true` skips the Have I Been Pwned lookup, for an air-gapped deployment |
| `AUDIT_RETENTION_DAYS` | no | — | Unset means keep audit entries forever. Pruning is still a manual command |
| `APP_URL` | no | first `CLIENT_ORIGIN` | Public URL used to build password-reset links |
| `MAIL_TRANSPORT` | no | `console` | `console` logs the message; `webhook` POSTs it to `MAIL_WEBHOOK_URL` |
| `MAIL_WEBHOOK_URL` | no | — | Required when `MAIL_TRANSPORT=webhook` |
| `MAIL_WEBHOOK_AUTH` | no | — | Sent verbatim as the `Authorization` header on that POST. Needed by every hosted provider |
| `ALLOW_PUBLIC_SIGNUP` | no | `true` | `false` closes `/register` to everyone but the first account, so people arrive by invitation only |

**A note on `APP_URL` and `CLIENT_ORIGIN`.** Neither is required, but leaving both unset used
to break a deployment in two ways that looked unrelated:

- Invite and password-reset links fell back to `http://localhost:5173`, so the token was
  valid and the URL pointed at the recipient's own machine.
- The CORS allow-list fell back to the same localhost default, so a browser on the real
  domain was refused. A CORS refusal is invisible to the page, and axios reports it as the
  literal string `Network Error` — no status, no body, nothing to act on.

Both now fall back to **the origin the request actually arrived on**, so an unconfigured
deployment works. Setting `APP_URL` is still the right thing for anything sending real mail:
an explicitly configured origin cannot be influenced by a request header, which is what makes
a deployment immune to host-header injection in reset emails. See `src/utils/publicUrl.js`.
| `MAIL_FROM` | no | `SimpleCRM <no-reply@simplecrm.local>` | Sender shown on outgoing mail |
| `LOG_LEVEL` | no | `info` in production, `debug` otherwise | `fatal` · `error` · `warn` · `info` · `debug` · `trace` |
| `AI_CACHE_DISABLED` | no | — | `true` turns off the 5-minute AI search response cache |
| `AI_MAX_PROMPT_CHARS` | no | `8000` | Prompts above this are refused before the call is made |
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

### What can be edited, and what cannot

Every entity has list, view, edit and delete. Two of the edit rules are
deliberately narrower than the others, and both exist to stop the UI offering
something the API is right to refuse.

| Entity | View | Edit | Delete |
| --- | --- | --- | --- |
| Customer | detail page | all fields; reassignment for managers and admins only | confirm, then list refreshes |
| Product | detail page | all fields (managers and admins) | confirm |
| Order | detail page | **items only, and only while pending**; status from the detail page | confirm |
| User | the list row carries every field | name and email; role inline; status inline | confirm, never yourself |

**An order's items are frozen once it is completed or cancelled.** The stock has moved and
the money is real — rewriting the lines would silently change what was shipped and what was
charged for it, leaving the stock ledger describing an order that no longer exists. The form
says so in a sentence rather than showing a page of disabled inputs: a form full of dead
controls is a puzzle, a sentence is an answer.

**An order's customer never changes.** Moving an order to a different customer is not an edit,
it is a different order — the original customer's history would silently lose a purchase they
actually made.

**Status lives on the detail page, not the edit form**, because completing or cancelling is
the one action in the UI that moves stock. Keeping that in one place is worth more than the
symmetry of having every field on one screen.

**A user's password is never set by an admin.** The edit form has no password field even
though the endpoint accepts one: an admin setting somebody else's credential is exactly the
pattern the invite flow was built to remove. Someone who has lost access uses the reset flow.

### Order numbers

Orders carry a human-readable number alongside their `_id`:

```
ORD-000142
```

`_id` remains the primary key and remains what URLs and every relation use. The number is a
display and lookup field, not a replacement — swapping the key for a sequential integer would
leak the order volume of the business to anyone who can see one, and invalidate every existing
reference.

It is allocated **atomically**, from a counter document with a `$inc`, and the reason is the
same one behind the atomic stock decrement:

```js
const n = await Order.countDocuments();      // two requests both read 41
await Order.create({ orderNumber: n + 1 });  // both write ORD-000042
```

The window is exactly the gap between the read and the write, which is where every race of
this shape lives. `findOneAndUpdate` with `$inc` closes it by making the read and the write
one operation. `count()` is also not a sequence on its own terms — delete order 42 and the
next one is numbered 42 again, so the number stops identifying anything.

Allocation happens inside the order's transaction, so an order that is never written does not
burn a number. Search accepts whatever someone types: `ORD-000142`, `ord-142` and `142` all
find the same order.

**Existing deployments:** orders created before this field have no number, which is handled
everywhere (the field is optional; the UI falls back to a short id). To close the gap:

```bash
cd backend && npm run backfill-order-numbers        # report
cd backend && npm run backfill-order-numbers --yes  # assign, oldest first
```

### Order assignment

An order can be assigned to a specific rep, independently of its customer.

**Why not just inherit the customer's rep?** Inheriting is right most of the time and was the
previous behaviour. Two ordinary things it cannot express:

- **One deal handled by someone else** — a specialist brought in for a large order, or cover
  during leave. Reassigning the *customer* to move one order hands over the whole relationship.
- **History.** Moving a customer to a new rep silently rewrites who owned every order that
  customer ever placed, including ones closed years ago by someone who has since left.
  Commission and credit are attached to those.

`assignedTo` is therefore stored per order, and **null means "follows the customer"** — the
common case, and the default, so nothing is frozen onto historical rows.

The scope filter treats it as an **override, and it cuts both ways**:

```js
$or: [
  { assignedTo: user._id },                              // explicitly mine
  { createdBy: user._id, assignedTo: null },             // mine unless handed over
  { customer: { $in: myCustomers }, assignedTo: null },  // ditto
]
```

The second half is the part that is easy to miss: an order assigned *away* from you has to
leave your list even though the customer is still yours. Without that, a hand-off adds the
order to the recipient's list and changes nothing for the person who gave it up, and both of
them believe they own it.

`PATCH /api/orders/:id/assign` — manager and admin only, a separate route from the general
update because it is a different kind of change: editing an order alters what was sold,
reassigning alters who is accountable. A rep may do the first to their own order and must not
do the second. The audit entry names both people rather than logging two ObjectIds.

### Role-based UI

Authorisation is enforced by the API. The frontend's job is a different one: not to OFFER
actions that will be refused, so a user never learns to read a 403 as normal.

That logic lives in exactly one place, `frontend/src/hooks/usePermissions.js`, as a table
mapping an ACTION to the roles allowed to perform it:

| Action | admin | manager | sales rep |
| --- | :---: | :---: | :---: |
| `viewAllRecords` — every customer and order, not only their own | yes | yes | no |
| `reassignRecords` — hand a record to a different rep | yes | yes | no |
| `manageProducts` — create, edit, delete | yes | yes | no (read-only) |
| `inviteUsers` | yes | yes | no |
| `manageUsers` — roles, deactivation, deletion | yes | no | no |
| `approveAccounts` | yes | no | no |
| `viewAuditLog` | yes | no | no |
| `viewInternals` — metrics, AI status, AI spend | yes | no | no |

Consumed as a hook (`const { can } = usePermissions()`) or as a wrapper:

```jsx
<Can do="manageProducts">
  <Link to="/products/new">New product</Link>
</Can>
```

**Permissions are named by action, not by role.** `<Can do="reassignRecords">` rather than a
component taking a role list, which is what this replaced. The difference is not cosmetic:
with a role list, every call site restates the policy, so changing who may do something means
finding and editing all of them consistently. It was not being done consistently — the app
had the same rule spelled three different ways, and the customer and order detail pages had
no checks at all.

Each entry names the server-side rule it mirrors, so a drift between the two is visible in
the table rather than discovered by a user hitting a wall. An unknown action throws in
development rather than quietly denying: a misspelling would otherwise hide the control from
everyone, admin included, and look exactly like a deliberate rule.

**None of this is a security boundary.** A hidden button is hidden from someone using the app,
not from someone using curl. The API enforces every rule independently.

### Account lifecycle

There are two ways to get an account, and which of them is available is a deployment
decision — `ALLOW_PUBLIC_SIGNUP`, which defaults to **open**.

| | who starts it | role granted | available when |
| --- | --- | --- | --- |
| **Sign-up** | the person themselves, at `/register` | `sales_rep` | `ALLOW_PUBLIC_SIGNUP` is not `false` |
| **Invitation** | an admin or manager | whatever they choose | always |

The very first account on an empty database is a special case that ignores the setting
entirely: it is always allowed and always becomes the **admin**. A fresh install has nobody
to send an invitation, so gating it would lock everyone out of a new deployment permanently.

**Which to run.** Open sign-up means anyone who can reach the page gets an account and can
read the customer list — the role granted is the least-privileged one, so they cannot
administer anything, but a stranger reading the CRM is usually the part you minded about. A
deployment holding real customer data on the public internet should set
`ALLOW_PUBLIC_SIGNUP=false` and invite people instead. It is left open by default so that a
freshly cloned or demoed instance works without configuration.

```
Admin or manager invites (email + role)
        |  account created as `pending`, with no password
Invitee receives a single-use link (7-day expiry)
        |  they choose their own password
Account becomes `active`, and they are signed in
```

**When there is no mail transport configured**, the invite endpoint returns the link in
`meta.inviteLink` and the Users screen displays it with a copy button, rather than reporting
"Invitation sent" for an email that was never sent. That was a real failure: the link reached
the server log and nowhere else, so the admin waited for a delivery that was not coming and
the invitee never received anything.

Handing the link back is safe **here specifically**, and the reasoning is worth being explicit
about because it does not generalise. The recipient is the manager or admin who just issued
the invite, one call after `protect` and `requireManagerOrAdmin`: they chose the address and
the role, they can re-issue the invite at will, and they can deactivate the account outright.
They are given nothing they did not already control. The password-reset flow deliberately
does **not** do this — there the requester is an anonymous member of the public claiming to
own an address, and returning the token would let anyone take over any account by typing in
an email. When mail genuinely goes out, the link is withheld and the invitee's inbox is the
only place it exists.

| status | can sign in? | meaning |
| --- | :---: | --- |
| `pending` | no | invited, has not set a password yet |
| `active` | yes | normal |
| `deactivated` | no | offboarded — **existing sessions stop working on the next request** |

The invited account holds **no password at all**, so it cannot authenticate even though the
record exists. The password is set by the invitee through the link, which means it is never
transmitted and never known to the admin who invited them. This replaced a form where an
admin typed a password and told the new hire what it was.

**Deactivation is enforced in `protect`, not just at login.** Checking only at login would
leave an offboarded employee working until their access token expired — up to fifteen
minutes of continued access after someone pressed the button. Deactivating also revokes
their refresh token, so the session cannot be resurrected.

Deactivation rather than deletion is the offboarding action: deleting the account would
orphan every customer and order that references it, and the audit trail would lose the name
behind past actions.

**A manager may invite but may not grant `admin`** — a manager who could mint an admin
account would be one.

---

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

**The counters live in MongoDB, shared across every instance.** express-rate-limit's default
is a Map inside the process, which on a serverless platform means each function instance
keeps its own — so the effective limit becomes (configured limit x warm instances) and every
counter resets when an instance recycles. A "10 per 15 minutes" login limit quietly becomes
sixty. Redis is the usual answer; this project already runs MongoDB and nothing else, and a
second datastore for one counter is a real operational cost for a difference measured
against the bcrypt comparison happening on the same request.

The increment is a single atomic upsert. Read-then-write would let simultaneous requests
each read the same count and each write count+1 — hiding exactly the burst these limits
exist to catch.

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

**On top of the local list, every new password is checked against the Have I Been Pwned
corpus** — over half a billion breached passwords, which is where credential-stuffing tools
get their wordlists.

That is done with **k-anonymity**, which is what makes sending anything password-shaped to a
third party acceptable: the password is hashed locally, only the **first five characters** of
the SHA-1 leave this server, HIBP returns every suffix matching that prefix, and the
comparison happens here. The service sees five hex characters — matching roughly 800 hashes —
and cannot tell which was asked about, cannot reconstruct the password, and cannot link the
request to an account. A test asserts the URL contains the prefix and neither the password
nor the full hash.

Ten appearances, not one, counts as breached: a password appearing once may be a genuinely
strong passphrase that happened to be in a dump, and rejecting it teaches people the rules
are arbitrary.

**It fails open.** If the service is slow, down or firewalled, the check is skipped and the
local rules still apply — refusing to let anyone sign up because a third party is unreachable
trades a strong password policy for an outage. `BREACH_CHECK_DISABLED=true` turns it off for
an air-gapped deployment.

### Forgot password

`POST /auth/forgot-password` emails a link; `POST /auth/reset-password` redeems it. Four
decisions carry the security of the flow:

- **The response is identical whether or not the account exists.** "No account with that
  email" is a free enumeration oracle — feed in a list of addresses, learn which are
  customers. The cost is that a mistyped address waits for a mail that never arrives, which
  the mail content mitigates: an address with no account still receives a message saying so,
  which helps the user and tells an attacker nothing, since they cannot read the inbox. The
  UI holds the same line — it says *"if an account exists"*, never *"we've sent you an
  email"*.
- **Tokens are hashed, single-use and expire in 30 minutes.** A reset link bypasses the
  password entirely and travels through email, which is stored, forwarded and synced to
  phones. Requesting a new link invalidates any earlier one, so clicking "forgot password"
  five times does not leave five working keys scattered across a mailbox.
- **Redeeming revokes every session**, with no exception — unlike change-password, which
  spares the current device. Someone resetting is not necessarily at a browser we can trust.
- **The password is validated before the token is consumed.** Otherwise a weak password
  burns the link, and the user is told both that their password was rejected and that their
  reset link no longer works.

Delivery is a seam, not an integration: `MAIL_TRANSPORT=console` (the default) writes the
message and its link to the log so the flow works locally with nothing configured, and
`webhook` POSTs `{ from, to, subject, text }` to `MAIL_WEBHOOK_URL` with `MAIL_WEBHOOK_AUTH`
as the `Authorization` header. Hard-wiring one vendor's SDK for a single email would be the
wrong dependency.

That payload is deliberately the shape [Resend](https://resend.com)'s send endpoint already
accepts, so the common case needs no relay in between:

```bash
MAIL_TRANSPORT=webhook
MAIL_WEBHOOK_URL=https://api.resend.com/emails
MAIL_WEBHOOK_AUTH=Bearer re_your_api_key
MAIL_FROM=SimpleCRM <no-reply@a-domain-you-verified.com>
```

The auth header is not optional in practice. Without it the POST goes out anonymous, which
only an endpoint you wrote yourself will accept — so before it existed, "point
`MAIL_WEBHOOK_URL` at your provider" was quietly untrue and produced a 401 that surfaced as
mail never arriving. A provider whose payload differs (Postmark wants `From`/`To`/`TextBody`)
still needs a small relay, or one more branch in `services/mailer.js`.

### Security headers

Set in **two places**, and the split is easy to get silently wrong. The API and the static
frontend are separate Vercel services, so a header set by Express only ever lands on a JSON
response - it never reaches the HTML the browser executes scripts in.

- **helmet, in `app.js`** - for API responses. `default-src 'none'`, `frame-ancestors
  'none'`, HSTS in production only, and a referrer policy that stops record ids leaking
  through `Referer`.
- **`vercel.json` `headers`** - the real app CSP. The reasoning for every directive is in
  [SECURITY_HEADERS.md](SECURITY_HEADERS.md) rather than inline, because `vercel.json`
  cannot carry comments: JSON has no comment syntax, and Vercel's schema rejects the
  `"//"` key sometimes used as a workaround — it fails the deploy outright.

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

**Retention is opt-in and manual.** Every other growing collection here (refresh tokens,
idempotency keys, rate-limit counters) expires automatically, and that is uncontroversial —
those rows stop being useful the moment they expire. An audit trail is different: it is read
when something has gone wrong, usually about a period nobody was watching at the time, so a
TTL index deletes evidence silently on a schedule nobody remembers setting and the deletion
is discovered on the day it matters.

So the default is keep everything. Setting `AUDIT_RETENTION_DAYS` makes entries *eligible*
for pruning, and `npm run prune-audit` performs it — reporting what it would delete unless
given `--yes`, because deleting audit records cannot be undone and a retention period typed
with the wrong number of zeroes looks exactly like a correct one until it runs. The prune is
recorded in the application log rather than in the audit collection, so the evidence of a
deletion is not itself subject to the deletion policy.

---

## API reference

All routes are prefixed with `/api`. Every route except `register`, `login`, `refresh`,
`logout` and `health` requires a session — either the auth cookies or an
`Authorization: Bearer <token>` header.

Every **state-changing** request authenticated by cookie must also send `X-CSRF-Token`.

### Auth

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | public | Creates an account. The first on an empty database becomes the admin; later ones are `sales_rep`, and are refused with a pointer to the invite flow when `ALLOW_PUBLIC_SIGNUP=false`. The role is never read from the body. Rate limited: 5/hour per IP |
| `POST` | `/auth/login` | public | Sets session cookies; returns `{ user, token }`. Rate limited: 10/15min per IP, plus per-account lockout |
| `POST` | `/auth/refresh` | refresh cookie | Rotates the session and reissues both cookies |
| `POST` | `/auth/logout` | any | Clears the cookies **and revokes the refresh token**. Always `200` |
| `POST` | `/auth/change-password` | any | Requires the current password. Revokes every *other* session. Rate limited: 5/hour |
| `POST` | `/auth/forgot-password` | public | Emails a reset link. **Always answers identically**, whether or not the address has an account. Rate limited: 5/hour |
| `POST` | `/auth/reset-password` | reset token | Redeems a link. Single use, 30-minute expiry, revokes **every** session |
| `GET` | `/auth/invite/:token` | invite token | Who an invitation is for and which role it grants, so the accept page can identify the invitee before asking for a password |
| `POST` | `/auth/accept-invite` | invite token | Sets the password, activates the account, and signs the user in |
| `GET` | `/auth/me` | any | The signed-in user — used to restore a session after a page refresh |

The refresh token is **never** in a response body; it exists only as a cookie.

### Users

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/users/assignable` | any | Trimmed list (id, name, email, role) for dropdowns |
| `GET` | `/users` | admin | Filters: `?role=` `?search=` |
| `POST` | `/users` | admin | Create a user directly, with a password. Retained for scripts; the UI uses the invite flow |
| `POST` | `/users/invite` | admin, **manager** | Creates a pending account and emails a single-use link. A manager may not grant `admin` |
| `PATCH` | `/users/:id/status` | admin | `active` / `deactivated`. Revokes their sessions immediately |
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

### AI cost tracking and caching

### Is the AI actually running?

`GET /api/internal/ai-status` — **admin only** — answers the question this project got
wrong for a long time.

Every AI feature here degrades gracefully: no key, a network blip, an unparseable reply, and
it falls back to something that still answers. That is the right behaviour, and it has one bad
consequence — **a degraded feature looks exactly like a working one**. `ANTHROPIC_API_KEY`
was never set on the deployment, so AI search had been running a plain keyword search behind a
label that said AI. Nothing errored. Every response was a 200. The only evidence anywhere was
a `mode` field on individual responses.

So configuration is now reported as a fact rather than inferred from behaviour:

```json
{
  "configured": false,
  "keyPresent": false,
  "mode": "fallback",
  "model": "claude-sonnet-4-6",
  "recent": { "days": 7, "calls": 0, "succeeded": 0, "failed": 0, "cached": 0 },
  "summary": "ANTHROPIC_API_KEY is not set. Every AI feature is falling back to its non-AI path — AI search is running a plain keyword search."
}
```

`configured` and `recent` answer **two different questions** — "is the key present" and "is it
actually succeeding" — and a deployment can be wrong in either direction independently. A valid
key that has run out of credit reports `configured: true` next to a wall of failures. Cache
hits are excluded from the success count, because counting them would make a wholly broken key
look healthy for as long as the cache stayed warm.

Backed by two things that need no one to go looking: a **startup warning** when the key is
missing in production, and an **admin-only notice on the search box itself**, which is where
someone actually notices. The key is never returned, in any form.

`GET /api/internal/ai-usage?days=30` — **admin only** — reports what the AI features cost.

```json
{ "windowDays": 30,
  "pricing": { "note": "Estimated from published per-token rates…", "checkedOn": "2026-08-21" },
  "totals": { "calls": 431, "billableCalls": 366, "cacheHits": 65,
              "cacheHitRate": 0.1508, "inputTokens": 412000, "outputTokens": 78000,
              "estimatedCostUsd": 2.406, "averageDurationMs": 940 },
  "projectedMonthlyUsd": 2.406,
  "byFeature": [ { "feature": "customer-summary", "calls": 240, "estimatedCostUsd": 1.61 },
                 { "feature": "ai-search", "calls": 191, "estimatedCostUsd": 0.79 } ] }
```

**Why a collection when the same figures are already in the logs.** A log line answers
*"what happened just now"* and is excellent at it. It is poor at *"what did we spend last
month, and on which feature"* — an aggregation over a time range, which needs either a log
platform with a query language and a long retention window, or a table. The table is cheaper
here and survives log rotation.

**What is deliberately not stored: the prompt or the response.** Prompts contain customer
names, notes and order history; keeping a second copy in a collection nobody thinks of as
customer data is how data ends up somewhere it should not be. The token counts are all the
cost question needs.

**Cost is estimated and stored per call, not computed on read**, because prices change —
recomputing last quarter at today's rates would quietly rewrite history. The rate table
carries the date it was checked, so a stale figure is visible rather than assumed current.
It is an estimate from published per-token rates: it does not know about caching discounts,
batch pricing, or the plan the account is on. Good enough for *"is this feature worth what it
costs"*, not for reconciling an invoice.

Usage rows expire after 90 days. Unlike the audit trail — which has no TTL because deleting
evidence is the failure mode — this is operational cost data, and nobody investigates an
incident by reading token counts from last year.

#### Response caching

Identical AI **search** requests are served from a 5-minute in-memory cache.

**It is safe because what is cached is the FILTER, not the results.** The AI call translates
a question into a query; the query is re-run against the live database on every hit, so
nothing stale is ever shown. What could go stale is the translation, and only if the schema
changed mid-session.

**Keyed per user**, which is the part that matters: a sales rep sees only their own
customers, so serving them an admin's cached results would leak exactly the records the
permission model exists to hide. The question is hashed rather than stored, so a customer
name does not sit in a map that ends up in a heap dump.

**The customer summary is deliberately not cached.** It includes figures that move whenever
an order is placed, and showing a rep a revenue number minutes out of date — on the screen
they opened to check it — is a different and worse risk than re-translating a query. Search
caches a translation; a summary would cache an answer.

**In memory, like the metrics and unlike the rate limiter.** A cache is an optimisation, not
a control: a per-instance cache still avoids most duplicate calls, and a miss costs exactly
what the call cost before. A shared cache would add a read and a write to every AI request
to save a fraction more — paying latency on all of them to save money on some.

Only *successful* translations are cached; caching a fallback would keep the feature degraded
for five minutes after a single blip. Entries are capped, because a cache keyed on user input
with no limit is a memory leak with extra steps.

#### Prompt size limit

`AI_MAX_PROMPT_CHARS` (default 8000, roughly 2000 tokens) is enforced **before** the request
leaves the server. Part of every prompt is user-supplied — a search box, a customer's
free-text notes — so without a ceiling someone pasting a document becomes a large and
entirely pointless bill.

Oversized prompts are **refused, not truncated**: a silently shortened prompt produces a
confidently wrong answer and nobody would know why.

---

### Churn risk

Returned alongside the metrics and health score by `GET /api/customers/:id/summary`, and
shown on the customer detail page beneath the score.

**It is not the health score restated.** RFM answers "how valuable is this relationship";
churn risk answers "is it ending", and they disagree in the case that matters most — a
customer with forty orders who has not bought in six months scores superbly and is the most
urgent call in the book.

**Risk is measured against each customer own ordering cadence, not a fixed threshold.** A
flat "90 days = at risk" rule is wrong in both directions: a customer who orders every three
weeks and has been silent for 90 days is four cycles overdue, while one who orders annually
is exactly where they always are. So the measure is how many of their own typical gaps have
elapsed — 1.5 is overdue, 3 is a pattern rather than a delay.

The cadence is averaged across the whole relationship rather than the last two orders, or two
orders placed a day apart during one busy week would imply a one-day rhythm.

| level | means |
| --- | --- |
| `unknown` | no completed orders — an unconverted lead, not a relationship being lost |
| `low` | ordering on schedule |
| `moderate` | overdue by their own standards, or on schedule but spending less |
| `high` | several of their own cycles missed |

Every assessment carries a **reason** built from checkable facts ("they normally order about
every 24 days, and it has been 96"), and the UI shows it. A flag a rep cannot interrogate is
one they learn to ignore.

It is computed, not generated — no AI call, no new query, derived entirely from metrics the
summary endpoint already calculates.

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

**Indexes are built deliberately, not lazily.** Mongoose otherwise creates them on the app's
first use of a collection, which means the first queries after a deploy run unindexed — and,
worse, that an index REMOVED from a schema is never dropped from the database. The two unused
text indexes above would have stayed there forever, still maintained on every write, despite
being deleted from the code. `syncIndexes()` runs at boot on a long-running server and via
`npm run indexes` as a deploy step. Serverless skips it on purpose: cold starts are frequent,
and this only needs doing once per deploy. A failed sync logs and continues, because missing
indexes make the app slow while refusing to start makes it unavailable.

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

## Observability

### Structured logging

Every log line is a JSON object with a level, an ISO timestamp, a **request id**, and
whatever context the event has. `console.log('[db] connected to ' + host)` is readable by a
person watching a terminal and almost useless to anything else — and on a hosted platform
nobody watches a terminal. Logs are searched, filtered and alerted on, and that needs fields
rather than sentences.

```json
{"level":"info","time":"2026-08-21T09:14:22.118Z","component":"http",
 "requestId":"c1f4…","userId":"652f…","req":{"method":"POST","route":"/api/orders"},
 "res":{"statusCode":201},"durationMs":84.2,"msg":"request completed"}
```

Locally it prints readable prose via `pino-pretty` when that is installed; its absence is
not fatal, because a missing dev dependency should never stop the server.

**Three places still use `console` on purpose:**

- `config/env.js` — `config/logger` reads it to decide its level, so requiring the logger
  there would be a circular dependency, and the failure would be the worst kind: the config
  error you are trying to report becomes an unrelated module-load crash.
- the CLI scripts (`seed`, `syncIndexes`, `pruneAuditLog`) — the output is prose for a human
  at a terminal, not records for a log platform.
- `middleware/requestLogger` and the error handler log *through* pino, not console.

Secrets are redacted centrally (`password`, `token`, `authorization`, `cookie` and friends)
rather than relying on every call site to remember. Logs are retained, shipped to third
parties and read by people who are not the user, which makes them the wrong place for a
credential.

**The logger is silent under `NODE_ENV=test`.** Not laziness: the suite deliberately
exercises failure paths — expired tokens, refused logins, rolled-back transactions — and
hundreds of lines of *expected* errors make a real failure impossible to spot.

### Request ids, and tracing a user's report

Every response carries `X-Request-Id`, and **every error response repeats it in the body**:

```json
{ "success": false, "message": "Order not found", "requestId": "c1f4a9b2-…" }
```

That is what makes the logging useful to a real person. A user says *"it failed and showed
me c1f4a9b2"* and that string finds every line produced while handling their request, across
every module. Without it, support starts from a timestamp and a guess.

An **incoming** `x-request-id` (or Vercel's `x-vercel-id`) is **forwarded, not replaced** —
the platform uses it in its own logs, and generating a fresh one would break the chain
exactly where correlating across systems matters. It is validated first, because a header is
user input and an unvalidated one ends up in every log line: that is how log injection works.

The id reaches code five calls deep without being passed as an argument, via
`AsyncLocalStorage`. Threading `req` through every service function purely so it could log
would distort every signature in the codebase for one cross-cutting concern.

### Viewing logs on Vercel

Structured JSON is what Vercel's log viewer parses, so the fields above are directly
filterable.

**In the dashboard:** *Project → Logs*, then filter. Useful queries:

| goal | filter |
| --- | --- |
| one user's report | `c1f4a9b2` (paste the request id straight in) |
| everything failing | `level=error` |
| one endpoint | `route=/api/orders` |
| one subsystem | `component=ai` (or `auth`, `db`, `mail`, `audit`) |
| slow requests | `durationMs>1000` |

**From the CLI:**

```bash
vercel logs <deployment-url> --follow          # live tail
vercel logs <deployment-url> | grep c1f4a9b2   # one request, end to end
```

Log **drains** (*Project → Settings → Log Drains*) forward the same JSON to Datadog, Better
Stack or an HTTP endpoint if it needs to outlive Vercel's retention window — no code change,
because the output is already structured.

### Metrics

`GET /api/internal/metrics` — **admin only** — returns request counts, error rates and
latency buckets per route.

```json
{ "scope": "this server instance only", "instanceId": "a1b2c3d4",
  "totals": { "requests": 1284, "serverErrors": 3, "errorRate": 0.0023 },
  "routes": [ { "method": "GET", "route": "/api/customers",
                "count": 412, "errorRate": 0,
                "latencyMs": { "mean": 31.4, "max": 210, "buckets": { "50": 380, "100": 28 } } } ] }
```

Three decisions worth knowing:

- **Admin, not an IP allow-list.** An allow-list is the usual answer and does not work on
  serverless: the app sees the edge network's addresses, not a stable office IP, so the list
  would be either wrong or meaninglessly broad. The app already has a strong, well-tested
  notion of "administrator".
- **In memory, unlike the rate limiter.** The two look similar and are not. A rate limiter
  is a *control* — wrong counters mean a wrong limit, which is why it moved to MongoDB.
  Metrics are an *observation*, and a per-instance view is still a true sample. Writing to
  the database on every request to improve it would mean the measurement changing the thing
  measured. **The response says so itself** via `scope` and `instanceId`, rather than
  letting a reader mistake one instance's numbers for the deployment's.
- **Latency in buckets, and route labels capped.** Keeping every raw duration would grow
  without bound, and the questions people actually ask ("how many took over a second?") are
  bucket questions. The label cap stops a scanner hitting a thousand unmatched URLs from
  growing the map until the process runs out of memory — a cardinality explosion takes out
  the app it was meant to be observing.

The shape is deliberately close to what a Prometheus exporter emits, so pointing this at a
real monitoring system later is a formatter rather than re-instrumenting the app.

---

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

### Environment variables added since the first deploy

All of these are **optional with safe defaults**, so an existing deployment keeps working
without setting any of them. Add them when you want the behaviour they describe.

| Variable | Set it when |
| --- | --- |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | You want session lifetimes other than 15m / 7d |
| `COOKIE_SAME_SITE` | The API and frontend end up on genuinely different sites (`none` needs HTTPS) |
| `APP_URL` | `CLIENT_ORIGIN` is a comma-separated list — password-reset and invite links need exactly one origin |
| `MAIL_TRANSPORT` / `MAIL_WEBHOOK_URL` / `MAIL_WEBHOOK_AUTH` / `MAIL_FROM` | **Recommended in production.** The default `console` transport only writes reset and invite links to the log |
| `ALLOW_PUBLIC_SIGNUP` | You want accounts to come only from invitations. Defaults to open |
| `LOG_LEVEL` | Default is `info` in production |
| `AUDIT_RETENTION_DAYS` | You want audit entries to become eligible for pruning. Unset means keep forever |
| `BREACH_CHECK_DISABLED` | Outbound HTTPS is firewalled and the Have I Been Pwned lookup cannot reach the internet |
| `AI_CACHE_DISABLED` / `AI_MAX_PROMPT_CHARS` | You want to turn off search caching or change the 8000-character prompt ceiling |

`JWT_EXPIRES_IN` is **no longer read** — `ACCESS_TOKEN_TTL` replaced it. Leaving it set is
harmless; it simply does nothing.

### Node version

Both `package.json` files declare `engines.node >= 20.19.0`, which Vercel reads to pick the
runtime. The floor comes from two places: Vite 7 requires `^20.19.0 || >=22.12.0` to build the
frontend, and the backend uses global `fetch` (Node 18+) for the breach check and the mail
webhook. Declaring it means the platform is not choosing a version by guess.

### Things that deliberately do NOT run on serverless

- **Index syncing.** `syncIndexes()` runs at boot on a long-running server, and is skipped on
  a serverless instance — cold starts are frequent, and paying for an index check on each one
  would add latency forever to do work that only needs doing once per deploy. Run
  `npm run indexes` as a deploy step instead.
- **The pino transport.** Pretty-printing spawns a worker thread, which is the classic way
  logging breaks on serverless. In production the transport is `undefined` and pino writes
  JSON straight to stdout, which is exactly what Vercel's log collector wants.

### After deploying

```bash
curl https://<your-app>/api/health     # 200 = configured and connected
```

`/api/health` reports which environment variables are missing by name, so a misconfiguration
is readable over HTTP rather than being a blind 500.

**Then two things, each done once.**

**1. Sync the indexes**, against the production `MONGO_URI` — the one in the hosting
provider's environment variables, not the one in your local `.env`:

```bash
cd backend
MONGO_URI="mongodb+srv://..." npm run indexes
```

Safe to run against a live database: it creates and drops *indexes* and never reads, writes
or deletes a document. It is not a no-op on an existing deployment either — Mongoose
creates missing indexes on its own but never removes ones the schema has dropped, so a
database deployed before this work is still carrying two unused text indexes and an
`Order.createdAt` index that no longer satisfies the `_id`-tiebroken sort. Those are paid for
on every write until this command removes them. Expect output like:

```
[indexes] Customer: dropped 1 index(es) no longer in the schema — name_text_email_text_...
[indexes] Product:  dropped 1 index(es) no longer in the schema — name_text_sku_text_...
[indexes] Synced 10 collections with their schemas.
```

**2. Set `APP_URL` to your deployment's URL** (optional but recommended):

```
APP_URL=https://your-app.vercel.app
```

Links now fall back to the request's own origin, so invitations work without it. Setting it
explicitly means the origin in an outgoing email cannot be influenced by a request header at
all, which matters once real password-reset mail is going to real users.

**3. Configure a mail transport.** Until you do, password-reset and invite links are only
written to the log — which is a working link sitting in your log output, readable by anyone
with log access. Set all four (see [Forgot password](#forgot-password) for why the auth header
matters):

```
MAIL_TRANSPORT=webhook
MAIL_WEBHOOK_URL=https://api.resend.com/emails
MAIL_WEBHOOK_AUTH=Bearer re_your_api_key
MAIL_FROM=SimpleCRM <no-reply@a-domain-you-verified.com>
```

Setting `MAIL_TRANSPORT=webhook` **without** a URL is worse than leaving it alone: the send
fails and the link goes nowhere, where the `console` default at least leaves it somewhere
retrievable. Verify with a real password reset and check the mail arrives; a failure is
logged with the provider's own error message, so a 422 tells you the `MAIL_FROM` domain is
not verified rather than making you guess.

---

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
| `auth.test.js` | Registration with sign-up open and closed, the admin-bootstrap rule, role-in-body being ignored, bcrypt hashing, login, identical messages for wrong-password vs unknown-email |
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

Things a production deployment would still need, called out rather than left as surprises.

Five earlier entries have since been fixed and are described in their own sections above:
shared rate-limit counters, breached-password checking, the forgot-password flow, audit
retention, and deterministic index building.

- **Substring search cannot use an index.** An unanchored `/karachi/i` has no prefix to seek
  to, so MongoDB scans the whole index range and applies the pattern to every key. That is
  cheaper than a collection scan but still linear. The real fixes are MongoDB Atlas Search
  or a dedicated search service — both are infrastructure decisions rather than code
  changes, and the collections here are far too small to need one. Two tests pin the actual
  behaviour so nobody later assumes it is indexed.
- **Password-reset delivery needs a transport configured.** The flow itself is complete —
  tokens, expiry, single use, session revocation — but the default `console` transport only
  writes the link to the log. A real deployment sets `MAIL_TRANSPORT=webhook`,
  `MAIL_WEBHOOK_URL` and `MAIL_WEBHOOK_AUTH` and points them at a provider or a queue — the
  POST body matches Resend's send endpoint, so that case needs no relay. Deliberately not
  hard-wired to one vendor's SDK for a single email.
- **AI search reads one entity at a time.** A question spanning two entities ("customers
  and their overdue orders") returns whichever the model judged primary. Supporting joins
  would mean a query language rather than a filter object.
- **The keyword fallback matches terms, not meaning.** It answers the identifying part of a
  question (a name, city or category) but not the analytical part — "running low",
  "overdue", "top spenders" need the AI path. Its stop-word list is also English-only.

