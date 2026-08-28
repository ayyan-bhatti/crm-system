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

---

# Phase 2 — AI features

## Phase 2.1 — AI customer summary

### The one decision the whole feature rests on

The tempting shape is: hand the model the customer's order history and ask it to summarise.
That is exactly the shape that produces a CRM which confidently reports the wrong revenue.
**Language models are not arithmetic engines** — they will add fourteen order totals and be
plausibly, invisibly wrong, and the person reading the summary has no way to tell.

So the split is absolute:

| | responsibility |
|---|---|
| `services/customerMetrics.js` | computes **every** figure, with MongoDB doing the arithmetic |
| the model | receives those figures and writes prose about them |

The model never sees a raw order and is never asked to count anything.

**Enforced twice, not once.** The prompt tells it the figures are authoritative and must
not be recalculated — but a prompt instruction is a *request*. The guarantee is the
response schema: it has **no numeric fields at all**, so a figure the model invented has
nowhere to land. There is a test that passes `totalRevenue: 999999` through the validator
and asserts it is dropped.

### Figures, and the definitions behind them

One aggregation pipeline, not several queries — one round trip, and every figure computed
from the same view of the data, so the order count and the revenue can never disagree
because an order arrived between two reads.

- **Revenue counts completed orders only.** Pending money is not revenue — it can still be
  cancelled — and counting it would make the summary optimistic exactly where accuracy
  matters. Written down in one place because the dashboard and the summary must agree; two
  definitions of "revenue" in one product is a support ticket waiting to happen.
- **Order count includes everything, cancellations included.** "They placed 12 orders" is
  true, and hiding the cancellations would misrepresent the relationship.
- **Average order value divides by completed orders,** to stay consistent with revenue.
  Dividing revenue by every order would produce a number that is not the average of
  anything.

### Trend: five words, not a percentage

`rising / steady / declining / new / dormant / no_orders`, from comparing revenue in the
last 90 days against the 90 before.

Deliberately coarse. A percentage change between two windows *sounds* precise and is mostly
noise for a customer with three orders; a word is honest about how much the data actually
supports. The 20% threshold is a judgement, chosen so ordinary variation in one order's
size does not read as a trend.

### It degrades to a template, never to an error

Every figure comes from the database, so when the AI call fails nothing about the *data* is
unavailable — only the wording. A 503 would hide correct information behind a failure in
the optional part of the feature. `services/summaryFallback.js` writes the same summary by
rule.

The fallback's wording is deliberately plainer and **never claims higher than "medium"
confidence** — a template cannot judge how well data supports a conclusion, and claiming
otherwise would be a lie told by a string concatenation.

**`mode` is in the response** (`'ai'` or `'fallback'`) and the UI says which. A generated
sentence and a templated one look identical on screen; letting a reader assume the first
when it is the second is the small dishonesty that costs trust in the whole feature.

### The UI keeps provenance visible

The card separates the **figures** (computed, exact) from the **narrative** (generated, an
interpretation) into distinct visual blocks. Laying them out as one paragraph would invite
a reader to trust both equally. The card also loads independently of the rest of the page,
so a slow AI call never delays the record the user actually navigated to.

### New endpoint

`GET /api/customers/:id/summary` — returns `{ metrics, summary, mode }`. Same access rule
as reading the customer: a summary is a view of the record, so it cannot be a way around
the record's permissions (tested). Rate limited with the AI limiter — Phase 2.4 replaces
that with one that also counts per user.

25 new tests, all with the model stubbed — no API key needed and no credits spent.
**314 backend tests passing.**

## Phase 2.2 — Customer health score (RFM)

### Why this is arithmetic and not an AI call

Asking the model for a score would be easy and would look more impressive on a feature
list. It would also be wrong, for three reasons worth being able to say out loud:

1. **Reproducibility.** The same customer, unchanged, must score the same today and
   tomorrow. A model asked twice returns two answers, and a health score that drifts on
   refresh is not a metric — it is a mood.
2. **Testability.** *"Is 82 the right score for this customer?"* has an answer here.
   The same question about a model's output has none. `tests/leadScore.test.js` only exists
   because the score is computed.
3. **Explainability.** A rep asking *"why is this account at 41?"* deserves *"because the
   last order was 140 days ago"*, not a paraphrase of a hidden judgement.

The AI still has a job — it writes the narrative about the score. **Numbers from code,
words from the model**, the same division as 2.1 for the same reason.

### Why RFM, and the weights

Recency / Frequency / Monetary is the standard CRM segmentation model. That matters
practically: it is a known method with a literature behind it, so the weights are a
documented judgement rather than three numbers invented on a Tuesday.

| component | weight | reasoning |
|---|---|---|
| Recency | **40%** | The strongest single predictor of whether someone buys again. Bought last week = a live relationship; bought once two years ago mostly is not, whatever they spent. |
| Frequency | **35%** | Repeat buying is habit, and habit is what a rep can build on. Close to recency because a regular small customer usually deserves more attention than a one-off large one. |
| Monetary | **25%** | Deliberately the smallest. Revenue is the most visible number and the most misleading one alone. |

**There is a test that justifies the weights:** a steady small customer (6 orders, $3k, 25
days ago) must outrank a lapsed big spender (1 order, $30k, 300 days ago). They score 82 and
42. If someone later "fixes" the weights so revenue dominates, that test fails and says why.

### Monetary is scored against a fixed ladder, not a percentile

A percentile would be more statistically respectable and much worse in practice: it needs
the whole customer base loaded to score one customer, and — the real problem — **a
customer's score would change because someone else placed an order.** A score that moves
without the customer doing anything is impossible to explain to the person looking at it.

`calculateLeadScore` takes exactly one argument and touches no database, so that guarantee
is structural rather than merely tested.

### The breakdown is the feature

The endpoint returns the score *and* the three components with the actual figure behind
each, and the UI shows them under the meter. A score with no explanation is a number people
learn to ignore. There is a test that the components add back up to the reported score, so
the explanation can never drift from the thing it explains.

### It feeds the prompt, and the prompt cannot override it

The computed score is passed to the model with an instruction that its wording must **agree**
with the number — a paragraph calling an account "strong" next to a score of 31 is worse
than no paragraph. And as with every other figure, the response schema has no field for a
score, so the model cannot return one of its own.

The score is computed **before** the AI call, so an AI outage costs the wording and never
the number.

### Bands

`healthy` (75+) · `stable` (50-74) · `at_risk` (25-49) · `dormant` (<25) — used for the
label and colour. Shown as a meter rather than a bare number: it is one value on a fixed
0-100 scale, and the bar communicates that instantly in a way "72" does not.

18 new tests. **332 backend tests passing.**

## Phase 2.3 — Structured AI output, in one place

### What changed

`extractJson` was living inside `aiSearchService.js`, and the customer summary imported it
from there — a service reaching into another service for a parser. Both AI features now go
through `services/aiJson.js`: defensive parsing, a shared `parseAndValidate`, and the small
field validators (`string`, `enumValue`, `boundedNumber`) that both response schemas need.

The point of consolidating is not tidiness. **The alternative is two slightly different
parsers that drift, and the one that drifts is the one that lets something through.**

### The framing that makes the rules obvious

A model's output is **untrusted input, exactly like a request body**. It is not "nearly
right" data that needs tidying — it is a string from outside the system. Once that is the
frame, the three rules stop looking paranoid:

- **Parse defensively.** "Respond with JSON only" is an instruction, not a guarantee. The
  parser handles markdown fences, surrounding prose, nested objects and braces inside
  string values. Those are real failure modes that were hit, not hypothetical ones — hence
  counting braces rather than regex-matching, and tracking string literals so a customer
  note containing `}` cannot truncate the object.
- **Validate against an allow-list.** Both validators build their result **field by field**,
  never by spreading the parsed object. That is the whole difference between a schema and a
  tidy-up: `{ ...raw }` with a few fields corrected carries through every key the model
  invented, including a `totalRevenue` it made up.
- **Fail closed.** Anything that does not validate is discarded entirely and the caller
  degrades to its fallback. Half an answer is not better than a template.

### The two validators guard against different things

| | risk | consequence of a miss |
|---|---|---|
| **search filter** | **injection** — its output becomes a database query | a hallucinated `$where` reaching MongoDB |
| **customer summary** | **fabrication** — its output becomes text a human trusts | a confidently wrong revenue figure on screen |

Same mechanism, opposite failure modes. The summary schema's most important property is
what it leaves out: no numeric fields at all, so an invented figure has nowhere to land.

### Why not zod or ajv

Both would work; neither is here, for two reasons.

1. The validation this app needs is not "is this a string" — it is *"is this field name on
   the allow-list for this entity, and is this operator legal for that field type"*, which
   is domain logic a generic validator expresses awkwardly.
2. **`filterSchema.js` generates the model's prompt AND the validator from the same object.**
   The prompt and the validator therefore cannot disagree. That property is worth more than
   a shorter validator, and a separate schema library would take it away.

### The guarantee

Every failure is a returned value, never an exception: `{ ok: false, reason }`. **No AI
feature can 500 because a model said something strange.** There is a test that throws six
kinds of malformed input at `parseAndValidate` — including a `__proto__` payload — and
asserts none of them throw.

28 new tests. **360 backend tests passing.** No API contract change; this is a refactor
plus the tests that pin the behaviour.

## Phase 2.4 — AI reliability and cost controls

### One client, because two reliability policies is two places to get it wrong

Both AI features previously constructed their own `new Anthropic(...)` with their own
timeout and retry settings. A timeout that is 20 seconds in one feature and unset in
another is not a configuration, it is an accident waiting to be found in production.
`services/aiClient.js` is now the only place that talks to Anthropic.

### The settings, and the reasoning

| setting | value | why |
|---|---|---|
| timeout | **10s per attempt** | Chosen against the user's patience, not the model's speed. These are short prompts with small replies; past ten seconds something is wrong, and waiting longer only delays the fallback that will be shown anyway. |
| attempts | **3** (one try + two retries) | Deliberately low. Every retry is a real delay in front of someone waiting, and both features degrade gracefully — so giving up costs a plainer answer, not a broken page. Retrying five times to avoid a template is the wrong trade. |
| backoff | **250ms, doubling, jittered** | See below. |
| SDK `maxRetries` | **0** | Critical. Leaving the SDK's own retries on inside a loop that also retries would multiply them — up to nine calls at nine times the cost for one request, with the logs showing one attempt. Retry logic belongs in exactly one layer. |

**The jitter is not decoration.** If several requests are rate limited at the same moment
and all back off by exactly 250ms, they retry in lockstep and hit the limit together again —
a thundering herd that turns one bad second into several. There is a test asserting twenty
calls to `backoffDelay` do not all return the same number.

### Retrying only what is worth retrying

The distinction matters in **both** directions:

- Retrying a **400** wastes time and money on a request that will fail identically every
  time. The prompt is wrong; patience does not fix it. Same for 401/403 — a bad API key
  stays bad.
- **Not** retrying a **429 or 503** throws away a request that would very likely have
  succeeded a moment later.
- **No status at all** (timeout, DNS failure, dropped connection) means the request never
  got an answer, so trying again is reasonable.

### Cost controls

**Usage logging** — one line per call: feature, model, input/output tokens, duration,
attempt count, outcome. Deliberately a **log line, not a collection**. Token usage is
operational data, read while investigating a bill or a latency spike, not queried by the
application — and a log is where the platform's tooling can already aggregate and alert on
it. A MongoDB write on every AI request in exchange for a query nobody in this app makes
would be the wrong trade.

**Per-user rate limiting, on top of per-IP.** The two catch different things, and the IP
limiter gets it wrong in *both* directions on its own:

- An office behind one NAT address shares a single IP, so five colleagues using the feature
  normally would exhaust one quota between them — a limit that punishes ordinary use.
- A determined user with a phone hotspot changes IP freely, so the IP limit alone is not a
  cap on any individual's spending.

The signed-in user id is a far better identity for a **cost** control, because it is exactly
the thing being budgeted. 30 per 5 minutes per user, alongside 20 per 5 minutes per IP.

**A real bug express-rate-limit caught for me:** my first per-user key generator fell back
to raw `req.ip`. A single IPv6 customer is normally handed a whole /64, so keying on the raw
address would let one person present billions of distinct "clients" and walk straight past
the limit. The fallback now goes through the library's `ipKeyGenerator`, which normalises to
the subnet prefix.

### What the client deliberately does not do

It does not decide what happens when a call fails. Each feature has its own sensible
degraded behaviour — keyword search, a templated summary — and burying a fallback in the
client would make those decisions invisible at the place they matter. `complete()` throws;
the caller chooses.

13 new tests. **373 backend tests passing.** Phase 2 complete.

---

# Phase 3 — Scalability

## Phase 3.1 — Server-side searchable selects

### The bug this fixes, which is worse than it looks

The order form filled both dropdowns with `limit=100`. The obvious cost is downloading a
hundred records to render a picker. The **dangerous** cost is different:

> With 101 customers, the hundred-and-first cannot be selected at all. No error, no
> "showing 100 of 4,000" — a user simply cannot find their customer and has no idea why.

Silent truncation is the worst kind of limit, because nothing about the screen suggests
anything is missing. (The old code's own comment admitted it: *"a real deployment with
thousands of records would want a searchable async select instead."*)

### New endpoints, and why they are not just the list endpoint

`GET /api/customers/options` and `GET /api/products/options` — `?search=&limit=`.

Reusing `GET /api/customers` would have worked, and the temptation is real: one endpoint,
one code path. But a picker fires a request per pause in typing, and the list endpoint
returns **whole documents with `assignedTo` populated** — a second query against the users
collection plus a payload of notes, phone numbers and timestamps, per keystroke, to render
one line of text.

So these return three or four fields, unpopulated, `.lean()` (plain objects with no Mongoose
document wrapper, measurably cheaper when the result is serialised straight to JSON and
discarded).

The cost of the extra endpoint is a second place the permission rules have to be right. That
is paid by reusing `customerScopeFilter` — the *same function* the list endpoint uses — so a
sales rep cannot discover through the picker what the list would have hidden. Two tests
cover it, including "a rep searching for another rep's customer by name finds nothing".

**The limit is capped server-side (25) rather than trusted from the query string**, so the
endpoint cannot be turned into a bulk export of the customer table by passing `limit=10000`.

Products include `price` and `stockQty` even though neither is the label — the order form
shows both and totals from them, so returning them here removes a follow-up request per line.

### The component: three things it has to get right

`components/SearchSelect.jsx`, a debounced combobox (250ms — one request per typed word
rather than eight, still fast enough to feel live).

1. **The selected record is held by the parent, not looked up from the options list.** This
   is the bug most hand-rolled async selects have. A search for "wid" returns twenty
   products; the one already chosen on another line is very likely not among them, so a
   component deriving its label from the visible options **blanks out every existing
   selection the moment anyone types**.
2. **Debouncing alone is not enough — stale replies are discarded too.** Two requests can
   still be in flight, and the slower earlier one can land last and overwrite newer results
   with older ones.
3. **It is a real combobox.** Arrow keys, Enter, Escape, `role="combobox"`/`listbox`/`option`
   and `aria-activedescendant`. A div-based picker that only works with a mouse is a
   *regression* from the `<select>` it replaced, however much better it looks. Options are
   chosen on `onMouseDown` rather than `onClick`, because click fires after blur — by which
   point the click-outside handler has closed the list and the selection never happens.

A hidden `required` input carries the browser's native validation: the visible combobox
holds a *label*, not the id, so marking it required would demand the wrong thing.

### A small flow fix that came with it

Arriving from a customer's page (`/orders/new?customer=…`) gives an id but no name. The form
now fetches that one record so the picker shows who is selected, instead of an empty box
that is nonetheless valid — confusing in exactly the flow meant to be the convenient one.

19 new tests. **392 backend tests passing.** Additive API change; no existing contract moved.

## Phase 3.2 — Pagination: both styles, and the bug that was already there

### First, a real bug in the existing offset paging

`getSort` returned `{ createdAt: -1 }` and nothing else. **Sorting by a non-unique field
gives MongoDB no defined order among documents that tie**, and it is free to return them
differently between two queries.

Ties are not rare here — the seed script creates records in a loop, and any bulk import
stamps dozens of rows with the same `createdAt` to the millisecond.

The consequence is silent: page 1 ends mid-tie, page 2 starts mid-tie in a different order,
**a record appears on both pages while another never appears at all.** Nothing errors and
the total still reads correctly.

The fix is one line — append `_id`, which is unique by construction, so the ordering is
*total* and the sequence is identical every time. There is an end-to-end test that creates
12 customers sharing one timestamp, pages through them, and asserts all 12 appear exactly
once.

Cursor paging depends on this absolutely: *"everything after this record"* is meaningless
without a deterministic definition of "after".

### Then: both paging styles, chosen by the caller

`?cursor=` present → cursor paging. Absent → offset. That is not indecision; the two answer
different questions and each is bad at the other's job.

| | offset (`?page=3`) | cursor (`?cursor=…`) |
|---|---|---|
| page numbers, "jump to page 7" | **yes** | no — only "next" |
| total count | **yes** | no (a separate query) |
| cost at depth | **O(n)** — `skip` walks and discards every skipped doc, so page 500 costs 500 pages of work | **O(log n)** with an index, however deep |
| stable under writes | **no** — see below | **yes** |

**Drift is the important column.** If a record is inserted while someone pages through,
everything shifts down by one: the last row of page 1 slides to the top of page 2 and is
seen twice, while another is skipped. There are **two tests side by side** — one asserting
cursor paging does not repeat a row when a record is inserted mid-traversal, and one
asserting offset paging *does*. The second test documents the trade-off rather than
deploring it.

### Which is used where, and why

**The UI uses offset.** A CRM list with page numbers and "312 results" is what people
expect, and the collections a human pages through by hand are small enough that `skip` costs
nothing. Removing page numbers to win an optimisation nobody would notice would be a
downgrade.

**Cursor exists for the cases that break offset:** the audit log — append-only, unbounded,
and constantly written at the top, so drift is not theoretical there — and any script
exporting a whole collection.

Offering both costs one shared helper. Offering only offset would mean the audit log gets
slower *and* less correct the longer the system runs.

### The keyset predicate, and the part that is easy to get wrong

```js
{ $or: [ { sortField: { $lt: v } },
         { sortField: v, _id: { $lt: id } } ] }
```

The first clause takes everything past the tie; **the second walks the rest of the tie the
cursor stopped inside.** Using only the first drops the tail of a tied run; using only `_id`
ignores the sort entirely. The cursor therefore carries the sort value *and* the `_id` — a
cursor landing mid-run could not otherwise say which of the identical timestamps it meant.

It is combined with `$and` rather than merged into the filter, because the incoming filter
may already have its own `$or` (a sales rep's scope, a search clause) — overwriting it would
drop a permission rule. A test confirms scoping survives cursor paging.

Cursors are base64 JSON and treated as opaque. Not for secrecy — anyone can decode one — but
so the encoding can change later without breaking callers who might otherwise have started
parsing it. A malformed cursor falls back to the first page rather than erroring.

`nextCursor: null` is how a client knows to stop; comparing counts is unreliable because a
final page that happens to be exactly `limit` long looks identical to a full one. One extra
row is fetched (`limit + 1`) purely to answer "is there more?" without a second count query.

### API contract change (additive)

All four list endpoints (`customers`, `products`, `orders`, `audit-logs`) accept `?cursor=`.
The offset response is unchanged, so nothing existing breaks. The cursor response returns
`{ success, count, data, nextCursor }` — deliberately **no `total`**, because counting the
whole collection on every page is precisely the cost cursor paging exists to avoid.

25 new tests. **417 backend tests passing.**

## Phase 3.3 — Indexes, and two bugs the explain() tests found

Every index is documented in the model file next to its definition, saying which query it
serves. An index matching no query is not free: every write maintains it and it takes RAM
the working indexes would otherwise use.

### Bug 1 — two text indexes serving nothing

`Customer` and `Product` each carried a `text` index, `Customer`'s described as *"powers the
keyword fallback used by the AI search endpoint."* **It did not.** Nothing in the codebase
issues a `$text` query — the AI keyword fallback builds `containsRegex` clauses, and so do
both list endpoints. Both indexes were maintained on every insert and update and read by
nothing.

They could not have helped even if wired up: `$text` matches whole words with stemming, so
it finds "trading" from "trade" but **not "rach" inside "Karachi"**. A CRM search box is
expected to match substrings — a different operation.

### Bug 2 — `createdBy` had no index, so every sales rep's list scanned the collection

Both scope filters are `$or`s:

```js
{ $or: [{ assignedTo: user._id }, { createdBy: user._id }] }   // customers
{ $or: [{ createdBy: user._id }, { customer: { $in: [...] } }] } // orders
```

**MongoDB cannot serve an `$or` from one compound index** — it evaluates each branch
separately and unions the results — so each branch needs its own index. `createdBy` had none
on either collection, and `assignedTo` existed only as the *second* field of
`{status:1, assignedTo:1}`, which an `$or` branch cannot use on its own.

Invisible with seed data. Quadratic with real data.

### Bug 3 — my own `_id` tiebreaker invalidated every sorting index

This is the one I would not have found by reading the code, and it was caused by my *own*
change in 3.2. Appending `_id` to every sort is correct for pagination determinism, but:

> An index on `{ createdAt: -1 }` does **not** satisfy a sort of `{ createdAt: -1, _id: -1 }`.

MongoDB falls back to fetching every match and sorting it in memory. The index still exists,
the query still returns the right answer, and the only symptom is that it got slower —
exactly the regression nobody notices until the collection is large. I verified it directly
with `explain()` before and after adding `_id` to the index key.

So every sorting index now carries `_id` in the same direction as its sort field.

### The tests assert usage, not existence

Asserting an index *exists* is nearly worthless — it passes just as happily when the index
is unused. These tests also run `explain()` against the real queries and assert `IXSCAN`
with **no in-memory `SORT` stage**. That second assertion is what caught bug 3.

Two details that make the tests meaningful rather than decorative:

- **They seed 200 documents.** On a nearly empty collection MongoDB correctly prefers a
  collection scan — reading four documents beats consulting an index — so an `explain()`
  assertion against an empty collection proves nothing.
- **They stringify the plan rather than walking it.** MongoDB reports the plan tree
  differently between its classic and SBE engines (`inputStage` vs `queryPlan`), and a
  walker assuming one shape silently reports "no index" on the other.

### What the indexes deliberately do NOT fix

The search box builds an **unanchored, case-insensitive** regex (`/karachi/i`). Two tests
pin the real behaviour, which is more precise than "regex cannot use an index":

- It **cannot seek** — with no `^` anchor there is no prefix to jump to, so MongoDB scans
  the *entire index range* and applies the pattern to every key. That is cheaper than a
  collection scan (the index is smaller; documents are fetched only for matches) but still
  linear, and no additional index changes it.
- An **anchored** prefix search (`/^Customer/`) *can* seek — which is the fix available
  without new infrastructure, at the cost of changing the feature to "starts with".

The other options are Atlas Search (what a production deployment on Atlas should use) or a
dedicated search service. Neither is done here because the collection is small and the
honest answer is that it does not need one yet. Writing that down beats implying the index
list solved a problem it has not.

### One operational note worth carrying forward

Mongoose creates schema indexes **lazily**, on the model's first use. The same applies in
production: indexes appear when the app first touches each collection, so the first queries
after a deploy can run unindexed. `syncIndexes()` as a deploy step is how to make that
deterministic.

25 new tests. **442 backend tests passing.** Phase 3 complete.

---

# Phase 4 — Quality

## Phase 4.1 — Frontend and end-to-end tests

The frontend had **no test setup at all**. It now has two layers, doing different jobs.

### Layer 1 — component tests (Vitest + React Testing Library), 43 tests

Configured inside `vite.config.js` rather than a separate config, so tests run through the
same plugin pipeline as the app — identical JSX transform and `import.meta.env` handling,
which means a test cannot pass against a build the browser would never produce.

Coverage: **login** (8), **protected routes and RoleGate** (9), **customer create/edit** (7),
**order creation** (10), **AI search** (9).

Two principles worth stating:

- **Tests find things the way a user does** — by label, by role, by visible text — never by
  reaching into state or props. A test that asserts on internals breaks when the component
  is refactored and passes when the screen is broken, which is exactly backwards.
- **The API is mocked per test, not globally.** A shared mock server would be less
  repetitive and much harder to read: you could no longer tell what a test assumes without
  opening another file.

Three of these tests are regression guards for earlier phases: *"never stores a token in
localStorage or sessionStorage"* (Phase 1.1), *"waits for the session check instead of
redirecting while it is pending"* (the refresh-flash bug), and *"keeps an earlier line's
selection when a later one is searched"* (the async-select bug from Phase 3.1).

### Two real bugs the component tests found

**1. Form labels were not associated with their inputs.** `Field` rendered a bare `<label>`
next to the control with no `htmlFor` and no nesting. It *looked* right — the text sits
above the field — but nothing connected them, so a screen reader announced every input as
unlabelled and clicking a label did not focus its field. `getByLabelText` failing is how it
surfaced: **a test written the way a user interacts with the page failed on markup a user
with a screen reader could not use either.** `Field` now generates an id, wires `htmlFor`,
and links `hint`/`error` through `aria-describedby`.

**2. `CustomerForm` ignored its load error.** It destructured `useFetch` without `error`, so
a customer that failed to load (deleted, no permission, network down) rendered an **empty
form with no warning** — and pressing "Save changes" would then PATCH the record with blank
fields. A failure to *read* became data loss on *write*. It now shows the error and does not
render the form at all.

### Layer 2 — end-to-end (Playwright), 11 tests

These start the **real backend** against a throwaway in-memory replica set, the real
frontend, and a real browser.

**Why not mock the network.** Playwright could intercept requests, which is faster and far
easier to set up — and would miss the entire point. The riskiest work in this project is the
auth rework: httpOnly cookies, the CSRF double-submit, refresh rotation, the order
transaction. Every one is an interaction *between* browser and server. A component test
mocks the server; an API test has no browser. Only this layer can tell you the cookie was
actually accepted and the CSRF header actually sent.

The headline test is **login → search the picker → create an order → land on its detail
page**, with nothing mocked. One test verifies the Phase 1.1 guarantee in a real browser
rather than from a response header: the session cookies exist, `document.cookie` cannot see
them, and both storages are empty.

Scope is kept narrow on purpose. E2E tests are slow and the flakiest thing in any suite, so
they cover the flow that must never break rather than duplicating the 442 backend and 43
component tests. `workers: 1` because the seeded dataset is shared and parallel workers
would race over the same stock — exactly the flakiness that teaches people to ignore E2E
failures.

### Two environment problems worth recording

- **Vitest's default `forks` pool cannot start workers when the project path contains a
  space** — which this one does ("digisofts project"). The failure is an opaque *"Timeout
  waiting for worker to respond"*. Pinned to `pool: 'threads'`.
- **mongodb-memory-server re-downloaded 600MB of MongoDB** when launched by Playwright,
  blowing the start-up timeout and reporting only *"Timed out waiting for webServer"*. It
  resolves its binary cache relative to the working directory. `process.chdir` alone did not
  fix it, so `e2eServer.js` now sets `MONGOMS_DOWNLOAD_DIR` outright — stating the location
  rather than relying on resolution rules, and reusing the copy the Jest suite already
  downloaded.

**43 component tests + 11 end-to-end tests, all passing.** Run with `npm test` and
`npm run test:e2e` in `frontend/`.

## Phase 4.2 — Frontend polish

### Error boundaries — the gap that mattered most

There were none. **React's behaviour on an uncaught render error is to unmount the entire
tree** — not the component that threw, everything. So one `undefined.name` in a table cell
replaced the working application with a blank white page: no message, no navigation, no way
back except a manual reload, and no way for the user to tell that from the site being down.

`ErrorBoundary` now wraps the whole app, showing a message, a "Try again" that re-renders
the subtree, and a link home. It is a class component because `componentDidCatch` and
`getDerivedStateFromError` still have no hook equivalent — worth saying so, or it reads like
legacy nobody updated.

Two deliberate choices:

- **It logs rather than swallows.** A boundary that shows a friendly message and reports
  nothing turns a crash into a mystery: the user sees "something went wrong", the console is
  empty, and nobody can reproduce it. The error message itself is shown only in development
  — noise at best in production, internal detail at worst.
- **A `compact` mode** for wrapping a single panel. Replacing the whole screen because one
  dashboard card broke is the same over-reaction the boundary exists to prevent, at a
  smaller scale.

It is worth being explicit about what a boundary does **not** catch: only render errors.
Event handlers, promises and async code need their own handling, which the API layer already
does. A boundary is the last line, not the only one.

### Toasts — and why banners were not enough

Every screen kept its own `notice`/`error` state and rendered its own banner. That produced
three problems, and the third is the one that made it worth replacing:

1. the same action was confirmed differently on different screens
2. a confirmation was invisible if it happened below the fold
3. **a message rendered by a page vanished the instant that page navigated away** — which is
   exactly what "Customer deleted" does, since deleting returns you to the list

Toasts live above the routes, so they survive the navigation that caused them.

**Accessibility is the point here, not a detail.** A toast is the one piece of UI that
appears without the user doing anything, at the place they happen to be looking. If it is
only visual, a screen-reader user gets no confirmation their action worked at all. So there
are **two live regions**, because politeness is a property of the region rather than the
message: `assertive` for errors, which should interrupt, and `polite` for confirmations,
which should wait for a pause.

**Errors last 8s against 4s for a success.** A success confirms something the user already
knows they did; an error is news, often with a detail worth reading twice, and losing it
early means redoing the action just to read the message.

**Not everything became a toast.** A form's *validation* error stays an inline banner: the
user is still on the form, still looking at the field that needs fixing, and a message that
floats away after four seconds is the wrong place for something they must act on. Likewise a
list's own load failure stays inline, because it explains why the table below is empty.

### Skeletons instead of spinners

A centred spinner says "wait" and nothing else. A skeleton says what is coming and roughly
how much, and — the real gain — it reserves the layout so content appears **in place**
instead of pushing everything down when it lands. That jump is what makes a fast page feel
unfinished, and it is worse than the wait it replaced. `TableSkeleton` matches the column
count for the same reason.

### Empty states that tell the two cases apart

Every list previously showed one empty state. But **"no customers" and "no customers
matching this search" are different situations** — and showing the first when the second is
true tells the user the database is empty so they stop looking, when in fact they have a
filter applied they may have forgotten setting. `ListEmptyState` distinguishes them and
offers a "Clear filters" button in the filtered case.

### One test-harness lesson

Adding `ToastProvider` broke all seven `CustomerForm` tests: `useToast` throws outside its
provider. The fix was to make the test harness mirror `App.jsx`'s provider tree exactly —
which is the right rule anyway. A harness that diverges from the app fails for reasons that
have nothing to do with the code under test.

**17 new tests** (error boundary 8, toasts 9). **60 frontend tests passing.**

## Phase 4.3 — Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every PR against it. **Both**,
not just PRs: a PR run proves the branch is good, a push run proves `main` is good after the
merge — and two PRs that each pass alone can still break `main` together.

### Three jobs, and why they are split that way

| job | runs | why separate |
|---|---|---|
| **Backend** | lint → 442 Jest tests | Parallel with the frontend, so a frontend failure does not hide a backend one. When something breaks you want to see *everything* that broke, not the first thing. |
| **Frontend** | lint → 60 Vitest tests → **build** | Same reason. |
| **End-to-end** | 11 Playwright tests, `needs: [backend, frontend]` | E2E is the slowest and flakiest layer. No point spending three minutes booting browsers to discover a lint error — and `needs` makes a red E2E result unambiguous: the units passed, so the failure is in how the pieces fit together. |

**The build is a test in its own right.** Vite fails on an import that does not resolve and
on syntax the transform cannot handle — neither of which unit tests catch, because they only
load the modules a test happens to import. A page nobody has written a test for can still be
broken, and this is what notices.

`npm ci` rather than `npm install`, so CI tests the exact dependency tree that will be
deployed and fails if `package.json` and the lockfile disagree. The mongod binary is cached,
Playwright runs **Chromium only** (three browsers would triple the time to tell us the same
thing about an internal CRM), and traces are kept for a week **on failure only** — nobody
opens a trace from a passing run.

### Linting: what it is for, and what it is not for

**Not formatting.** No line-length rule, no opinion about quotes. Those are arguments that
cost more than they settle, and CI failing because a line is 101 characters is how a team
learns to ignore CI.

What it catches is the class of mistake that is invisible in review and only appears at
runtime. Four decisions worth explaining:

- **`no-console` is off in the backend.** `console` is a deliberate part of this service —
  config problems, CORS rejections, refresh-token reuse and AI usage all report through it,
  and on a hosted platform the log stream is the only view into a running deployment.
  Warning about it would mean a disable comment on every one of those lines.
- **`no-unused-vars` ignores `next`.** Express identifies error handlers by their **arity**,
  so `(err, req, res, next)` must keep four parameters even when `next` is never called —
  removing one silently turns the error handler into ordinary middleware and every error
  becomes an unhandled 500.
- **`require-atomic-updates` is off**, after seeing what it actually flagged: `req.user =
  user` after an `await`, thirty times. In Express that is the standard pattern and
  perfectly safe — each request owns its own `req`. Thirty warnings nobody can act on is
  exactly how lint output gets ignored.
- **`react-hooks/exhaustive-deps` is a warning, not an error.** The rule is right most of
  the time and wrong in one case this codebase keeps hitting: a `fetcher` passed as an
  inline arrow is a new function every render, so obeying it would loop forever. Making it
  an error would force either a pile of disables or an infinite loop shipped to satisfy a
  linter.

### The linter immediately earned its place

It found **a real bug I had just introduced**: converting `UserList` to toasts left two
calls to `setNotice` and `setActionError` behind, which no longer existed. Creating a user
would have thrown at runtime. No test covered that handler, and it is exactly the kind of
thing that survives review — the diff looked complete.

It also found an unused `catch (err)` binding in the auth middleware, now `catch {}` with a
note about why the error is deliberately not inspected: its message must never reach the
client, since *"invalid signature"* tells an attacker more than *"invalid or expired
token"*.

**Phase 4 complete.** 442 backend + 60 frontend + 11 end-to-end tests, all green, all
running in CI.

---

# Round 3 — closing out the known limitations

The README carried eight documented limitations. Five were fixable within this codebase and
are now fixed; three are genuinely infrastructure decisions and stay documented, which is
the honest outcome rather than pretending otherwise.

## 1. Rate-limit counters now live in MongoDB

express-rate-limit counted in a Map inside the process. On a long-running server that is
right; on Vercel each function instance has its own memory, so the effective limit was
**(configured limit x warm instances)** and every counter reset when an instance recycled. A
"10 attempts per 15 minutes" login limit quietly became sixty.

**Why not Redis,** the usual answer: this project already runs MongoDB and nothing else, and
a second datastore for one counter is a real operational cost — another thing to provision,
monitor and pay for. Mongo is slower for this, and "slower" means one indexed upsert on the
handful of endpoints that are limited, which is not meaningful next to the bcrypt comparison
on the same request.

Fixed windows rather than a sliding log: a sliding window is more precise at the boundary but
needs a timestamp per request instead of one counter, for a precision that does not change
the defence. The increment is a **single atomic upsert** — read-then-write would let
simultaneous requests each read the same count and each write count+1, hiding exactly the
burst these limits exist to catch. A test fires eight parallel requests and asserts all eight
are counted.

Each limiter has its own named store, so signing in does not consume the sign-up budget for
the same address. Because the Mongo TTL collector runs about a minute behind, an expired
window is explicitly reset rather than continued.

## 2. Passwords are checked against the Have I Been Pwned corpus

The in-repo blocklist catches the fifty passwords everyone thinks of. The real corpus holds
over half a billion, which is where credential-stuffing tools get their wordlists — and it
keeps working as those lists grow without anyone maintaining anything.

**K-anonymity is what makes this acceptable.** The password is hashed locally; only the
**first five characters** of the SHA-1 leave the server; HIBP returns every suffix matching
that prefix and the comparison happens here. The service sees five hex characters matching
roughly 800 hashes — it cannot tell which was asked about, cannot reconstruct the password,
and cannot link the request to an account. A test asserts the URL contains the prefix and
neither the password nor the full hash, and the request asks for a padded response so its
size leaks nothing either.

SHA-1 because that is the corpus format. Broken for signatures, irrelevant here — it is a
lookup key, and passwords are still stored with bcrypt.

**Ten appearances, not one.** A password appearing once may be a genuinely strong passphrase
that happened to be in a dump; rejecting it teaches people the rules are arbitrary.

**It fails open**, deliberately: if the service is slow, down or firewalled, the check is
skipped and the local rules still apply. Refusing to let anyone sign up because a third party
is unreachable trades a strong password policy for an outage. The corpus is only consulted
once the local rules pass — a password failing on length does not need a network round trip
to also be told it is common.

## 3. A real forgot-password flow

Two endpoints, and the security rests on four decisions:

- **The response is identical whether or not the account exists.** Otherwise it is a free
  enumeration oracle. The cost is a mistyped address waiting for a mail that never arrives,
  which the mail content mitigates — an address with no account still gets a message saying
  so, which helps the user and tells an attacker nothing, since they cannot read the inbox.
  The UI holds the same line: *"if an account exists"*, never *"we have sent you an email"*.
- **Tokens are hashed, single-use, 30-minute expiry.** A reset link bypasses the password
  entirely and travels through email — stored, forwarded, synced to phones. Requesting a new
  link invalidates any earlier one, so clicking "forgot password" five times does not leave
  five working keys in a mailbox.
- **Redeeming revokes every session**, with no exception, unlike change-password which spares
  the current device. Someone resetting is not necessarily at a browser we can trust.
- **The password is validated before the token is consumed.** The token is single-use, so
  validating afterwards would burn the link on a rejected password — the user would be told
  both that their password was too weak and that their link no longer works.

**Delivery is a seam, not an integration.** `console` (default) writes the message and link
to the log, so the flow is exercisable locally with nothing configured; `webhook` POSTs it to
a URL, which is enough to connect any provider or queue. Carrying a vendor SDK for one email
would be the wrong dependency. The console transport warns when it runs in production,
because a reset link in a log is a credential in a log — stated rather than hidden.

**A real bug this surfaced:** `clearFailedLogins()` skipped its write when the counters
looked falsy. `failedLoginAttempts` and `lockUntil` are `select: false`, so a user loaded via
`populate()` has `undefined` in both — indistinguishable from "already clear" under a
truthiness check. A locked-out account therefore stayed locked after a successful password
reset. It now compares explicitly, so an unloaded field falls through to the write, which is
the safe direction: at worst one redundant update.

## 4. Audit retention: opt-in, manual, and logged elsewhere

Every other growing collection expires automatically, and that is uncontroversial — those
rows stop being useful the moment they expire. An audit trail is different: it is read when
something has gone wrong, usually about a period nobody was watching at the time. A TTL index
deletes evidence silently on a schedule nobody remembers setting, and the deletion is
discovered on the day it matters.

So the default is **keep everything**. `AUDIT_RETENTION_DAYS` makes entries *eligible*, and
`npm run prune-audit` performs it — reporting what it would delete unless given `--yes`,
because deletion cannot be undone and a retention period typed with the wrong number of
zeroes looks exactly like a correct one until it runs.

The prune is recorded in the **application log, not the audit collection**. Writing it into
the trail would be neater and slightly dishonest: the record of a deletion would then be
subject to the same deletion policy.

## 5. Indexes are built deliberately

Mongoose created them lazily on first use, which meant the first queries after a deploy ran
unindexed and — worse — that removing an index from a schema never dropped it. The two unused
text indexes deleted earlier would have stayed in the database forever, still maintained on
every write.

`syncIndexes()` now runs at boot on a long-running server and via `npm run indexes` as a
deploy step. Serverless skips it on purpose: cold starts are frequent, and paying for an index
check on each one adds latency forever to do work needed once per deploy. A failed sync logs
and continues — missing indexes make the app slow, refusing to start makes it unavailable.

## What is deliberately still open

- **Substring search cannot use an index.** An unanchored `/karachi/i` has no prefix to seek
  to. The fixes are Atlas Search or a dedicated search service — infrastructure decisions,
  and these collections are nowhere near needing one. Two tests pin the real behaviour so
  nobody later assumes it is indexed.
- **AI search reads one entity at a time.** Supporting joins would mean a query language
  rather than a filter object.
- **The keyword fallback matches terms, not meaning**, and its stop-word list is English-only.

**Totals: 492 backend + 73 frontend + 11 end-to-end tests**, lint clean on both packages.

---

# Round 4 — invitations, observability, AI cost controls

## Fixing what a frontend-wiring audit found

Before adding anything new, four things the audit turned up:

- **`change-password` had no caller.** The endpoint was built, tested and documented, and
  nothing in the UI reached it. There is now an `/account` page with the form, linked from
  the sidebar identity block and the mobile avatar.
- **Toast coverage was inconsistent** — customers, orders and users had it; products did
  not, and order creation had none. Product create/edit/delete and order create now raise
  one. Product delete previously navigated away on success with *no confirmation at all*.
- **`ProductForm` had the same ignored-load-error bug** already fixed in `CustomerForm`:
  a record that failed to load rendered an empty form, and Save would PATCH the blanks over
  it — a failed read becoming data loss on write.
- **The audit page** used a flat empty state despite having filters (so narrowing to a type
  with no writes said "no activity recorded"), and a spinner where the other lists use a
  skeleton.

## 1. Invite-based user management

### Why open registration had to go

`POST /api/auth/register` let anyone who could reach it create an account on an internal
CRM. The `sales_rep` default limited the blast radius but did not stop the account existing
— and a sales rep can see customers.

**Public registration is now admin bootstrap only.** The first registration on an empty
database still works exactly as before and becomes the admin; every later one is refused
with a pointer to the invite flow. Keeping the bootstrap rather than deleting the route
means a fresh deployment still has a way in without a seed script or a database console.

### The account exists before the password does

An invite creates the user immediately in `pending` **with no password field at all**.

That is the part worth explaining. The account exists — so it appears in the admin's list,
holds the role that was chosen, and reserves the email address — but cannot authenticate,
because `comparePassword` returns false for an account with no password and `login` refuses
a non-active status. The invitee sets the password themselves through a single-use link, so
it is never transmitted, never known to the admin, and never needs a "change this on first
login" convention that everybody ignores.

This replaced a form where an admin typed a password and presumably told the new hire what
it was.

### `status: pending | active | deactivated`, enforced in three places

| where | what it stops |
| --- | --- |
| `login` | a pending or deactivated account obtaining a session |
| **`protect`** | an **existing** session continuing to work |
| the UI | offering controls that would be refused (courtesy, not security) |

The middle one is the one that matters. Checking only at login would leave an offboarded
employee working normally until their access token expired — **up to fifteen minutes of
continued access to the customer list after someone pressed "deactivate"**. Because
`protect` reloads the user on every request, it takes effect on their very next one. A test
asserts exactly that: a session that works, a deactivation, and the same session dead on the
next call with no new login involved.

Deactivating also revokes the refresh token, so the session cannot be resurrected.

**Deactivation rather than deletion** is the offboarding action: deleting the account would
orphan every customer and order referencing it as `createdBy`, and the audit trail would
lose the name behind past actions. Deletion stays available for a record created by mistake.

### Managers may invite; they may not mint an admin

Managers run teams and know when someone joins, so requiring an admin for every hire makes
the admin a bottleneck on onboarding. But **a manager who could create an admin account
would be an admin** — so the role they may grant is capped, in the API (403) and in the UI
(the option is not offered).

### Smaller decisions

- **Login reports deactivation only after the correct password.** Answering "your account is
  deactivated" to anyone who types the address would confirm the account exists — the same
  enumeration leak the identical-error rule prevents. Requiring the password first means
  only the genuine owner sees it, and they need it: "invalid email or password" would send
  an offboarded employee off to reset a password that was never the problem.
- **Re-inviting a pending user re-sends** rather than erroring, because that is the common
  case (the first invite went to spam, or predated their start date), and it invalidates the
  earlier link so two working invites never sit in two inboxes.
- **Invites last 7 days**, against 30 minutes for a password reset — the recipient may be on
  holiday and did not ask for it. The longer window is why everything else is tight: hashed,
  single use, invalidated on re-send.
- **The accept page identifies the invitee before asking for a password.** An anonymous
  "choose a password" box reached from an email link is indistinguishable from a phishing
  page; what makes it legitimate is that it already knows who you are and what you were
  offered. It also reports an expired invite on arrival, not after someone has typed a
  password twice.
- **Accepting signs you in immediately.** "Now go and log in" asks someone to retype the
  password they chose four seconds ago, having already proved control of the mailbox.

37 new backend tests, 8 new frontend tests.


## 2. Observability

### Structured logging replaces console

Every line is now JSON with a level, timestamp, request id and context. Prose is readable by
a person watching a terminal and useless to everything else — and on a hosted platform nobody
watches a terminal. "Show me every 5xx on /api/orders for user X in the last hour" is a query
against fields and a regex guessing game against sentences.

**Three places still use console deliberately.** `config/env.js` cannot require the logger
because the logger reads it for its level — a circular dependency whose failure mode is the
worst kind, where the config error you are reporting becomes an unrelated module-load crash.
The CLI scripts print prose for a human. Both are documented in place.

Secrets are redacted centrally rather than per call site. The logger is silent in tests: the
suite deliberately exercises failure paths, and hundreds of lines of expected errors make a
real failure impossible to spot.

morgan was removed rather than kept alongside — it cannot carry the request id, the user or
the route pattern, and running both would mean two lines per request saying the same thing
in two formats.

### Request ids

Every response carries `X-Request-Id` and **every error repeats it in the body**. That is
what makes logging useful to a real person: a user reports "it said c1f4a9b2" and that
string finds every line for their request, across every module.

An incoming id is **forwarded, not replaced** — the platform uses it in its own logs, and a
fresh one would break the chain exactly where cross-system correlation matters. It is
validated first, because a header is user input and an unvalidated one lands in every log
line, which is how log injection works.

The id reaches code five calls deep via `AsyncLocalStorage` rather than being passed as an
argument. Threading `req` through every service purely so it could log would distort every
signature in the codebase for one cross-cutting concern.

### Metrics

`GET /api/internal/metrics`, admin only: request counts, error rates and latency buckets per
route.

**In memory, unlike the rate limiter — and the distinction is the interesting part.** A rate
limiter is a *control*: wrong counters mean a wrong limit, which is why it moved to MongoDB.
Metrics are an *observation*: a per-instance view is still a true sample, and writing to the
database on every request to improve it would mean the measurement changing the thing being
measured. The response states its own `scope` and `instanceId` rather than letting a reader
mistake one instance for the deployment.

**Admin rather than an IP allow-list**, because on serverless the app sees the edge
network's addresses, not a stable office IP — the list would be wrong or meaninglessly broad.

Latency is bucketed (keeping raw durations grows without bound, and the real question is
"how many took over a second?") and route labels are capped, because metrics keyed on
something unbounded — a 404 for every URL a scanner tries — grow until the process dies,
taking out the app they were meant to observe. Routes are keyed on the **pattern**, so
`/api/customers/:id` is one series rather than one per customer.

18 new tests.


## 3. AI cost and reliability — the remaining pieces

Retries, structured-output validation and rate limiting were already in place. Three things
were missing.

### Token usage tracking

AiUsageLog records one row per call — feature, model, tokens each way, estimated cost,
duration, outcome, user. GET /api/internal/ai-usage aggregates it, admin only.

**Why a collection when the same figures are already logged.** The log answers "what
happened just now"; it is poor at "what did we spend last month, on which feature", which is
an aggregation over a range. A table is cheaper than a log platform with a query language and
a long retention window, and it survives log rotation.

**The prompt and response are deliberately not stored.** Prompts contain customer names,
notes and order history, and a second copy in a collection nobody thinks of as customer data
is how data ends up where it should not be. Token counts are all the cost question needs.

**Cost is stored per call, not computed on read**, because prices change and recomputing last
quarter at today rates would quietly rewrite history. The rate table carries the date it was
checked. Rows expire after 90 days — unlike the audit trail this is operational data.

### Response caching

Identical AI **search** requests hit a 5-minute in-memory cache.

**Safe because what is cached is the FILTER, not the results.** The translation is re-run
against the live database on every hit. **Keyed per user**, which is the part that matters: a
sales rep sees only their own customers, so serving them an admin cached results would leak
exactly what the permission model hides.

**The summary is deliberately not cached** — it contains figures that move whenever an order
is placed, and a stale revenue number on the screen someone opened to check it is worse than
re-translating a query.

**In memory, like the metrics and unlike the rate limiter.** A cache is an optimisation, not
a control. Only successful translations are cached; caching a fallback would keep the feature
degraded for five minutes after one blip.

### Prompt size limit

AI_MAX_PROMPT_CHARS (8000, about 2000 tokens), enforced before the request leaves the server.
Part of every prompt is user-supplied, so without a ceiling a pasted document becomes a
pointless bill. **Refused, not truncated** — a silently shortened prompt produces a
confidently wrong answer nobody can explain. Checked before the API-key check, because input
validation should not depend on whether a dependency is configured.

26 new tests.


## 4. Churn risk — and promoting the recommended action

The brief offered two options and asked which fit with least new infrastructure.

**`recommendedAction` already existed**, on both the AI and fallback paths, and was already
rendered — but as the third paragraph inside the grey narrative block, styled identically to
the summary prose. So per the brief that bullet needed **UI prominence, not new logic**: it is
now its own block with an accent border and a label, because it is the only part of the card
that asks for a decision and it looked like more description.

**Churn risk is the new build**, because it is genuinely new signal derived entirely from
metrics that already exist — no model, no API call, no collection, no query.

### Why it is not just the health score again

The RFM score answers "how valuable is this relationship". Churn risk answers "is it
ending", and the two genuinely disagree: **a customer with forty orders and no purchase in
six months scores superbly and is the most urgent call in the book.** A score cannot express
that, because most of its inputs are historical and history does not decay. A test asserts
the two can report a healthy score and a high churn risk together.

### Why it is relative to each customer own cadence

The obvious implementation is a fixed threshold — 90 days without an order means at risk —
and it is wrong in both directions:

- A customer who orders every three weeks and has been silent for 90 days is **four cycles
  overdue**. Something has happened.
- A customer who orders once a year is at 90 days **exactly where they always are**. Flagging
  them wastes a call and teaches the rep the flag means nothing.

So the measure is how many of the customer own typical gaps have elapsed. The headline test
is two customers with **identical 90-day silence** and different rhythms: one comes back
high, the other low. A flat threshold scores them the same.

The cadence is averaged across the whole relationship rather than the last two orders —
otherwise two orders placed a day apart during one busy week imply a one-day rhythm and flag
the customer as catastrophically overdue by Thursday. Several orders on the same day report
"no measurable cadence" rather than an infinite overdue ratio.

### The cases that are not churn

- **No orders at all** returns `unknown`, not `low`. That is an unconverted lead, not a
  relationship being lost, and calling it low risk on a screen used to decide who to chase
  would be technically true and actively misleading.
- **A single order** has no gap to measure, so it falls back to deliberately generous fixed
  thresholds — one purchase says very little, and a false "high risk" is what teaches a rep
  to ignore the column.
- **On schedule but spending less** is raised one step, because someone ordering on time for
  steadily less money is leaving slowly and the cadence measure alone would never notice.

The reason string is always returned and always rendered. A flag a rep cannot interrogate is
one they learn to ignore.

20 new tests.

---

## Making the production mail transport actually reach a provider

Found while writing the post-deploy runbook, which is a good argument for writing runbooks:
the advice "set `MAIL_TRANSPORT=webhook` and point `MAIL_WEBHOOK_URL` at your email provider"
did not work, and failed in the quietest possible way.

The webhook transport sent no `Authorization` header. Every hosted provider — Resend,
Postmark, SendGrid — rejects an unauthenticated POST, so the only endpoint it could ever
talk to was one you had written yourself and left open. Following the documented advice got
you a 401, and because `sendMail` deliberately never throws (a mail outage must not turn a
public endpoint into a 500), the visible symptom was password-reset emails that simply never
arrived.

So `MAIL_WEBHOOK_AUTH` now goes out as the `Authorization` header, **verbatim**. Not
`Bearer ${key}` — Resend and SendGrid want Bearer, an internal relay might want Basic, and
prefixing here would silently break the second group to save eight characters of config.

The existing body, `{ from, to, subject, text }`, already happens to match Resend's send
endpoint, so with the header in place the common case needs no relay at all:

```
MAIL_TRANSPORT=webhook
MAIL_WEBHOOK_URL=https://api.resend.com/emails
MAIL_WEBHOOK_AUTH=Bearer re_...
MAIL_FROM=SimpleCRM <no-reply@a-verified-domain.com>
```

Failures now include the provider's own response body, truncated to 500 characters. The
status alone is rarely enough to act on: a 422 from a mail provider almost always means "that
From address is not a verified sender", which is a five-minute fix if you can read it and an
afternoon if all you have is the number.

**8 new tests, and the first ones this transport has ever had.** That gap was the real
finding — the invite and password-reset suites both stub delivery out, so the webhook branch
was executed for the first time in production, by a user trying to get back into their
account. The new suite covers the header being sent, being sent verbatim, being omitted when
unset, and the three failure paths all returning `{ delivered: false }` instead of throwing.

---

## The invite feature that looked like it worked

Reported as "I am not getting any invite on my email". The invite flow itself was fine —
token, expiry, single use, pending account, all correct. The problem was the last step and
the sentence the UI printed about it.

With no mail transport configured, `sendMail` falls through to the console transport, which
writes the message to the server log and reports `delivered: true`. That is honest about what
it did, but the invite controller treated it as "an email is on its way" and answered
**"Invitation sent."** So the admin waited for a delivery that was never coming, the invitee
never received anything, and the only copy of a working single-use link was sitting in a log
neither of them reads.

Two things were wrong, and the second is the one that matters.

**The response now says what actually happened.** `inviteUser` returns `emailed`, which is
the narrower claim than `delivered`: a transport that leaves the building said it succeeded.
The console transport does not qualify.

**And when nothing was emailed, the link comes back in `meta.inviteLink`**, which the Users
screen shows with a copy button. The alternative — refusing to invite at all without a mail
provider — makes a finished feature unusable on any deployment that has not bought one yet.

Returning a live credential in an API response deserves the argument in full, because it is
exactly the kind of thing that is right once and wrong everywhere else. The recipient here is
the manager or admin who just issued this invite, one call after `protect` and
`requireManagerOrAdmin`. They chose the address and the role. They can re-issue it at will,
and they can deactivate the account outright. Handing them the link grants them nothing they
did not already have. The password-reset flow deliberately does **not** do this, and the
difference is the whole point: there the requester is an anonymous member of the public
claiming to own an address, so returning the token would let anyone take over any account by
typing in an email. When mail genuinely goes out, the link is withheld — the invitee's inbox
should be the only place it exists.

The panel is styled as a warning rather than a success, because something *is* misconfigured
and an admin who never notices will hand-deliver links forever. It also names the person the
link is for, since a single-use credential pasted into the wrong chat window is an account
handed to the wrong human. It sits on the page rather than in a toast: a toast disappears
after a few seconds, and losing a link you have not copied yet means re-issuing the invite.

**6 backend and 7 frontend tests**, including the one that would have caught this — a
transport that reports `console` must not produce a message claiming an email was sent.

---

## Letting people sign themselves up again

Public sign-up had been closed during the security work: the first account on an empty
database became the admin, and every later `/register` was refused with a pointer to the
invite flow. The reasoning was sound for an internal CRM — anyone who could reach the page
could give themselves an account — but it is a deployment decision, not a property of the
software, and it was hard-coded.

So it is now `ALLOW_PUBLIC_SIGNUP`, defaulting to **open**, and the README states the
trade-off rather than assuming an answer:

- **Open** — anyone reaching the page gets an account. They are always a `sales_rep`, never
  an admin, so the blast radius is "can read the CRM" rather than "can administer it". For a
  deployment holding real customer data on the public internet, "can read the CRM" is usually
  the part you minded about.
- **Closed** — accounts exist only because an admin invited someone. What an internal tool
  should run.

The first-user bootstrap deliberately ignores the flag. A fresh install has nobody to send an
invitation, so gating it too would mean a new deployment with sign-up closed has no way to
create its first administrator at all, short of a seed script or a database console.

One thing changed while I was in there. The bootstrap check was
`estimatedDocumentCount() === 0`, which reads collection metadata that can be stale after an
unclean shutdown. That was a narrow risk when it ran once on an empty database; now it runs
on every sign-up and decides whether the caller is handed the **admin** role. A stale
estimate there is an unintended administrator, so it is an exact `countDocuments` — a few
milliseconds against a mis-issued admin account is not a close call.

The `/register` page already existed in the frontend and already described this behaviour
correctly; only the backend was refusing.

**10 new backend tests** across both modes. One existing rate-limit test needed updating: it
asserted that only one account existed after six registration attempts, which was really
asserting the side effect of closed sign-up rather than the limiter. It now checks that five
attempts succeed and the sixth creates nothing — which is what actually proves the limiter
runs before the controller — and a second test covers the closed case it used to cover.

---

## Two bug reports, one root cause

Reported as two things: "network error once I logged in as a sales rep", and "the token or
link it generates for invite user isn't working". They turned out to be the same missing
configuration, surfacing in two places that look nothing alike.

`CLIENT_ORIGIN` defaults to `http://localhost:5173`, and `APP_URL` falls back to it. On a
laptop both are right. On a deployment where neither was set:

**The invite link pointed at localhost.** Confirmed by reproducing it against the real app —
`http://localhost:5173/accept-invite?token=...`. The token was perfectly valid; I redeemed it
in the repro. The URL was simply somewhere the recipient could not go, which is why it
presented as "the link doesn't work" rather than as a missing environment variable.

**The CORS allow-list was localhost too**, so a browser on the real domain was refused. This
is the nastier of the two, because a CORS refusal is invisible to the page that made the
request by design: axios gets no status and no body, and reports the literal string
`Network Error`. Identical to what it says when the server is switched off.

### The fix, in one idea

Both now fall back to **the origin the request actually arrived on** — `x-forwarded-host` and
`x-forwarded-proto`, which Vercel sets from the hostname it routed. A deployment nobody
configured produces working links and answers its own browser, instead of failing in two
directions at once.

Explicit configuration still wins outright, and that ordering is the security-relevant part.
Deriving a link from a request is the classic host-header injection vector: forge a Host,
request a reset for someone else's address, and the email in their inbox carries your domain.
Three things make this the right default anyway:

- It only applies when nothing is configured. Setting `APP_URL` disables the path completely.
- The alternative is not a safer link, it is a link to localhost — broken for 100% of
  recipients. A configuration mistake should degrade to something that works.
- Behind a proxy the forwarded host comes from the platform, not from the client.

The host value is validated rather than sanitised before it goes into a URL: anything outside
the character set of a hostname and port is refused. A header with a slash or a quote in it
is not a hostname that needs rescuing.

For CORS the check deliberately uses a *different* function — `requestOrigin`, not
`publicOrigin`. It is asking "did this request arrive on the origin the caller claims to be
from", which has nothing to do with whether `APP_URL` is set; folding in that fallback would
have made the answer depend on unrelated configuration. Writing the test is what surfaced
that, because the test had to reach past one setting to exercise the other.

The `cors` middleware also had to move from its options-object form to the options-**delegate**
form, because the object form's `origin` callback is handed only the origin string and this
check needs the request.

### And the message the user actually saw

`errorMessage` returned axios's `Network Error` verbatim, which is the least useful string
available: it names neither cause. It now says the server could not be reached, gives both
possibilities, and points at the browser console — where the real CORS message is logged and
nowhere else.

**20 new backend tests** across two new files. `cors.test.js` is the first coverage this
middleware has had, which is the honest reason a localhost default survived to production:
nothing asserted what happened to a browser on any other origin.

---

## Item 1 + 6: the AI was never running

Reported as "AI search is not answering questions correctly". It was not mistranslating
anything. **`ANTHROPIC_API_KEY` was never set**, so `aiClient` never constructed a client,
`isConfigured()` returned false, and `translateQuery` returned a fallback before a prompt was
ever built. Every AI search that has ever run on this deployment was a keyword search.

The audit found the surrounding machinery was already right — the endpoint returns
`mode: 'ai' | 'fallback'` with a `reason`, and the frontend already renders the interpreted
filter in a collapsible block. The feature was not missing. It was switched off, and nothing
said so.

### Why nobody noticed for so long

Every AI feature in this codebase degrades gracefully. That is a deliberate design decision
and I would make it again — an AI outage should not take down a CRM. But it has a
consequence that had not been paid for: **a degraded feature is indistinguishable from a
working one**. Results appeared. Nothing was red. Every response was a 200.

So graceful degradation now comes with an obligation to say it is degrading, in three places
that do not require anyone to go looking:

- `GET /api/internal/ai-status` (admin only) — the state of the integration on demand.
- A **startup warning** in production when the key is missing.
- An **admin-only notice on the search box**, which is where someone actually notices.

`configured` and the recent outcome mix are reported separately, because "is the key present"
and "is it succeeding" are different questions with completely different fixes — a valid key
out of credit reports `configured: true` and a wall of failures, and a single "AI unavailable"
would send someone to check the wrong thing. Cache hits are excluded from the success count:
counting them would make a wholly broken key look healthy for as long as the cache stayed
warm. The key is never returned, and a test asserts that.

The notice says nothing when the AI is working. A green badge on every screen is how people
learn to stop reading badges.

### Verifying the translation without a key

I could not run the queries against the real model — that needs a live key. What I could do is
run everything downstream of it, which is where a prompt/validator drift would actually show
up. `aiQueryShapes.test.js` starts from raw model REPLY TEXT and runs the real path:

```
text -> extractJson -> validateFilter -> runFilter -> rows
```

The existing tests stub `translateQuery` and hand the endpoint a filter that is already valid.
That tests the plumbing after translation and cannot catch a reply in the exact format the
prompt asks for that the validator then rejects. All three brief queries now have regression
tests at that level, verified against seeded data:

| Question | Filter produced | Returned |
| --- | --- | --- |
| customers in Karachi with no orders in 30 days | `city contains` + `orderActivity {none, 30}` | the dormant one only |
| products running low on stock | `special.lowStock` | at-or-below threshold only |
| orders over $500 last week | `total gt 500` **and** `createdAt withinDays 7` | both conditions applied |

### One real flaw found on the way

`aiSearchService` hardcoded `direction: 'desc'` for every entity's default sort. Correct for a
date — newest first — and wrong for products, whose default sort field is `name`: the
catalogue came back Z-to-A. The direction is now declared next to the field in
`filterSchema.js`, because the sensible default depends on what the field means.

**27 new backend tests, 4 new frontend tests.**

---

## Item 3: one permission table instead of thirteen role checks

The audit found the frontend was not ungated — it was INCONSISTENTLY gated, which is worse,
because the parts that were done right made it look finished. Thirteen role checks across the
whole app, spelled three different ways. The gaps were exactly where you would predict: the
screens written last, `CustomerDetail` and `OrderDetail`, had no checks at all.

### Naming the action, not the role

`usePermissions.js` is now a single table of ACTION to allowed roles, consumed as a hook or as
`<Can do="manageProducts">`. The old role-list gate is deleted rather than kept alongside it,
because two mechanisms is the problem restated.

The distinction matters more than it looks. A component asking for a role list has restated
the policy locally, so changing who may reassign a record means finding every site and editing
them all the same way. Naming the action means one edit, in one file, that cannot be applied
inconsistently. It also makes "what can a manager see?" a table you read rather than a grep
you interpret.

Each entry names the backend rule it mirrors, so the table shadows the server rather than
inventing policy. That mattered immediately: I had assumed a sales rep should not see a
Delete button on a customer, checked, and found the API deliberately allows it — a rep owns
their own records. Mirroring reality beat implementing my assumption.

An unknown action throws in development instead of returning false. A typo would otherwise
hide the control from everyone including the admin, and look exactly like a deliberate rule
— failing invisibly, in the direction hardest to notice.

### What actually changed for a sales rep

The genuine find was on the customer list: reps were shown an "assigned to" filter, which can
only ever be a no-op for someone who sees only their own records — and populating it meant
**every rep fetching the name of every other rep** to fill a dropdown that does nothing. The
column is hidden too; it only ever showed them their own name.

### The tests are role-by-role on the same screen

Asserting per-page would have passed on the pages that had checks and never been written for
the pages that did not. Rendering the SAME screen as each role is what makes an omission
visible: an ungated control appears for all three, and the difference the test demands does
not materialise.

### And a flaky suite, found while running it

Running the frontend suite repeatedly to check my work, it failed about one run in five,
always in a different file, always a timing-sensitive assertion. Two causes:

- **Memory pressure.** Vitest defaults to one worker per core; twelve cores meant eleven jsdom
  environments at once on a machine with 2.6 GB free. Capped at four — which also halved the
  wall-clock, because the machine had been thrashing.
- **An ordering assumption in one of my own new tests.** It asserted a fetch had happened
  because a control depending on the same permission was on screen. The control renders from
  the permission; the fetch happens in an effect. True until the machine is busy.

A flaky suite is worse than a slow one: people learn to re-run it rather than read it, and a
real regression gets re-run away with the noise. Six consecutive clean runs now.

**28 new frontend tests.**

---

## Items 4 and 5: order numbers and order assignment

Done together because both change the `Order` model, and doing them separately would have
meant two migrations of the same document.

### The number

`ORD-000142` beside the `_id`, not instead of it. Replacing the key would leak the order
volume of the business to anyone who can see a single order, and invalidate every existing
reference — the number is for humans, and `_id` is for machines.

Allocated from a counter document with an atomic `$inc`. The obvious alternative is a race:

```js
const n = await Order.countDocuments();      // two requests both read 41
await Order.create({ orderNumber: n + 1 });  // both write ORD-000042
```

That is the same shape as the stock bug fixed in the first round — a read and a write with a
window between them — and it is closed the same way, by making them one operation. `count()`
is also not a sequence on its own terms: delete order 42 and the next order is numbered 42
again, so the number stops identifying anything, which is the whole point of having one.

Allocation sits inside the order's transaction, so an aborted order does not burn a number.

**A trap I walked into and the test caught.** I first declared the field `default: null` with
a `sparse` unique index, reasoning that sparse would let the many historical nulls coexist. It
does not: a sparse index skips documents where the field is ABSENT, and one explicitly set to
null is present. The second unnumbered order was rejected with a duplicate key error on null.
Replaced with a **partial** index conditioned on the value being a string, which ignores nulls
and absences alike.

### The assignment

`assignedTo` on the order, where **null means "follows the customer"**.

Inheriting from the customer was the previous behaviour and is right most of the time. Two
ordinary things it cannot express: one deal handled by a specialist while the account stays
put, and history — moving a customer to a new rep silently rewrote who owned every order that
customer ever placed, including ones closed years ago by someone who has since left.
Commission is attached to those.

The design claim is that assignment is an **override**, and the half that is easy to get wrong
is that an override has to cut both ways. Granting the assignee access is obvious. Removing it
from the customer's owner is what most implementations forget — and without it, a hand-off
adds the order to one list, removes it from none, and both reps believe they own it. There is
a test for exactly that, and the list and detail endpoints are checked against each other,
because a rep seeing a row they cannot open is worse than either rule alone.

Its own endpoint rather than a field on the general update: editing an order changes what was
sold, reassigning changes who is accountable. Different permissions, so folding them together
would mean a per-field permission check inside one handler, which is where rules like this go
wrong quietly.

The audit trail gained a `note` field for this. The generated diff is complete and says
`assignedTo: 65f3a9… → 68b1c4…`, which is the whole truth and tells a reader nothing —
resolving those ids a year later means looking up two users who may since have been deleted.
"assigned: Ayesha → Bilal" is readable when it matters.

### Two bugs found on the way

**The colleague picker offered people who cannot be assigned work.**
`/api/users/assignable` returned every user including deactivated and pending accounts. Work
assigned to someone who cannot sign in lands in a list nobody opens, which looks exactly like
the work being handled. Now active-only, with `?search=` so the picker queries the server.

**A timezone bug in every date-range filter.** The full backend suite failed after midnight
local time, on a test I had not touched. `getDateRange` ended the range with `setHours`, which
operates in LOCAL time, while `new Date('2026-08-21')` parses a bare date as UTC midnight.
Mixing the two shortens every range by the machine's UTC offset — on a server five hours
ahead, the last five hours of every day were silently missing from every filtered result. No
error, just quietly incomplete answers. Invisible on the deployment, which runs in UTC, and
found only because a test happened to run at 00:13. Now `setUTCHours`, with assertions on
absolute instants so it fails in any timezone if it returns.

**53 new backend tests, 13 new frontend tests.**

---

## Item 2: the two CRUD gaps that were real

The audit found the picture better than the brief assumed. Customers and Products already had
list, detail, edit and delete, all reachable and all with confirmation on delete. Two genuine
gaps:

### No way to edit an order

`PATCH /api/orders/:id` accepted item changes on a pending order and **nothing in the UI ever
sent them**. A mistyped quantity meant deleting the order and placing it again — which on a
completed order also means the stock moves twice.

`OrderForm` now serves both routes, as the customer and product forms already did. The
interesting part is what it refuses to offer:

- **Items are frozen once the order is completed or cancelled.** The stock has moved and the
  money is real. The form says so in a sentence instead of rendering a page of disabled
  inputs — a form full of dead controls is a puzzle, a sentence is an answer.
- **The customer never changes.** Moving an order to a different customer is not an edit, it
  is a different order; the original customer's history would silently lose a purchase.
- **Status stays on the detail page**, because completing or cancelling is the one action in
  the UI that moves stock, and keeping that in one place beats the symmetry of having every
  field on one form.

The submit path sends only `items`, so it never asks the API for something it is right to
refuse.

### No way to correct a colleague's name or email

`PATCH /api/users/:id` has always accepted both, and the only thing the screen ever sent was
`role` from the dropdown. So a typo in a colleague's email address was unfixable without a
database console — on the screen whose entire purpose is managing people.

A small panel above the table, deliberately without a password field even though the endpoint
accepts one: an admin setting somebody else's credential is exactly the pattern the invite
flow was built to remove.

### A wrong fixture that had been passing

Writing the user tests, `findByText('Bilal Ahmed')` could not find a row that was plainly in
the mock. `usersApi.list` resolves to the whole envelope and the component reads `data.data`,
but the existing fixture was a bare array — so the table had **always** rendered empty in
those tests. Harmless while nothing asserted on a row, and exactly the kind of harness bug
that makes the next test mysteriously impossible to write.

Also raised `testTimeout` above `asyncUtilTimeout`. With the two equal, a `waitFor` that is
going to fail dies of the test timeout at the same instant it would have reported what it was
waiting for, so the output says "test timed out" instead of naming the element. Two of my own
failures were diagnosed a step slower for that reason.

**26 new frontend tests.**

---

## Item 7: sign-up becomes a request somebody has to approve

The previous round had re-opened public sign-up behind `ALLOW_PUBLIC_SIGNUP`, and I flagged
the trade-off at the time: anyone who could reach the page got a working login and could read
the customer list. The least-privileged role limited what they could damage, not what they
could see, and seeing it was the part that mattered.

This resolves that properly rather than by choosing a side. Signing up now creates an account
that **exists and cannot be used**. "Anyone can get in" becomes "anyone can ask", which is a
question an administrator answers.

### The details that took the most thought

**Two kinds of `pending`.** An invited colleague and an unapproved applicant are both pending,
and they need completely different treatment. They are told apart by `requestedRole`, which
only a sign-up sets. It matters most at the login screen: *"use your invitation link"* and
*"awaiting approval"* send someone to two entirely different places, and a single "account
unavailable" would leave an invitee waiting for an approval that is not coming. It matters
again in the approvals queue, which filters on the same field — filtering by status alone
would put invited colleagues into a queue where there is nothing to approve.

**Admin is not requestable, and asking for it is an error rather than a downgrade.** Quietly
turning `requestedRole: 'admin'` into `sales_rep` would let someone come away believing they
had asked for admin and been approved for it.

**The admin may override the requested role in the same action.** A request is a request.
Approve-then-demote would leave a window, however brief, in which somebody holds access nobody
agreed to give them.

**Rejected accounts are kept.** The brief allowed either; keeping wins on three counts.
Deleting frees the address, so the same person re-applies and the admin sees an identical
request with no memory of declining it. The decision itself is the answer to "who asked for
access and what was decided", which is exactly what an audit of an internal system asks. And
the login screen can say "your request was not approved" instead of "invalid email or
password", which would send them round the reset loop for an account that no longer exists.
The cost — a rejected applicant cannot re-apply unaided — is deliberate: that is a
conversation, not a form.

**202, not 201.** Something was created, but the thing the caller asked for — an account they
can use — has not happened and may never. "Received, not acted on" is precisely the state.

**No session on sign-up, and the frontend had to be changed to match.** `register` in
`AuthContext` used to set the user. Leaving that would have put the app into a signed-in state
with no credentials behind it: every request 401s and the person is bounced back to login
having apparently been signed in for a second.

**Both emails are best-effort.** The request is already recorded and the queue shows it
regardless, so losing a notification costs a little time and nothing else. Failing the
approval because mail is down would be much worse — the admin retries, and the second attempt
is refused because the account is no longer pending.

**A route-ordering bug I caught before it shipped.** `GET /users/pending` was registered after
`GET /users/:id`, so Express would have matched it as an id. Moved above.

### The queue is in the way, and vanishes when empty

`PendingApprovals` renders nothing at all when nobody is waiting. An empty "no pending
approvals" panel on every visit is how people learn to skip past that part of the screen —
including on the day it is not empty. When there is something, it is the first thing on the
page, with a count.

**34 new backend tests, 21 new frontend tests.** Three existing tests in `auth.test.js`
asserted the old behaviour (a second sign-up producing a usable account) and were rewritten
against the new one.

### A note on the environment, not the code

Nine backend tests failed mid-way through this item with `Mongod internal error (fassert()
failure)`. That was not the code: **the disk was 100% full**, 92 MB free of 277 GB, so the
in-memory MongoDB could not write its data files. Clearing regenerable build artifacts and the
npm cache freed 3.9 GB and all nine passed unchanged. Worth recording because the symptom
looks nothing like the cause.

---

## The lock file that stopped every deployment

CI had been failing on `npm ci` with a lock file out of sync, and the same failure was
stopping Vercel from building — which is why the live site had not changed despite all of the
work above being merged. The features were shipped to `main` and never to a server.

```
npm error Missing: @emnapi/core@1.11.3 from lock file
npm error Missing: @emnapi/runtime@1.11.3 from lock file
```

The first read of that is a dependency problem, and it is not one. **npm 10 and npm 11 write
different lock files for the same `package.json`**: npm 11 records optional platform binaries
— `fsevents`, the `@unrs`/`@emnapi` resolver bindings — that npm 10 leaves out entirely.
Reproduced both directions locally, which is what turned a guess into a diagnosis:

| lock written by | packages | npm 10 verdict | npm 11 verdict |
| --- | --- | --- | --- |
| npm 10 | 582 | accepted | rejected — wants `fsevents`, the `@unrs` bindings |
| npm 11 | 607 | rejected — wants `@emnapi/core@1.11.3` | accepted |

Neither lock works everywhere, so the fix cannot be "regenerate the lock". Whichever version
writes it, a machine on the other major rejects it, and the error blames the file rather than
the toolchain. My Node 24 gives npm 11; CI runs Node 20.19, which gives npm 10.

So the npm MAJOR is now pinned rather than inherited: `packageManager` in both
`package.json` files declares it, and CI installs `npm@10` explicitly before `npm ci`, so the
lock is always validated by the same npm that produced it — whatever npm `setup-node` ships
with next. The lock itself was regenerated with npm 10 and verified against both packages
with `npm ci --dry-run`.

The stale entry that triggered it is worth recording too: the committed lock pinned
`@napi-rs/wasm-runtime@1.2.2` with only `@tybys/wasm-util` as its dependency, while that
version's real manifest also requires `@emnapi/core` and `@emnapi/runtime`. A regenerated
npm 10 tree drops that whole subtree — it was a leftover from a dependency no longer in
`package.json`.

**No application code changed.** The suites are re-run to confirm that.

---

## Switching the AI provider to Gemini

Asked for directly, and it turned into the best argument yet for the seam that was put in
front of the SDK three rounds ago: **every AI feature calls `aiClient.complete()` and nothing
else**, so changing provider meant rewriting one function body. The search translator, the
customer summary and the lead scorer never knew which model they were talking to and still do
not. That abstraction had never had to prove itself before.

What was NOT a one-line change was everything the old defaults quietly assumed. Four bugs, all
of which shipped looking entirely reasonable, and none of which a unit test would have caught
because each produced a *plausible* result rather than an obvious failure. All four were found
by calling the real API.

**Thinking tokens come out of the reply's budget.** `maxOutputTokens` caps thinking and the
reply *together*. A 20-token request returned a **successful response containing 16 thinking
tokens and no text**. Not an error — a 200 with nothing in it. The client now adds a measured
thinking allowance on top of the caller's budget, and treats an empty reply as an error rather
than handing `undefined` to a JSON parser.

**`thinkingBudget: 0` is a 400 on Gemini 3.** It is how Gemini 2.x turned thinking off. Gemini
3 rejects it outright, so the first working version of this switch failed every call with
INVALID_ARGUMENT. `thinkingLevel: 'low'` is the floor; unset, a one-word prompt spent over a
hundred tokens deliberating.

**A 499 is our own timeout coming back to us.** It arrives with a status, so the existing rule
— "any explicit status is a permanent answer" — sent it straight to the fallback, while the
identical failure arriving *without* a status was retried three times. Inconsistent in the
least useful direction.

**Retrying a 429 actively made things worse.** The free tier allows five requests per
*minute*, and the API says precisely how long to wait: `retryDelay: "47s"`. Three attempts
250 ms apart do not ride out a rate limit — they spend two more of the five requests that are
left on calls that cannot possibly succeed yet. The client now reads that delay and abandons
the call when it exceeds the operation's budget, which is both faster for the user and cheaper
for the account.

Timeouts were re-tuned against measurement rather than inheritance. The 10 s ceiling was set
for a different provider; Gemini 3 Flash is more variable, and one live query burned two
timeouts before its third attempt succeeded — 24 seconds to produce an answer the first
attempt would have given in twelve. Measured p50 is 2–4 s, so: 15 s per attempt marks a stall,
and a new **20 s deadline on the whole operation** stops three retries adding up to a minute
of somebody watching a spinner.

The pricing table was wrong the instant the provider changed — it still held the old rates and
would have reported roughly twenty times the real spend, with nothing failing, because nothing
there can tell a plausible number from a correct one. Carrying the old entry over would
normally be right, since re-costing existing usage rows at the default silently changes what
last month cost. There were no such rows to protect: the old key was never configured on any
deployment, so not one call was ever billed — which was the finding that started this work.

**Verified against the live API: 4 of 4 brief queries translate correctly in AI mode**, with
the filters and results they should produce. Before the retry fixes it was 2 of 4.

**No fallback to the old `ANTHROPIC_*` variable names.** A deployment with the old one still
set would otherwise look configured while every call failed against a key for the wrong
provider — precisely the silent degradation `/api/internal/ai-status` exists to make
impossible.

**7 new backend tests**, each pinning one of the four findings above.

---

## Reworking who can do what, and adding an approval step

A substantial change to the permission model, asked for directly. Three of the four
decisions needed clarifying first, because different readings meant materially
different work — in particular "admin has to approve everything", which could
reasonably have meant anything from "nothing new" to "a manager cannot finish a
single task alone".

### The model now

A sales rep has **no access to the customer book at all**. Not a filtered slice —
none of it. That is the sharpest change and the reasoning is simple: a rep's job is
to fulfil orders assigned to them, and the customer list is the most commercially
sensitive collection in the system. "Only my customers" is still a slice of it, and
a slice is enough to walk out with.

What a rep does get is the customer's **phone and address on an order assigned to
them**, because they cannot deliver an order without them. That travels with the
order rather than coming from the customer endpoints — one customer, only while an
order for them is open, only for the rep holding it.

A rep's scope collapsed from three overlapping rules to one. It used to be orders
they created, OR orders for a customer they owned, OR orders assigned to them. The
first two are now impossible, so `assignedTo` is the whole of it. Three branches
became one, which is one fact to reason about rather than three that have to agree.

A manager reads the whole customer book and writes none of it. Products and orders
they run; the record itself belongs to the admin.

### The approval layer

A manager's create, edit or delete of a customer or an order is now a **change
request**. `202 Accepted`, nothing written, an admin decides.

The design decision worth recording is that **nothing is written when the change is
proposed**. The obvious alternative — write it now, undo it if rejected — is much
simpler and wrong in a way that matters: between the write and the rejection the
record is LIVE. A live order can be completed and move stock; a live customer
address is the one a delivery goes to. "Approved" has to mean "took effect", which
means nothing can take effect first.

Three smaller decisions inside that:

- **An admin's own changes apply immediately.** Approving yourself is theatre, and a
  queue full of your own requests is a queue you stop reading.
- **A rep completing their own order is outside the whole mechanism.** It is a status
  transition, not a change to what was sold, and gating it would leave a rep able to
  see work and unable to do it — a waiting room, not a permission model.
- **One outstanding request per record.** Two managers queueing conflicting edits,
  both approved, means the second silently overwrites the first having been written
  against a version that no longer exists. The second submission is refused with a
  409, in front of the person making it.

### Two mistakes I made and had to correct

**I gated the customer write routes with `requireAdmin` first.** A manager got a 403
and had no way to propose anything, which turns "needs approval" into "not allowed" —
a different rule from the one asked for. The decision belongs in the handler, where
the actor's role picks between applying and queueing, and where the response can say
which happened.

**Approving an order returned a 400.** `Model.create(payload)` was the right answer
to the wrong question: a proposal holds `{ product, quantity }`, and a real order
needs each line priced at the price of the day, a total, an atomically-allocated
number, and stock moved if it is being completed. Fixed by extracting `placeOrder`
and having both paths use it — anything else means two definitions of what an order
is, and the approved kind would be the one nobody tested.

### And a piece of documentation that had quietly become false

`assignedTo: null` used to mean "follows the customer", and the model comment, the
frontend copy and three tests all said so. With inheritance gone it means "nobody
holds it". The tests caught it; the comment and the UI copy would have gone on
lying indefinitely, telling an admin an unassigned order was being handled by a rep
who could not see it.

`Customer.address` was added as one free-text block rather than
street/city/postcode/country fields. Address formats are not the same shape across
countries, so a fixed set of boxes forces every address that does not fit into the
wrong one — and nothing here sorts or validates on the parts.

### The test migration was most of the work

51 tests failed on the first run, across 11 suites, and almost none of them were
bugs — they were tests asserting the old model. The interesting part was that
several could not simply be repointed:

- Tests using a sales rep as a generic "some authenticated user" for customer CRUD
  had to become admins.
- The audit tests that assert a NON-ADMIN actor is snapshotted moved to a product
  write, keeping a manager as the actor. Switching them to an admin would have made
  them pass while testing something weaker.
- `filters by actor` had been filtering a trail where every entry belonged to the
  same person — it would have passed against a filter that did nothing. It now has
  one entry per actor and checks that the filter discriminates.
- The cursor-paging scope test had been asserting against a customer list a rep can
  no longer reach, so it was passing on a 403 with no `data` at all. Moved to orders,
  where a rep genuinely has a narrowed view.
- The stock-atomicity suites had to switch to an admin actor: a manager's order is
  now a proposal, so the responses came back 202 and the stock was never touched —
  the tests would have passed without exercising the race they exist for.

**43 new backend tests, 4 new frontend tests.**

---

## Assignment at the point of sale, and undoing an approval step

Reported as: the order form never asks who the order is for. It did not —
assignment was a second trip to the detail page afterwards, for a decision that
is usually already made when the order is taken. Fixing that turned into a
correction of something I had got wrong the round before.

### The correction

**Order creation no longer waits for approval.** I built it that way and it was
the wrong call: it put the approver in the critical path of SELLING. Nothing a
manager agreed became real, and no rep could start work, until somebody else
acted. Deciding what is sold and who works it is precisely the manager's job.

What still waits is changing or destroying a record that already EXISTS —
editing an order's items, deleting one, any write to a customer. None of those is
on anybody's critical path, and all of them are edits to data the admin owns.
That is a much better line than "everything a manager does".

### The changes

**"Assign to" on the order form**, under the customer, listing active colleagues.
Optional on purpose: requiring it would mean a manager taking an order over the
phone cannot record it until they have decided who works it — so the order does
not get written down, which is worse than it being briefly unowned. Sent as
`null` rather than omitted when nobody is chosen, so "deliberately unassigned" is
explicit rather than inferred.

**Deleting an order is the admin's alone.** A manager could do it directly, which
was too casual for the most destructive and least reversible act available: on a
completed order it restores stock, so the inventory ledger is rewritten along
with the record. A manager may now ask.

**A rep can request a transfer.** They cannot reassign — that would let them push
a difficult account onto a colleague, which is a staffing decision somebody else
should make. But the rep is the one who knows they are on leave next week. So
they name a colleague, optionally say why, and an admin decides; the order stays
with them meanwhile. Modelled as a fourth change-request action rather than an
`update` carrying an `assignedTo`, because the two read completely differently in
a queue: "a manager wants to change what was sold" against "the rep holding this
cannot do it".

### Three bugs the tests caught, all mine

**An approved EDIT to an order was not priced.** Exactly the same mistake as the
CREATE path a round earlier, in the branch next door: the payload holds
`{ product, quantity }` and an order line needs `priceAtOrder` with a total
recomputed from the lines. Now priced at APPROVAL time rather than when it was
asked for, so a request that sits in the queue over a price rise applies the new
price rather than a stale one.

**A manager's queued item edit was writing anyway.** The decision is made deep
inside the update transaction, and returning from there would have committed it.
Fixed by throwing a sentinel to abort the transaction and submitting the change
request outside it — with a test that asserts the order is *completely*
untouched, not merely that a request exists.

**Two children inside `<Field>` took the whole form down.** `Field` clones its
single child to give it the label's id, so a second one throws — and every test
in the file then failed on a missing customer label, which says nothing about the
cause. The clearing button became a sibling, which is also what it is.

### And a test helper that was lying by position

`getAllByRole('combobox')[1]` was the first product picker. Adding the assignee
control between the customer and the items shifted every index, and the tests
failed on a missing OPTION rather than on the control they were actually
grabbing. Replaced with a named helper — and the obvious fix, matching on the
placeholder, does not work either: `SearchSelect` swaps its placeholder for the
selected label, so a line stops matching the moment it has a product on it, which
is exactly when a test wants the next one.

**33 new backend tests, 12 new frontend tests.**

---

## Three tabs, three roles, one browser

Reported as: sign in as a rep, a manager and an admin in three tabs, reload, and all three
show the same role.

### The reported symptom is browser behaviour and is not fixable

A cookie is keyed on `(name, domain, path)`. There is no tab dimension in that key, and the
session is cookies — `simplecrm_access` at `/` and `simplecrm_refresh` at `/api/auth`, no
`domain` set, so host-only and shared by every tab of the origin. Signing in anywhere
replaces the session everywhere. Three simultaneous identities in one browser profile on one
origin is not something cookie authentication can express, and no amount of code changes
that.

I ruled out the code-side possibilities before concluding that: there is no
`BroadcastChannel`, no `storage` listener, no WebSocket, no service worker and no shared
store anywhere in the frontend. React context is per-tab by construction — each tab is a
separate JS realm. The cookies were, genuinely, the only shared state.

The honest recommendation is separate browser profiles, an incognito window, or different
browsers, and the README now says so.

### The bug worth fixing was a different one, and worse

The report describes what happens after a RELOAD. Before the reload, the tab does not get
signed out at all — it goes on rendering the previous user's name, role and navigation while
its requests are authenticated as somebody else.

It never finds out, because **replacing a session does not produce a 401**. The new cookie is
perfectly valid, so every request comes back `200` with the new user's data behind the old
user's interface. `onSessionExpired` only fires on a 401 that a refresh could not rescue, and
there is no 401 here. `/auth/me` ran once, on mount, and nothing revalidated afterwards.

So the failure mode is not "logged out silently" — it is "silently acting as a different
person", which is worse, because nothing about the screen suggests anything has changed.

**Not a privilege escalation, and worth saying so plainly.** The backend authenticates the
cookie on every request and is the only authority on what may be read; the human at the
keyboard is necessarily whoever just typed the newer credentials. Nobody reaches data they
could not already reach. What is wrong is honesty rather than authorisation.

### The fix: converge, and say why

Signing in or out broadcasts the new user id; a tab holding a different one re-reads
`/auth/me` and re-renders as the truth with a message explaining it. A focus/visibility check
covers what the channel cannot — browsers without `BroadcastChannel`, a message posted while
the tab was discarded, a session replaced from another window — and it fires at the moment it
matters, when somebody is about to look at the tab.

**Convergence rather than signing the tab out.** There is one live session and the person
created it deliberately; signing them out of a tab they did not touch, to protest their own
action, is theatre, and they would sign straight back in as the user the tab was about to
become. Converging is also what a reload does, so a tab left open and a tab reloaded end up
in the same state rather than two.

Only the user **id** goes on the channel. It is readable by any script on the origin, and
there is nothing to gain from putting a name or role on it when the receiving tab asks the
server anyway.

### Two bugs in my own fix, both caught by the test

The test failed about two runs in five, and both causes were real rather than test artefacts:

**The announcement channel was closed in the same tick as the post**, which can drop the
message before delivery. Replaced with one long-lived sender per tab.

**The subscription depended on a callback.** Any change to it re-subscribed, and
re-subscribing tears down a `BroadcastChannel` and builds a new one — losing whatever was in
flight. That is not a test-only problem: in a browser it would mean a tab occasionally
missing the announcement and going on lying, which is precisely the bug being fixed. The
listener is now registered once and calls through a ref. Eight consecutive clean runs.

**8 new frontend tests**, driving the real scenario: a tab open as a rep, an announcement
that the browser now belongs to an admin, and assertions that the tab stops claiming to be
the rep, adopts the admin, and says why.

---

## The role audit

Every route hit as each of the three roles against the real backend with a genuine session,
rather than sampled or reasoned about from the middleware. The full matrix, per-role sections
and findings live in **[ROLE_AUDIT.md](ROLE_AUDIT.md)**; reproduce with `npm run audit-roles`
in `backend/`.

**Role separation holds.** Every denial is a proper `403` — there is no `200`-with-filtered-data
where a refusal was intended, and nothing `500`s. A rep calling every admin-only and
manager-only endpoint directly with a valid session was refused every time; a manager
inviting an admin was refused while an ordinary invite succeeded; a rep reading another rep's
order by id was refused, consistent with it being absent from their list.

### The audit's own bug, which mattered more than it sounds

The first run showed `POST /api/orders` returning `404` for all three roles, which looks
exactly like a permission bug. It was not. The routes ran in order against one shared
fixture, and the destructive ones poisoned everything after them — the admin deleted the
customer, and every later call referenced a customer that no longer existed.

Worth recording because of which results survived that: **the 403s were still trustworthy**,
since a permission decision is made before any data is touched. Everything else was not. The
script now rebuilds the world before every single (route, role) pair.

### The one finding worth fixing

`GET /api/users/assignable` returned `name`, `email` and `role` to any authenticated caller,
including a sales rep — an internal staff directory any rep could enumerate. Not an
escalation, and there is a legitimate need behind it: the transfer-request picker is a
rep-facing feature and has to list colleagues.

So the projection narrowed rather than the route closing. A rep gets `name` and `role`, which
is all a picker displays; anyone who can actually manage people still gets the address,
because the screens that identify a colleague by email are theirs. **4 new backend tests**
covering both halves.

Two further findings were recorded as deliberate rather than fixed — admins and managers
being able to file a transfer request they could simply carry out (harmless, and refusing a
strictly-less-powerful action would be a rule with an edge case for no gain), and the
dashboard being scoped correctly but shaped identically for every role. The second is the
substance of the dashboards work and is handled there.

### The dashboard question, answered decisively

The brief suspected the dashboard might be hidden with frontend conditionals rather than
scoped on the server. **It is scoped on the server**, and the proof is not a code reading: with
two completed £100 orders where only one belongs to the rep, the rep's `totalRevenue` comes
back `100` and the admin's `200`. Customers and recent orders scope the same way.

What is wrong is the shape — all three roles receive an identical payload, so a sales rep is
shown a "Total customers" tile reading `0` because they have no customer access at all. That
is not a leak; it is a screen telling somebody the business has no customers.

---

## Notes, and why they cannot be edited

An append-only timeline on customers and orders. One `Activity` collection for both, because
every rule about them — ordering, authorship, immutability — is identical and only the record
they hang off differs; two collections would mean maintaining that twice and watching it
drift.

### The append-only part is the feature

A timeline anyone can quietly reword is not a history of an account, it is a draft of one. Its
whole value is that it says what was known at the time, and the moment a note can be edited
the question "did this say something different yesterday?" stops having an answer.

It also breaks what notes are most used for. Somebody reads back a conversation before ringing
a customer; if the previous rep tidied their note afterwards, what gets read back is the tidy
version rather than the one that would explain why the customer is annoyed.

Corrections are made the way they are in a paper ledger — by writing another line.

### Enforced three times, on purpose

Not routing a `PATCH` is how it is enforced today, and that holds exactly as long as nobody
adds one. "We simply won't build that" is a convention, not a guarantee: a later generic admin
screen or a well-meant bulk fix walks straight through it without anyone noticing the rule
existed.

So the **model** refuses every mutating path Mongoose offers — `updateOne`, `updateMany`,
`findOneAndUpdate`, `findOneAndReplace`, `replaceOne`, the three delete forms, and `save()` on
a document that already exists. A write attempt fails loudly at the point of the write with a
message saying what to do instead. The **routes** offer no edit or delete. The **screen** has
no edit control and states the reason, because a missing button reads as unfinished software
unless the interface says the absence is deliberate.

### Permissions are the record's own, and that is the whole design

Whether you may read or write notes on something is exactly whether you may read that thing,
resolved by loading the record and asking the same helper its own endpoints ask. A separate
rule here would be a second definition of "yours" to keep in step with the first — and notes
on an account are often franker than its fields.

That produces the right answers without stating any of them separately: the assigned rep can
write up a delivery, a rep gets a `403` on a colleague's order exactly as they do on the order
itself, and no rep reaches customer notes at all.

### Two judgment calls worth recording

**A manager's note is not a change request.** Their customer edits queue for approval; their
notes do not. Approval exists because an edit overwrites what was there and an overwrite needs
a second pair of eyes. A note overwrites nothing — it is additive, attributed and immutable,
so the worst a bad one does is be wrong in public with someone's name on it. Queueing them
would also make the feature pointless: the moment to write down what a customer said is
straight after the call, and a note that appears when an admin gets round to it is one nobody
writes.

**Notes outlive the record they describe.** Deleting an order does not erase what people wrote
about it, for the same reason the audit trail has no TTL: a history that disappears with the
record cannot answer anything about why the record was deleted.

### A flaky test that was a test-boundary problem, not an app one

Adding these tests surfaced an intermittent failure in the multi-tab suite — about one
full-suite run in four, in a file I had not touched.

Every test in that file shares one realm and one channel name, and a `BroadcastChannel`
delivers on a later task rather than synchronously. So an announcement posted at the end of
one test could still be queued when the next mounted its tab, and that tab did exactly what it
should: re-read `/auth/me`. Which is precisely what the "does nothing when the announced
session is the one it already has" test asserts must not happen.

A real browser does not have this problem — a tab is not delivered a message posted before it
subscribed, and if it somehow were, re-checking would converge it on the truth. Fixed by
draining the channel before each test, while no tab is mounted. Worth chasing rather than
re-running: a suite that fails one run in four teaches people to re-run it, which is how a
real failure gets waved through.

**16 new backend tests and 8 new frontend tests.**

---

## "ASSIGNED TO" above nothing at all

Reported from the order page: the assignment bar shows its heading and no name.

### One response out of five had drifted

Four hand-written populate lists, and the detail response was the one that never populated
`assignedTo`. So it arrived as a bare id — which is truthy, so the panel took its "somebody
holds this" branch and rendered `assignedTo.name`: `undefined`. A heading over two empty
lines, on the one screen whose job is to answer who has the order.

The list endpoint had always populated it, which is what made this odd to look at rather than
obviously broken: the name showed in the table and vanished when you clicked the row.

The edit form had the same fault from the same cause — it seeds its assignee picker from the
detail response, so the picker opened blank on an order that was in fact assigned.

### Naming the shape once is the actual fix

Four copies of a projection are four chances to forget one, and forgetting one fails silently:
a missing populate is not an error, it is a field that renders as nothing. Every order
response now shares a single `ORDER_POPULATE`.

Two things came out of writing it:

**`stockQty` is load-bearing.** The edit form warns you as you type that a line exceeds stock,
reading that number off the order's own populated items — and only the detail response carried
it. Unifying on the shorter list would have switched that warning off with no error anywhere:
the server still refuses to oversell, but you would find out on submit rather than while
typing. Caught before it shipped, and the reason is now written next to the field.

**No email on the people.** `name` and `role` are what the screens display, and nothing reads
an address off an order. Leaving it in would have reintroduced, one record at a time, exactly
what narrowing `/users/assignable` fixed — a rep collecting colleagues' addresses from records
they are perfectly entitled to open.

### A test that pinned the bug in place

`assigns the order at the moment it is placed` asserted `String(data.assignedTo)` equalled the
id, which passes whether the field is populated or not — so the suite was agreeing with the
broken behaviour. It now asserts the name and role are present and the address is not, because
the bare id is what the bug looked like.

The screen is keyed on the name rather than the object as a second line, so the worst future
outcome is a wrong message instead of a blank one. **7 new tests** across both packages,
including one that renders the panel with an unpopulated id and requires it to say something.

---

**Final totals: 854 backend + 215 frontend + 11 end-to-end**, lint clean on both packages.

---

## Storefront, phase 1: the data models underneath a buyer track

The brief for this round is a full storefront — buyer accounts, a public catalogue, cart,
checkout, buyer-initiated cancellations, ten AI features, a design pass, all of it. Working
through it in the phases it was specified in, testing and reporting after each rather than
landing it as one enormous change. This entry covers phase 1: the schema underneath everything
else. No route exists yet that uses any of this — the point of doing it first is that every
later phase is building on a settled shape rather than discovering what the shape needs to be
while also wiring up an endpoint.

### A buyer is not a smaller staff role

The whole of this app's permission reasoning — `hasFullRecordAccess`, `requireManagerOrAdmin`,
every check in `usePermissions` — is "which of the three staff roles is this". A buyer is not
one of those roles held loosely; it is not staff at all. Folding it into `User` as a fourth
`role` value would mean every one of those checks needed an "and not a buyer" clause added by
hand, forever, and the one place that got missed is a buyer looking at the customer book. A
separate `Buyer` model makes that failure structurally impossible instead of merely
disciplined: nothing in the staff permission table can accidentally grant a buyer anything,
because a `Buyer` document is never what those checks read. Password hashing, the same
exponential lockout backoff, and the same `toJSON` stripping all mirror `User.js` line for
line — a buyer's account deserves exactly the same protection a staff member's does, and nothing
about being a customer rather than an employee changes that.

### The refresh-token store is deliberately duplicated, not shared

The obvious move for buyer sessions is a `refPath` on the existing `RefreshToken.user`, the
same technique used below on `ChangeRequest.requestedBy`. Rejected here on purpose: refresh
rotation and reuse detection is the single most security-sensitive piece of machinery in this
app, and the buyer and staff tracks are meant to be fully independent — separate cookies,
separate paths, separate middleware, so a person can be signed into the internal CRM and the
storefront in the same browser without collision (see the multi-tab cookie entry earlier in
this log for why that scoping matters). Threading a second actor type through the staff session
store would mean every future change to staff session logic has to be re-reasoned about for
buyers too, and a defect in one track's rotation could revoke or leak sessions in the other. A
second, identically-shaped `BuyerRefreshToken` collection costs a little duplication and buys
real isolation.

### `ChangeRequest.requestedBy` becomes polymorphic, on purpose, without a migration

A buyer will eventually be able to request cancellation of their own pending order, and that
request has to sit in the same approval queue a manager's customer edit sits in — the brief is
explicit that it should be the *same* queue, just labelled differently, not a second mechanism.
The requester was always `ref: 'User'`; a buyer is not one. Rather than a second
`requestedByBuyer` field — which would let both be set, or neither, on a request that has
exactly one requester — `requestedBy` now uses `refPath: 'requestedByModel'`, a new field
defaulting to `'User'`.

The default is what keeps this backward compatible with zero migration: every change request
written before this field existed has nothing stored there, and Mongoose applies a schema
default when hydrating a document that is missing the field — not only on `.create()`, on every
read. A test inserts a request directly into the collection with no `requestedByModel` at all,
the way a genuinely old document would look, and confirms it still `populate()`s its requester
as a `User`.

Also added: a `cancel` action, distinct from the existing `delete`. Mechanically they look
similar, but a manager's `delete` removes the order document; a buyer's `cancel` — the only
change a buyer will ever be able to request — moves a still-`pending` order to `cancelled` and
leaves the document standing, because a buyer's own order history has to keep showing an order
they cancelled, not lose it. Same reasoning as why `transfer` is separate from `update`,
recorded when that field was written: two different requesters asking for two different things
read as one row apiece in a queue, not as one action a reader has to infer the meaning of.

### Order gets `source` and `buyerId`, both nullable-safe by default

`source: 'internal' | 'storefront'` defaults to `'internal'` — not because every existing order
needs backfilling, but because the default states the truth: an order placed before the
storefront existed really was placed by staff, through this app. `buyerId` is separate from
`customer` rather than replacing it: every order has a `Customer` — that record is what a sales
rep follows up with, and matching a storefront order to one by email is the entire reason to
build this on the CRM rather than a generic cart plugin — but only an order placed by a
signed-in buyer also has a `Buyer`. A guest checkout will create or match a `Customer` and leave
`buyerId` null, exactly like a staff-placed order does today.

### Product.imageUrl, and category was already there

The brief asked for both `imageUrl` and `category` on `Product`. `category` already exists —
indexed, defaulted to `'Uncategorised'` — so only `imageUrl` was new: optional, empty-string
default, so a product created before the storefront existed falls back to a placeholder image
in the UI rather than failing validation or needing a backfill.

### Cart is buyer-only and price-free

`Cart` holds a buyer id (unique — one cart per buyer, enforced by the index rather than a
lookup-then-create, which is what actually stops two concurrent "first add to cart" requests
from creating two carts) and `{ product, quantity }` lines. No price is stored on a cart line:
price is resolved fresh at checkout from the product's current price, the same as every other
order path in this app — a cart is not a quote and was never meant to lock one in. A guest's
cart never reaches this collection at all; it is client-side state until someone signs in,
which is also why there is no cleanup job for abandoned guest carts here — there is nothing
server-side to clean up.

**13 new backend tests**, covering the buyer account (hashing, duplicate email, lockout), the
one-cart-per-buyer constraint, `Order.source`/`buyerId` defaults and validation, and — the part
worth the most scrutiny — that a `ChangeRequest` with no stored `requestedByModel` still reads
back correctly as a `User`. Full suite re-run clean after the `ChangeRequest` change, since a
polymorphic reference on an approval queue used throughout the app was the one edit in this
phase with real regression risk.

**Final totals: 867 backend + 215 frontend + 11 end-to-end**, lint clean on both packages.

---

## Storefront, phase 2: buyer auth, and a coupling bug the coexistence test caught

`/api/shop/auth/*` — register, login, refresh, logout, me — structurally parallel to the staff
auth system: httpOnly cookies, hashed refresh rotation with reuse detection, the same password
policy, the same exponential lockout. See the phase 1 entry for why the underlying models
(`Buyer`, `BuyerRefreshToken`) are separate collections rather than shared ones; this phase is
that same isolation carried through to the HTTP layer.

### Registration activates immediately, and that is a deliberate divergence

Staff sign-up creates a `pending` request an administrator has to approve, because the moment
that account works it can read the customer list — the risk is what the account can *see*, not
what it can do. A storefront account grants access to nothing but the buyer's own cart and
order history. There is nothing for an admin to gate, so `Buyer.create` runs straight through to
an issued session. Copying the staff registration flow wholesale would have added an approval
step that protects nothing and makes the storefront unusable the moment someone signs up.

### The token itself says which track it belongs to

A buyer's access JWT carries `kind: 'buyer'` and no `role` claim at all. `protectBuyer` checks
`kind` before it even looks the id up, so a staff token presented to a buyer route is refused on
the claim alone — it does not depend on the id happening not to resolve against `Buyer`. The
reverse direction (a buyer token on a staff route) is already safe by construction, since
`protect` looks the id up in `User`, a different collection — but the explicit check exists so
the boundary is stated, not incidental. A test proves both directions.

### The coexistence test found a real bug before anyone hit it by hand

The premise the whole design rests on is that a person can have a staff session and a buyer
session open in the same browser without either disturbing the other — a manager previewing the
storefront, most obviously. Writing the test that proves it (`register as staff, then register
as buyer, in the same cookie-jar agent, confirm both sessions work`) failed immediately: the
buyer registration came back `403`.

The cause was the STAFF CSRF middleware, mounted globally for every route in `app.js`. It
decides whether a request is "cookie-authenticated" by checking for the *staff* access cookie —
and that cookie's path is `/`, so the browser had already started attaching it to
`/api/shop/...` requests too, the moment the staff session existed. Every buyer write was
therefore being asked to also carry the staff CSRF header, a requirement that has nothing to do
with the buyer session at all. Fixed by excluding `/api/shop` from the staff CSRF middleware
entirely — that prefix has its own complete, independent CSRF pair
(`middleware/shopCsrf.js`), and the staff one has no business there.

Worth being honest about why this shipped in the first draft rather than being designed around
from the start: nothing about the buyer auth code itself was wrong in isolation, every test
written against `/api/shop/auth/*` alone passed on the first run. It only surfaced once a test
exercised the two tracks *together*, in one cookie jar, which is exactly the scenario the "fully
separate track" design promises to handle. A lesson worth stating plainly for the phases still
ahead: isolation claimed by two systems each tested alone is not the same as isolation proven by
testing them at the same time, in the same client — the multi-tab cookie bug earlier in this log
was a different flavour of the identical mistake.

**28 new backend tests**, including the coexistence test and its inverse (a staff CSRF token
must not satisfy the buyer check, or vice versa), full rotation/reuse-detection coverage mirrored
from `session.test.js`, and the registration-activates-immediately behaviour asserted against the
staff bootstrap rule to confirm the two paths genuinely don't touch. Full suite re-run clean
after the `app.js` change, since it altered request handling for every route in the app, not
only the new ones.

**Final totals: 895 backend + 215 frontend + 11 end-to-end**, lint clean on both packages.

---

## Storefront, phase 3: the public catalogue, cart, checkout, and a buyer's own orders

`/api/shop/products*` (public), `/api/shop/cart*` (buyer-only), `/api/shop/checkout` (guest or
buyer), `/api/shop/orders*` (a buyer's own, plus the two requests they may make against a
pending one). This is the phase that makes the earlier two mean something — a visitor can now
actually browse, buy, and later ask to undo.

### Two fields were missing from phase 1, and phase 3 is where that showed up

`Product` needed a `description` for the catalogue to say anything about an item beyond its
name and price — phase 1 added `imageUrl` and `category` (`category` already existed) but
missed this one. Caught while writing the public projection, not before, which is worth
recording rather than quietly folding into "phase 1" after the fact: reading a spec and
building the projection it implies are different exercises, and the second one is what actually
proves the first was complete.

### The public projection is a fixed list, not the internal one minus a blocklist

`GET /api/shop/products` shares nothing with `productController.js`'s handlers — no `sku`, no
`lowStockThreshold`, and stock is a boolean rather than a count. Same reasoning as narrowing
`/users/assignable` in the role audit: an allow-list is explicit about what leaves the server,
so a future internal-only field arriving on `Product` is excluded by default instead of shipping
to the public the day someone adds it and forgets this file existed.

### Matching a customer by email is an atomic upsert, not a lookup then a create

Two guest checkouts with the same email arriving at once must not create two `Customer`
records — the same shape of race the stock decrement is careful about elsewhere in this app, and
closed the same way: `findOneAndUpdate` with `upsert: true` inside the transaction, so the
database arbitrates which of two simultaneous callers performs the insert rather than both
reading "not found" and both writing one.

It also **only sets fields on insert, never on match**. A returning buyer's second checkout
might carry a different phone number than the one on file — that record may since have been
corrected or annotated by a sales rep, and a checkout form overwriting it unreviewed would be a
regression dressed as a feature. Matching links the order to the right account; keeping the CRM
record accurate stays a person's job.

### `createdBy` had to stop being unconditionally required, on two models

`Order.createdBy` and `Customer.createdBy` were both `required: true`, because every write path
that existed before this phase was a staff member acting through `protect`. A guest or a buyer
placing an order has no staff actor at all. `Order.createdBy` is now required unless
`source === 'storefront'`; `Customer.createdBy` is simply optional, since every staff-facing
write path has always supplied it regardless and nothing about loosening a requirement can break
a caller who was already meeting it.

### The idempotency key had to stop assuming `req.user`

`IdempotencyKey` scoped its unique index on `{ key, user }`, where `user` was a required `User`
ref — because until this phase every caller of the middleware was staff. Checkout needed the
same protection (a dropped response on a checkout button is the identical lost-connection
problem, for an audience with far less recourse than staff have: nobody to ring and ask "did my
order go through"), for three kinds of caller at once. The scope is now a plain string —
`user:<id>` / `buyer:<id>` / `guest:<ip>` — computed once and used for both the lookup and the
uniqueness constraint. `user` is kept as an optional field purely for debugging, the one case it
can still be resolved to a document. This is ephemeral, 24-hour-TTL bookkeeping with no
long-term meaning, which is why loosening its shape here carries none of the weight a change to
`Order` or `Customer` would.

### Checkout always starts an order `pending`, and never reads `status` from the client

A staff-placed order may legitimately arrive already `completed` — a phone sale being entered
after the fact. Nothing about a storefront checkout is ever after the fact: stock must not move
until staff actually fulfil it, so the field is not merely defaulted, it is never read from the
request body at all. Everything else about placing the order — pricing at time of purchase,
the atomic order-numbering counter, the transactional stock guarantee — is the unmodified
`placeOrder()` every other order in this app already goes through; `ORDER_POPULATE` is now
exported from `orderController.js` rather than staying file-private, so the checkout response
shares the exact same shape as every other order response instead of a second hand-written one.

### The cart stores a quantity, never a price

`Cart` holds `{ product, quantity }` and nothing else. Price is resolved fresh from the product
at both the cart-viewing endpoint and at checkout — a cart is not a quote, and freezing a price
into it would mean a product's price change silently applying to some carts and not others
depending on when they happened to be built.

### A buyer's cancel/edit request reuses the manager's queue completely, not a shadow of it

`POST /api/shop/orders/:id/request-cancel` and `/request-edit` call the exact same
`changeRequestService.submit`/`approve` a manager's customer edit or order-item edit already
goes through — `submit` now reads `actor.constructor.modelName` to set `requestedByModel`
(`'User'` vs `'Buyer'`, from phase 1) rather than trusting a caller-supplied flag, so it is
structurally impossible for a route to mislabel who is asking. Approving a buyer's cancellation
runs the identical transactional path (`applyChange`'s new `cancel` branch, mirroring the
`updateOrder` status transition's own restore-stock logic exactly rather than a copy of it), and
approving an edit re-prices at approval time through the same `buildOrderItems` call a manager's
edit already uses — proven with the same test shape as the existing manager-edit-repricing test:
raise the price between request and approval, confirm the *new* price is what gets charged.

Only ever proposed against a `pending` order, checked before the request is created — once
`completed` or `cancelled` there is nothing left to request, and the order detail screen (phase
9) will say so in place of the buttons rather than letting the request fail after the fact.

**28 new backend tests**: the public projection's absences (not just its presence — asserting
`sku`/`lowStockThreshold`/`stockQty` are genuinely gone, not merely unread by today's frontend),
cart add/merge/price-freshness, guest and buyer checkout including the customer-matching and
idempotency-replay cases, a buyer's order list correctly excluding a staff-placed order and a
colleague buyer's order (404, not 403 — a buyer has no more business learning an unrelated
order exists than a sales rep does with a colleague's), and the cancel/edit requests end to end
through real approval. Full suite re-run clean after the `IdempotencyKey` and `createdBy` schema
changes, both of which affect every existing order-creation and customer-creation test in the
app, not only the new ones.

**Final totals: 923 backend + 215 frontend + 11 end-to-end**, lint clean on both packages.

---

## Storefront, phase 4: opening the approval queue to buyer requests — and a real conflict with an existing design

`/api/change-requests` and its approve/reject actions now handle buyer-initiated cancel/edit
requests, and a buyer is emailed the outcome. The mechanics — restore stock on an approved
cancellation, re-price on an approved edit — needed no new code at all; phase 3's `applyChange`
`cancel` branch and the existing generic `update` branch already do both, and phase 3's tests
already proved it. What phase 4 actually had to resolve was **who is allowed to open the queue**,
and that turned out to conflict with a rule already on record.

### The brief assumed something the code did not do

The storefront brief says a buyer's request should be "visible to admin and to any manager
(not just one specific manager) alongside the existing manager-initiated requests" — phrasing
that assumes managers already see the queue generally. They do not: `changeRequestRoutes.js` is
admin-only, for a reason stated in its own comment — *"managers are who these requests come
from, and an approver who can approve their own request is not an approver."* Opening the whole
queue to managers would let a manager approve a colleague's customer edit, reversing a
deliberate design this same engagement put in place, for a reason that still holds.

**The two records disagree, and it is not obviously a mistake in either.** The buyer brief and
the existing access rule were written for different problems and neither one mentions the other.
Rather than guess which one the brief-writer would drop, the resolution keeps both true at once:
the gate on the route moved from `requireAdmin` to `requireManagerOrAdmin`, but
`changeRequestController.js` now filters and checks **per request** rather than per role — a
manager's `GET` returns only buyer-initiated rows (their own staff-initiated ones stay invisible
to them, unchanged), and an `approve`/`reject` call is checked against the specific request's
`requestedByModel` before anything else runs: a manager may decide a buyer's request, never a
colleague's. Recorded here explicitly because it is a genuine judgment call, not a small one —
anyone reviewing this later should see the conflict was noticed and resolved on purpose, with
the reasoning next to it, rather than assume the two documents simply agreed.

### The notification is symmetric with the existing account-request one

`notifyAdminsOfRequest` in `authController.js` already tells admins about a pending staff
sign-up, best-effort, outside the write it accompanies. `notifyBuyerOfOutcome` in
`changeRequestService.js` is the same shape the other direction: after approve or reject —
never inside the transaction, so a mail outage cannot roll back a change that already happened —
logged and swallowed on failure rather than surfacing to the person who just approved something.
A staff-initiated request generates no such email; the requester is already signed into the CRM
and can look the record up, and a manager whose edit was rejected does not need an inbox ping to
find out.

**6 new backend tests**: the queue answering a manager with a filtered, buyer-only list rather
than a blanket 403; approve and reject each checked in both directions (refused for a
staff-initiated request, allowed for a buyer's own); and the notification itself, captured via
the same `mailer.sendMail` monkey-patch `invite.test.js` already established, including the
negative case — no email at all for a staff-initiated decision. One existing test
(`is refused to a manager and a sales rep`) had pinned the now-superseded blanket rule and was
split into the rep-only 403 plus the new filtered-200 behaviour, rather than simply relaxed.

**Final totals: 929 backend + 215 frontend + 11 end-to-end**, lint clean on both packages.

---

## Storefront, phase 5: RBAC extension, and why most of the new actions aren't in the table

The brief asked for every new action — `viewStorefront`, `manageOwnCart`, `requestOrderChange`,
`approveBuyerRequest` — to go into the existing `usePermissions` table and its backend mirror,
with an explicit instruction not to build a second permission mechanism. Only one of those four
actually went in.

### The table is shaped like the staff role system, because it mirrors one

`usePermissions` resolves everything from `useAuth()` — the STAFF session — against three roles.
`viewStorefront`, `manageOwnCart` and `requestOrderChange` are not staff capabilities at all;
they describe what a BUYER or a guest may do, and a buyer is never `useAuth()`'s user. Forcing
them into this table would not just be pointless, it would be actively wrong: every one of them
would permanently evaluate to `false`, because `permissionsFor` returns `false` for anyone whose
`role` is not `admin`/`manager`/`sales_rep` — which describes every real buyer and every guest,
always. A permission entry that can never be true for the people it is about is worse than no
entry, because it looks like a working gate.

This is the same conflict Phase 4 hit, from the other side. There it was the brief's storefront
instructions assuming something the CRM's existing access rule did not do; here it is the
brief's RBAC instructions asking for buyer-facing gating inside a mechanism its OWN ground rule
1 says a buyer must never be checked against at all — *"structurally parallel to `protect`, but
never populated into or checked against the staff permission table."* Read literally, "add
every new action to the table" and "never check a buyer against that table" cannot both be
followed for a buyer-facing action. Resolved the same way Phase 4's conflict was: keep the
architectural rule (buyers stay off the staff table, full stop) and let the storefront's own,
much simpler gating do the buyer-facing work — "is a buyer signed in", asked of a `BuyerAuthContext`
built in phase 9, not a three-role matrix that would have exactly one real row (buyer) and one
permanently-false one (guest) for every entry.

**`approveBuyerRequest`, on the other hand, is a genuine staff action** — a manager or admin
deciding a request — and went into the table as its own entry rather than widening
`approveChanges`. The two ask different questions: `approveChanges` is "may this user decide a
*colleague's* request" (admin only, per the self-approval rule); this one is "may this user
decide a *buyer's*" (no colleague involved, so no such conflict — see phase 4's reasoning for
why the route itself opened to managers). A test locks in the distinction directly: a manager's
`can.approveBuyerRequest` is `true` while their `can.approveChanges` stays `false`.

### The audit script now runs a buyer through both sides of the boundary

`npm run audit-roles` adds a fourth actor to the existing internal-routes matrix — a buyer,
authenticated the identical way the three staff roles are (`Authorization: Bearer <token>`) —
and every single internal route answers `401`. Worth being precise about what that proves: not
`403`, because `protect` never gets far enough to make an access *decision* at all — a buyer
token's id does not resolve in the `User` collection, so the isolation is structural rather than
a role check that could be got wrong. A second, separate table then audits the storefront's own
routes with three callers (a guest, a buyer, and that buyer's colleague), proving cart and order
scoping the same way `otherRep` already proved it for staff — including the one row that checks
the reverse direction, a staff bearer token tried against a buyer-only cart route, which also
`401`s.

`ROLE_AUDIT.md` is updated with both new tables, plus a correction: `GET /api/change-requests`
for a manager was recorded as `403` before phase 4 and is now genuinely `200 (0)` — filtered
rather than refused — which is a real behaviour change from that phase, not new information
about an old one, and the audit document now says so.

**Deferred to phase 6:** confirming the ten AI features are gated through this same table where
they are staff-facing (a rep's drafted follow-up, a manager's team digest) at the point each one
is actually built, rather than adding speculative entries now for actions that do not exist yet.

**1 new frontend test.** No backend test changes — the audit script is a diagnostic tool run by
hand, not part of the suite, consistent with how it has been treated since Task 2.

**Final totals: 929 backend + 216 frontend + 11 end-to-end**, lint clean on both packages.

---

## Storefront, phase 6: ten AI features, and a live key almost got spent on the test suite

Every feature below follows the discipline this project has used since the first AI
feature: code computes every fact and decides every list; the model writes prose about
figures already correct, or makes one bounded, schema-validated choice from options code
already offered it — never a number, never which records appear. Each one reports
`mode: 'ai' | 'fallback'` and has a real, useful fallback rather than an error path.

### Where the data comes from, what the model may and may not return, per feature

1. **Guest NL product search** (`GET /api/shop/products/search`) — reuses
   `aiSearchService.translateQuery`, the same translator staff AI search uses, forced to
   the `product` entity. The model returns a filter; `filterTranslator.conditionsToMongo`
   (already exported, already used by `runFilter`) turns it into a query this file runs
   itself, through the storefront's own narrow projection rather than `runFilter`'s full
   documents. Fallback: a plain substring match on `name`.
2. **"You might also like"** — the list is entirely code: co-purchase counts from
   completed orders' line items, padded with same-category in-stock products when
   history is thin. The model writes one sentence explaining the list; it cannot name a
   product, because the response schema has no field a product name could go in.
   Fallback: a generic "frequently bought together" / "popular in `<category>`" line.
3. **Buyer order-status assistant** (`POST /api/shop/orders/ask`) — the model is handed a
   plain list of the SIGNED-IN buyer's own order facts (`Order.find({ buyerId })`, nothing
   else) and answers from those alone; it is not scoping the answer itself; the query is
   what scopes it. Fallback: a rule that matches an order number in the question, or
   states the most recent order's real status.
4. **Customer summary + storefront history** — `customerMetrics.js` now splits
   `orderCount` by `source`, and the prompt is told to mention it when non-zero. No new
   endpoint; the existing `/api/customers/:id/summary` figures are simply more complete
   now that a customer can order through two channels.
5. **AI-drafted follow-up** (`POST /api/customers/:id/draft-message`) — tone (`check-in` /
   `upsell` / `win-back`) is the one caller-chosen, schema-validated option; the model
   drafts subject and body from the customer's already-computed figures. Never sent —
   nothing in this feature has a mail transport wired to it at all; it is text for a rep
   to read, edit and send by hand. Fallback: a short, honest template per tone.
6. **Note-thread summarizer** (`GET /.../activity/summary`, customer AND order) — reuses
   `activityController.loadSubject`'s existing access rule verbatim, so a summary can
   never be read by someone who could not read the notes themselves. The model condenses
   what the notes already say; told explicitly not to add anything or recommend an
   action. Fallback: note count, span, and the most recent note verbatim.
7. **Weekly team digest** (`GET /api/dashboard/digest`) — this-week/last-week revenue and
   order counts, and a per-rep breakdown, all one pair of aggregations. The model narrates
   them and may name a clear leader; told not to rank reps when the numbers are close
   enough that ranking would mislead. Fallback: a templated sentence from the same figures.
8. **Inventory reorder suggestions** (`GET /api/products/reorder-suggestions`) — a product
   qualifies by two facts alone: at or below its own `lowStockThreshold`, AND actually sold
   in the last 30 days (a quiet low-stock item is not urgent). The model writes one
   justification per product ALREADY in that list, by position — a reply with the wrong
   number of justifications is rejected outright rather than zipped against the wrong
   product. Fallback: a one-line fact string per item (units sold, stock left, threshold).
9. **Team churn-risk roll-up** (`GET /api/customers/churn-rollup`) — reuses the EXISTING
   `assessChurnRisk` from the earlier churn-risk feature, run once per customer with a rep
   actively assigned, kept when it already rates moderate or high. The model writes one
   "call these people" paragraph from that list; cannot add a customer or change a level.
   Fallback: the flagged names and labels, concatenated.
10. **Change-request diff summary** (`GET /api/change-requests/:id/summary`) — reuses
    `auditService.diff()`, the SAME function the permanent audit trail runs at approval
    time, computed early as a preview. The model turns `{field, from, to}` triples into one
    sentence; fallback does the identical job as a plain field list.

### Two more places the "sales rep" categorisation didn't fit this CRM, resolved the same way as phase 5

The brief lists AI-drafted messages and note summaries as sales-rep features, for "an
assigned customer" — language that assumes a rep has customers. This CRM settled that
question long before this round: a rep has **zero** customer-book access, full stop, and
reopening it for one AI feature would undo that. Resolved by splitting on what a rep
genuinely reaches: **the message draft and the customer-notes summary are
manager/admin, mirroring `canAccessCustomer`** (draft-message, and the customer variant of
the note summarizer); **the order-notes summary is reachable by the assigned rep**,
because reps already read and write order notes — nothing new needed there, the rep-facing
half of feature 6 already worked the moment it reused `loadSubject`.

### A live key almost got spent on every run of this suite

Writing the tests assuming "no `GEMINI_API_KEY` in the test environment" — true of a fresh
checkout, false here: this deployment's `backend/.env` carries a real key for manual
testing, and `env.js` loads it regardless of `NODE_ENV`. The first run of
`aiFeatures.test.js` made real, billed Gemini calls on every "fallback" test and took 158
seconds; one recommendation response came back as genuine model prose ("Gear up for your
next outdoor adventure…"), which is what caught it — a hand-written fallback string would
never read like that. Fixed by stubbing `aiClient.isConfigured` to `false` for the whole
file, restored in `afterAll`, rather than relying on the key's absence. Worth flagging
plainly: **any future AI test in this repo has to do the same** — checking "does the test
env have a key" by reading `env.js` is not safe here, because this one does.

### `/api/internal/ai-status` now reports per feature, not only in aggregate

The deliverable was explicit: the new features' health has to be visible alongside the
existing two. `aiUsageService.getUsageSummary`'s `byFeature` breakdown already existed for
the cost dashboard but dropped failure counts; added a `failed` accumulator to that
aggregation and surfaced `recent.byFeature` on the status endpoint. The reason this
matters and is not cosmetic: the aggregate `recent.failed` can read as healthy while one
specific feature — most plausibly a newly-added one with the least real traffic — is
failing every call, and an admin reading only the aggregate has no way to see that.

**29 new backend tests**, covering every feature's fallback path for real (not by luck),
role gating per feature (a rep refused the two manager/admin-only ones, allowed the
order-notes summary and its own order-status assistant), the reorder validator's
exact-length rejection, and the change-request summary's manager/buyer split reusing
phase 4's `assertMayDecide`. Full suite re-run clean — **958 backend tests, in 118 seconds**,
confirming nothing in this phase is making a live network call by accident anymore.

## Storefront, phase 7: the buyer-facing pages, and a checkout race the tests caught

Everything the previous six phases built an API for finally got a screen. `BuyerAuthContext`
and `CartContext` sit above a new `ShopRoot` wrapper in `App.jsx`, scoped only to the
`/shop` subtree — the internal `AuthContext` never enters that tree and vice versa, the
same one-directional isolation the backend has kept since phase 2. Pages: `Home`,
`ProductGrid` (category filter + the phase-6 NL search), `ProductDetail` (add-to-cart,
recommendations), `BuyerLogin`/`BuyerRegister`, `Checkout` (guest form or saved-address
picker), `OrderConfirmation`, `BuyerOrders`, `BuyerOrderDetail` (pending-only cancel/edit
requests), `BuyerAccount` (address book). On the CRM side: `Approvals` now shows a
"Customer request" pill and falls back to the buyer's email instead of a blank role column
when `requestedByModel === 'Buyer'`; `Dashboard` gained a manager/admin-only
`ManagerInsights` section wrapping the digest, reorder-suggestions and churn-rollup cards
from phase 6, each on its own `useFetch` so one slow card never blocks the others.

**A backend gap found before any frontend code was written against it**: `Buyer.addresses`
existed and `Checkout` needed to read from it, but nothing let a buyer ever populate it —
there was no route. Added `addAddress`/`updateAddress`/`deleteAddress` to
`shopAuthController.js` and their routes before starting the UI, specifically to avoid
building a screen against a contract that didn't exist yet.

**Real bug, found and fixed by review rather than by a test that happened to catch it**: a
signed-in buyer's server cart loads from `CartContext`'s effect, which cannot run until
after the render that first sees `isSignedIn: true` has already committed — one frame where
`isSignedIn` is true and `items` is still `[]`. `Checkout`'s empty-cart guard fired on that
stale frame and permanently redirected a signed-in buyer with a full cart back to the
product grid. Fixed with React's documented "adjust state during render" pattern:
`CartContext` compares `isSignedIn` against its previous value during render and sets
`loading` true the instant it flips, so the very first render that sees the sign-in also
reports "still loading" — `Checkout` waits on that flag alongside its own auth-loading
check. The merge-once-per-sign-in effect itself was untouched.

**33 new frontend tests** (Field's `required` rendering, `CartContext`'s guest/buyer/merge
behaviour including the once-per-sign-in guarantee across re-renders, `BuyerAuthContext`'s
401-is-not-an-error handling, `Checkout`'s full guest and signed-in paths, `BuyerOrderDetail`'s
pending-only actions) plus an extended `ProtectedRoute` test for the multi-role
`/approvals` guard. **Frontend: 248/248 passing, lint clean, build succeeds.**

## Storefront, phase 8: end-to-end coverage for the whole buyer journey

Everything up to this point had been proven by mocked component tests or, on the backend,
Supertest against Express directly — nothing had driven a real browser through the real
`/api/shop/*` cookie and CSRF machinery the way `e2e/order-flow.spec.js` already does for
staff auth. Added `e2e/storefront.spec.js`: catalogue browse and search fallback, guest
cart survives a reload with zero network calls, guest checkout to a real confirmation page,
buyer registration and login, the address book, guest-cart-to-buyer-cart merge on sign-in
followed by checkout with a saved address, order history and detail, a buyer's cancel and
edit requests (including the second-request-refused-while-one-is-pending case), an admin
and a newly-seeded manager each deciding a buyer-originated request in `Approvals`, and —
the one assertion that matters most architecturally — that `shop_access`/`shop_refresh`
and `simplecrm_access`/`simplecrm_refresh` are distinct, both httpOnly, and one session in
a browser context is unaffected by the other.

**Real bug, found only because this was a real browser and not a mock**: registering or
logging in as a buyer landed on the empty order-history page instead of wherever the flow
should have sent them. `BuyerRegister`/`BuyerLogin` both guard `isSignedIn` with a redirect
to account/orders — correct for someone arriving already signed in — but `register()`/
`login()` flip `isSignedIn` true via context before the page's own post-submit `navigate()`
runs, and the guard's `<Navigate>` commits from an effect, so it can win the race and
overwrite the intended destination. Fixed identically in both files with a `justSubmitted`
ref, set synchronously at the start of the submit handler and checked by the guard, reset
to `false` on a failed submission so the guard still behaves correctly if the user is later
signed in some other way.

`backend/scripts/e2eServer.js` gained a seeded manager account (`Bilal Ahmed`) alongside the
existing admin — needed to exercise the phase-5 RBAC extension end to end, which had zero
prior E2E coverage. **Playwright: 29/29 passing** (11 existing staff-flow specs, unchanged,
plus 18 new). Backend and frontend suites re-confirmed clean throughout: **962/962 backend,
248/248 frontend** (the backend total moved from 958 to 962 between phases from ordinary
test additions, not a regression — confirmed by a clean serial `npm test` run).

## Storefront, phase 9: the storefront becomes the front door

Explicit correction from the person running this project: opening the app's root URL was
still landing on the staff login screen, indistinguishable from before any of this work
started, because the CRM's protected dashboard had owned `/` since before phase 1 and the
storefront had only ever been reachable at `/shop`. The instruction was direct — this is
now an e-commerce site with a CRM tucked on the side, not the other way round — so the two
route trees in `App.jsx` swapped places. The storefront (`ShopHome`, `ProductGrid`,
`ProductDetail`, `BuyerLogin`/`Register`, `Checkout`, order confirmation, and the whole
`/account/*` buyer tree) now sits at the root with no prefix; every CRM route, staff auth
included, moved under `/crm` (`/crm/login`, `/crm`, `/crm/customers`, …). `ShopLayout`
gained one small "CRM" link in its header — deliberately last in the row and styled as the
least prominent element there, since staff are a tiny fraction of that header's audience
and the link exists only so they have a way in. `ProtectedRoute`, `Login`, and
`DashboardLayout` were updated to redirect to and from `/crm/*` instead of the old bare
paths, and every internal `Link`/`navigate()` across both the CRM and storefront pages was
swept to match — 40-odd call sites across roughly thirty files, found by grepping for every
`to="/`, `` to={`/ ``, and `navigate('/` / `` navigate(`/ `` in the tree rather than trusting
memory of which files touch routing.

**Guest checkout was turned off, deliberately not removed.** The instruction was explicit:
a guest can add to cart, but buying requires a buyer account. `Checkout.jsx` now checks
`isSignedIn` before rendering anything and redirects an unauthenticated visitor to
`/login` with `state.from: '/checkout'`, so signing in returns them straight back — the
guest form and its client-side validator were deleted outright rather than left dead in the
file. The backend endpoint (`shopCheckoutController` + `attachBuyerIfPresent`) and its 28
existing tests were left exactly as they were: a documented, deliberate choice to restrict
the *product's* checkout flow at the one layer that actually defines the user's experience,
without discarding a working, tested, already-secure capability nobody asked to have
deleted from the API.

**AI features moved to where their subject lives, per explicit instruction** ("features
associated to customers should be in customers tab and product tab"). `Dashboard`'s
`ManagerInsights` — added only in phase 7 — is gone; it held three cards, and two of them
were never dashboard content in the first place. `ReorderCard` moved to `ProductList`
(`ReorderSuggestionsCard`, gated on `can.viewAllRecords` since a sales rep can read products
but not this call). `ChurnCard` moved to `CustomerList` (`ChurnRollupCard`, no extra gate
needed — reaching that page at all already requires the same `[ADMIN, MANAGER]` the backend
requires for churn-rollup). Only `DigestCard` stayed on `Dashboard`, because a team-wide
weekly digest genuinely is dashboard content and nothing else. Two features that existed on
the backend since phase 6 but had **never been wired to any UI at all** were added now, not
before: `DraftMessageCard` on `CustomerDetail` (tone selector, on-demand — never
auto-fetched, since every draft is a fresh paid model call) using the existing
`customersApi.draftMessage`, and an on-demand "Summarize this thread" button added directly
to the shared `ActivityTimeline` component, which means it appears on both `CustomerDetail`
and `OrderDetail` for free. `Approvals` gained a per-row "AI summary" button using
`changeRequestsApi.summary`, needing no extra role gate since the list endpoint already
filters each viewer to requests they're allowed to decide.

**A class of bug the routing swap would otherwise have shipped silently**: every backend
email that links back into the app — invite links, password-reset links, the
account-request notification an admin gets, the "your account is ready" notification an
applicant gets — built its link with the OLD bare path (`/accept-invite`, `/reset-password`,
`/users`, `/login`). None of those pages exist at those paths anymore; a real user clicking
any of these emails would have landed on the storefront home with no error and no idea why.
Found by grepping the backend for every `publicUrl(` call rather than waiting for someone to
report a broken email, and fixed in `inviteService.js`, `passwordResetService.js`,
`authController.js`, and `userController.js` — all four now build `/crm/...` links. Two
backend test assertions had the old path hard-coded into an anchored regex/substring
(`publicUrl.test.js`'s invite-link format check, `passwordReset.test.js`'s reset-link
substring) and were updated to match; every other existing assertion on these links used an
unanchored pattern and needed no change.

**What broke and was fixed to match, not weakened to pass**: 5 frontend test files and both
Playwright specs encoded the old route shape or the old guest-checkout behaviour directly.
`ProtectedRoute.test.jsx`'s own mini route table declared `/login`/`/` instead of
`/crm/login`/`/crm`. `Login.test.jsx`, `PasswordReset.test.jsx`, and
`BuyerOrderDetail.test.jsx` asserted stale `href`/redirect targets. `Checkout.test.jsx`'s
entire `as a guest` block (4 tests) tested a form that no longer exists — replaced with one
test asserting the new sign-in redirect and the `state.from` round-trip, following the same
`<Navigate>`-assertion pattern already used by `BuyerOrderDetail.test.jsx`; the empty-cart
test was rewritten for a signed-in buyer, since an unauthenticated visitor now never reaches
that branch at all. Both E2E specs got the same prefix swap, plus `storefront.spec.js`'s own
guest-checkout scenario was rewritten to assert the sign-in redirect instead of a completed
guest order, with the guest's cart confirmed still intact in `localStorage` across the
round trip.

**Final totals: 962 backend + 245 frontend (245, not 248 — three tests removed were the
guest-checkout-form assertions for behaviour that was deliberately deleted, not weakened)
+ 29 end-to-end, all clean. Lint and production build clean on both packages.**

**Final totals: 958 backend + 216 frontend + 11 end-to-end**, lint clean on both packages.

## Round 2, phase 10: a QA pass, and two bugs that only a real catalogue could surface

A written fix-list from the person running the project, after a QA review of everything
above. Six sections, most of them corrections rather than new features — the interesting
part of this entry is the two defects found while *verifying* the work, neither of which
any existing test would ever have caught.

**The internal AI search became admin-only, at the route and not just in the UI.** It had
been open to every authenticated role since it was built, on the reasoning recorded in
`aiSearchRoutes.js` that the controller's `customerScopeFilter`/`orderScopeFilter` narrowed
whatever the model asked for. That reasoning was half right and the wrong half mattered: a
scope filter returns *nothing* for a sales rep, which is safe, but returns *everything* for
a manager — so a manager could phrase their way to the entire customer book through a
search box, while `customerRoutes.js` took care to keep them read-only on the same
collection. `requireAdmin` now runs before any Gemini call is made, which is both cheaper
(a 403 costs nothing; a scoped-to-empty search still spends a paid request) and impossible
to loosen by accident later, since it no longer depends on a scope helper staying strict.
Mirrored in `usePermissions` as a new `internalAiSearch` action — named for the action, not
the role, per that file's own rule — and `Dashboard` now renders `<AiSearchBar />` only
behind it. Four tests in `aiSearch.test.js` asserted the *old* rule (a rep gets an empty
200, a manager gets the whole answer); they were rewritten to assert 403 on both the AI and
the fallback paths, because a test that still passes after a security rule inverts is a test
that was checking the wrong thing. `aiClient.test.js`'s outage test also had to switch its
actor from manager to admin — it exists to prove an AI outage degrades to a 200, and left
alone it would have started failing on a 403 it was never about.

**Three dashboards that are actually different screens.** This was a known gap flagged in
the original build log and never properly closed — all three roles got one layout with
different numbers in it, which is how a sales rep ended up looking at a "Customers: 0" tile.
Zero is the correct figure (a rep has no customer book) and a false-sounding statement about
the business, which is the precise failure mode of filtering a layout instead of choosing
one. `Dashboard.jsx` is now three components behind a role switch, and the split is
enforced server-side: `roleExtras()` in `dashboardController` computes the approval queue
and unassigned-order count for admin and manager, the user/account figures for admin alone,
and for a rep only their own pending orders. Nothing a role cannot act on is *sent* to them,
so nothing has to be hidden — a rep is not one devtools tab away from company revenue. The
rep dashboard is deliberately not a tile grid at all but a work queue: their pending orders,
oldest first, each linking to where they can move it. The one company-wide figure it keeps
is low stock, because that blocks their own fulfilment work. `dashboard.test.js` asserts on
what is *absent* per role as much as what is present, since "structurally different" is only
true if the payloads differ.

**A caveat on what "team-scoped" currently means.** The brief asks for a manager to see
their team's figures. There is no manager-to-rep relationship anywhere in the data model —
no `managerId` on `User`, no team collection — and `hasFullRecordAccess` treats admin and
manager identically, so a manager has always seen the whole book. Inventing that hierarchy
was well outside a fix-list, so "team" here means all operational data, and a manager is
differentiated from an admin by what is *removed* (user management, account figures,
org-wide framing) rather than by a narrower query. Recorded rather than glossed over,
because the difference matters the moment a second sales team exists.

**Two new AI features, 11 and 12, both admin-only.** A staff activity digest on the Users
page (`staffActivityDigestService`) and an audit digest on the Audit Logs page
(`auditDigestService`). Both follow the discipline every other feature here follows —
MongoDB counts, the model narrates, no numeric field in either response schema, both
degrade to a templated narrative. Two decisions worth recording. The activity digest reports
records *changed*, from the audit trail, and its prompt explicitly forbids the model from
saying anyone has or has not logged in: the app records writes and never records a bare
session, so "hasn't signed in" is a claim this data cannot support, and a model asked to
narrate "activity" will reach for it unless told not to. And the audit digest takes the
screen's *current filters* — `buildAuditFilter` was extracted from `listAuditLogs` so both
share one definition — because an audit log is only ever read through a filter, and a
summary computed over a different set than the table beneath it would look authoritative
while contradicting what the reader can see.

**Product images, with the required-ness in the right place.** `imageUrl` and `description`
already existed on the `Product` model and on both storefront surfaces; the gap was that
`ProductForm` never offered either, so nothing could set them. Both added, `imageUrl`
required. Required *in the create controller*, deliberately not on the schema: a
schema-level `required` would fail validation the next time anyone edited an older product
for an unrelated reason — a restock, a price change — which is a rule about new products
reaching back to break old data. `product.test.js` asserts exactly that: 400 on a create
with no image, 200 on a `stockQty` edit of an existing image-less product. For those older
products the storefront now renders a generated placeholder (`placeholderImage` in `ui.js`)
— an inline SVG data URI with the product's initials and category on a hashed-but-stable
background colour, so it needs no network request, never 404s, and reads as "no photo yet"
rather than as a wrong photo. The seed script now populates images and descriptions for all
ten demo products, so the catalogue looks populated out of the box rather than being a wall
of placeholders.

**Buy now, and the details a purchase actually needs.** There was no "Buy now" control
anywhere — the closest path was add-to-cart, find the drawer, click checkout. Added to
`ProductDetail`, and it routes an unsigned visitor to `/login` carrying
`state.from: '/checkout'`, so they land back on checkout rather than the shop home.
`BuyerRegister` had never read `state.from` at all (only `BuyerLogin` did), so a visitor who
chose "create an account" instead of "sign in" lost their destination — fixed, and both
pages now pass `state` through the link between them so the round trip survives switching
between the two. Checkout also collects a payment method (`PAYMENT_METHOD` in
`config/constants`, stored on `Order`, shown on the staff order detail) and addresses gained
a required `city`. Both are optional on their schemas and required at their controllers, the
same reasoning as `imageUrl`: an order placed before either existed is still a valid order.
A "Back to store" link was added to the CRM sidebar and mobile header, mirroring the small
"CRM" link `ShopLayout` already offered in the other direction — the CRM had been a
one-way door since the routing swap.

**Hints and required markers** were applied through the existing shared `Field` component on
every form named in the brief. One deliberate deviation: the brief lists customer *phone* as
required, and it is not marked required here — `Customer.phone` is optional on the model and
several existing tests create customers without one, so marking it required in the UI alone
would have produced a form that refuses input the API accepts. It carries the hint
explaining when it is needed instead.

### The two bugs, both found by verification rather than by a test

Neither would ever have failed a unit test, because both are cases where the code did
exactly what its tests asked and the tests asked for the wrong thing.

**The storefront's fallback search could not find its own products.** Running all twelve
features against a realistic seeded catalogue — rather than against fixtures whose product
names happen to contain the search words — the very first one returned *zero results* for
"something waterproof under $50", with a $45 waterproof rain jacket sitting in the
catalogue. Two causes, both in the fallback path. It split the query on whitespace and kept
every word of two characters or more, so it searched for the literal words "something" and
"under"; and it matched on `name` alone. A shopper describes what a thing *is*, not what it
is *called* — "waterproof" was in the description, "outdoor" was the category, and neither
was in the name. The existing test passed because it searched for "rain jacket" against a
product named "Rain Jacket". Fixed by reusing `tokenize` from `filterTranslator` — the
internal search's own stop-word-aware splitter, which is why it lives in a shared module —
and matching name, description and category, all three of which were already in
`PUBLIC_PRODUCT_FIELDS` and rendered on the product page, so nothing new is exposed. The
endpoint now also returns the terms it actually searched for, and the storefront shows them,
for the same reason the internal search bar already did: the difference between "no results"
and "no results *for this*".

**A test that passed for the wrong reason.** The new audit-digest filter test seeded its
"unfiltered" case with `createCustomer()`, a helper that writes straight through the Mongoose
model — which records no audit entry at all. So the trail held only the product, the
filtered and unfiltered totals were both 1, and the assertion that one exceeds the other
failed. The fix was the test's, not the code's: both writes now go through the API, which is
the only thing that produces a trail. Worth recording because the failure mode is the
inverse of the usual one — had the numbers happened to differ for any other reason, this
would have passed while testing nothing.

**The storefront lied about what it was showing, for the length of every search.** Found by
the end-to-end suite, and worth the entry on its own because the test failed the way a
*user* would have been misled. `useFetch` keeps the previous response in `data` while the
next request is in flight — correct, and what stops the grid flashing empty between pages.
But the previous response on this screen is the plain product LIST, and a list response has
no `mode` field at all. The status line only asked whether `mode === 'ai'`, so for any
response without one it fell to the else branch and rendered `Showing keyword matches for
"Widget"` — a confident, specific claim — directly above the stale, unfiltered catalogue,
for as long as the search took. The Playwright snapshot caught it exactly: the status line
and a `Loading` spinner and the *unfiltered* results, all on screen together. Fixed by
gating the block on `!loading && data?.mode` — the `mode` check is what distinguishes a
search response from a list one, and neither guard is redundant — and by holding the results
grid and the empty state back while loading too, since "No products found" over a
half-finished request is the same lie in the other direction.

### On proving both AI modes — and the third bug, which was the worst of them

Section A asked for live proof of both modes for all twelve features, and the verification
was done with a throwaway harness that seeds a real in-memory database and calls each of
the twelve services directly, reporting the `mode` each came back with.

The fallback mode is proven for all twelve, and more convincingly than a mocked failure
would have been: the first run hit a real `429 RESOURCE_EXHAUSTED` from the live API — the
free tier's 20-requests-per-day cap, already spent — so every one of the twelve degraded
under a genuine upstream failure rather than a stubbed one, and every one produced correct,
data-grounded output. That is precisely the scenario the fallbacks exist for, arrived at by
accident and worth more than the test that was planned.

The live run is what found the third and most serious bug of this round.

**Every AI feature had been silently serving its fallback under the configured model.** On
the first live pass, three features came back `fallback` with *no upstream failure in the
log to explain it* — the AI request was logged `outcome: ok`, with a token count, and the
feature served a template anyway. The cause is `THINKING_ALLOWANCE_TOKENS` in `aiClient.js`.
Gemini bills thinking against `maxOutputTokens`, so that constant exists to add head-room on
top of whatever a caller asks for; it was set to 256, measured honestly at the time against
a model generation that barely thought (68-109 thought tokens for a one-word reply, per the
comment that was there). Current Gemini 3-class models are not that. Measured again with a
real feature prompt, `thoughtsTokenCount` came back at **529-640** for a two-to-four-sentence
answer whose actual text was about 55 tokens. A service asking for 500 therefore had a true
budget of 756, thinking consumed 640 of it, and the JSON was cut off mid-string — reliably,
for any feature whose prompt made the model think even slightly harder than average.

The failure mode is the reason this survived a full green test suite. A truncated reply is
not an error at any layer: the HTTP call succeeds, `aiUsageService` records a normal
successful request, `parseAndValidate` does exactly its job and rejects unparseable JSON,
and the caller does exactly its job and degrades. Every one of those components behaved
correctly and the observable result was a product where the AI never worked. No mocked-
failure test can catch it, because a mocked failure *is* the thing being tested — the bug
lives precisely in the case where nothing fails. Raised to 1024, which covers the measured
640 with room for a longer prompt, and is still spent only if the model actually uses it, so
it costs nothing on a model that thinks less. Recorded at length because the lesson is not
about a number: a fallback that fires when nothing is broken is indistinguishable, from the
inside, from a fallback that is working as designed.

### Exactly what was and was not proven live, and what is left

Being precise about this, because "12/12 verified in both modes" would be a nicer sentence
than the true one.

**Fallback mode: all twelve, under a real upstream failure** (the 429 described above), each
producing correct data-grounded output.

**Live AI mode: nine of twelve confirmed** — the storefront search, recommendations, order
assistant, customer summary, note summariser, team digest, reorder suggestions,
change-request summary, and the new audit digest all returned `mode: 'ai'` with sensible
prose over real seeded data. Of the remaining three, the churn roll-up is *correct* to fall
back: `getRollup` short-circuits when the risk list is empty rather than paying for a model
call to narrate nothing. The other two — the draft-message and the new staff activity digest
— are the truncation bug, diagnosed directly rather than inferred: the same prompt at a
756-token budget came back cut off mid-string, and at 1456 came back as complete valid JSON.

**What is not yet re-verified end to end**: the two truncation cases after the allowance was
raised. Both free-tier daily quotas (the configured `gemini-3.6-flash` and the
`gemini-3.5-flash` used as a second source) were exhausted by this verification work itself,
and a later run degraded to 2/12 purely on `RESOURCE_EXHAUSTED` — confirmed by grepping the
run for outcomes, not assumed. The mechanism behind the fix is proven by direct token
measurement; the end-to-end re-run needs a quota reset or a paid key, and should be the
first thing done next.
