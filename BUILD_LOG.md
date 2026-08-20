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
