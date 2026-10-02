# AdPilot

An ad network that monetises the dead time while a frontier model is thinking.

A browser extension notices that ChatGPT, Claude, Gemini, Perplexity (or a local
LLM UI) has started generating, shows one small sponsored card for those few
seconds, and credits the person watching. Advertisers prepay, target by country →
state → city → area, and see aggregate performance. The platform operator sees
everything.

Three roles, one console:

| Portal | Sign in at | How they sign in | Can see |
|---|---|---|---|
| **Platform console** | `/login/admin` | Google or password, **TOTP mandatory** | Every vendor, every earner, every dollar, platform health |
| **Advertiser** | `/login/vendor` | Google or password, self-serve signup | Own campaigns and spend, aggregated geography — never an earner's identity |
| **Earner** | `/login/user` | **Google only** | Own earnings, devices, withdrawals, ad on/off and blocked categories |

Each portal refuses the wrong kind of account: vendor credentials at `/login/admin`
are rejected before the password is even checked.

---

## Security model

| Concern | How it is handled |
|---|---|
| **Sessions** | Opaque token in an **httpOnly, SameSite=Lax** cookie. Only its SHA-256 is stored, so a database leak cannot be replayed. Nothing lives in `localStorage`. |
| **CSRF** | Double-submit: a readable `adpilot_csrf` cookie echoed back in `x-csrf-token` on every write. Cookies ride along cross-site; a custom header does not. |
| **Second factor** | TOTP (RFC 6238, SHA-1/6/30s) implemented against `node:crypto`. Mandatory for console accounts — `requireAuth` refuses a super admin whose TOTP is not enrolled, so the only reachable route is enrolment. Eight single-use recovery codes. |
| **Authorisation** | Every panel route carries a `requirePermission(section, action)` guard. The panel hides what you cannot open; the API refuses it regardless. |
| **Rate limits** | Global 1500/15min, login 10/15min (failures only), MFA 8/15min, signup 15/hr, payments 20/min, ad serving 60/min, pairing 10/min. Counters live in Redis so the limit holds across every instance; authenticated requests key on user id, not IP. |
| **Password recovery** | Emailed single-use token, one hour, and the response is identical whether or not the address exists so the endpoint cannot enumerate customers. A reset revokes every other session. |
| **Invalid traffic** | Serves and clicks are scored on velocity, dwell, shared-IP device counts, impossible click timing and device-key/UA drift. Past the flag threshold an event is **held unbilled** — the vendor is not charged and the earner is not paid. Past the block threshold the device stops being served. Scores decay hourly. |
| **Creative destinations** | Checked on every save and re-scanned hourly: scheme, embedded credentials, private/loopback hosts, bare IPs, link shorteners, an admin blocklist, and Google Safe Browsing when a key is set. |
| **Webhooks** | Mounted before the JSON parser and verified by HMAC over the exact raw body. |
| **Extension** | Per-device key in its own header — never a session. A stolen panel session cannot mint impressions; a stolen device key cannot open a dashboard. |

### Team permissions

Both panels share one model. A grant is `section:action` over
`read` / `create` / `update` / `delete`:

- **Owner** — the signing-up user. Every permission, cannot be edited or removed.
- **Administrator** — every permission in that panel.
- **Custom** — exactly the boxes ticked in the permission grid.

Two rules the server enforces, not just the UI: a member can never grant a
permission they do not hold themselves, and suspending or removing someone
revokes their live sessions immediately.

Console users can only be created from inside the console — there is no public
signup for `/login/admin`. Vendors self-onboard with their business details and
land as `PENDING` until a super admin approves them.

## Quick start

Needs PostgreSQL and Redis. On macOS:

```bash
brew services start postgresql@16 redis
createdb adpilot
```

```bash
cd adpilot
npm install          # installs server + panel workspaces
npm run db:setup     # applies the schema and seeds 30 days of demo data
npm run dev          # API on :4000, console on :5173
```

Redis is optional in development — without `REDIS_URL` the server falls back to
per-process state and warns at startup. It is required in production, because
rate limits and scheduled jobs are wrong when each instance keeps its own copy.

Open <http://localhost:5173>. Every demo account uses the password `Passw0rd!23`:

| Role | Email |
|---|---|
| Super admin | `admin@adpilot.io` |
| Vendor | `ads@vectordb.io` · `growth@brewbeans.in` · `marketing@finlypay.com` · `hello@skillforge.dev` |
| End user | `aarav@example.com` · `diya@example.com` · `kabir@example.com` · … |

The login screen has one-click buttons for the three main accounts.

### Install the extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick `adpilot/extension`
3. Sign in as an end user → **Devices** → **Pair a device** → copy the 8-character code
4. Click the AdPilot icon in Chrome → paste the code → **Pair device**

Then open ChatGPT/Claude/Gemini and ask something slow. The card appears while the
model is generating. The extension popup has a **Show a test ad** button that runs
the whole serve → view → click loop on demand.

---

## How the money works

Everything is stored as integer **micro-USD** (1 USD = 1,000,000 micros), so no
floating-point drift ever reaches a balance.

```
vendor wallet ──(impression or click)──▶ end-user wallet   (60% by default)
                                     └─▶ platform revenue  (the remainder)
```

- A vendor **prepays** into a wallet, by card/UPI/net-banking through **Razorpay**
  or by bank transfer. Card payments credit automatically: Checkout returns a
  signed result, the panel verifies it for an instant confirmation, and the
  `payment.captured` webhook is the source of truth. Both paths are idempotent —
  `gatewayOrderId` is unique and the wallet only moves while the row is `PENDING`.
- Withdrawals are **manual by default**: a super admin approves and releases each
  one. Switch on `auto_payout_enabled` in Admin → Settings and a sweep runs every
  five minutes, paying through **RazorpayX** when configured and otherwise
  auto-approving and leaving the transfer to a human. Guard rails: a minimum
  threshold, a per-payout ceiling above which a human must sign off, and a skip
  for any account that is not active.
- An impression is **served** unbilled. It is only charged when the extension
  confirms the card was genuinely on screen for more than 1.2 seconds. Shorter
  views are voided: they cost the vendor nothing and pay the end user nothing.
- Unconfirmed impressions expire after five minutes via a background sweeper, so
  the funnel never shows phantom revenue.
- A click bills the CPC on top and credits the same split.
- Every balance change writes an append-only `LedgerEntry`. The admin ledger page
  reconciles: *gross spend = end-user payouts + platform revenue.*
- End users withdraw above a configurable minimum. The amount is locked while the
  request is open and debited only when the operator marks it paid.

The revenue share, bid floors, minimum withdrawal and delivery pacing are all live
settings in **Admin → Settings**; they take effect within 15 seconds without a restart.

### Who controls what

Delivery pacing is **platform policy, not a user preference**. A super admin sets
`max_ads_per_hour` and `min_seconds_between_ads` for everyone in **Admin → Settings**,
and can override them for a single account from that end user's page under
**End users → Delivery pacing**. `Publisher.maxAdsPerHour` and
`Publisher.minSecondsBetweenAds` are nullable: null means "inherit the platform
policy", and the ad server resolves `override ?? policy` on every request.

End users control only what is genuinely theirs: whether ads run at all, which
categories to block, their display name and payout details. `PATCH /api/me/settings`
does not accept pacing fields, so the limits cannot be raised by a crafted request —
not just hidden in the UI.

## Operations

| Concern | How it is handled |
|---|---|
| **Database** | PostgreSQL, pooled. Money is `BigInt` micro-USD; enum-like columns are strings so a new status needs no migration. |
| **Scheduled work** | Every instance runs the same timers, so each job takes a database lease first (`JobLock`). Without it two workers sweep payouts together and can both initiate the same transfer — the ledger would catch the second write, but the money would already have gone. Payouts take a second per-row claim inside the lock. |
| **Ad-serving hot path** | Daily pacing reads a counter maintained at charge time rather than aggregating per candidate; frequency and hourly caps read Redis; the eligible-campaign set is memoised for ten seconds and invalidated whenever a campaign changes. A warm serve is a handful of queries, not two per competing campaign. |
| **Observability** | Structured JSON logs with secrets redacted and a request id on every response; `GET /metrics` exposes Prometheus counters and latency quantiles; `ERROR_DSN` is the seam for an error reporter. |
| **Reporting** | Buckets by the viewer's IANA timezone, passed from the browser — an advertiser in `Asia/Kolkata` sees their own days, not UTC ones. |
| **Retention** | Location detail ages out of impressions after 400 days. Erasure detaches delivery history from the person and keeps the financial record. |

### Tests

```bash
npm -w server test          # 52 unit + integration tests
npm -w server run test:payments   # the payment flow, end to end
```

Unit tests cover the revenue split (never loses a micro, remainder goes to the
platform), TOTP against an independently derived code, geo matching and
specificity, the permission algebra, timezone bucketing, tax arithmetic, the URL
checks and the rate-limit store. Integration tests run the real app on the real
database and cover portal isolation, the 2FA gate, CSRF, cross-vendor access,
per-section permissions, the data export, the lock (asserting maximum concurrency
of exactly one), and that the books balance.

CI runs all of it against Postgres and Redis services, plus the payment flow
against the gateway stand-in — see `.github/workflows/ci.yml`.

## Testing payments without a Razorpay account

Razorpay test keys are issued per account, so the repo ships with a local
stand-in instead. It speaks the same protocol — the same Orders and Payments
shapes, the same `order_id|payment_id` checkout HMAC, the same raw-body webhook
HMAC — so the application code under test is exactly the code that will run
against production Razorpay. Only the host changes.

```bash
npm -w server run mock:razorpay    # terminal 1 — stand-in gateway on :4100
npm run dev                        # terminal 2 — API + panel
npm -w server run test:payments    # terminal 3 — the flow, end to end
```

`server/.env` already points at the mock. The suite covers:

| # | Case | Asserts |
|---|---|---|
| 1 | Card paid, verified at checkout | order created, signature accepted, wallet credited, journal entry written |
| 2 | Forged checkout signature | rejected, no money moves |
| 3 | Webhook capture with no callback | wallet credited by the webhook alone |
| 4 | Webhook replayed three times | idempotent — one credit, one journal entry |
| 5 | Forged webhook signature | 400, no money moves |
| 6 | Declined card | recharge `FAILED`, no money moves |
| 7 | Member without `wallet:create` | 403 before any order is created |
| 8 | Whole book | ad spend still equals earner payouts + platform margin |

**Switching to your own keys.** In `server/.env`, replace the four mock lines
with your test keys from [dashboard.razorpay.com/app/keys](https://dashboard.razorpay.com/app/keys)
and delete `RAZORPAY_API_BASE`:

```env
RAZORPAY_KEY_ID="rzp_test_xxxxxxxxxxxx"
RAZORPAY_KEY_SECRET="your_test_secret"
RAZORPAY_WEBHOOK_SECRET="your_webhook_secret"
```

Then add a webhook in the Razorpay dashboard pointing at
`POST /api/webhooks/razorpay`, subscribed to `payment.captured` and
`payment.failed`. Locally, expose it with `ngrok http 4000` (or similar) and use
that public URL. No application code changes.

The one thing the mock cannot stand in for is Razorpay's own Checkout modal,
which loads from their CDN and validates the key against their servers — that
needs real test keys. Everything on the server side is covered above.

`env.ts` refuses to boot in production unless `RAZORPAY_API_BASE` is the real
host, so a mock can never credit a live wallet.

## How an ad is chosen

When the extension reports that a model started thinking:

1. **Gate** — global kill switch, the user's own opt-out, and the delivery pacing
   (minimum gap between ads, maximum ads per hour).
2. **Filter** — campaigns that are active, in flight, inside their daily budget and
   total budget, whose vendor is active with a positive balance, that pass the geo
   rules, that fit the dayparting window, that are under the per-user frequency cap,
   and whose category the user has not blocked.
3. **Rank** — by effective CPM (CPM bid plus expected click revenue from a smoothed
   CTR), boosted by geo specificity — an area-level rule outbids a worldwide one —
   and by campaign priority.
4. **Rotate** — pick randomly, weighted by score, from the strongest four, then pick
   a creative by weight while avoiding the one just shown. That is what makes a
   *different* ad appear each time the model thinks again.
5. **Sign** — the impression row is created and handed to the client with an HMAC
   token. The client cannot mint impressions, replay them, or alter the price.

Geo rules are evaluated most-specific-first with `*` as a wildcard at each level,
and an `EXCLUDE` rule always beats an `INCLUDE`.

## Privacy boundary

This is enforced in the API, not just the UI:

- Vendor endpoints are scoped to `req.user.vendorId` and return **aggregates only** —
  no `publisherId`, no email, no device, no raw impression rows.
- End-user IP addresses are never stored raw, only as a keyed HMAC used for fraud checks.
- Payout details are readable by their owner and the super admin, nobody else.
- The super admin console is the only place the demand and supply sides meet.

---

## Layout

```
adpilot/
├── server/                 Express + Prisma + SQLite API
│   ├── prisma/schema.prisma    data model (money as BigInt micros)
│   ├── prisma/seed.ts          30 days of consistent demo traffic
│   └── src/
│       ├── routes/             auth · sdk (extension) · vendor · me · admin
│       ├── services/           adserve (auction) · billing (ledger) · stats · settings
│       ├── middleware/         JWT auth, role guards, error shaping
│       └── lib/                money, geo matching, HMAC tokens, audit
├── panel/                  React 18 + Vite + Tailwind console (all three roles)
│   └── src/
│       ├── components/         ui kit, charts, app shell, campaign builder
│       ├── pages/admin/        15 pages — dashboard to audit log
│       ├── pages/vendor/       campaigns, wallet, reports
│       └── pages/user/         earnings, devices, withdrawals, preferences
└── extension/              Chrome MV3
    ├── src/background.js       holds the device key, proxies every API call
    ├── src/content.js          thinking detection + shadow-DOM ad card
    └── src/popup.html/js       pairing and today's earnings
```

### API surface

| Prefix | Auth | Purpose |
|---|---|---|
| `/api/auth` | — / cookie | portal config, login, Google, MFA challenge & enrolment, sessions, vendor signup |
| `/api/team` | cookie + `team:*` | panel users and their permissions, for both scopes |
| `/api/webhooks` | HMAC signature | Razorpay `payment.captured` / `payment.failed` |
| `/api/sdk` | device key header | pair, config, serve, impression, click, heartbeat |
| `/api/vendor` | JWT + `VENDOR` | campaigns, creatives, wallet, reports |
| `/api/me` | JWT + `END_USER` | earnings, devices, payouts, preferences |
| `/api/admin` | JWT + `SUPER_ADMIN` | everything, plus settings, ledger and health |

The extension authenticates with a per-device key, never a JWT — a stolen console
session cannot mint impressions, and a stolen device key cannot read a dashboard.

---

## Going to production

The stack runs end-to-end as-is. These are the deliberate swaps before real money moves:

1. **Database** — point `DATABASE_URL` at your managed Postgres and run
   `npx prisma migrate deploy`. Tune `connection_limit` to your instance count.
2. **Payments in** — paste your keys from
   [dashboard.razorpay.com/app/keys](https://dashboard.razorpay.com/app/keys) into
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, then add a webhook pointing at
   `POST /api/webhooks/razorpay` subscribed to `payment.captured` and
   `payment.failed`, and paste its secret into `RAZORPAY_WEBHOOK_SECRET`.
   Test keys (`rzp_test_…`) work end to end. Set `USD_TO_CURRENCY_RATE` to your
   settlement rate — USD is the unit of account, Razorpay charges in
   `RAZORPAY_CURRENCY`.
3. **Payments out** — optional. Fill the three `RAZORPAYX_*` variables to let the
   auto-payout sweep actually move money; leave them blank and it stops at
   auto-approval. Manual release through the console works either way.
4. **Google** — create an OAuth 2.0 Web client, add `http://localhost:5173` (and
   your production origin) as an authorised JavaScript origin, and set
   `GOOGLE_CLIENT_ID`. Optionally pin `GOOGLE_HOSTED_DOMAIN` to one Workspace domain.
5. **Geo** — set `GEO_PROVIDER=ipapi` (or point `GEO_API_URL` at a paid provider). The
   built-in `local` provider is a small offline table for development.
6. **Secrets** — set real `SESSION_SECRET` and `IMPRESSION_SECRET`, and turn
   `DEV_ALLOW_PASSWORD_LOGIN` off. The server refuses to boot in production if any
   of those is wrong, or if `GOOGLE_CLIENT_ID` is missing.
7. **Cookies** — the panel and API must share a site. In development the Vite proxy
   handles that (`/api` → `:4000`); in production serve both under one domain, or
   set `COOKIE_DOMAIN=.yourdomain.com`.
8. **Fraud** — impression confirmation, dwell-time flooring, per-device keys, hourly
   caps, frequency caps and IP hashing are in place. Add velocity checks per IP hash
   and creative-level anomaly alerts before opening signups.
9. **Extension distribution** — publish to the Chrome Web Store and replace the
   `host_permissions` localhost entries with your API domain.

## Environment

`server/.env` (copied from `.env.example` on first setup):

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | local Postgres | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | shared limits, counters and locks; required in production |
| `PLATFORM_TIMEZONE` | `Asia/Kolkata` | the accounting day daily budgets reset against |
| `SMTP_*`, `MAIL_FROM` | blank | transactional email; without it mail is logged, not sent. Required in production |
| `SAFE_BROWSING_API_KEY` | blank | optional creative destination scanning |
| `TAX_RATE_BPS`, `TAX_LABEL`, `INVOICE_PREFIX` | `1800`, `GST`, `ADP` | invoice numbering and tax breakdown |
| `PRIVACY_POLICY_VERSION` | date | stamped onto every consent record |
| `RATE_LIMIT_DISABLED` | `false` | **test only**; the server refuses to boot with it set in production |
| `PORT` | `4000` | |
| `SESSION_SECRET` | dev value | must be changed in production |
| `SESSION_TTL_HOURS` | `12` | how long a signed-in session lasts |
| `COOKIE_DOMAIN` | blank | set to `.yourdomain.com` in production |
| `GOOGLE_CLIENT_ID` | blank | required in production; Google buttons hide without it |
| `DEV_ALLOW_PASSWORD_LOGIN` | `true` | **development only** — lets earners use a password so the demo works without Google. The server refuses to boot with this on in production. |
| `RAZORPAY_KEY_ID` / `_SECRET` | blank | vendor top-ups; without them only bank transfer is offered |
| `RAZORPAY_WEBHOOK_SECRET` | blank | verifies the capture webhook |
| `USD_TO_CURRENCY_RATE` | `88.5` | USD is the unit of account; the gateway charges in `RAZORPAY_CURRENCY` |
| `RAZORPAYX_*` | blank | optional, enables automated payouts |
| `IMPRESSION_SECRET` | dev value | signs impression tokens; must be changed |
| `CORS_ORIGINS` | `http://localhost:5173` | comma-separated; extension origins are always allowed |
| `GEO_PROVIDER` | `local` | `local` or `ipapi` |
| `DEFAULT_REV_SHARE_BPS` | `6000` | end user keeps 60%; editable live in the admin panel |

## Scripts

```bash
npm run dev          # API + console together
npm run dev:api      # API only
npm run dev:panel    # console only
npm run seed         # re-seed demo data (wipes first)
npm -w server run mock:razorpay   # local stand-in payment gateway
npm -w server run test:payments   # end-to-end payment flow suite
npm run studio       # Prisma Studio, to browse the database
npm run build        # typecheck + production build of both
```
