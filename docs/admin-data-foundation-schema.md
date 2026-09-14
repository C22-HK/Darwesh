# Admin Data Foundation — Visitor Analytics + Brokerage Revenue Ledger

**Status: schema + security/privacy model for review. Nothing in this document
is implemented yet** — no new Firestore collection, rule, index, or backend
route exists in the repo as of this doc. Per the explicit gate this was asked
under: implementation starts only after this is reviewed.

This is the "parallel data foundation" the approved Stage 2 sign-off called
out as a hard requirement, not deferred future work: real Visitor Analytics
and a real Brokerage Revenue Ledger, so the eventual Overview command center
never has to fake either. It follows directly from
`docs/admin-command-center-research.md`'s own data-availability audit, which
classified both as REQUIRES NEW TRACKING / NOT CURRENTLY POSSIBLE — this is
that tracking, designed.

---

## Part 1 — Visitor Analytics

### 1.1 Design principles (binding constraints on everything below)

1. **Aggregate over raw.** No collection here stores an unbounded, ever-growing
   log of individual page views. Every write either updates a small, bounded
   set of daily/session documents via `increment()`, or is itself a session
   document that gets updated in place (not appended to). This is also the
   answer to "do not continuously write to Firestore every few seconds" below
   — there is no per-event Firestore write in the hot path at all.
2. **Anonymous by default.** A visitor gets a random session identifier
   client-side (not derived from anything identifying). It is never linked to
   a `uid` unless the visitor is actually signed in, and even then the link is
   used only to let a signed-in admin correlate "this session belongs to this
   account" for support/fraud investigation — it is never joined into the
   aggregate business-intelligence numbers the Overview page shows.
3. **No raw IP, no precise geolocation, no full user-agent string stored.**
   Anywhere a coarse category is genuinely useful (device class, browser
   family), it is derived client-side into a small enum before it is ever
   sent — the server never receives, and therefore can never leak or be asked
   to redact, the raw string.
4. **City/region: honestly NOT CURRENTLY POSSIBLE.** This codebase has no
   IP-geolocation service configured anywhere (grepped: none). Coarse
   city-of-visitor is therefore out of scope for this pass — including it
   would mean silently adding a third-party geo-IP dependency and sending it
   every visitor's IP, which is exactly the kind of unauthorized new
   third-party data flow this instruction set asks not to add without
   discussion. **Flagging this as a decision point, not a silent omission** —
   see §1.6.
5. **Referrer stored as host only** (`google.com`, `instagram.com`, direct),
   never the full referrer URL — an upstream referrer URL can itself carry a
   visitor's search query or account-specific path, which would be a privacy
   leak this system has no business capturing.

### 1.2 Event model

Client-side event names (fired locally, then folded into the aggregate
writes below — never stored as individual documents):

| Event | Fires when |
|---|---|
| `session_start` | A new anonymous session begins (no valid session id in `localStorage`, or the stored one is past its 30-min inactivity window) |
| `page_view` | Each route/page render |
| `listing_view` | A listing detail is opened (map.html card expand, or a listing page) |
| `project_view` | A project detail is opened |
| `search` | A text/filter search is run on Buy/Rent/Map |
| `map_search` | A map bounds/polygon search ("Search this area") |
| `contact_request` | A Sell submission or map viewing request is submitted (already a real write — this event rides alongside it, not a new user action) |
| `property_save` | A listing is saved/favorited (if/when that feature exists — currently does not; event name reserved, not wired) |
| `area_alert_created` | An Area Alert is saved (already a real write — same pattern as `contact_request`) |
| `service_request` | A provider service request is submitted (already a real write) |
| `challenge_join` | An Arena challenge is joined (already a real write) |
| `lead_created` | Reserved — no generic "lead" concept exists yet outside the above; not wired until one does |

**Every event above that already corresponds to a real Firestore write
(`contact_request`, `area_alert_created`, `service_request`,
`challenge_join`) is an analytics *label* on an existing write, not a new
one** — the browser increments the matching daily counter (§1.3) in the same
request cycle as the real submission, it does not create a second document.
`session_start`/`page_view`/`listing_view`/`project_view`/`search`/
`map_search` have no existing write to ride on, so they batch client-side and
flush as a single increment call (§1.3) rather than one call per event.

### 1.3 Firestore shape

```
analyticsDaily/{YYYY-MM-DD}                          -- one doc per UTC day
  pageViews: number                                    (increment)
  sessions: number                                      (increment)
  events: { [eventName: string]: number }               (increment, map field)
  byDevice: { desktop: number, mobile: number, tablet: number }
  byLanguage: { en: number, ku: number, ar: number, tr: number }
  byReferrerHost: { [host: string]: number }             -- capped: only the
                                                            top 20 hosts by
                                                            volume are kept
                                                            as individual
                                                            keys server-side;
                                                            everything else
                                                            folds into "other"
  topPages: { [path: string]: number }                   -- same 20-key cap
  updatedAt: server timestamp

analyticsSessions/{sessionId}                         -- one doc per session,
                                                          written once at
                                                          session_start,
                                                          updated (not
                                                          appended) after that
  sessionId: string                                     -- the client-
                                                            generated
                                                            anonymous id
  uidHash: string | null                                -- SHA-256(uid), set
                                                            only if the
                                                            visitor is signed
                                                            in at session
                                                            start; never the
                                                            raw uid
  startedAt: server timestamp
  lastSeenAt: server timestamp                          -- updated by the
                                                            heartbeat, §1.4
  deviceCategory: 'desktop' | 'mobile' | 'tablet'
  language: 'en' | 'ku' | 'ar' | 'tr'
  referrerHost: string | null
  pageViewCount: number                                  (increment)
  ttlExpiresAt: timestamp                                -- Firestore native
                                                            TTL field, set to
                                                            startedAt + 35
                                                            days; the
                                                            collection is
                                                            self-cleaning,
                                                            nothing here is
                                                            kept forever
```

No `analyticsEvents` collection of raw per-event documents exists at all —
every event folds into `analyticsDaily`'s map fields via `increment()`, which
is O(1) storage growth per day regardless of traffic volume.

### 1.4 "Online Now" — exact definition and architecture

**Definition, to state in the UI verbatim wherever this number is shown:**
"visitors active in the last 5 minutes." No other meaning.

- A session sends a heartbeat **once every 60 seconds** while the tab is
  foregrounded (`document.visibilityState === 'visible'`; paused entirely
  when backgrounded) — this is the answer to "do not continuously write to
  Firestore every few seconds": 60s is the floor, not a suggestion, and it
  stops the moment the tab isn't visible.
- The heartbeat is a single field update: `analyticsSessions/{sessionId}
  .lastSeenAt = serverTimestamp()`. One write per session per minute, not
  per page view.
- "Online Now" is computed by the backend aggregate endpoint (§1.6), not by
  a live Firestore listener: `count(analyticsSessions where lastSeenAt >
  now() - 5min)`. A `lastSeenAt` composite index services this query
  efficiently at any real traffic volume this platform is likely to see;
  revisit only if it stops being true.
- The 35-day TTL (§1.3) means this collection never needs a manual cleanup
  job — Firestore's native TTL deletes expired session docs automatically.

### 1.5 Security & privacy rules (Pattern B, admin-read-only)

```
match /analyticsDaily/{day} {
  allow read: if isAdmin() && hasPermission('analytics.view');
  allow write: if false;  // backend Admin SDK only, via increment()
}
match /analyticsSessions/{sessionId} {
  allow read: if isAdmin() && hasPermission('analytics.view');
  allow write: if false;  // backend Admin SDK only
}
```

Both collections are **backend-write-only from day one**, same posture as
`brokerageDiscountHistory`/`areaAlerts` — the client never gets a Firestore
SDK write path to either collection, even from a signed-in visitor's own
session. The browser calls a new lightweight ingestion endpoint (§1.6); the
backend validates the payload (device category is one of 3 enum values,
event name is one of the §1.2 list, referrer host is truncated/sanitized)
and performs the actual `increment()`/session-upsert with the Admin SDK. This
also closes off the obvious abuse case — a public, unauthenticated write path
straight to Firestore would let anyone inflate or corrupt the traffic numbers
the business will eventually read as truth.

`analytics.view` is a new permission key, added to
`backend/app/access/constants.py` + `js/permission-catalog.js` +
`firestore.rules`' `hasPermission()` map, same three-file pattern every
existing permission key already follows (`alerts.review`, `brokerage.manage`).

### 1.6 New backend endpoints

```
POST /api/v1/analytics/events           -- public, unauthenticated (any
                                            visitor). Body: { sessionId,
                                            events: [...], deviceCategory,
                                            language, referrerHost?, path? }.
                                            Rate-limited using the same
                                            Firestore-backed limiter
                                            INFRA-01 already added, keyed by
                                            sessionId, to bound abuse without
                                            needing auth.
POST /api/v1/analytics/heartbeat        -- public, unauthenticated. Body:
                                            { sessionId }. Touches
                                            lastSeenAt only.
GET  /api/v1/analytics/admin/summary    -- admin + analytics.view. Today's
                                            pageViews/sessions/onlineNow +
                                            period-over-period comparison.
GET  /api/v1/analytics/admin/timeseries -- admin + analytics.view. Daily
                                            series over a requested date
                                            range, reading analyticsDaily
                                            docs directly (already
                                            pre-aggregated, no fan-out read).
GET  /api/v1/analytics/admin/pages      -- admin + analytics.view. Top pages
                                            for a range (merges each day's
                                            topPages map).
GET  /api/v1/analytics/admin/sources    -- admin + analytics.view. Top
                                            referrer hosts for a range.
```

Only 6 endpoints, not the 4 the original spec sketch named plus a 5th for
traffic — city/region has no endpoint because §1.1.4 keeps it out of scope
for this pass.

### 1.7 What this does NOT do (explicit, so it isn't assumed later)

- No city/region-of-visitor. No IP storage, geolocation, or third-party geo
  service. Revisit only as its own explicitly-scoped decision.
- No cross-session visitor identity ("unique visitors over 30 days") beyond
  what the 35-day session TTL naturally allows counting distinct
  `sessionId`s for — this undercounts a returning visitor whose browser
  storage was cleared, which is the correct, privacy-respecting failure mode
  (no fingerprinting to compensate for it).
- No individual visitor is ever exposed in an admin UI or export by session
  detail — `analyticsSessions` is read by the aggregate endpoints only, never
  listed row-by-row. If a future fraud-investigation need requires looking at
  one session, that is a separate, explicitly-scoped, audit-logged capability
  — not part of this pass.

---

## Part 2 — Brokerage Revenue Ledger

### 2.1 The one honest scope boundary this design has to state up front

**This codebase has exactly one place today where a brokerage deal actually
closes with money changing hands: Arena's `arenaDeals.paymentState`
(`pending → invoiced → received`, `model.PAYMENT_STATES` in
`backend/app/arena/model.py`).** There is no generic "close a brokerage
deal" flow anywhere else — Sales hub's Requests are submissions/viewing
requests, not closed deals (confirmed again while building the Sales hub in
Stage 1 of this redesign: "Deals/negotiations stay planned until a real
deals feature exists"). `brokerage/compute-fee` itself is preview-only
(`record: false`).

So: **the ledger schema below is real and general-purpose, but at launch its
only real write source is an Arena deal transitioning to `paymentState:
"received"`.** A ledger entry for a brokerage deal closed *outside* Arena
cannot be created until a real "mark this deal closed" flow exists somewhere
else in the product — that is out of this pass's scope, and the schema is
deliberately shaped so adding that second write source later is additive
(same collection, same fields, a different `dealRef.kind`), not a rework.

### 2.2 Firestore shape

```
brokerageTransactions/{transactionId}    -- immutable once written; a closed
                                            financial record, never edited
  transactionId: string                    -- also the doc id
  dealRef: { kind: 'arena', dealId: string, challengeId: string }
                                            -- kind is the extension point
                                              for §2.1's future second
                                              source; only 'arena' exists
                                              today
  propertyId: string | null                -- the arenaDeals doc's own
                                              property reference, carried
                                              through as-is
  accountId: string                        -- the account the discount/fee
                                              applied to (brokerage_ops'
                                              existing subject)
  city: string | null                      -- resolved the same way
                                              brokerage_ops already resolves
                                              city for discount matching
                                              (companyId/activeOrganizationId
                                              -> companies/organizations),
                                              not re-derived differently here
  propertyType: string | null
  grossFee: number                         -- compute_discount()'s
                                              `original_fee` input, snapshot
  discountPercent: number                  -- the effective percent applied
                                              at close time
  discountAmount: number                   -- compute_discount()'s first
                                              return value, snapshot
  netFee: number                           -- compute_discount()'s
                                              `final_fee`, snapshot -- this
                                              field, summed, is what "Net
                                              Brokerage Revenue" means
                                              (§2.4)
  discountSource: 'account_override' | 'policy' | 'none'
                                            -- mirrors get_account_discount's
                                              existing precedence result,
                                              not a new concept
  policySnapshot: { policyId: string, ... } | null
                                            -- a full copy of the matched
                                              policy's fields AT CLOSE TIME,
                                              not a live reference -- a
                                              policy edited or deleted later
                                              must never change what this
                                              record shows
  overrideSnapshot: { ... } | null         -- same immutability rule, for an
                                              account-level override
  currency: 'USD' | 'IQD'                  -- model.CURRENCIES, unchanged
  paymentState: 'pending' | 'invoiced' | 'received' | 'waived' | 'disputed'
                                            -- deliberately the EXACT same 5
                                              states as arena.model.
                                              PAYMENT_STATES, not a new
                                              vocabulary -- see §2.3
  createdAt: server timestamp              -- when the ledger entry was
                                              written (deal closed)
  closedAt: server timestamp               -- the underlying deal's own
                                              close timestamp, may predate
                                              createdAt if backfilled
  recordedBy: string                       -- uid of the admin/system action
                                              that produced this entry
                                              (mirrors accessAuditLog's
                                              actor field shape)
```

Composite indexes needed: `(city, createdAt)`, `(paymentState, createdAt)`,
`(propertyType, createdAt)` — for the Financial Intelligence
by-city/by-type/over-time breakdowns the command-center spec asks for,
following the same one-index-per-real-query-shape discipline
`firestore.indexes.json` already uses everywhere else.

### 2.3 Money status: reusing Arena's vocabulary, not inventing a new one

The brief offers Pending/Due/Partially-Paid/Paid/Cancelled/Voided as an
example, with the explicit caveat "only if they match the actual business
model" and "do not invent unnecessary accounting complexity." This system
has no partial-payment tracking anywhere (an invoice is invoiced and later
received, in full, or it is waived/disputed) — adding a "partially paid"
state would need an amount-paid-so-far field and reconciliation logic that
does not exist and was not asked for elsewhere. Reusing
`pending`/`invoiced`/`received`/`waived`/`disputed` verbatim:

- keeps one state vocabulary for "money owed to Darwesh" across the whole
  product instead of two similar-but-different ones,
- is already fully modeled, tested, and UI-wired in Arena today (nothing new
  to design),
- and `disputed` already covers the real-world "this shouldn't count as
  revenue yet" case the brief's "Cancelled/Voided" was reaching for.

### 2.4 Financial auditability — where each requested number comes from

| Requested figure | Source |
|---|---|
| Gross Brokerage Fees | `sum(grossFee)` over ledger entries in range |
| Discount Given | `sum(discountAmount)` over ledger entries in range |
| Net Brokerage Revenue | `sum(netFee) where paymentState = 'received'` — **only received money counts as revenue**; `pending`/`invoiced` are receivables, shown separately, never folded into "revenue" |
| Closed Deals | `count()` of ledger entries where `paymentState in ('received', 'invoiced', 'waived', 'disputed')` (i.e. the deal itself closed, regardless of payment outcome) |
| Average Brokerage Fee | `sum(netFee where received) / count(received)` |
| Revenue by City | `sum(netFee where received)` grouped by `city`, via the `(city, createdAt)` index |
| Revenue over Time | `sum(netFee where received)` grouped by day/week/month over `createdAt`, via the `(paymentState, createdAt)` index |

Every one of these reads the ledger only — never listing prices, never an
unfinished deal, matching the brief's explicit "do not infer revenue from
listing prices" / "do not count an unfinished deal as revenue" instructions
directly.

### 2.5 Immutability guarantee

`write: if false` for every client SDK caller, admin sessions included —
identical posture to `brokerageDiscountHistory` today. The only writer is
`backend/app/brokerage/ledger_ops.py` (new module, alongside the existing
`brokerage_ops.py`), called from the one real trigger point:
`arena_ops.set_payment_state()` transitioning a deal's `paymentState` to
`"received"` for the first time. A ledger entry, once created, is never
updated by that path again — a later `disputed`/`waived` transition on the
*same* Arena deal creates a **new** ledger entry referencing the same
`dealRef.dealId}`, rather than mutating the immutable original, so the
historical record of "what this deal's fee was computed as, and when" is
permanently preserved exactly as the brief requires
("historical financial records must remain immutable/auditable" /
"do NOT recalculate historical closed transactions when future discount
policies change").

### 2.6 New backend endpoints

```
GET /api/v1/brokerage/admin/ledger/summary      -- admin + brokerage.manage.
                                                    Gross/discount/net/deals/
                                                    average for a range,
                                                    period-over-period.
GET /api/v1/brokerage/admin/ledger/by-city      -- admin + brokerage.manage.
GET /api/v1/brokerage/admin/ledger/timeseries   -- admin + brokerage.manage.
GET /api/v1/brokerage/admin/ledger/entries      -- admin + brokerage.manage.
                                                    Paginated raw entries,
                                                    for a "Transactions"
                                                    table under
                                                    Discounts/Finance --
                                                    the only place any of
                                                    this reads as a list
                                                    rather than an aggregate.
```

No new permission key needed — `brokerage.manage` already gates every other
brokerage admin surface; the ledger extends that same surface rather than
inventing a parallel one.

### 2.7 Privacy — what a ledger entry never contains

Per the brief's explicit export-safety instruction: no phone numbers, no
emails, no buyer identity beyond the existing `accountId` reference (already
the pattern `brokerageDiscountHistory` uses today — a reference, not inlined
PII), no owner documents, no fraud notes. `accountId` resolves to a name only
through the existing admin People hub's own account lookup, under that
surface's own permission gate — the ledger itself carries no display-ready
personal data.

---

## What happens next

Both schemas above are designs, not code. Once reviewed:

1. `firestore.rules` + `firestore.indexes.json` additions (both collections,
   Pattern B).
2. `backend/app/analytics/` (new package: model.py, analytics_ops.py,
   handlers.py) and `backend/app/brokerage/ledger_ops.py`, wired into
   `server.py`/`main.py`.
3. `js/analytics-client.js` (new, tiny — session id, heartbeat, event batch
   flush) loaded site-wide, alongside the existing site-wide includes
   (`js/site-header.js` etc.).
4. Firestore emulator rules tests + backend pytest for both, following the
   same coverage shape every prior phase's ledger/history-style collection
   already has (`test_brokerage_ops.py`, `tests/firestore/brokerage.test.mjs`).
5. Only after that: wire the real numbers into Overview per
   `docs/admin-command-center-research.md`'s own widget inventory — this
   stays Stage 6/7 in the staged plan, not pulled forward.
