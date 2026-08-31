# Security headers

Reference for the `headers` block in [`vercel.json`](vercel.json).

This lives in its own file because **`vercel.json` cannot carry comments**. JSON has no
comment syntax, and Vercel's schema validation rejects any property it does not recognise —
including the `"//"` key that is sometimes used as a workaround. A deploy fails with:

```
The 'vercel.json' schema validation failed with the following message:
'headers[0]' should NOT have additional property '//'
```

So the config stays minimal and the reasoning lives here.

---

## Why these headers are set in `vercel.json` and not in helmet

This is the part that is easy to get silently wrong.

The app deploys as **two separate Vercel services**: the Express API and the static
frontend. A header set by Express therefore only ever lands on a **JSON response** — it
never reaches the HTML document the browser is actually executing scripts in.

Configuring a strict Content-Security-Policy in helmet and assuming the SPA is protected is
a complete no-op, and nothing warns you about it.

So both halves exist and each points at the other:

| where | covers | defined in |
| --- | --- | --- |
| **helmet** | API responses (JSON) | `backend/src/app.js` |
| **`vercel.json`** | the frontend document (HTML) | this file's subject |

The API policy is deliberately far stricter — `default-src 'none'` — because a JSON
endpoint has no legitimate reason to load a script, embed a frame, or be framed.

---

## The CSP, directive by directive

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: https:;
connect-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none'
```

| directive | why |
| --- | --- |
| `default-src 'self'` | Nothing loads from anywhere but our own origin unless a more specific directive below allows it. |
| `script-src 'self'` | **The directive that actually stops XSS.** No inline scripts, no CDNs — an injected `<script>` has no valid source, so the browser refuses to run it. |
| `style-src … 'unsafe-inline'` | A real, deliberate weakening — see below. |
| `font-src` / `style-src` Google | The app loads IBM Plex Sans from Google Fonts; these two hosts are exactly what that needs. |
| `img-src 'self' data: https:` | `data:` covers the inline SVG icons and the generated "no photo yet" product tiles. `https:` is needed because a product photo is a URL an operator types into the CRM and lives on somebody else's host — the previous `'self' data:` blocked every product image on the deployed site while working locally, where no CSP is served. An image URL cannot execute; the residual risk is a broken picture or a tracking pixel from a host an admin pasted. |
| `connect-src 'self'` | XHR and `fetch` may only reach our own API. Even a script that somehow ran could not exfiltrate data to an attacker's server. |
| `frame-ancestors 'none'` | Nobody may put the app in a frame — clickjacking. |
| `base-uri 'self'` | Stops an injected `<base>` tag repointing every relative URL on the page. |
| `form-action 'self'` | A form cannot be repointed to submit somewhere else. |
| `object-src 'none'` | No Flash or applet embeds, a legacy XSS vector with no modern use. |

### The one deliberate weakening: `'unsafe-inline'` in `style-src`

Recharts — the dashboard charting library — sets **style attributes at runtime**, and CSP
counts those as inline styles. Removing `'unsafe-inline'` would require a nonce on every
element the library generates, which a third-party chart library does not offer.

It is worth being precise about what this costs, because "unsafe" in the name makes it sound
worse than it is here:

- Inline **style** at worst allows defacement — restyling the page.
- Inline **script** allows code execution, and that stays blocked by `script-src 'self'`.

Combined with `connect-src 'self'`, even a successful style injection has nowhere to send
anything.

---

## The other headers

| header | why |
| --- | --- |
| `X-Content-Type-Options: nosniff` | Stops the browser second-guessing a `Content-Type` and executing something we served as data. |
| `X-Frame-Options: DENY` | Belt-and-braces clickjacking protection for older browsers that ignore `frame-ancestors`. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Record ids live in our URLs (`/customers/652f…`). A full `Referer` would leak them to any third-party site a user clicks through to. |
| `Strict-Transport-Security` | HTTPS for a year, so a later plain-HTTP request is upgraded before it leaves the machine and cannot be intercepted. |
| `Permissions-Policy` | Denies camera, microphone, geolocation, payment and USB — features the app never uses, so an injected script cannot ask for them either. |

---

## If you change `vercel.json`

Validate it before pushing. The schema allows only recognised keys, and a `"//"` comment key
will fail the deploy:

```bash
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('valid JSON')"
npx vercel build --prod   # optional: full local schema check
```

Header rule objects accept `source`, `headers`, and optionally `has` / `missing`. Each entry
in `headers` accepts `key` and `value`. Nothing else.
