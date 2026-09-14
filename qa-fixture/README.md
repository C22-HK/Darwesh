# QA fixture harness (TEST-ONLY)

Renders the real, unmodified `admin.html` against deterministic synthetic
data instead of a live Firebase project + backend, so the Admin Panel can be
visually and functionally QA'd without network access to production
infrastructure. **Never used by production** — none of the files this
directory contains are referenced from `admin.html` or any other shipped
page; they are only ever served by Playwright's own route interception
below.

## What it is

- `fixtures.js` — deterministic fixture records (People/Users, Properties/
  Listings, Brokerage/Discount accounts). Clearly test data (`qa-u-*`,
  `qa-l-*` uids, `.test` emails) — never mistake it for real production
  records.
- `fake-firebase-*.js` — minimal fakes of the modular Firebase JS SDK
  surface (`app`, `app-check`, `auth`, `firestore`, `storage`) that
  `admin.html` imports from `www.gstatic.com/firebasejs/...`.
- `fake-firebase-init.js` — fake replacement for `js/firebase-init.js`.
  Stamps a fixed, unmissable red "QA FIXTURE DATA — not production Firebase
  data" banner on every page it renders, so a screenshot can never be
  mistaken for a production capture.
- `run-qa-screenshots.mjs` — the Playwright harness. Launches Chromium,
  intercepts every request via `context.route('**/*', ...)` (no real HTTP
  server process), and serves: the real site files from disk, the fake
  Firebase SDK modules above in place of the gstatic imports, and an
  in-memory fixture-backed fake of the `/api/v1/brokerage/*` backend
  endpoints (mirroring `js/backend-api.js`'s real calls). Runs a matrix of
  viewport × language combinations, a functional interaction pass (search,
  filters, bulk select, row action menus, delete/remove confirmation
  dialogs, keyboard nav + Escape), an RTL numeric-isolation check, and a
  mobile card-layout check — then writes screenshots to `screenshots/` and
  a machine-readable `report.json`.

## Running it

```
node qa-fixture/run-qa-screenshots.mjs
```

Requires `playwright` (already a repo dependency) and the pre-installed
Chromium at `/opt/pw-browsers/chromium`. No live Firebase project, backend
server, or network reachability is required — everything is served locally
or faked.

Set `QA_DEBUG_ONE=1` to run only the `1440/en` combination (fast iteration
while debugging a single check).

Exit code is non-zero if any check fails; failures are also listed by name
at the end of the run.

## Why this exists

Building admin-facing UI against a real Firebase project requires either
live credentials or a reachable emulator — neither is available in every
environment this repository is worked in. This harness lets the same real
`admin.html`, `js/admin-*.js`, and `css/admin-shell.css` files be rendered
and interactively exercised end-to-end (not just statically inspected)
without either of those, while guaranteeing zero production impact: nothing
here is imported by any shipped page, and it only ever runs inside a
Playwright-controlled browser context that this script itself creates.
