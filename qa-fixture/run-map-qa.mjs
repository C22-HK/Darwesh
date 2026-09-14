#!/usr/bin/env node
// =====================================================================
// QA FIXTURE -- map.html layout/layering regression harness, TEST-ONLY.
//
// Renders the real, unmodified map.html against the same fake-Firebase
// route-interception technique as run-qa-screenshots.mjs (see that
// file's header), plus a local vendored Leaflet (node_modules/leaflet,
// a real devDependency -- see package.json) served in place of the
// unpkg.com CDN, since this sandbox has no route to unpkg.com.
//
// Purpose: regression-guard the Save-as-Alert-modal-vs-Leaflet
// stacking bug (the modal used to render BEHIND the map because
// css/tailwind.css's compiled bundle was missing the z-[1300]/z-[1100]
// arbitrary-value rules -- see the "Layer scale" comment in map.html's
// own <style> block for the full root-cause writeup) and capture the
// §21 QA-matrix screenshots for the map layout/UI repair pass.
//
// Usage: node qa-fixture/run-map-qa.mjs
// Output: qa-fixture/screenshots/map-*.png + qa-fixture/map-report.json
// =====================================================================
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const QA_DIR = __dirname;
const SHOTS_DIR = path.join(QA_DIR, 'screenshots');
const LEAFLET_DIST = path.join(REPO_ROOT, 'node_modules', 'leaflet', 'dist');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const ORIGIN = 'http://localhost:8080';
const CHROMIUM_PATH = '/opt/pw-browsers/chromium';

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
    const qaLocalCandidate = path.join(QA_DIR, path.basename(url.pathname));
    if (fs.existsSync(qaLocalCandidate) && fs.statSync(qaLocalCandidate).isFile()) {
      return fulfillLocalFile(route, qaLocalCandidate, 'application/javascript; charset=utf-8');
    }
    if (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) {
      const base = path.basename(url.pathname);
      if (GSTATIC_FAKES[base]) return fulfillLocalFile(route, path.join(QA_DIR, GSTATIC_FAKES[base]), 'application/javascript; charset=utf-8');
      return route.fulfill({ status: 404, body: 'qa-fixture: unmocked gstatic module ' + base });
    }
    // Real Leaflet 1.9.4, served from the local devDependency instead of
    // unpkg.com (unreachable from this sandbox) -- same bytes, same
    // version pinned in map.html's <link>/<script integrity=...> tags.
    if (url.hostname === 'unpkg.com' && url.pathname.startsWith('/leaflet@1.9.4/dist/')) {
      const rel = url.pathname.replace('/leaflet@1.9.4/dist/', '');
      return fulfillLocalFile(route, path.join(LEAFLET_DIST, rel));
    }
    if (url.hostname === 'localhost' && url.port === '8080' && url.pathname.startsWith('/api/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (url.origin === ORIGIN) {
      return fulfillLocalFile(route, path.join(REPO_ROOT, decodeURIComponent(url.pathname)));
    }
    return route.abort('failed');
  } catch (err) {
    console.error('[qa-fixture] route handler error for', request.url(), err);
    return route.fulfill({ status: 500, body: 'qa-fixture route handler error' });
  }
}

const report = { checks: [], screenshots: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' (' + detail + ')' : ''));
}
async function shot(page, name, fullPage) {
  const file = path.join(SHOTS_DIR, name + '.png');
  await page.screenshot({ path: file, fullPage: !!fullPage });
  report.screenshots.push(name + '.png');
}

async function gotoMap(page) {
  await page.goto(ORIGIN + '/map.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#map', { timeout: 15000 });
  // Let Leaflet finish its first tile-pane layout + favAuth resolve
  // (initFavorites()'s onAuthStateChanged fires asynchronously).
  await page.waitForTimeout(800);
}

// #citySearch lives inside the closed-by-default #cityFilterMenu dropdown
// -- open it first via its trigger, exactly as a real user would, so
// currentAlertArea() has a real {type:'city', city} to hand the modal.
async function enableSaveAlertViaCity(page) {
  await page.click('#cityTriggerBtn');
  await page.waitForTimeout(150);
  await page.fill('#citySearch', 'Erbil');
  await page.dispatchEvent('#citySearch', 'input');
  await page.waitForTimeout(150);
  await page.click('#cityTriggerBtn');
  await page.waitForTimeout(150);
}

function noHorizontalOverflow(page) {
  return page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
}

// -------------------------------------------------------------------
// §20 -- Save-as-Alert modal vs. Leaflet stacking regression suite.
// -------------------------------------------------------------------
async function saveAlertRegressionSuite(page) {
  await enableSaveAlertViaCity(page);
  const disabled = await page.locator('#saveAlertBtn').isDisabled();
  check('Save Alert button enabled once a city is chosen', !disabled);

  await page.click('#saveAlertBtn');
  await page.waitForTimeout(250);

  const state1 = await page.evaluate(() => {
    const modal = document.getElementById('saveAlertModal');
    const cs = getComputedStyle(modal);
    const centerEl = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
    return {
      visible: !modal.classList.contains('hidden'),
      zIndex: cs.zIndex,
      position: cs.position,
      bg: cs.backgroundColor,
      centerElIsModalOrChild: !!(centerEl && modal.contains(centerEl)),
    };
  });
  check('Modal is visible after clicking Save as Alert', state1.visible);
  check('Modal has a real numeric z-index (not "auto")', state1.zIndex !== 'auto' && state1.zIndex !== '', `z-index=${state1.zIndex}`);
  check('Modal is position:fixed (portal-style overlay)', state1.position === 'fixed');
  check('Modal backdrop is visibly dimmed', /rgba?\(0,\s*0,\s*0/.test(state1.bg), state1.bg);
  check('The dialog (not the map) is what paints at the viewport center', state1.centerElIsModalOrChild);

  await shot(page, 'map-savealert-open-1440-en', false);

  // Map does NOT receive click-through: click at a point still inside the
  // dimmed backdrop but outside the modal card, and confirm no Leaflet
  // popup/marker interaction fired (the modal must swallow the click).
  const clickThrough = await page.evaluate(() => {
    const modal = document.getElementById('saveAlertModal');
    const r = modal.getBoundingClientRect();
    // A point inside the fixed inset-0 backdrop but left of the centered card.
    const x = Math.max(4, r.left - 20 < 0 ? 4 : r.left - 20);
    const y = Math.floor(r.top + r.height / 2);
    const el = document.elementFromPoint(x, y);
    return { tag: el ? el.tagName : null, isMapOrChild: !!(el && document.getElementById('map').contains(el)) };
  });
  check('Backdrop area does not resolve to the Leaflet map underneath', !clickThrough.isMapOrChild, JSON.stringify(clickThrough));

  // Dialog receives click: Cancel closes it.
  await page.click('#saveAlertCancelBtn');
  await page.waitForTimeout(200);
  const afterCancel = await page.evaluate(() => document.getElementById('saveAlertModal').classList.contains('hidden'));
  check('Clicking Cancel inside the dialog closes it', afterCancel);

  const focusAfterCancel = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('Focus returns to the trigger button after Cancel-close', focusAfterCancel === 'saveAlertBtn', `activeElement=${focusAfterCancel}`);

  // Reopen works.
  await page.click('#saveAlertBtn');
  await page.waitForTimeout(250);
  const reopened = await page.evaluate(() => !document.getElementById('saveAlertModal').classList.contains('hidden'));
  check('Modal reopens on a second click', reopened);

  // Escape closes it + focus returns.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const afterEscape = await page.evaluate(() => document.getElementById('saveAlertModal').classList.contains('hidden'));
  check('Escape closes the modal', afterEscape);
  const focusAfterEscape = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('Focus returns to the trigger button after Escape-close', focusAfterEscape === 'saveAlertBtn', `activeElement=${focusAfterEscape}`);

  // No stuck backdrop: a point that used to be under the backdrop now
  // resolves back to the real map/page content, and the map is
  // interactive again (no leftover full-screen overlay eating clicks).
  const stuck = await page.evaluate(() => {
    const el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
    const modal = document.getElementById('saveAlertModal');
    return { hiddenModalCovers: !!(el && modal.contains(el)), displayNone: getComputedStyle(modal).display === 'none' };
  });
  check('No stuck backdrop after close (closed modal is display:none / not painting)', stuck.displayNone && !stuck.hiddenModalCovers, JSON.stringify(stuck));
}

// -------------------------------------------------------------------
// Screenshot + overflow/layering matrix, per §21.
// -------------------------------------------------------------------
const VIEWPORTS = {
  1920: { width: 1920, height: 1080 },
  1440: { width: 1440, height: 900 },
  1024: { width: 1024, height: 900 },
  390: { width: 390, height: 844 },
};
const RUNS = [
  { vp: 1920, lang: 'en' },
  { vp: 1440, lang: 'en' },
  { vp: 1024, lang: 'en' },
  { vp: 390, lang: 'en' },
  { vp: 1440, lang: 'ku' },
  { vp: 390, lang: 'ku' },
  { vp: 1440, lang: 'ar' },
  { vp: 390, lang: 'ar' },
];

async function run() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  for (const { vp, lang } of RUNS) {
    const label = `${vp}-${lang}`;
    const context = await browser.newContext({ viewport: VIEWPORTS[vp] });
    await context.route('**/*', routeHandler);
    await context.addInitScript((l) => { try { localStorage.setItem('darwesh_lang', l); } catch (e) {} }, lang);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => { const m = 'pageerror: ' + e.message; consoleErrors.push(m); console.error('[browser]', m); });
    page.on('console', (msg) => { if (msg.type() === 'error' && !/net::ERR_FAILED/.test(msg.text())) { const m = 'console: ' + msg.text(); consoleErrors.push(m); console.error('[browser]', m); } });

    await gotoMap(page);
    await shot(page, `map-${label}`, false);

    const overflow = await noHorizontalOverflow(page);
    check(`${label}: no horizontal page overflow`, overflow.scrollW <= overflow.clientW + 1, `scrollW=${overflow.scrollW} clientW=${overflow.clientW}`);

    if (vp === 1440 && lang === 'en') {
      await saveAlertRegressionSuite(page);
    }

    if (vp === 390) {
      // Mobile List/Map mode switching -- #viewToggle flips between the
      // two full-screen panes (see map.html's mobileView state).
      const initialMode = await page.evaluate(() => document.getElementById('mapPanel').classList.contains('hidden') ? 'list' : 'map');
      await shot(page, `map-mobile-${initialMode}-${lang}`, false);
      await page.click('#viewToggle');
      await page.waitForTimeout(300);
      const otherMode = await page.evaluate(() => document.getElementById('mapPanel').classList.contains('hidden') ? 'list' : 'map');
      check(`${label}: mobile List/Map toggle actually switches panes`, otherMode !== initialMode, `${initialMode} -> ${otherMode}`);
      await shot(page, `map-mobile-${otherMode}-${lang}`, false);
      const mOverflow = await noHorizontalOverflow(page);
      check(`${label}: no horizontal overflow after mode switch`, mOverflow.scrollW <= mOverflow.clientW + 1);
    }

    check(`${label}: no console/page errors`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    await context.close();
  }
  await browser.close();

  const outPath = path.join(QA_DIR, 'map-report.json');
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
