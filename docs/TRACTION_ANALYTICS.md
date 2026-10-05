# DarkSol traction analytics

Design, 2026-09-27. The initial private dashboard is implemented in the sibling backend repo; see [setup and access](../../darksol-backend/docs/ADMIN_STATS.md). Deployment and credential setup are still required. Broader metrics below remain subject to the stated evidence limits.

## Decision

Use aggregate operational statistics on the existing VPS. No analytics consent prompt, browser telemetry, cookies, local-storage identifiers, fingerprinting or wallet-based user tracking. Explain the aggregate statistics in the privacy notice; do not add an analytics setting or banner.

Reuse the backend's Express API, Postgres and existing deployment. No new service, database or analytics dependency. The private dashboard at `/admin-stats` refreshes totals every 60 seconds. CSV export is deferred until sparse-cell suppression is implemented; the exact internal breakdowns are not an investor export.

Unique users, retention and individual spending are deliberately unavailable. Do not replace them with hashed wallets, IP hashes or invented estimates. Transaction size and product mix answer what activity looks like without identifying people.

## What we can measure

| Metric | Definition |
| --- | --- |
| Verified payment volume | Principal in finalized, funded DarkSol payment links, counted once per invoice. Native asset totals plus USD where historical prices exist. |
| Completed payments | Number of funded invoices, not chain signatures or merchant withdrawals. |
| Monthly growth | Volume and payment-count changes against the previous comparable period. Label month-to-date separately. |
| Typical payment size | Mean and size-band distribution, computed from aggregate counts and amounts. No individual spending histories. |
| Usage mix | Count and volume by protocol and asset for verified payments. Add other products only when their execution is operationally observable. |
| Reliability | Existing server operation success/error counts. Payment completion rate only where the backend has a meaningful attempt denominator; unknown outcomes remain unknown. |
| Economics | Actual DarkSol revenue and operating costs where available. Protocol and network fees are not DarkSol revenue. |

The headline is initially **verified payment-link volume**, not all DarkSol routed volume. The existing protocol indexer sees activity from other applications and cannot establish DarkSol attribution. Browser-executed sends, swaps and bridges remain outside these verified totals until the backend already has operational evidence of their completion. Do not introduce tracking requests just to fill that gap.

## Existing implementation evidence

- The sibling `darksol-backend` repo runs Express, Postgres, Caddy and the indexer on the VPS; reuse that stack.
- Its `server/payment-deposits.js` checks finalized successful deposits against invoice commitments. `server/payment-links.js` records the first paid transition. Funding is observable; merchant redemption is a different event.
- The frontend's `src/main.jsx` dispatches browser SDK execution. A returned receipt may mean submitted, partially completed or awaiting delayed delivery; it is not uniformly proof of settlement.
- The frontend's `/analytics` page reports protocol-wide flows. Keep it separate from the private traction dashboard.

## Smallest implementation

Start with aggregate SQL queries over existing paid payment records and a protected summary endpoint in `darksol-backend`. Query only the columns required for totals; return no invoice IDs, transaction signatures, merchant identifiers or recovery material. A short server-side cache is sufficient initially. Do not add an event ingestion endpoint or an analytics ledger.

Use UTC calendar boundaries. Count each paid invoice once; redemption, retries, funding legs and recipient fan-out do not multiply volume. Exclude known test records through existing trusted operational classifications. State that unknown self-dealing is not detected.

Use integer native units and SQL `numeric`. Historical USD valuation requires a price at completion time within a documented freshness limit. Missing prices stay unpriced, with a coverage percentage; do not use today's price for historical volume or assume stablecoins equal $1. Native asset totals remain available independently.

If query cost or operational record retention later requires it, add a daily aggregate table with counts, principal, priced USD and unpriced counts by protocol and asset. Rebuild it from operational records using fixed date boundaries and atomic replacement, so reruns cannot double-count. Preserve closed aggregates before deleting their source records. Until then, display the actual available history rather than promising permanent totals.

## Privacy and access

Analytics must not create any new user identifier or event history. Never copy wallets, hashed wallets, recipients, signatures, invoice IDs, notes, balances, IPs, user agents, URLs or free-text errors into analytics storage or exports. Operational records needed to provide payments stay governed by their existing purpose and retention; they are not a source for user profiling.

Keep the dashboard private using existing Caddy authentication or localhost access through SSH. Never embed its credential in the frontend bundle; use `Cache-Control: no-store`. Internal exact totals remain sensitive, particularly during low activity.

Investor exports use fixed closed months and coarse breakdowns. Suppress cells below 10 payments, including complementary totals where subtraction would expose them. This reduces disclosure risk; it is not a guarantee of anonymity. Do not publish a live per-transaction feed.

Check that application and proxy logs do not duplicate payment payloads or credentials for analytics. Existing operational request handling still exposes metadata to infrastructure; do not claim the entire app processes no personal data. This design removes the browser-tracking feature rather than silently enabling it without consent.

Suggested privacy-notice wording, to publish only when implemented accurately:

> We calculate aggregate payment statistics, such as total volume, payment counts and protocol usage, from records needed to operate DarkSol. We do not create browser identifiers or individual analytics profiles. These statistics are processed on our own server.

## Acceptance

Verify that repeated payment reports count once; only funded invoices contribute; pending and failed deposits stay out; date boundaries and missing prices are handled honestly; dashboard access is protected; and exports contain only permitted aggregates. Confirm there are no added browser analytics requests, cookies or storage keys. No frontend analytics consent flow is needed by this design because it adds no browser analytics collection.


## Live private-send indicator (2026-10-01)

The private backend dashboard now also has a separate **Possible private sends**
card. Successful single-recipient, same-asset amount queries are compared with
exact same-asset withdrawal amounts in available pools within 60 seconds. This
is explicitly an estimate and never enters verified payment totals. The backend
checks every minute, allows ten minutes for indexing, groups repeated amount
queries and deduplicates withdrawal transactions. No new browser request or
identifier is added; DNT and Sec-GPC opt-outs skip observation.

This extends the initial aggregate-only design with temporary in-memory query
amounts, eligible pools and timestamps, plus temporary transaction references for
deduplication. They expire after ten minutes. Only hourly counts remain for the
last 24 hours, with whole-hour boundaries; all state resets on API restart and
the dashboard shows its actual coverage start. Coincidental matches, fees,
delays and unsupported send modes limit the estimate. Backend deployment is
required; see [implementation details](../../darksol-backend/docs/ADMIN_STATS.md#possible-private-sends-live-estimate).

## Trace activity and in-app visits (2026-10-04)

The traffic counter now includes navigation within the app as well as full page
loads. Only a fixed page category is sent to the same-origin edge middleware;
there is no invoice ID, transaction signature, original URL, referrer, cookie or
visitor identifier in this request. The initial document is counted only at the
edge, so mounting the app does not count it again. DNT and Global Privacy Control
opt-outs apply to these counters. This anonymous navigation request supersedes
the initial prohibition on additional browser analytics requests above; no
individual analytics profiles are created.

The private dashboard distinguishes **Payment links** (the merchant page) from
**Payment checkout** (a valid `/pay/<invoice>` page). Checkout polling is not a visit.
Trace activity shows page views and primary deposit, withdrawal and other checks
in the selected period. Pagination and automatic supporting deposit lookups stay
in the separate operational API-call total and do not inflate check counts.
Repeated user checks count again. Other checks include unclassified transactions
and failed requests; these are not successful deposits or withdrawals.

These are visits and checks, not unique people. No identity or per-transaction
history is stored. The new breakdown starts when backend migration
`0016_trace_check_counts.sql` and the backend are deployed; older raw API totals
cannot be split retrospectively. Deploy the backend before the frontend.
