# Darwesh Group — Client-Side Security Review (Stage 6)

Scope, per your selection: DOM-based/stored XSS risk, unsanitized data
flowing into `innerHTML`/attributes, input-validation consistency, and
whether a Content-Security-Policy is feasible given GitHub Pages'
header limitation (INFRA-07).

**No source code was modified.** This is analysis only, matching every
prior stage's review-then-remediate pattern.

Method note: this stage's original plan was to delegate an exhaustive,
per-file audit to two background agents. Both failed mid-run on a
session-wide rate limit (not a defect in the task) before producing any
output. Rather than re-running them, this review was completed directly
— reading every `.innerHTML =` call site across all 16 files that have
one (111 total), tracing each back to its data source, and verifying
whether that source is escaped. This is narrower than a literal
line-by-line report on all 111 sites, but every site was inspected; the
findings below are the ones that turned out to matter.

---

## Evidence legend

- **CODE CONFIRMED** — read directly from source, quoted with file:line
- **RULES CONFIRMED** — cross-checked against `firestore.rules` to establish whether a data source is genuinely attacker-controllable, not assumed

---

## Findings

### CLIENT-01 — Unescaped listing `city` field renders as stored XSS on the public, unauthenticated Insights page

- **Status**: CONFIRMED
- **Type**: SECURITY VULNERABILITY (stored XSS)
- **Severity**: **High** — no authentication required to trigger, fires for every visitor who loads the page
- **CWE**: CWE-79 (Improper Neutralization of Input During Web Page Generation)
- **Evidence**: CODE CONFIRMED —
  - `insights.html:472`: `` tbody.innerHTML = cities.map(c => `<tr><td>${cityLabel(c.city)}</td>...`).join("") ``
  - `insights.html:544`: same pattern, `CITY_STATS.map(c => ...)`
  - `insights.html:461`: a chart tooltip built via the same unescaped `city` variable
  - `insights.html:331-337`: `CITY_STATS` is built by `loadRealMarketData()`, which queries the real, public `listings` collection (`where('private','==',false), where('status','==','active')`) and groups results by `d.data().city` — a real Firestore field, not a constant.
  - `js/i18n.js:1935-1938`: `window.cityLabel(englishName)` returns a translated string **or falls through to the raw `englishName` argument unchanged** for any value not in its known-cities lookup table — it is not itself a sanitizer, and its own sibling file says so explicitly (`js/city-nav.js:22-27`: *"`city` ultimately comes from listings.city in Firestore, which any agent account... can set to arbitrary text... Escaped before ever reaching innerHTML"* — a comment written specifically to warn about this exact risk, correctly heeded in `city-nav.js` itself but not in `insights.html`).
  - **RULES CONFIRMED**: `firestore.rules` allowlists `city` as a permitted field name on both listing `create` and `update` (`firestore.rules:261`, `:310`) but validates nothing about its *content* — any agent account can set it to arbitrary text, exactly as `js/escape-html.js`'s own header comment already documents as the general rule for this codebase (*"firestore.rules validates who can write a field, not its content"*).
  - Confirmed no auth gate exists on `insights.html` (no `onAuthStateChanged`/login-redirect logic found) — it is a fully public marketing/analytics page.
- **Impact**: Any real-estate agent account (a normal, self-service signup, not an elevated role) can set a listing's `city` to an XSS payload (e.g. `<img src=x onerror="...">`  — `<script>` tags inserted via `innerHTML` don't execute, but attribute-event-handler-based payloads do). The next time `insights.html` loads that listing into its city aggregation — which happens automatically, with no admin action needed — the payload executes in the browser of **every visitor who loads the page**, unauthenticated. This is a full JavaScript execution primitive in an anonymous visitor's session: session/localStorage theft, credential-phishing overlay injection, or (chained with an authenticated visitor who happens to view the page while logged in) actions performed as that user.
- **Root cause**: `cityLabel()`'s pass-through fallback was evidently assumed to always receive a "known" city string; every other page that calls it (`index.html:320`, `js/city-nav.js`) wraps the result in `escapeHtml()` before use — `insights.html` is the one place that doesn't.
- **Recommended remediation**: Not implemented this stage (analysis only). Wrap all three call sites in the escaping function `insights.html` already has access to (it loads `js/escape-html.js`, confirmed by checking its own `<script>` tags) — e.g. `escapeHtml(cityLabel(c.city))`. Mechanical, three call sites, no design decision required.
- **Confidence**: High — traced end to end from a real, unauthenticated Firestore write path to an unescaped public render.

---

### CLIENT-02 — Unescaped company name renders as stored XSS in the admin session

- **Status**: CONFIRMED
- **Type**: SECURITY VULNERABILITY (stored XSS)
- **Severity**: High — requires an admin to open a specific panel, but yields full JavaScript execution in the highest-privilege session on the site
- **CWE**: CWE-79
- **Evidence**: CODE CONFIRMED — `admin.html:2997-3004`:
  ```js
  async function populateCompanySelect() {
    const select = document.getElementById('aaCompanySelect');
    const { companiesSnap } = await fetchAgentStats();
    const branches = [];
    companiesSnap.forEach(d => branches.push({ id: d.id, name: d.data().name || d.id }));
    branches.sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')
      + `<option value="__new__">${trAdmin('admin.newCompanyOption', '+ New company…')}</option>`;
  }
  ```
  `${b.name}` is not escaped. Every *other* place `admin.html` renders a company/branch name **does** escape it: `admin.html:1116` (`escapeAdmin(companyNames[u.companyId])`), `:2690`/`:2694` (`escAdmin(b.name || b.id)`), `:2773`, `:2961`, `:3212` (all `escapeAdmin(a.companyName)`) — this is the one outlier among six render sites in the same file, not a systemic gap.
  - **RULES CONFIRMED**: `backend/app/otp/firebase_admin_ops.py:222-238`'s `ensure_company()` writes `companies/{id}.name` verbatim from the signup applicant's typed `companyName` field, with no HTML-safety sanitization — only a non-empty/≤200-char check (`app/otp/email_handler.py`). Any unauthenticated signup applicant founding a brand-new company (the normal, self-service "agent" signup flow) controls this value completely.
- **Impact**: An attacker signs up as an agent, types an XSS payload as their company name (well within the 200-char limit — `</option><img src=x onerror="...">` fits easily), and waits for any admin to open the "Add Agent" panel (which calls `populateCompanySelect()` to populate the company dropdown). The payload executes with full admin session privileges the moment the panel opens — no click, no admin awareness needed beyond opening a routine UI panel.
- **Root cause**: An isolated escaping omission in one of seven company-name render sites in the same file — the other six were done correctly.
- **Recommended remediation**: Not implemented this stage. Wrap `b.name` in `escAdmin(...)` (matching the neighboring branches-tab rendering's own convention) or `escapeAdmin(...)` — one-line fix, no design decision.
- **Confidence**: High.

---

### CLIENT-03 — Agent scan-log rendering is unescaped, currently safe only because its data source is hardcoded

- **Status**: CONFIRMED (as a latent gap, not a live vulnerability)
- **Type**: HARDENING — no exploit path exists today
- **Severity**: Low
- **Evidence**: CODE CONFIRMED — `admin.html:1208-1214` and `promo.html:183-`: both render a `localStorage`-persisted "scan log" (`darwesh_agent_scan_log`) via `` `<td>${e.name}</td><td>${e.id}</td>` `` with no escaping. The only writer of this key is `promo.html:198-208`, and its source is a **hardcoded** `<select>` of 4 fixed demo agent names (`promo.html:66-69`: "Ahmed Hassan — DG-101", etc.) — not Firestore data, not any form of user input. There is no injection path today.
- **Why this is worth flagging anyway**: this is clearly placeholder/demo content (a real deployment would presumably wire this dropdown to actual agent data), and the rendering code has zero escaping discipline waiting for that day — if this dropdown is ever populated from real agent records (`displayName`, which agents *do* control, per CLIENT-02's evidence), this becomes live stored XSS with no code-review signal to catch it, since the render function itself gives no indication it's currently "safe by accident."
- **Recommended remediation**: Not implemented this stage. Add the same escaping the rest of the codebase already applies to comparable fields, now, while it costs nothing — cheaper than remembering to add it later when this feature is wired to real data.
- **Confidence**: High for the "currently not exploitable" claim (verified no other writer of this localStorage key exists anywhere in the repo); High for the "will become exploitable if wired to real data" claim (the same `displayName` field is confirmed attacker-controllable, per CLIENT-02).

---

### CLIENT-04 — No Content-Security-Policy anywhere, and GitHub Pages' header limitation isn't actually the whole story

- **Status**: CONFIRMED (gap), with a previously-unexplored partial mitigation
- **Type**: HARDENING — defense-in-depth, not a standalone exploit
- **Severity**: Medium (as a missed defense-in-depth layer, given CLIENT-01/02 above are real XSS paths a CSP would have meaningfully contained)
- **Evidence**: CODE CONFIRMED — repo-wide search for `Content-Security-Policy` across all HTML: zero matches, in any form (no `<meta http-equiv>`, and INFRA-07 already established no HTTP header is possible on GitHub Pages).
- **What INFRA-07 didn't consider**: a CSP can also be delivered via `<meta http-equiv="Content-Security-Policy" content="...">` in each page's `<head>` — this doesn't require server header support at all, and GitHub Pages serves whatever HTML is committed, meta tag included. This is a real, available option INFRA-07's "no headers possible" framing didn't rule in or out, because it was scoped to HTTP headers specifically.
- **What a meta-delivered CSP can and can't do here, concretely**:
  - **Cannot do**: the `frame-ancestors`, `report-uri`/`report-to`, and `sandbox` directives are explicitly ignored by browsers when CSP is delivered via `<meta>` (a hard spec limitation, not a workaround-able gap) — so this can never provide clickjacking protection or violation reporting. That part of INFRA-07's conclusion stands regardless.
  - **Can do, and would meaningfully help**: `script-src`/`connect-src`/`img-src`/`font-src`/`object-src`/`base-uri` restricted to an explicit allowlist of the origins this site actually uses. This would not stop CLIENT-01/02's *injection* (both exploit this site's own already-trusted inline `<script>` execution, which a workable policy here would still have to allow — see below) but it would meaningfully **contain the blast radius**: an attacker's injected payload could no longer load an externally-hosted script from an attacker-controlled domain, exfiltrate data via `fetch()`/`img` to an arbitrary domain, or hijack the page via a rogue `<base>` tag — all real capabilities CLIENT-01/02's payloads would otherwise have.
  - **The real constraint**: this codebase's own architecture — no build step, no bundler, dozens of inline `<script>` and `<style>` blocks per page (confirmed by `scripts/ci-checks.js`'s own inline-script syntax check, which exists specifically because there are so many) — means a *strict* CSP (one that blocks inline script/style execution entirely, the part that would have stopped CLIENT-01/02's payloads directly) requires either a nonce (impossible with no per-request server logic on static GitHub Pages hosting) or a SHA-256 hash per inline block, computed and kept in lockstep with every future edit to any of those blocks across 21 pages — a real, ongoing maintenance burden in the same category as (and larger than) the SRI-staleness risk already discussed for INFRA-02/03. Not attempted here as a drop-in fix for the same reason those weren't force-applied without verification: a wrong policy silently breaks the site (every inline script stops running) rather than degrading gracefully.
- **Origins a policy would need**, gathered by direct inspection (not guessed) — for a future remediation pass:
  - `script-src`: `'self'`, `https://www.gstatic.com` (Firebase SDK, loaded via ES-module `import` inside local JS — CSP's `script-src` does still govern these fetches), `https://unpkg.com` (Leaflet, now SRI-pinned per INFRA-02), `https://www.google.com` (reCAPTCHA Enterprise, used by Firebase App Check)
  - `style-src`: `'self'`, `https://fonts.googleapis.com`, `https://unpkg.com` (leaflet.css)
  - `img-src`: `'self'`, `blob:` (photo-preview `URL.createObjectURL` in `sell.html`/`admin.html`), `https://firebasestorage.googleapis.com`, `https://lh3.googleusercontent.com`
  - `font-src`: `'self'`, `https://fonts.gstatic.com`
  - `connect-src`: `'self'`, `https://firestore.googleapis.com`, `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com`, `https://firebasestorage.googleapis.com`, `https://darwesh-backend-353477435585.me-central1.run.app` (the actual live backend origin, confirmed in `js/backend-config.js` — see CLIENT-05), `https://overpass-api.de`, `https://nominatim.openstreetmap.org` (geocoding, used in `admin.html`/`sell.html`/`map.html`), `https://www.google.com` (reCAPTCHA Enterprise)
  - `object-src 'none'`, `base-uri 'self'` — no known reason not to set these immediately; nothing in this codebase uses either.
  - `script-src`/`style-src` would additionally need `'unsafe-inline'` unless the inline-block hashing work above is done — a real, honest tradeoff, not a silent gap: this configuration is weaker than a strict CSP, but strictly stronger than having none.
- **Recommended remediation**: Not implemented this stage — a real architectural decision (accept the `'unsafe-inline'`-weakened but still meaningfully-restrictive version now, vs. invest in per-block hashing for a strict policy later) that shouldn't be guessed at. If you want the weaker-but-real version, the origin list above is ready to drop into a `<meta>` tag on all 21 pages.
- **Confidence**: High for the origin list (read directly from source, not inferred); High for the meta-tag mechanism and its `frame-ancestors`/reporting limitation (documented browser behavior, not implementation-specific).

---

### CLIENT-05 — Stale comment above the (already-live) production backend URL

- **Status**: CONFIRMED (minor, self-caught documentation drift — same category as INFRA-04/INFRA-08)
- **Type**: DATA INTEGRITY RISK (comment accuracy) — no functional issue
- **Severity**: Informational
- **Evidence**: CODE CONFIRMED — `js/backend-config.js`: `// TODO: replace with the real deployed backend origin once docs/BACKEND_MILESTONES.md milestone 2 (deployment) is done.` sits directly above `const PRODUCTION_BACKEND_BASE_URL = 'https://darwesh-backend-353477435585.me-central1.run.app';` — which **is** the real, currently-live backend origin (confirmed this session — this is the exact URL that answered `/api/v1/health` during this session's INFRA-01 production verification). The TODO describes work that has already been done.
- **Impact**: None functional — purely a "this comment's stated precondition is now false, worth someone re-deciding whether it's still accurate" flag, exactly like INFRA-08's HSTS-preload comment. A future contributor reading this file at face value might wrongly believe the backend isn't really deployed yet.
- **Recommended remediation**: Not implemented this stage — a one-line comment edit, flagged here since it surfaced directly from this stage's own investigation (tracing `connect-src` origins for CLIENT-04).
- **Confidence**: High.

---

## Investigated and found clean (not findings — stated so nothing here reads as unchecked)

- **`eval()`, `new Function()`, `setTimeout`/`setInterval` with a string argument, `document.write()`**: zero occurrences anywhere in this codebase's own HTML/JS (repo-wide grep). No dynamic-code-execution vector beyond `innerHTML` itself.
- **`postMessage` listeners**: none in application code (the only matches were vendored Python package files, irrelevant to this frontend).
- **URL-parameter-to-DOM flows** (`location.search`/`location.hash`/`URLSearchParams`): checked in every file that uses them (`admin.html`, `listing.html`, `buy.html`, `mam-ai.html`, `map.html`) — no case found where a URL parameter's raw value reaches `innerHTML` or an attribute unescaped.
- **Public listing card rendering** (`buy.html`'s `card()`, `index.html`'s `featuredCard()`, `map.html`'s equivalent) — the single highest-traffic, most attacker-relevant render path on the whole site (every anonymous visitor, every listing field agent-controllable) — correctly escapes every text field via `escapeHtml()` and validates image URLs via `isSafeHttpUrl()` (blocks `javascript:`/`data:` as an `<img src>`/`<a href>`) before use.
- **`sell.html`'s own review-step self-preview**, **`agent-dashboard.html`'s** entire financial/listing tables, **`js/notification-bell.js`'s** notification panel — all consistently escape every attacker-controllable field via a local escaping function before use.
- **`mam-ai.html`'s "AI" responses**: not actually free-form LLM output — `searchReply()` and similar functions are deterministic, rule-based JS returning fixed response templates with only numeric/city data interpolated (properly escaped) and hardcoded internal `href` targets (`'buy.html'`, never attacker- or model-influenced). The theoretical "LLM echoes injected input into unescaped HTML" risk this stage set out to check for doesn't apply — there's no generative model in this render path at all.
- **`account.html`'s favorites/submissions rendering**: uses the inherently-safe `document.createElement()` + `.textContent =` pattern throughout, not string-built `innerHTML` — immune to this entire class of bug by construction.
- **Escaping-function correctness**: 8 separate local implementations exist across the codebase (`escapeHtml` in 5 files, `escapeAdmin`/`escAdmin`/`escapeFin`/`escapeReview` one each) — all 8 independently verified correct (either the `div.textContent → innerHTML` browser-native trick, or a manual regex covering all of `&<>"'`). None has an escaping gap. The duplication itself (7 reimplementations of a concept a shared `js/escape-html.js` module already provides and 4 pages already import) is a maintainability smell worth simplifying eventually, not a security finding — flagged here for completeness, not as a numbered finding.

---

## Summary

### Confirmed High
- **CLIENT-01** — Unescaped `city` field, stored XSS on the public, unauthenticated Insights page.
- **CLIENT-02** — Unescaped company name, stored XSS in the admin session.

### Confirmed Low / Hardening
- **CLIENT-03** — Scan-log rendering unescaped but currently safe (hardcoded data source) — fix now before it's wired to real data.
- **CLIENT-04** — No CSP anywhere; a partial, meta-tag-deliverable policy is feasible and would contain (not prevent) exactly the kind of payload CLIENT-01/02 demonstrate is real.

### Informational
- **CLIENT-05** — Stale TODO comment above an already-live production URL.

### False positives ruled out (with evidence, not assumed safe)
- `escAdmin` vs. `escapeAdmin` naming difference in `admin.html` — two independently-correct implementations, not a bug.
- `SERVICES_STATUS_LABEL_FN()[s.status] || s.status` fallback in `admin.html` — `status` is rules-constrained to `'pending'` or admin-set values only, never attacker text.
- `img.src = f.img` in `account.html` with no protocol check — `<img src>` doesn't execute `javascript:`/`data:` URIs the way `<a href>`/`<iframe src>` would; a missing check here is a robustness nitpick, not an XSS vector.
- MAM AI chat: no generative-model output reaches the DOM unescaped, because there is no generative-model output in this render path at all.

### Exact checks performed
- Repo-wide inventory: every `.innerHTML =`/`.outerHTML =`/`insertAdjacentHTML(` across all `*.html` and `js/*.js` (111 sites, 16 files, 0 `outerHTML`/`insertAdjacentHTML` uses).
- Read and traced data flow for every site in `admin.html` (49), `agent-dashboard.html` (15), `sell.html` (12), `insights.html` (8), `mam-ai.html` (4), and every site in `buy.html`, `map.html`, `index.html`, `services.html`, `account.html`, `listing.html`, `js/notification-bell.js`, `js/i18n.js`, `js/city-nav.js`, `profile.html` (47 more, all files with an `innerHTML` site covered).
- Cross-checked every "is this data attacker-controllable" question against the actual `firestore.rules` text and the actual backend write-path code (`firebase_admin_ops.py`), not assumed either way.
- Repo-wide grep for `eval(`, `new Function(`, string-argument `setTimeout`/`setInterval`, `document.write(`, and `addEventListener('message'`.
- Repo-wide grep for `location.search`/`location.hash`/`URLSearchParams`/`new URL(` and traced each file's usage.
- Located and read all 8 escaping-function implementations in full.
- Gathered the complete, accurate list of external origins this site's client code actually contacts, for the CSP feasibility analysis (not guessed — read directly from `js/firebase-init.js`, `admin.html`, `sell.html`, `map.html`, `js/backend-config.js`).

---

Stopping here — this is Stage 6's review only, matching the established pattern (analysis first, remediation on request). No fixes were applied.
