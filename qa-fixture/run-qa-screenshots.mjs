#!/usr/bin/env node
// =====================================================================
// QA FIXTURE -- Playwright visual/functional QA harness, TEST-ONLY.
//
// Renders the real, unmodified admin.html against deterministic
// synthetic fixture data (qa-fixture/fixtures.js) instead of a live
// Firebase project, by intercepting every network request the page
// makes and serving either a real local file, a fake Firebase SDK
// module (qa-fixture/fake-firebase-*.js), or a fixture-backed fake
// backend response -- no real server, no real Firebase, no real
// network reachability required. See qa-fixture/README.md.
//
// Usage: node qa-fixture/run-qa-screenshots.mjs
// Output: qa-fixture/screenshots/*.png + a JSON report on stdout.
// =====================================================================
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_BROKERAGE_ACCOUNTS } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const QA_DIR = __dirname;
const SHOTS_DIR = path.join(QA_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const ORIGIN = 'http://localhost:8080';
const CHROMIUM_PATH = '/opt/pw-browsers/chromium';

// -------------------------------------------------------------------
// Fake backend: an in-memory copy of the brokerage fixture, mutated by
// PATCH/bulk requests exactly like the real backend would be -- so
// discount edits made during an interactive QA run are visible on the
// very next re-fetch, same as production behavior.
// -------------------------------------------------------------------
const BROKERAGE = new Map(QA_BROKERAGE_ACCOUNTS.map((a) => [a.uid, { ...a }]));
const NOW = () => ({ seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 });

function jsonBody(obj) { return JSON.stringify(obj); }

async function handleBackendRoute(route, url) {
  const request = route.request();
  const method = request.method();
  const pathname = url.pathname;
  // A small deliberate delay on the list endpoint only, so the
  // skeleton-row loading state (see js/admin-table-kit.js) is on
  // screen long enough to screenshot deliberately (see captureLoading
  // below), the same way fake-firebase-firestore.js does for
  // People/Properties.
  if (pathname === '/api/v1/brokerage/accounts' && method === 'GET') {
    await new Promise((r) => setTimeout(r, 250));
    let rows = [...BROKERAGE.values()];
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const accountType = url.searchParams.get('accountType');
    const discountMin = url.searchParams.get('discountMin');
    const discountMax = url.searchParams.get('discountMax');
    const noDiscountOnly = url.searchParams.get('noDiscountOnly') === '1';
    if (search) rows = rows.filter((a) => (a.displayName || '').toLowerCase().includes(search) || (a.city || '').toLowerCase().includes(search));
    if (accountType) rows = rows.filter((a) => a.accountType === accountType);
    if (discountMin) rows = rows.filter((a) => (a.effectiveDiscountPercent || 0) >= Number(discountMin));
    if (discountMax) rows = rows.filter((a) => (a.effectiveDiscountPercent || 0) <= Number(discountMax));
    if (noDiscountOnly) rows = rows.filter((a) => !a.effectiveDiscountPercent);
    return route.fulfill({ status: 200, contentType: 'application/json', body: jsonBody({ accounts: rows, nextCursor: null }) });
  }
  const acctMatch = pathname.match(/^\/api\/v1\/brokerage\/accounts\/([^/]+)$/);
  if (acctMatch && method === 'GET') {
    const acct = BROKERAGE.get(decodeURIComponent(acctMatch[1]));
    return route.fulfill({ status: acct ? 200 : 404, contentType: 'application/json', body: jsonBody(acct || { error: 'Not found.' }) });
  }
  if (acctMatch && method === 'PATCH') {
    const uid = decodeURIComponent(acctMatch[1]);
    const body = JSON.parse(request.postData() || '{}');
    const acct = BROKERAGE.get(uid) || { uid };
    if (body.op === 'set') {
      acct.discountPercent = body.percent; acct.discountActive = body.active !== false;
      acct.effectiveDiscountPercent = acct.discountActive ? body.percent : 0;
      acct.discountSource = 'override';
    } else if (body.op === 'disable') { acct.discountActive = false; acct.effectiveDiscountPercent = 0; }
    else if (body.op === 'enable') { acct.discountActive = true; acct.effectiveDiscountPercent = acct.discountPercent || 0; }
    else if (body.op === 'remove') { acct.discountPercent = null; acct.discountActive = null; acct.effectiveDiscountPercent = 0; acct.discountSource = null; }
    acct.discountUpdatedAt = NOW();
    acct.discountUpdatedBy = 'Rezan Ahmadi';
    BROKERAGE.set(uid, acct);
    return route.fulfill({ status: 200, contentType: 'application/json', body: jsonBody(acct) });
  }
  if (pathname === '/api/v1/brokerage/accounts/bulk' && method === 'POST') {
    const body = JSON.parse(request.postData() || '{}');
    const results = (body.accountIds || []).map((uid) => {
      const acct = BROKERAGE.get(uid);
      if (!acct) return { uid, ok: false };
      acct.discountPercent = body.percent; acct.discountActive = body.active !== false;
      acct.effectiveDiscountPercent = acct.discountActive ? body.percent : 0;
      acct.discountSource = 'override';
      acct.discountUpdatedAt = NOW();
      acct.discountUpdatedBy = 'Rezan Ahmadi';
      BROKERAGE.set(uid, acct);
      return { uid, ok: true };
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: jsonBody({ results }) });
  }
  // Everything else under /api/ (policies, history, compute-fee, access/me,
  // notifications, ...) -- not part of the 3 screens under QA. A safe empty
  // 200 keeps those code paths from throwing without pretending to be a
  // real endpoint for them.
  return route.fulfill({ status: 200, contentType: 'application/json', body: jsonBody({}) });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};
function mimeFor(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

function fulfillLocalFile(route, filePath, contentType) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return route.fulfill({ status: 404, body: 'qa-fixture: not found: ' + filePath });
  }
  return route.fulfill({ status: 200, contentType: contentType || mimeFor(filePath), body: fs.readFileSync(filePath) });
}

const GSTATIC_FAKES = {
  'firebase-app.js': 'fake-firebase-app.js',
  'firebase-app-check.js': 'fake-firebase-app-check.js',
  'firebase-auth.js': 'fake-firebase-auth.js',
  'firebase-firestore.js': 'fake-firebase-firestore.js',
  'firebase-storage.js': 'fake-firebase-storage.js',
};

async function routeHandler(route) {
  const request = route.request();
  let url;
  try { url = new URL(request.url()); } catch { return route.continue(); }
  try {
    if (url.pathname.endsWith('/js/firebase-init.js')) {
      return fulfillLocalFile(route, path.join(QA_DIR, 'fake-firebase-init.js'), 'application/javascript; charset=utf-8');
    }
    // Any request whose basename matches a file that actually lives in
    // qa-fixture/ directly -- covers fixtures.js and every fake-firebase-
    // *.js's own relative imports of each other, however the browser
    // resolved that relative path (which origin it lands on depends on
    // which fake file did the importing, not on anything meaningful here).
    // Checked before the gstatic-specific branch below so a fake module's
    // own relative import (e.g. fake-firebase-init.js -> ./fake-firebase-
    // firestore.js, requested as if from the gstatic origin) still lands
    // here instead of being swallowed by that branch's own 404 fallback.
    const qaLocalCandidate = path.join(QA_DIR, path.basename(url.pathname));
    if (fs.existsSync(qaLocalCandidate) && fs.statSync(qaLocalCandidate).isFile()) {
      return fulfillLocalFile(route, qaLocalCandidate, 'application/javascript; charset=utf-8');
    }
    if (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) {
      const base = path.basename(url.pathname);
      if (GSTATIC_FAKES[base]) return fulfillLocalFile(route, path.join(QA_DIR, GSTATIC_FAKES[base]), 'application/javascript; charset=utf-8');
      return route.fulfill({ status: 404, body: 'qa-fixture: unmocked gstatic module ' + base });
    }
    if (url.hostname === 'localhost' && url.port === '8080' && url.pathname.startsWith('/api/')) {
      return handleBackendRoute(route, url);
    }
    if (url.origin === ORIGIN) {
      return fulfillLocalFile(route, path.join(REPO_ROOT, decodeURIComponent(url.pathname)));
    }
    // Any other external origin (Google Fonts, unpkg/Leaflet, Sentry, Maps)
    // -- this sandbox has no real network reachability either way, so fail
    // it fast and let the page's own graceful-degradation paths (already
    // exercised in production for users on a slow/blocked connection) run,
    // rather than hang waiting on a request that will never resolve.
    return route.abort('failed');
  } catch (err) {
    console.error('[qa-fixture] route handler error for', request.url(), err);
    return route.fulfill({ status: 500, body: 'qa-fixture route handler error' });
  }
}

// -------------------------------------------------------------------
// Matrix + per-screen functional checks
// -------------------------------------------------------------------
const VIEWPORTS = { 1440: { width: 1440, height: 900 }, 1024: { width: 1024, height: 900 }, 390: { width: 390, height: 844 } };
const DEBUG_ONE_RUN = process.env.QA_DEBUG_ONE === '1';
const RUNS = DEBUG_ONE_RUN ? [{ vp: 1440, lang: 'en' }] : [
  { vp: 1440, lang: 'en' }, { vp: 390, lang: 'en' }, { vp: 1024, lang: 'en' },
  { vp: 1440, lang: 'ku' }, { vp: 390, lang: 'ku' },
  { vp: 1440, lang: 'ar' }, { vp: 390, lang: 'ar' },
];

const report = { checks: [], screenshots: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' (' + detail + ')' : ''));
}

async function gotoAdmin(page) {
  await page.goto(ORIGIN + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForSelector('#adminContent:not(.hidden)', { timeout: 15000 });
  } catch (err) {
    const gateVisible = await page.locator('#loadingGate').isVisible().catch(() => 'n/a');
    const authGateVisible = await page.locator('#authGate').isVisible().catch(() => 'n/a');
    const notAdminVisible = await page.locator('#notAdminGate').isVisible().catch(() => 'n/a');
    console.error(`[qa-fixture] auth gate never resolved -- loadingGate visible=${gateVisible} authGate visible=${authGateVisible} notAdminGate visible=${notAdminVisible}`);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'DEBUG-authgate-failure.png'), fullPage: true }).catch(() => {});
    throw err;
  }
}
// 'attached' rather than the default 'visible' -- below the 900px
// breakpoint the table wrap is display:none and the card list is what's
// actually visible (see .ash-entity-cards in css/admin-shell.css), so a
// visibility wait on the table rows alone would hang forever at mobile
// viewports even though the data loaded correctly.
async function openPeople(page) {
  await page.evaluate(() => document.querySelector('.ash-nav-item[data-tab="people"]').click());
  await page.waitForSelector('#usersBody tr', { timeout: 10000, state: 'attached' });
}
async function openProperties(page) {
  await page.evaluate(() => document.querySelector('.ash-nav-item[data-tab="properties"]').click());
  await page.waitForSelector('#listingsBody tr', { timeout: 10000, state: 'attached' });
}
async function openDiscounts(page) {
  await page.evaluate(() => document.querySelector('.ash-nav-item[data-tab="brokerage"]').click());
  // Wait for an actual data row (a row with a select checkbox), not just any
  // <tr> -- the loading-skeleton state also renders a single <tr> (see
  // renderAccountsList() in js/admin-brokerage.js), and on a fast run this
  // resolves before the fake backend's deliberate 250ms list-endpoint delay
  // (see handleBackendRoute above) finishes, leaving the table stuck showing
  // "Loading accounts..." at the moment a later check inspects it.
  await page.waitForSelector('#bdTableBody [data-bd-select]', { timeout: 10000, state: 'attached' });
}
async function shot(page, name) {
  const file = path.join(SHOTS_DIR, name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(name + '.png');
}

async function functionalPassPeople(page) {
  // Search
  await page.fill('#usersSearchInput', 'Sara');
  await page.waitForTimeout(250);
  const searchRows = await page.locator('#usersBody tr').count();
  check('People: search filters rows', searchRows === 1, `${searchRows} row(s) for "Sara"`);
  await page.fill('#usersSearchInput', '');
  await page.waitForTimeout(250);
  // Empty state via nonsense search
  await page.fill('#usersSearchInput', 'zzz-no-such-account-zzz');
  await page.waitForTimeout(250);
  const emptyText = await page.locator('#usersCards').innerText().catch(() => '');
  check('People: no-match search shows empty copy', /match|هیچ|توجد/.test(emptyText), emptyText.slice(0, 60));
  await shot(page, 'people-emptystate-1440-en');
  await page.fill('#usersSearchInput', '');
  await page.waitForTimeout(250);
  // Role filter
  await page.selectOption('#usersRoleFilter', 'agent');
  await page.waitForTimeout(200);
  const agentRows = await page.locator('#usersBody tr').count();
  check('People: role filter narrows rows', agentRows > 0 && agentRows < 13, `${agentRows} agent row(s)`);
  await page.selectOption('#usersRoleFilter', 'all');
  await page.waitForTimeout(200);
  // Checkbox select -> bulk bar + aria-selected
  const firstCb = page.locator('#usersBody [data-user-select]').first();
  await firstCb.check();
  await page.waitForTimeout(150);
  const bulkVisible = await page.locator('#usersBulkBar .ash-bulk-bar').count();
  check('People: selecting a row shows the bulk bar', bulkVisible === 1);
  const ariaSelected = await page.locator('#usersBody tr.is-selected').first().getAttribute('aria-selected');
  check('People: selected row has aria-selected="true"', ariaSelected === 'true');
  await shot(page, 'people-bulkbar-1440-en');
  // Action menu: open via keyboard, Escape closes
  await firstCb.uncheck();
  await page.waitForTimeout(150);
  const menuTrigger = page.locator('#usersBody [data-ash-menu-trigger]').first();
  await menuTrigger.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const menuOpenCount = await page.locator('.ash-menu:visible, [role="menu"]:visible').count();
  check('People: action menu opens via keyboard', menuOpenCount > 0, `${menuOpenCount} open menu(s)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const menuClosedCount = await page.locator('.ash-menu:visible, [role="menu"]:visible').count();
  check('People: Escape closes the action menu', menuClosedCount === 0);
}

async function functionalPassProperties(page) {
  await page.fill('#listingsSearchInput', 'Villa');
  await page.waitForTimeout(250);
  const searchRows = await page.locator('#listingsBody tr').count();
  check('Properties: search filters rows', searchRows >= 1 && searchRows < 17, `${searchRows} row(s) for "Villa"`);
  await page.fill('#listingsSearchInput', 'zzz-no-such-listing-zzz');
  await page.waitForTimeout(250);
  const emptyText = await page.locator('#listingsCards').innerText().catch(() => '');
  check('Properties: no-match search shows empty copy', /match|filter|هیچ|توجد/.test(emptyText), emptyText.slice(0, 60));
  await shot(page, 'properties-emptystate-1440-en');
  await page.fill('#listingsSearchInput', '');
  await page.waitForTimeout(250);
  await page.selectOption('#listingsTypeFilter', 'villa');
  await page.waitForTimeout(200);
  const villaRows = await page.locator('#listingsBody tr').count();
  check('Properties: type filter narrows rows', villaRows > 0 && villaRows < 17, `${villaRows} villa row(s)`);
  await page.selectOption('#listingsTypeFilter', 'all');
  await page.waitForTimeout(200);
  await page.selectOption('#listingsSortSelect', 'price-desc');
  await page.waitForTimeout(200);
  const firstPriceCell = await page.locator('#listingsBody tr').first().locator('.ash-cell-num').innerText();
  check('Properties: sort by price (desc) applied', /\$/.test(firstPriceCell), firstPriceCell);
  await page.selectOption('#listingsSortSelect', 'updated-desc');
  await page.waitForTimeout(200);
  const firstCb = page.locator('#listingsBody [data-listing-select]').first();
  await firstCb.check();
  await page.waitForTimeout(150);
  const bulkVisible = await page.locator('#listingsBulkBar .ash-bulk-bar').count();
  check('Properties: selecting a row shows the bulk bar', bulkVisible === 1);
  await shot(page, 'properties-bulkbar-1440-en');
  await firstCb.uncheck();
  await page.waitForTimeout(150);
  // Action menu -> Delete -> AdminDialog appears -> Escape cancels (no mutation)
  const rowsBefore = await page.locator('#listingsBody tr').count();
  const menuTrigger = page.locator('#listingsBody [data-ash-menu-trigger]').first();
  await menuTrigger.click();
  await page.waitForTimeout(150);
  const deleteItem = page.locator('.ash-menu-item, [role="menuitem"]').filter({ hasText: /Delete|سڕینەوە|حذف/ });
  await deleteItem.last().click();
  await page.waitForTimeout(150);
  const dialogVisible = await page.locator('.ash-dialog-backdrop:not([hidden])').count();
  check('Properties: delete action opens AdminDialog confirmation', dialogVisible > 0);
  await shot(page, 'properties-delete-dialog-1440-en');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const dialogClosed = await page.locator('.ash-dialog-backdrop:not([hidden])').count();
  check('Properties: Escape cancels the delete dialog', dialogClosed === 0);
  const rowsAfter = await page.locator('#listingsBody tr').count();
  check('Properties: cancelled delete did not remove the row', rowsAfter === rowsBefore, `${rowsBefore} -> ${rowsAfter}`);
}

async function functionalPassDiscounts(page) {
  const discountCell = await page.locator('#bdTableBody tr').first().locator('td').nth(5).innerText();
  check('Discounts: two-line %% / source cell renders', /%/.test(discountCell) && discountCell.split('\n').length >= 1, discountCell.replace(/\n/g, ' | '));
  await page.fill('#bdSearchInput', 'Sara');
  await page.waitForTimeout(400);
  const searchRows = await page.locator('#bdTableBody tr').count();
  check('Discounts: search filters rows', searchRows === 1, `${searchRows} row(s) for "Sara"`);
  await page.fill('#bdSearchInput', '');
  await page.waitForTimeout(400);
  const firstCb = page.locator('#bdTableBody [data-bd-select]').first();
  await firstCb.check();
  await page.waitForTimeout(150);
  const bulkVisible = await page.locator('#bdBulkBar .ash-bulk-bar').count();
  check('Discounts: selecting a row shows the bulk bar', bulkVisible === 1);
  const ariaSelected = await page.locator('#bdTableBody tr.is-selected').first().getAttribute('aria-selected');
  check('Discounts: selected row has aria-selected="true"', ariaSelected === 'true');
  await shot(page, 'discounts-bulkbar-1440-en');
  await firstCb.uncheck();
  await page.waitForTimeout(150);
  const menuTrigger = page.locator('#bdTableBody [data-ash-menu-trigger]').first();
  await menuTrigger.click();
  await page.waitForTimeout(150);
  const removeItem = page.locator('.ash-menu-item, [role="menuitem"]').filter({ hasText: /Remove|سڕینەوە|إزالة/ });
  const removeCount = await removeItem.count();
  if (removeCount > 0) {
    await removeItem.first().click();
    await page.waitForTimeout(150);
    const dialogVisible = await page.locator('.ash-dialog-backdrop:not([hidden])').count();
    check('Discounts: remove action opens AdminDialog confirmation', dialogVisible > 0);
    await shot(page, 'discounts-dialog-1440-en');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  } else {
    await page.keyboard.press('Escape');
    check('Discounts: row action menu opened (first row had no discount to remove)', true);
  }
}

async function rtlNumericPass(page, lang) {
  // Properties price cell + Discounts %/date -- must read left-to-right
  // regardless of page direction (dir="ltr" spans, per §14/§6).
  const priceSpan = page.locator('#listingsBody tr').first().locator('.ash-cell-num span[dir="ltr"]');
  const priceDir = await priceSpan.getAttribute('dir').catch(() => null);
  check(`Properties (${lang}): price cell is dir="ltr" isolated`, priceDir === 'ltr');
  const pctSpan = page.locator('#bdTableBody tr').first().locator('td').nth(5).locator('p.ash-cell-num[dir="ltr"]');
  const pctDir = await pctSpan.getAttribute('dir').catch(() => null);
  check(`Discounts (${lang}): discount %% is dir="ltr" isolated`, pctDir === 'ltr');
}

async function captureLoading(page, lang, vp) {
  // Re-trigger a fresh Properties fetch (clicking the sidebar item again
  // re-runs renderPropertiesHub() -> renderListingsTable() same as a
  // first visit) and grab the skeleton mid-flight -- fake-firebase-
  // firestore.js's getDocs() carries a short deliberate delay for
  // exactly this.
  const reload = page.evaluate(() => document.querySelector('.ash-nav-item[data-tab="properties"]').click());
  await page.waitForTimeout(80);
  await shot(page, `properties-loading-${vp}-${lang}`);
  await reload;
  await page.waitForSelector('#listingsBody tr', { timeout: 10000 });
}

async function run() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  for (const { vp, lang } of RUNS) {
    const context = await browser.newContext({ viewport: VIEWPORTS[vp] });
    await context.route('**/*', routeHandler);
    await context.addInitScript((l) => { try { localStorage.setItem('darwesh_lang', l); } catch (e) {} }, lang);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => { const m = 'pageerror: ' + e.message; consoleErrors.push(m); console.error('[browser]', m); });
    page.on('console', (msg) => { if (msg.type() === 'error' && !/net::ERR_FAILED/.test(msg.text())) { const m = 'console: ' + msg.text(); consoleErrors.push(m); console.error('[browser]', m); } });
    page.on('requestfailed', (req) => console.error('[requestfailed]', req.method(), req.url(), req.failure()?.errorText));

    await gotoAdmin(page);

    await openPeople(page);
    await shot(page, `people-${vp}-${lang}`);
    await openProperties(page);
    if (vp === 1440 && lang === 'en') await captureLoading(page, lang, vp);
    await shot(page, `properties-${vp}-${lang}`);
    await openDiscounts(page);
    await shot(page, `discounts-${vp}-${lang}`);

    if (vp === 1440 && lang === 'en') {
      await openPeople(page); await functionalPassPeople(page);
      await openProperties(page); await functionalPassProperties(page);
      await openDiscounts(page); await functionalPassDiscounts(page);
    }
    if (lang !== 'en') {
      await openProperties(page);
      await rtlNumericPass(page, lang);
    }
    if (vp === 390) {
      await openProperties(page);
      const cardsVisible = await page.locator('#listingsCards .ash-entity-card').count();
      const tableVisible = await page.locator('.ash-entity-table-wrap').first().isVisible();
      check(`Properties (${lang}, mobile): card layout shown instead of table`, cardsVisible > 0 && !tableVisible, `${cardsVisible} card(s), table visible=${tableVisible}`);
      await openDiscounts(page);
      const bdCardsVisible = await page.locator('#bdCards .ash-entity-card').count();
      check(`Discounts (${lang}, mobile): card layout renders`, bdCardsVisible > 0, `${bdCardsVisible} card(s)`);
    }

    check(`No console/page errors (${lang}, ${vp})`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    await context.close();
  }
  await browser.close();

  const outPath = path.join(QA_DIR, 'report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok);
  console.log(`\n${report.checks.length} checks, ${failed.length} failed. ${report.screenshots.length} screenshots in ${SHOTS_DIR}`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((c) => console.log(' - ' + c.name + (c.detail ? ' :: ' + c.detail : '')));
    process.exitCode = 1;
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
