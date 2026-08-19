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
