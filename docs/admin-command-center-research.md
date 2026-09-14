# Darwesh Admin — Executive Command Center: Data Audit & Research

Status: **research + audit, not yet implemented.** This is the "before implementation" deliverable for the Overview/Home redesign — a real data-availability audit (grounded in the actual backend routes and Firestore collections that exist today), not an assumption of what a command center *could* show.

---

## 1. Method

Every metric requested in the brief was checked against:
- `backend/app/server.py`'s full route table (every `/api/v1/*` endpoint that exists today — grepped directly, not recalled from memory).
- Each domain package's `model.py`/`*_ops.py` (`access`, `alerts`, `arena`, `brokerage`, `verification`) for what fields/aggregates those endpoints actually return.
- A repo-wide, case-insensitive grep for any visitor/analytics tracking library or pattern (`google-analytics`, `gtag`, `plausible`, `mixpanel`, `segment.io`, `pageview`, `umami`, `posthog`, `hotjar`, `clarity.ms`) across every `.js`, `.html`, and `.py` file.

**Headline finding:** there is no visitor/session/traffic analytics instrumentation anywhere in this codebase — not client-side, not server-side, not a third-party snippet. This is a Firebase + FastAPI real-estate marketplace with a real, fairly rich admin/business-operations backend (access control, verification, brokerage discounts, Area Alerts, Arena challenges/deals) — but zero web-analytics layer. Section 3 classifies every metric the brief asked for against this reality.

## 2. What real aggregate/summary data already exists

These are not raw collections a browser would need to scan — they are already-built backend aggregate endpoints, found by direct route/handler inspection:

| Endpoint | Returns | Where |
|---|---|---|
| `GET /api/v1/access/admin/verification/metrics` | Verification pipeline counts (pending/needs-review/verified/rejected, presumably by stage) | `backend/app/verification/handlers.py` |
| `GET /api/v1/alerts/admin/summary` | Active Area Alerts, matches this week, alerts-by-city — the exact aggregate `js/admin-alerts.js` already renders today | `backend/app/alerts/handlers.py` |
| `GET /api/v1/arena/admin/challenges/{challengeId}/commercial-summary` | Per-challenge commercial rollup (deal count/value, presumably payment state breakdown) | `backend/app/arena/handlers.py` |
| `GET /api/v1/arena/admin/deals` + deal `paymentState` field (`PAYMENT_STATES`, `set_payment_state`) | Arena-sourced deals with a real payment-received/pending signal — the **only** real "money changed hands" tracking in this entire codebase | `backend/app/arena/arena_ops.py` |
| `GET /api/v1/brokerage/accounts`, `/brokerage/history`, `/brokerage/policies` | Per-account discount **rate** state and history of rate *changes* — not a ledger of fees actually collected | `backend/app/brokerage/handlers.py` |
| `POST /api/v1/brokerage/compute-fee` | A **preview-only** calculator; `record:false` always — confirmed in `js/admin-brokerage.js`'s own header comment: "never feeds any real deal-closing flow, because none exists in this codebase yet" | `backend/app/brokerage/brokerage_ops.py` |

**This last row is the single most important finding for the "Financial Intelligence" section of the brief.** "Gross Brokerage Fees," "Net Brokerage Revenue," "Deal Volume," "Average Deal Value" as *historical, actually-collected* figures do not exist as trackable data anywhere outside Arena's own deal/payment-state tracking. The Brokerage Discounts module (Phases 1–2 of that system) is a **rate-setting tool**, not a transaction ledger — it answers "what discount does this account get," never "how much did Darwesh actually collect from this account this month." Building real brokerage revenue reporting requires a new event: something that writes a record when a deal *actually closes and a fee is charged*, which does not exist for the general (non-Arena) case today.

## 3. Metric-by-metric classification

Per the brief's own required framework: **AVAILABLE NOW** (a working endpoint returns this today) / **DERIVABLE** (computable from existing collections, but needs a new aggregate query or endpoint — no raw browser-side Firestore scan) / **REQUIRES NEW TRACKING** (no data of this kind exists anywhere) / **NOT CURRENTLY POSSIBLE** (would require infrastructure beyond this codebase's scope, e.g. real IP geolocation).

### Live Business Pulse / general counts
| Metric | Class | Note |
|---|---|---|
| Registered accounts (by type) | **DERIVABLE** | `users` collection exists, already queried by People hub; needs a count aggregate, not a full scan |
| Active properties / new listings today | **DERIVABLE** | `listings` collection with status already exists (Properties hub reads it today) |
| Pending verifications | **AVAILABLE NOW** | `/access/admin/verification/metrics` |
| Open Area Alerts | **AVAILABLE NOW** | `/alerts/admin/summary` |
| Visitors today / Online now | **REQUIRES NEW TRACKING** | No analytics layer exists at all |

### Financial Intelligence
| Metric | Class | Note |
|---|---|---|
| Gross/Net Brokerage Revenue, Deal Volume, Avg. Deal Value (site-wide) | **REQUIRES NEW TRACKING** | No "fee actually collected" event exists outside Arena |
| Discount amount granted (aggregate) | **DERIVABLE** | `brokerageDiscountHistory` has per-account rate-change records; summing "current discount % × nothing" isn't revenue — this can only ever show *rate exposure*, not money, until a real transaction ledger exists |
| Arena deal value / payment-received total | **DERIVABLE** | Real data (`arenaDeals.paymentState`), but scoped to Arena-originated deals only — must be labeled "Arena deals" not "Company revenue" to avoid misleading the admin |
| Revenue by city / account type / time (site-wide) | **NOT CURRENTLY POSSIBLE** | Depends entirely on the missing revenue-ledger above |

### Property Market Intelligence
| Metric | Class | Note |
|---|---|---|
| Active / new / verified / sold listings, projects, units | **DERIVABLE** | `listings`, `projects`/sale-reports collections exist (Properties hub already reads them); needs a backend count/aggregate endpoint instead of a browser scan |
| Average property price, total listed value | **DERIVABLE** | Same collections carry price fields already |
| Days-to-sale, inventory trend | **DERIVABLE**, with a caveat | Requires a "sold at" timestamp to diff against "listed at" — confirm both fields are populated consistently before building this metric; do not fabricate a trend line from incomplete data |

### Visitor / Audience Intelligence
| Everything in this section of the brief (sessions, online now, traffic sources, device type, top pages, returning vs. new) | **REQUIRES NEW TRACKING**, entirely | Zero instrumentation exists. Building this responsibly means a privacy-conscious, first-party event pipeline (own collection + own aggregation, not a third-party script that leaks visitor data off-platform) — a real, separately-scoped project, not a subsection of a dashboard redesign |

### Sales / Buyer Funnel
| Metric | Class | Note |
|---|---|---|
| Lead → Qualified → Matched → Viewing → Negotiating → Closed funnel | **AVAILABLE NOW, but Arena-scoped only** | These exact stage names come directly from `js/admin-arena.js`'s own deal-stage model (`lead, contacted, qualified, matched, viewing_scheduled, viewing_completed, negotiating, deal_pending, closed, lost`) — this is Arena's Buyer/Deal CRM, not a general sales pipeline. A site-wide funnel using these stages for non-Arena leads **does not exist** and must not be presented as if it does |
| Sell/viewing requests (Sales hub) | **AVAILABLE NOW** | Already rendered today (`servicesBody`), just needs a summary count, not a funnel |

### Demand Intelligence
| Metric | Class | Note |
|---|---|---|
| Active alerts, matches this week, alerts by city | **AVAILABLE NOW** | `/alerts/admin/summary`, already the entire content of the Demand hub built in Phase 3 |
| Demand by property type / price range, demand vs. inventory | **DERIVABLE**, with a firm constraint | `admin_summary()` is deliberately built to **never** return per-alert or per-user rows (confirmed in `js/admin-alerts.js`'s own header comment and re-confirmed during Phase 3). Any new breakdown must be built as a *new backend aggregate*, never as a client-side reduction over raw `areaAlerts` documents — that would leak exactly what the backend was built to protect |

### Arena Intelligence
| Metric | Class | Note |
|---|---|---|
| Active challenges, participants, submissions, ledger/points, ranks, commission rules, per-challenge commercial summary | **AVAILABLE NOW** | Arena already has the richest admin backend in the codebase (`arena_ops.py`, ~1500 lines) — this section of a command center is the closest thing to a "free win" in the whole brief |

### People / Network
| Metric | Class | Note |
|---|---|---|
| Customers, agents, offices, organizations, developers, professionals, providers — counts and growth | **DERIVABLE** | `users`, `organizations`, `companies`, `serviceProviders` collections exist; People hub already queries by role today, needs count aggregates |

### Services Intelligence
| Metric | Class | Note |
|---|---|---|
| Requests / active providers / completed / pending by category | **DERIVABLE** | Same `providerRequests` data already rendered in the Sales hub's Provider Requests sub-tab; needs a by-category aggregate |

### Needs Attention
| Metric | Class | Note |
|---|---|---|
| Pending verifications, pending providers/orgs/companies, flagged Arena submissions | **AVAILABLE NOW or DERIVABLE** | Every one of these already has an admin queue today (Verification, Organizations, Professionals, Arena Submission Review) — this section is pure aggregation of existing queues into one attention list, the lowest-risk, highest-value part of the entire brief |

## 4. What this means for scope

**Buildable now, honestly, with real numbers:** Needs Attention, Arena Intelligence, Demand Intelligence (as already shipped), verification pipeline health, People/Network counts and growth, Property Market counts (once a couple of count-aggregate endpoints exist), Sales request volume.

**Buildable, but must be labeled precisely to avoid misleading the admin:** anything using Arena's deal-stage/payment data must say "Arena" in the label, never "Company-wide Sales" or "Total Revenue" — because it structurally is not that.

**Not buildable without new, scoped-out work:** the entire Visitor/Audience Intelligence section, and any "Gross/Net Brokerage Revenue" figure. These are not small gaps — audience analytics is a genuine new subsystem (event collection, storage, aggregation, privacy review), and a real revenue ledger is a genuine new business-logic feature (a "deal closed, fee charged" event and its own Firestore collection + firestore.rules), not a dashboard-layer task. Recommendation: ship the command center with these sections either omitted or explicitly marked "Not yet tracked — see docs/admin-command-center-research.md," never with placeholder numbers.

## 5. Backend endpoints that would need to be built

Only for the **DERIVABLE** rows above — nothing here is needed for what's already **AVAILABLE NOW**:

- `GET /api/v1/access/admin/overview` — the Needs Attention aggregation (pulls from the verification/orgs/companies/providers queues that already exist; new endpoint, no new data model).
- `GET /api/v1/access/admin/analytics/people` — counts + growth by role/city from `users`.
- `GET /api/v1/access/admin/analytics/properties` — counts/value/price aggregates from `listings`/`projects`.
- `GET /api/v1/access/admin/analytics/services` — request counts by category from provider requests.

Each should follow the exact pattern already established by `/alerts/admin/summary` and `/access/admin/verification/metrics`: a single backend-computed aggregate, never a client-side Firestore scan across an entire collection (the brief's own performance requirement, and consistent with how every existing admin summary in this codebase already works).

**Explicitly not proposed in this pass:** any visitor-analytics endpoint or any revenue-ledger endpoint — both require a scoping conversation (see §4) before an endpoint shape can even be designed responsibly.

## 6. Privacy/security constraints carried forward unchanged

- Area Alerts: never expose per-user alert or per-alert match rows on any Overview widget — aggregate only, exactly as the existing `admin_summary()` boundary already enforces.
- Any new "Needs Attention" row that links to a queue must respect the same `requires: [...]` permission gating those hubs already use (`alerts.review`, `brokerage.manage`, etc.) — a command-center widget is not a way around existing permission checks.
- Export/print (see §7) must default to aggregate business intelligence only — no phone numbers, emails, private documents, or fraud-review notes in a default executive export, per the brief's own explicit instruction.

## 7. Report / print architecture (proposed, not built)

Given no PDF-generation dependency exists anywhere in this codebase today (`backend/requirements` was not found to reference any PDF library), the responsible path is a **dedicated print stylesheet + printable HTML report view** the brief explicitly allows as the fallback ("design a printable HTML report that browsers can accurately save as PDF... do not add a huge dependency unnecessarily"). Concretely: a `css/admin-print.css` scoped under `@media print`, activated on a `/admin.html?report=1` (or a dedicated `admin-report.html`) view that renders white/ivory background, dark text, gold accent only, Darwesh Group header/footer, and only the sections backed by real data per §3/§4. This is Stage-7-scale work and is **not started** — flagged here only so the architecture is agreed before Stage 6 of the visual redesign reaches Analytics/System (where a report entry point would live).

## 8. Responsive strategy for the command center

Per the brief: mobile prioritizes Needs Attention → core KPIs → Financial (once real) → Properties → Demand, collapsing everything else. This slots directly into the visual redesign's existing responsive breakpoints (1920/1440/1280/1024/768/390) from `docs/admin-ui-research.md` §5 — no separate breakpoint system is needed.

## 9. Recommendation

Build the Overview redesign in two honest layers:
1. **Now**: Needs Attention + Arena Intelligence + Demand Intelligence (already real) + People/Property/Services counts (needs the four small aggregate endpoints in §5) — this alone is a dramatic, truthful upgrade from today's "wall of KPI cards" and delivers most of the brief's stated goal ("I have complete operational visibility... I can understand the health of the entire company from one screen") using only data that is real.
2. **Scoped separately, on explicit request**: visitor/audience analytics (a new subsystem) and a real brokerage-revenue ledger (a new business-logic feature with its own rules/tests) — both flagged, not silently skipped, and both too consequential (privacy instrumentation; a new financial record of truth) to fold into a visual-redesign pass without a dedicated go-ahead.
