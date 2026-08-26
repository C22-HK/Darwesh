# Darwesh Group — Security Audit

Defensive audit of the code and configuration as they exist in this
repository today. No destructive testing was performed; findings are
from direct code/rules inspection and, where noted, live read-only
verification (public Firestore reads, public Storage bucket-existence
checks).

Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## CRITICAL — none found

No committed secrets, no `allow read, write: if true;` patterns, no
path that lets a client write its own `role`, `assignedAgentId`, or
`companyId`, no way for a customer or agent to reach another user's
private data.

## HIGH

**H1 — Storage bucket not provisioned (availability, not confidentiality).**
Every photo upload on the live site fails. Not an exploitable
vulnerability, but a real production defect blocking a core feature
(Sell submissions, listing photos, profile photos). Fix: provision the
bucket in Firebase Console → Storage → Get started. Tracked separately,
outside this audit's scope to fix directly (requires Console access).

## MEDIUM

**M1 — No Firebase App Check.** Nothing currently stops a script from
calling the Firestore/Storage/Auth REST APIs directly with the public
Web API key, bypassing this site's UI entirely (the key is meant to be
public — protection comes from Security Rules, not from hiding the
key — but App Check adds a second layer that verifies requests are
coming from this actual web app, cutting down scripted abuse). Free to
enable (reCAPTCHA v3-backed), no backend required.

**M2 — Two orphaned pages are publicly reachable.** `verification.html`
and `profile.html` are not linked from anywhere but are still served at
their URLs, showing fabricated placeholder data (a fake "Omar Darwesh"
identity, a fake "Qaiwan Towers" listing). Not a data leak — nothing
real is exposed — but confusing/unprofessional if found (e.g. by a
search engine crawler or a curious visitor guessing URLs). Previously
raised; user chose to leave them for now.

**M3 — No rate limiting on `agentTransactions`/`listings` writes beyond
Firestore's own project-wide quota.** An authenticated agent could
technically script a large number of writes to their own ledger or
listings faster than a human would. Bounded by the fact that every
write still requires a real signed-in agent account and only affects
that agent's own data (enforced by rules) — low real-world impact at
current scale, but worth knowing this isn't actively throttled.

## LOW

**L1 — No security headers possible.** GitHub Pages doesn't support
custom response headers, so no CSP/HSTS/`X-Content-Type-Options`/
`Referrer-Policy`/`Permissions-Policy`. Mitigating factor: this is a
pure static site with no user-generated HTML rendering (all dynamic
content is inserted via `textContent`/template literals into fixed
markup, not via `eval` or unsanitized `innerHTML` of user input in the
paths reviewed) — so the actual XSS surface this would protect against
is already narrow. Would require moving hosting behind a platform that
supports custom headers (e.g. Cloudflare Pages, Netlify) to fix.

**L2 — No MFA option for admin/agent accounts.** Privileged accounts
(admin, agent) authenticate the same way as customers. Firebase Auth
supports TOTP/phone MFA natively; not currently enabled. Worth doing
for the small number of real admin/agent accounts specifically, and
notably does **not** require a backend — it's a Firebase Auth
configuration + a bit of client code.

**L3 — Some dynamic table rendering elsewhere in the codebase
(`agent-dashboard.html`'s `loadMyListings`/`loadTeamListings`, predating
this session) interpolates listing `title`/`address` into `innerHTML`
without escaping.** These values come from the listing's own
agent/admin (not arbitrary public input), and creating a listing already
requires an authenticated agent/admin account, but it's still
inconsistent with the escaping discipline used elsewhere (e.g. the
Finances tab, MAM AI's chat log). Low risk, worth a follow-up cleanup
pass rather than urgent.

## INFO

- Password hashing, reset-token generation/expiry/single-use
  enforcement, and login/reset rate limiting are all Firebase Auth's
  responsibility (server-side, not inspectable/replaceable from this
  codebase) — this is correct and should stay this way; reimplementing
  any of it client-side would be a downgrade, not an improvement.
- `firestore.rules`/`storage.rules` were reviewed field-by-field this
  session: role/company/agent-assignment are locked against
  self-modification on `users/{uid}`; `listings` writes require
  `agentId == request.auth.uid` (or admin) at both create and
  update/delete; `agentTransactions` are strictly owner+admin scoped;
  `submissions` are readable only by their own creator or an admin.
  This is genuine, rules-engine-enforced server-side authorization —
  not merely hidden UI.
- No API keys or credentials of any kind are committed to this repo
  beyond the Firebase Web config (`apiKey`, `authDomain`, etc. in
  `js/firebase-init.js`), which is designed to be public — Firebase's
  own documentation is explicit that this value is not a secret;
  security comes from Security Rules and (optionally) App Check/domain
  restrictions, not from hiding it.
