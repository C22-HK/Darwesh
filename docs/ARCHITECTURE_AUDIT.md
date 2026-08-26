# Darwesh Group — Architecture Audit

Written from direct inspection of this repository. Reflects what actually
exists today, not a target or aspirational architecture.

## 1. What this project actually is

A static website: 20 HTML files, no build step, no bundler, no frontend
framework. Each page is self-contained (inline Tailwind config via CDN,
a `<script type="module">` block for logic). Shared code lives in `js/`
(`firebase-init.js`, `i18n.js`, `nav-auth.js`, `notification-bell.js`,
`city-nav.js`).

- **Hosting:** GitHub Pages, serving from `main`. Custom domain
  `www.darweshgroup.com` via the `CNAME` file.
- **No backend.** No `go.mod`, no `package.json`, no `/functions`,
  no server process anywhere in this repo. Every page talks directly
  to Firebase from the browser using the Firebase Web SDK.
- **No CI/CD.** No `.github/workflows`. Deploys happen by merging to
  `main`; GitHub Pages rebuilds automatically.
- **No committed test suite.** Testing this session has been ad hoc
  Playwright scripts run against local copies with mocked Firebase
  modules, kept outside the repo.

## 2. Firebase architecture

Single Firebase project: `darwesh-group`.

- **Auth:** Email/password only. No Google/social sign-in wired up
  despite being mentioned in requests — `signInWithPopup`/`GoogleAuthProvider`
  do not appear anywhere in this codebase. Roles (`customer`/`agent`/`admin`)
  live on `users/{uid}.role`, promoted manually via the Firestore console —
  there is no self-service or admin-UI path to grant agent/admin, by design
  (prevents privilege escalation from the client).
- **Firestore collections:** `users` (+ subcollections `favorites`,
  `savedSearches`), `listings`, `submissions`, `companies`,
  `agentTransactions`. Schema is informal (no migrations, no schema
  validation beyond what `firestore.rules` enforces at write time).
- **Storage:** Configured in code (`storage.rules`, upload calls in
  `sell.html`/`admin.html`/`agent-dashboard.html`/`account.html`) but
  **the bucket itself is not provisioned** on the live project — confirmed
  repeatedly via direct `storage.googleapis.com` API checks (404 on both
  naming conventions). Every photo upload on the live site currently fails
  after a 25s timeout.
- **Real data scale:** 4 documents in `listings`, all `status: closed`
  (test/placeholder entries from initial setup, not real inventory).

## 3. Frontend structure

- Public pages: `index`, `map`, `buy`, `rent`, `listing`, `sell`,
  `services`, `about`, `insights`, `promo`, `mam-ai`, `build`, `renovate`.
- Auth pages: `login`, `signup`, `reset-password`, `account`.
- Role-gated dashboards: `agent-dashboard.html` (role must be `agent`,
  enforced client-side by redirecting if the Firestore profile says
  otherwise — real authorization still lives in `firestore.rules`, not
  in this redirect), `admin.html` (same pattern for `admin`).
- Two orphaned pages exist and are reachable by direct URL but linked
  from nowhere: `verification.html`, `profile.html` — both static
  mockups with fabricated placeholder data, predating the real
  `account.html`/`agent-dashboard.html` implementations.
- i18n: custom dictionary-based system (`js/i18n.js`), English/Kurdish
  Sorani/Arabic, ~750 keys per language, parity checked manually each
  session rather than by tooling.

## 4. "MAM AI" assistant

Client-side keyword/substring matcher (`mam-ai.html`) — no LLM, no NLP
library, no backend call. Real-data grounding exists only for a few
specific reply generators that read live `listings` stats directly from
Firestore. Property-search intent (city/type/price parsing) filters the
same live data. This is a deliberate, disclosed limitation, not a bug —
building a real LLM-backed assistant was discussed and deferred pending
a cost decision (needs a backend + a paid LLM API).

## 5. Known technical debt

- Tailwind loaded from CDN and compiled client-side on every page load —
  fine at this scale, not what Tailwind recommends for production
  (larger CSS payload, no purging, slightly slower first paint).
- No sitemap.xml, robots.txt, Open Graph tags, or Privacy Policy/Terms
  pages.
- No analytics or error monitoring of any kind — zero visibility into
  real traffic, drop-off, or client-side errors in production.
- GitHub Pages does not support custom HTTP response headers, so no
  CSP/HSTS/`X-Content-Type-Options`/etc. are possible without moving
  hosting (e.g. behind Cloudflare or to a platform that supports them).
- No automated tests committed; regressions are caught by manual/ad hoc
  Playwright runs during active work sessions, not on every change.

## 6. What is NOT technical debt (already solid)

- `firestore.rules`/`storage.rules` enforce real, server-side
  (rules-engine-evaluated) authorization: role/company/agent-assignment
  fields are locked against self-modification, listing writes are scoped
  to the owning agent or an admin, `agentTransactions` are strictly
  owner+admin scoped, submissions are readable only by their owner or an
  admin. This is genuine defense, not merely hidden UI.
- Password hashing, session tokens, one-time reset-token issuance/
  expiry/single-use enforcement are all handled server-side by Firebase
  Auth itself — this is real, audited infrastructure, not something
  this project reimplements or could improve on by reimplementing.
- Firebase Auth applies automatic rate limiting to both sign-in attempts
  and password-reset requests server-side (`auth/too-many-requests`),
  independent of anything in this codebase.
