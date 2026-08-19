# Build Log

## Project
AI Assisted CRM / Inventory System (SimpleCRM). A multi user CRM and inventory app with authentication, role based access, CRUD for customers, products and orders, search and filtering, and a natural language search feature powered by the Anthropic API.

## Stack
React (Vite) and Tailwind CSS on the frontend, Node.js and Express on the backend, MongoDB with Mongoose for the database, JWT and bcrypt for auth, Jest and Supertest for testing. Deployed on Vercel using their multi service setup so the frontend and backend ship from a single project.

## Approach

I planned the project before touching code. I picked MERN since that is my background, and mapped out the core entities first: User, Customer, Product and Order, then decided on three roles (admin, manager, sales_rep) with different levels of access. Admins can manage everything including users, managers can do full CRUD on customers, products and orders, and sales reps only see and manage their own customers and orders.

I built it in stages: auth and role middleware first, then customer and product CRUD with search and filtering, then orders with stock adjustment logic, then the AI search feature, then tests, then deployment.

## How I used AI

I used Claude Code as my main coding assistant for this project. I gave it a detailed spec covering the data models, auth rules, role permissions, API structure and the AI feature requirement, and had it scaffold the backend first (models, controllers, routes, middleware) and then the frontend pages. I reviewed the generated code as it came in rather than accepting it blindly, checked that the role based access logic actually matched what I wanted, and asked it to explain parts I wasn't sure about before moving on.

For the AI assisted feature itself, I built a natural language search endpoint. A user can type something like "customers in Karachi with no orders in the last 30 days" and the backend sends that query plus a description of the available fields to the Anthropic API, which returns a structured filter object. That gets converted into a Mongoose query. If the AI call fails for any reason, the endpoint falls back to a basic keyword search instead of breaking, since a search feature that just errors out isn't good enough.

I also used Claude for writing the automated tests, and to help debug the deployment once the app was live.

## Testing

Backend tests cover registration and login, role based access checks (making sure a sales rep actually gets blocked from other people's records), and CRUD operations on customers and orders. Tests run against an in memory MongoDB instance so they don't touch the real database.

## Deployment and debugging

Deployment turned out to be the hardest part of this project, more than the actual coding. I deployed to Vercel using their newer multi service config so one project serves both the React frontend and the Express backend from the same domain. After deploying, registration was failing with a 500 error and visiting some routes directly returned a 404.

I added a health check endpoint that reports whether the database is connected and lists any missing configuration, which made the actual problem obvious: I had never added my environment variables (MONGO_URI, JWT_SECRET, CLIENT_ORIGIN) to the Vercel project. Locally these come from a .env file, but that file is gitignored on purpose and never reaches the deployed server, so production had no database connection string and no JWT secret at all.

I set up a MongoDB Atlas cluster, created a database user, opened network access so Vercel's servers could reach it, generated a proper JWT secret, and added everything through Vercel's environment variable settings, then redeployed. After that the health check came back clean and the app worked end to end.

## What I'd do differently

If I started over I'd set up the hosted database and Vercel environment variables before writing any code, instead of leaving deployment for the end. It would have caught this issue much earlier and saved time at the end of the project.

---

# Improvements round 2

After the first review I got detailed feedback on security, AI depth, scalability and
test coverage. This section logs each change and why I made it, in the order I made it.

## Phase 1.1 — Auth tokens: localStorage to httpOnly cookies with refresh rotation

### The problem

The old flow signed one JWT valid for 7 days, returned it in the login response body
and the React app kept it in `localStorage`. Two things are wrong with that:

1. **`localStorage` is readable by any JavaScript on the page.** One XSS — an injected
   script, a compromised npm package, a third-party widget — and the attacker copies out
   a credential and uses it from their own machine.
2. **A signed JWT cannot be revoked.** Logging out only deleted the local copy. Anyone
   who had already captured the token stayed logged in for the rest of the week, and
   there was no server-side action that could stop them.

### What it is now

Two tokens, both delivered as httpOnly cookies the frontend cannot read:

| | access token | refresh token |
|---|---|---|
| what it is | signed JWT | 32 random bytes, no claims |
| lifetime | 15 minutes | 7 days |
| stored server-side? | no | yes, SHA-256 hashed |
| revocable? | no | yes |
| cookie path | `/` | `/api/auth` |

The split is the point. The access token is stateless so that verifying it costs one
signature check and no database round trip — affordable only because it expires in
minutes. The refresh token is the long-lived half, so it is the one that has to be
revocable, which means storing it.

**Why hashed, and why SHA-256 rather than bcrypt.** A refresh token is
password-equivalent: holding one mints access tokens for a week. Storing plaintext would
mean a database leak hands over every live session. It is 32 bytes of CSPRNG output, not
a human-chosen password, so there is no dictionary to attack — bcrypt's slowness would
buy nothing and cost latency on every refresh.

**Rotation and reuse detection.** Every call to `/api/auth/refresh` consumes the
presented token and issues a new one. All tokens descended from one login share a
`family` id. If an already-consumed token is presented again, either the user's copy or a
thief's copy is being replayed and there is no way to tell which — so the entire family
is revoked and both are forced to log in again. That caps the value of a stolen refresh
token at "until the real user next refreshes".

**Cookie flags,** all set in one place (`utils/cookies.js`) so they cannot drift apart:
`httpOnly` (the whole point), `secure` in production only (localhost has no HTTPS and the
browser would silently drop a Secure cookie), `sameSite=lax` (the browser will not attach
these to a cross-site POST, which removes the main CSRF vector before the CSRF token in
1.3 is even consulted), and the refresh cookie scoped to `/api/auth` so the long-lived
credential is not attached to every ordinary API call.

### Trade-off I accepted

Cookies are attached automatically, and that is exactly what makes CSRF possible. This
change is only a net win together with CSRF protection (Phase 1.3); `SameSite=Lax` is the
interim cover. `Authorization: Bearer` is still accepted by the auth middleware for
scripts, the test suite and any future mobile client — an attacker's page cannot set a
header on a cross-site request, so bearer requests are inherently CSRF-immune, and
`req.authVia` records which transport was used so the CSRF check can require a token only
where it is needed.

### Frontend changes

- `api/client.js`: no request interceptor and no token; `withCredentials: true` instead.
  A 401 triggers **one** transparent refresh and a replay of the original request.
- Concurrent 401s share a single in-flight refresh promise. Without that, a dashboard
  firing five requests at once would call refresh five times, and because refresh
  *rotates*, calls 2–5 would present an already-consumed token — the server would read
  that as reuse and kill the session. This was the subtle bug worth designing out.
- A dead session now notifies React (`onSessionExpired`) instead of calling
  `window.location.assign('/login')`, so the redirect happens in the router without a
  full page reload throwing away form state.

### API contract changes (breaking)

- `POST /api/auth/login` and `/register` now **set cookies**. They still return
  `data.token` for non-browser clients; the refresh token is never in a response body.
- **New:** `POST /api/auth/refresh` — rotates the session. No auth header needed; the
  refresh cookie is the credential.
- **New:** `POST /api/auth/logout` — clears cookies *and* revokes the refresh token
  server-side. Always 200, because logging out should be idempotent.
- Any client must now send credentials (`withCredentials` / `credentials: 'include'`).

### New environment variables

`ACCESS_TOKEN_TTL` (default `15m`), `REFRESH_TOKEN_TTL` (default `7d`),
`COOKIE_SAME_SITE` (default `lax`). `JWT_EXPIRES_IN` is no longer read.

Also set `trust proxy = 1` on the app: behind Vercel's edge, Express otherwise reports
the proxy's address as `req.ip`, which would make the per-IP rate limiting in Phase 1.2
treat every visitor as one client.

### Tests

21 new tests in `tests/session.test.js`, using supertest's cookie-jar agent so the real
browser flow is exercised: cookie flags (httpOnly, SameSite, Path), short access-token
lifetime, refresh token absent from response bodies and stored only as a hash, cookie-only
authentication, rotation, replay rejection, family revocation on reuse, and logout
revoking a previously captured token. **188 backend tests passing** (was 167).

## Phase 1.2 — Rate limiting and account lockout

### Two defences, because one is not enough

**Per-IP rate limiting** (`middleware/rateLimit.js`, express-rate-limit) caps how many
requests one address can make in a window. That stops sign-up spam, casual brute force
and runaway scripts. It does *not* stop a distributed attack: someone with a botnet has
thousands of addresses, each staying comfortably under the limit while the account under
attack absorbs thousands of guesses.

**Per-account lockout** (on the `User` model) counts consecutive failures against the
*account*, so it follows the thing being attacked no matter where the traffic comes from.

Neither alone is sufficient. Together they cover both shapes of attack.

### The thresholds and why

| endpoint | limit | reasoning |
|---|---|---|
| login | 10 / 15 min | A person mistypes twice or three times. Ten leaves room for a shared office NAT without being useful to an attacker who needs thousands of guesses. Tighter starts locking out real offices — the failure nobody notices until a customer calls. |
| register | 5 / hour | The only endpoint that creates unbounded state from an anonymous caller, so the tightest limit. Nobody makes a sixth account in an hour. |
| password change | 5 / hour | Verifies the current password, so it is a second place to guess one — and it sits behind a valid session, which makes it easy to forget. Wired up in 1.4. |
| AI search | 20 / 5 min | About money, not security: every call is a paid Anthropic request. Far more than anyone types by hand, far less than a stuck retry loop burns through. |

`protect` runs *before* the AI limiter, so an unauthenticated flood is rejected by the
cheaper check and never eats a signed-in user's quota.

### Exponential backoff, and why not a flat lock

From the fifth consecutive failure, each further one doubles the wait: 1, 2, 4, 8 minutes,
capped at 15.

A flat "15 minutes after 5 tries" punishes the user who genuinely forgot their password
exactly as hard as an attacker. Backoff barely inconveniences someone on their fifth try
but makes sustained guessing arithmetically hopeless — about four attempts an hour once
capped.

**The cap is a deliberate safety valve, not a rounding-off.** An uncapped backoff is a
denial-of-service weapon: anyone can fail logins against a known email address and lock
that person out of their own CRM permanently. Every lockout scheme carries that risk; the
cap bounds it.

The counter is advanced with an atomic `$inc`, not read-modify-write. A burst of parallel
guesses would otherwise all read `4` and all write `5`, recording a hundred attempts as
one — precisely the traffic this exists to catch.

### Two trade-offs I am accepting on purpose

**1. Locking leaks which emails have accounts.** A locked account answers 429 where an
unknown address answers 401. That is real. The alternatives are worse: not locking removes
the protection, and faking a lock for non-existent addresses needs per-email state for
accounts that do not exist, which is itself a way to fill the database. The per-IP limiter
is what covers bulk enumeration.

**2. The IP limiter's counters are in-process.** On Vercel each function instance has its
own memory, so the effective limit is roughly (limit x warm instances) and counters reset
when an instance recycles. The proper fix is a shared store (Redis, or Mongo-backed). Not
done here because it adds an external dependency to a project that otherwise needs only
MongoDB — and crucially, the defence that actually protects an account, the lockout, *is*
in MongoDB and therefore shared across every instance. The IP limiter is the cheap outer
layer; the durable one sits behind it.

The limiters are skipped when `NODE_ENV=test` (the other suites log in dozens of times
from one address, which is the exact traffic these reject). `tests/rateLimit.test.js`
turns them on for itself and resets the counters between tests.

**No API contract change** — only a new 429 response with a `Retry-After` header and a
`retryAfterSeconds` field, in the same `{ success, message }` envelope every other error
uses, so the existing frontend error handling already displays it.

13 new tests. **201 backend tests passing.**

## Phase 1.3 — CSRF protection

### Why this is part of the cookie change, not an extra

It was not needed before. When the token lived in `localStorage`, the app had to attach it
deliberately on every request, and an attacker's page could not do that. Cookies are
attached by the browser *automatically*, to any request aimed at this origin — including
one triggered by a hidden form on evil.com. Moving to cookies is what created this
problem, so this middleware is the second half of Phase 1.1 rather than an unrelated
addition.

### The mechanism: double-submit cookie

1. The server plants a random value in a **non-httpOnly** cookie.
2. The frontend reads it and echoes it back in an `X-CSRF-Token` header.
3. The server requires the two to match, compared in constant time.

An attacker's page can make the browser *send* our cookies, but the same-origin policy
stops it from ever *reading* them — so it cannot produce the matching header. That
asymmetry is the whole trick.

**Why this one cookie is deliberately not httpOnly.** It looks wrong next to the session
cookies, so being explicit: the frontend has to read it, or it could not send the header.
That is safe because the value is not a credential — on its own it grants nothing. It only
proves the request came from code running on our own origin.

**Why not the `csurf` package.** Deprecated and unmaintained since 2022. This is about
forty lines of well-understood logic; vendoring it means no dependency that quietly stops
receiving security fixes.

### What is exempt, and why each exemption is sound

| exempt | reason |
|---|---|
| GET / HEAD / OPTIONS | CSRF is about forged *writes*. An attacker can force a GET but cannot read the response — the same-origin policy already covers that — and requiring a token on GET would break ordinary navigation. |
| `Authorization: Bearer` requests | **The important one.** A header has to be set deliberately by the caller; an attacker's cross-origin page cannot set headers on a browser request. Bearer calls are inherently CSRF-immune, so demanding a token from a script would be ceremony with no security value. |
| requests with no session cookie | e.g. login itself. There is no session to ride, so nothing to forge. |

The bearer test is `req.cookies[access]` presence, checked in the middleware rather than
via `req.authVia`, because this runs *before* `protect` — a forged request must be
rejected before it reaches anything that acts on it.

### Defence in depth

`SameSite=Lax` on the session cookies (Phase 1.1) already blocks the cross-site POST in
every browser that honours it. This is the second layer, for what SameSite does not cover:
an older browser, a compromised same-site subdomain, or a future deployment forced onto
`SameSite=None` because the API and frontend end up on genuinely different sites.

### API contract change (breaking)

Every cookie-authenticated **write** (POST/PATCH/PUT/DELETE) must now send
`X-CSRF-Token`, read from the `simplecrm_csrf` cookie. The frontend does this
automatically in an axios request interceptor, reading the cookie fresh on each request —
caching it at startup would go stale when the server reissues one, and every write would
then 403. Bearer-authenticated clients are unaffected.

10 new tests, including the attack reproduced directly: a request carrying the session
cookie but no header must fail. **211 backend tests passing.**

## Phase 1.4 — Security headers and password policy

### Security headers: the split that is easy to get silently wrong

The app is two Vercel services — the Express API and the static frontend. **A header set
by Express only ever lands on a JSON response.** It never reaches the HTML document the
browser is actually executing scripts in. So configuring a strict CSP in helmet and
assuming the SPA is protected is a complete no-op, and nothing warns you.

Both halves therefore exist, and each points at the other:

- **helmet, in `app.js`** — for API responses. A JSON endpoint has no legitimate reason to
  load a script, embed a frame or be framed, so `default-src 'none'`, `frame-ancestors
  'none'`, `base-uri 'none'`, `form-action 'none'`. If an endpoint were ever tricked into
  reflecting HTML, the browser would refuse to run it. Plus HSTS (production only —
  pinning `localhost` to HTTPS is remembered by the browser for a year and is genuinely
  unpleasant to undo), `strict-origin-when-cross-origin` referrer policy (record ids live
  in our URLs, and a full `Referer` would leak them to any site a user clicks through
  to), and `Cross-Origin-Resource-Policy: same-site`.
- **`vercel.json` `headers`** — for the frontend. The real app CSP, with each directive
  commented in the file itself.

### One deliberate CSP weakening, stated plainly

`style-src` includes `'unsafe-inline'`. Recharts (the dashboard charts) sets style
attributes at runtime and CSP counts those as inline styles. Removing it would require
nonces on every generated element, which a third-party chart library does not offer.
Inline **style** is a far smaller risk than inline **script** — the worst case is
defacement, not code execution — and `script-src 'self'` stays strict. `connect-src 'self'`
means even a script that somehow ran could not exfiltrate data to an attacker's server.

`style-src`/`font-src` also allow Google Fonts, because the app loads IBM Plex Sans there.

### Password policy: why it is not "8 chars, one capital, one number"

That is the policy NIST SP 800-63B specifically advises against, and it is worth being
able to say why. Composition rules do not produce unpredictable passwords — they produce
`Password1!`, because people satisfy them in the same few ways. What resists guessing is
**length** and **not already being in a breach corpus**.

| rule | reasoning |
|---|---|
| ≥ 10 characters | The floor. |
| ≥ 14 → no variety required | `correct horse battery staple` is far stronger than `Xy7!qZ` and should not be rejected for lacking a digit. |
| 10–13 → 3 of 4 character classes | A short password has to buy its entropy from variety instead. |
| not on the common list | Credential stuffing tries those first, so blocking them removes the cheapest attack outright. |
| nothing derived from the name or email | `ayesha@…` / `ayesha2024` is guessed first by exactly the person attacking the account. |
| ≤ 72 bytes | **Not a style rule — a real bug.** bcrypt silently truncates at 72 bytes. Without a limit, a 100-character password is accepted, quietly shortened, and any other password sharing the first 72 bytes opens the account. Accepting input we then discard is worse than saying no. |

Two honest limits: the blocklist is a small in-repo list, where production should query a
real corpus (Have I Been Pwned's k-anonymity API); and it is checked against several
normalised forms of the input, because people bolt digits on (`password123`) and
substitute characters (`P@ssw0rd`). **The ordering there was a bug I hit and fixed:**
undoing substitutions *before* stripping the trailing digits turns `P@ssw0rd123` into
`passwordi2e`, which matches nothing. The suffix has to come off first.

All problems are reported at once. Telling someone their password is too short, watching
them fix it, then telling them it also contains their name is a small cruelty.

### `POST /api/auth/change-password` (new)

A full "forgot password" flow needs an email provider to deliver a one-time link, and
none is configured — inventing one would be a fake feature. **This is the password-reset
surface the app actually has**, and it does three things that are easy to leave out:

1. **Requires the current password.** Otherwise anyone at an unlocked laptop, or holding a
   stolen access token, locks the real owner out of their own account.
2. **Applies the same strength policy as registration.** A policy enforced on one of the
   two paths that set a password is not a policy.
3. **Revokes every other session,** then issues a fresh one for this device. Changing a
   password is what you do when you think you are compromised; if the attacker's session
   survives it, the change achieved nothing.

It is rate limited as well as authenticated — it verifies a password, so it is a second
place to guess one, and endpoints behind a login are the easy ones to forget.

**No UI for it yet** — the API binding exists in `resources.js`; the form belongs with the
frontend work in Phase 4.

### Fixture change worth noting

Every test and the seed script used `password123`, which is now (correctly) rejected as a
common password. They use a compliant password instead. The model's `minlength` went 8 →
10 as a backstop; the real policy is enforced at the API boundary, because only there do
we know the user's name and email to check the password against.

25 new tests. **236 backend tests passing.**

## Phase 1.5 — MongoDB transactions for the order lifecycle

### What was wrong

Creating an order touches two collections: it writes an `Order` and decrements `stockQty`
on several `Product`s. Those were separate writes with gaps between them, and a crash, a
timeout, or a serverless function frozen mid-request left the database not merely stale
but **wrong**:

- stock taken, order never written → inventory vanished into nothing
- order written, stock not taken → the same unit can be sold twice

The old code compensated by hand — decrement, and on failure loop back over the products
already touched and add the stock back. That works right up until the process dies between
the failure and the compensation, at which point nothing runs the undo and there is no
record that it was owed.

A transaction moves the guarantee from *"our code remembers to clean up"* to *"the database
will not show anyone a partial result"*. Stronger promise, shorter code.

### How it is done

`utils/transaction.js` wraps `session.withTransaction`, and the three handlers that move
stock — create, update (status transitions), delete — each run entirely inside one.

**`session.withTransaction` rather than start/commit/abort by hand,** because it retries
the two errors a correct transaction still has to expect:

- `TransientTransactionError` — two transactions touched the same document and one lost the
  write conflict. Retrying is the prescribed response, and it is **exactly what happens
  when two people buy the last unit at once** (Phase 1.6).
- `UnknownTransactionCommitResult` — the commit may or may not have landed. Retrying is
  safe; a committed transaction commits idempotently.

Hand-rolled start/commit/abort silently drops both, so the code looks correct and fails
only under the concurrency it was written for.

**The session is an explicit parameter on every helper,** not something ambient. A query
that misses it runs *outside* the transaction and is neither isolated nor rolled back —
that is the standard way a transaction ends up being decorative, and making it a required
argument is what stops it happening quietly.

**The order document is loaded inside the transaction** in `updateOrder`, not before it.
Loading outside would reintroduce exactly the read-then-write gap the transaction exists
to close.

### The graceful-degradation decision

MongoDB transactions require a replica set or sharded cluster. A plain standalone `mongod`
does not qualify:

| environment | topology | transactions |
|---|---|---|
| MongoDB Atlas (incl. free tier) | replica set | yes |
| `mongod` installed locally for dev | standalone | **no** |
| the test suite | single-node replica set | yes |

So a developer on a local standalone would otherwise hit an obscure *"Transaction numbers
are only allowed on a replica set member"* on every order. Rather than demand everyone
reconfigure their MongoDB, `withTransaction` detects it at first use, warns loudly once,
and runs the same work without a session — falling back to the old hand-rolled
compensation, which is degraded but not broken. Detected at runtime rather than inferred
from the connection string, because the string does not reliably tell you.

### Test harness change

`tests/setup.js` now starts `MongoMemoryReplSet` instead of `MongoMemoryServer`. This
matters more than it looks: a standalone test database would make every transaction test
**silently exercise the fallback path and report that the transactions work**. One test
asserts the harness really is a replica set, for exactly that reason.

Costs a few seconds of extra start-up per test file. Right price for testing the code path
production runs.

### An honest note on the tests

Most of the new lifecycle tests would *also* pass against the old hand-rolled compensation
— each of their failures happens at a point the compensation knew how to undo. So there is
a separate block that tests the wrapper directly: write to two collections, then throw from
a place no undo exists for. Nothing in the application puts those back. Only the database
can, and only if the work really was in a transaction.

14 new tests. **250 backend tests passing.** No API contract change.

## Phase 1.6 — Concurrency-safe stock and idempotent order creation

### Two failure modes that survive a green test suite

Both of these only appear under real traffic, and both show up months later as *"the
numbers don't add up"*:

- **Overselling** — two requests each read the stock, each see enough, each decrement.
- **Duplicate orders** — one logical submission becomes two, because the response was lost
  and the client retried.

Neither can be found by testing one request at a time, which is why the new tests fire
requests in parallel and replay them.

### Atomic conditional updates: what is authoritative and what is not

`decrementStock` uses `updateOne({ _id, stockQty: { $gte: quantity } }, { $inc: … })`.
MongoDB matches and decrements as **one operation**, so two requests for the last unit
cannot both succeed — the loser matches no document and reports zero modified. A
read-then-write check lets both through and lands at stock `-1`.

The read-then-write check in `buildOrderItems` is deliberately **kept**, and its role is
now written down in the code:

| | role |
|---|---|
| `buildOrderItems` check | **Advisory.** The only place that can produce a useful message — it knows the product name, SKU, amount requested and amount available. Catches the overwhelmingly common case (a genuinely impossible order) and explains it. |
| `decrementStock` | **Authoritative.** A conditional update that cannot be raced. Correctness lives here and only here. |

For a *pending* order the advisory check is the only stock validation that runs, and that
is correct — a pending order reserves nothing, so its check is inherently advisory and the
stock is verified again, atomically, on completion.

### Idempotency keys

`POST /api/orders` accepts an optional `Idempotency-Key` header. The client generates one
per logical submission and reuses it on every retry.

**Why the submit button is not the answer.** Disabling it handles the double-click and
does nothing at all for the case that actually costs money: the response is lost, the user
refreshes, and the retry comes from a *new page load* where no button state exists. The
client cannot know whether the order was created — retrying risks a duplicate, not
retrying risks losing the sale. An idempotency key removes the dilemma.

**Why the stored response, not just the key.** Recording "this key was used" and rejecting
the retry leaves the client exactly where it started — it still does not know the order id.
Replaying the original response answers the real question.

**Why the reservation is an insert into a unique index, not a check-then-insert.** Two
retries can arrive in the same millisecond, on different serverless instances. Both would
read "no key yet" and both would proceed. Inserting into a unique index pushes the decision
to the database, the only place that can arbitrate: one insert wins, the other gets a
duplicate-key error. That *is* the mechanism.

**A fingerprint (SHA-256 of method + path + body) is stored too.** A retry sends the same
body; the same key with a *different* body is a client bug, and replaying the stored
response would hand back an unrelated order. Refused with 409.

**Key generation lives in `ordersApi.create`, not in the axios interceptor.** An
interceptor fires per HTTP request, so it would mint a *new* key for a retry — defeating
the mechanism entirely. Generating once per logical submission is also what makes the
401-refresh-and-replay in `api/client.js` safe.

### Three trade-offs

1. **The key is optional.** Requiring it would be stricter and would break every existing
   client and curl command the day it shipped. Optional keeps the API backwards compatible
   while the frontend sends one on every order, so the path users actually take is
   protected. Cost: a client that forgets the header gets no protection and nothing tells
   it so.
2. **Keys expire after 24 hours.** Long enough for any realistic retry, short enough that
   the collection does not grow forever. A longer window prevents more duplicates and
   stores more data — a judgement, not a fact.
3. **A failed request releases its key.** The request created nothing, so there is nothing
   to protect from a repeat, and holding the key would force a client to invent a new one
   just to correct a typo.

If recording the outcome fails, the reservation is left `in_progress` and a retry gets a
409 telling it to try shortly, until the record expires. Losing a response is a strictly
better failure than executing the order twice.

### API contract change (additive, non-breaking)

`POST /api/orders` accepts `Idempotency-Key`. Responses to a replay carry
`Idempotent-Replay: true`. New status codes on that endpoint: **409** for a key reused with
a different body, or still in progress.

16 new tests. **266 backend tests passing.**

## Phase 1.7 — Audit logging

### Why the data itself cannot answer these questions

Ordinary documents hold only their *current* state. The moment a field is overwritten,
what was there before is gone — and with it any way to tell an honest correction from a
mistake, or from someone covering their tracks. Three questions need a separate record:

- **"Who deleted this customer?"** — accountability
- **"What did this record look like before someone changed it?"** — recovery
- **"Did anyone touch these orders last Tuesday?"** — investigation

A stock adjustment is the clearest case: a manual correction and a mistake look completely
identical in the product document.

### Explicit calls, not a Mongoose hook

A `post('save')` hook would catch every write automatically and could never be forgotten,
which sounds strictly better. It is not:

1. **A model hook has no idea who made the request.** Mongoose middleware sees the
   document, not the HTTP request, so the actor would have to be smuggled in through
   `AsyncLocalStorage` or stapled onto the document. Both work; both mean the most
   security-sensitive code in the app runs through indirection that is hard to follow and
   easy to break silently.
2. **Hooks fire on writes that are not user actions** — seeding, migrations, the
   failed-login counter — and filtering those back out is guesswork.

`grep recordAudit` lists every audited action. The cost is that a new write handler could
forget one, which is why there is a test asserting each write endpoint logs.

### Three decisions inside the record

**The actor is denormalised.** `actor` stores the user's id *and* a snapshot of their name,
email and role at the time. This looks like duplication and is deliberate: an audit trail
whose contents change when someone is renamed, demoted or deleted is not an audit trail.
"Ayesha (manager) deleted this" must still read that way a year later, after Ayesha has
left and her account is gone. There is a test for exactly that.

**`entityLabel` is captured too.** Without it, the entry for a deleted customer reads
"customer 652f8a…" — which is the case where the name matters *most*, because the record is
gone and nothing can look it up.

**`changes` is precomputed.** Strictly redundant given before/after, but a reviewer wants
"status: lead → active", not two whole documents to diff by eye. Computing it once at write
time also keeps the list endpoint from doing it for every row on every request.

### Redaction

The audit trail is kept indefinitely, read by administrators, and never overwritten — which
makes it exactly the wrong place to accumulate credentials. `password`, `tokenHash` and the
lockout counters are stripped before anything is stored, with a test asserting no bcrypt
hash ever reaches it. An audit trail that quietly collects secrets is a liability rather
than a control.

### **No TTL index — a deliberate omission**

Every other new collection in this project expires its rows automatically. This one does
not, and that is the point: audit logs that quietly delete themselves are exactly as useful
as no audit logs on the day you need them. The collection *will* grow, and pruning it is a
retention decision for whoever runs the system — a conscious policy, not a default.

### Admin only, and why that is not just caution

The trail holds a copy of **every field of every record**. That makes it a way around every
other permission rule in the app: a sales rep who could read it would see customers they
have no access to, and a manager reading it would be reading their own audit. Enforced with
`router.use` on the whole router rather than per route, so a handler added later is
protected by default.

**There are no write routes at all.** An audit trail that can be edited or deleted through
the API is not evidence of anything.

### Ordering: audited after the transaction commits

Order writes are logged *outside* the transaction. Inside, a rollback would erase the audit
entry along with the order — which is the right outcome for a failed write (nothing
happened, so nothing should be logged, and there is a test for that) but also means the
audit write can cause a write conflict and retry the whole order. Outside, the trail
records what actually happened, which is what it is for.

Snapshots are always taken **before** any field is touched. Taking them afterwards would
record the new values as the old ones and make the trail actively misleading.

### New endpoints and screen

- `GET /api/audit-logs` — admin only. Filters: `entity`, `action`, `actor`, `entityId`,
  `from`, `to`. Paginated and sorted, newest first. Each filter is backed by an index.
- `GET /api/audit-logs/:id` — one entry with full before/after. Separate from the list
  because shipping two complete documents for every row of a 25-row page would make the
  list heavy for data almost nobody expands.
- **`/audit`** in the frontend, admin only in the router *and* on the API, with the
  field-level diff expandable per row.

23 new tests. **289 backend tests passing.** Phase 1 complete.
