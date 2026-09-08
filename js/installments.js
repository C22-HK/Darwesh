// Darwesh Group -- Installment discovery (installments.html).
//
// WHERE THE DATA COMES FROM, AND WHY NO NEW COLLECTION WAS CREATED.
// Instalment terms already exist in production: firestore.rules'
// projects/{projectId} allowlists and type-validates
// `installmentAvailable` (bool), `minDownPaymentPercent`,
// `monthlyInstallmentFrom` (money), `paymentPeriodMonths`,
// `startingPrice`, `currency`, `city`, `verified` and `organizationId`,
// and the collection is `allow read: if true`. So this page queries the
// real projects a developer already publishes. It creates no
// `installments` collection, no second property database, and no
// installmentProviderProfiles.
//
// NOTHING IS CALCULATED. Every figure shown is a value the developer
// actually stored. This page never derives a monthly payment from a
// price and a term, never annualises anything, and never infers a
// down-payment amount from a percentage -- a number a visitor might act
// on financially must be one the developer published, not one this
// frontend invented. A project missing a field simply does not show that
// row.
//
// PROVIDER LINKING. `organizationId` names the responsible developer, and
// organizations/{orgId} is publicly readable, so the real organisation
// NAME is resolved and shown. There is no organisation profile page in
// this build, so the name is rendered as text -- deliberately not as a
// link to a page that does not exist. No fabricated href, no '#'.
//
// LOC-01. Projects carry a `location` map, and it is never read here.
// Cards show city/district text only.
import { db, getDocs, getDoc } from './firebase-init.js';
import { doc, collection, query, where, limit } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { renderEmptyState, renderErrorState } from './profile-shell.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  const s = tr(key, fallback);
  return Object.keys(vars || {}).reduce((acc, k) => acc.replace(`{${k}}`, vars[k]), s);
}
const el = (id) => document.getElementById(id);
function show(id) { const n = el(id); if (n) n.classList.remove('hidden'); }
function hide(id) { const n = el(id); if (n) n.classList.add('hidden'); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Same guard the other listing surfaces apply before emitting an <img src>.
function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

// A showcase, not a paginated search -- bounded like every other listing
// surface in this project.
const PROJECT_LIMIT = 48;

let allProjects = [];      // fetched once; filtering below is client-side
let orgNames = new Map();  // organizationId -> name, resolved at most once each

function money(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const c = typeof currency === 'string' && currency.trim() ? currency.trim() : '';
  return `${c ? c + ' ' : '$'}${amount.toLocaleString()}`;
}

/**
 * Resolves developer names for the projects on screen. One read per
 * DISTINCT organisation, cached for the life of the page -- never one
 * read per card, which is what would turn a 48-project page into 48
 * extra reads.
 */
async function resolveOrgNames(projects) {
  const ids = [...new Set(projects.map((p) => p.organizationId).filter((id) => typeof id === 'string' && id))]
    .filter((id) => !orgNames.has(id));
  if (!ids.length) return;
  await Promise.all(ids.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, 'organizations', id));
      // Absent or nameless organisation caches as null, so a failed
      // lookup is not retried on every re-render and never renders a
      // guessed name.
      orgNames.set(id, snap.exists() ? (snap.data().name || null) : null);
    } catch {
      orgNames.set(id, null);
    }
  }));
}

function readFilters() {
  const num = (id) => {
    const raw = (el(id).value || '').trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    city: (el('fCity').value || '').trim().toLowerCase(),
    maxPrice: num('fMaxPrice'),
    maxDown: num('fMaxDown'),
    maxMonthly: num('fMaxMonthly'),
    maxMonths: num('fMaxMonths'),
    verifiedOnly: el('fVerified').getAttribute('aria-pressed') === 'true',
  };
}

/**
 * Every predicate is skipped when the project has no value for that
 * field: a developer who did not publish a monthly figure is not
 * silently excluded from an unrelated city filter, and is never treated
 * as if the number were zero.
 */
function matches(p, f) {
  if (f.city && !(`${p.city || ''} ${p.district || ''}`.toLowerCase().includes(f.city))) return false;
  if (f.verifiedOnly && p.verified !== true) return false;
  if (f.maxPrice !== null && typeof p.startingPrice === 'number' && p.startingPrice > f.maxPrice) return false;
  if (f.maxDown !== null && typeof p.minDownPaymentPercent === 'number' && p.minDownPaymentPercent > f.maxDown) return false;
  if (f.maxMonthly !== null && typeof p.monthlyInstallmentFrom === 'number' && p.monthlyInstallmentFrom > f.maxMonthly) return false;
  if (f.maxMonths !== null && typeof p.paymentPeriodMonths === 'number' && p.paymentPeriodMonths > f.maxMonths) return false;
  return true;
}

function card(p) {
  const node = document.createElement('article');
  node.className = 'ps-card inst-card overflow-hidden';

  const cover = isSafeHttpUrl(p.coverImageUrl)
    ? `<img src="${esc(p.coverImageUrl)}" alt="" class="inst-cover-img" loading="lazy" decoding="async"/>`
    : `<span class="material-symbols-outlined inst-cover-fallback" aria-hidden="true">apartment</span>`;

  const place = [p.city, p.district].filter(Boolean).join(' · ');
  const org = p.organizationId ? orgNames.get(p.organizationId) : null;

  // Terms are built from what EXISTS. A missing field yields no row at
  // all rather than a dash, a zero, or a computed stand-in.
  const terms = [];
  const total = money(p.startingPrice, p.currency);
  if (total) terms.push([tr('inst.fromPrice', 'From'), total]);
  if (typeof p.minDownPaymentPercent === 'number') {
    terms.push([tr('inst.downPayment', 'Down payment'), `${p.minDownPaymentPercent}%`]);
  }
  const monthly = money(p.monthlyInstallmentFrom, p.currency);
  if (monthly) terms.push([tr('inst.monthlyFrom', 'Monthly from'), monthly]);
  if (typeof p.paymentPeriodMonths === 'number' && p.paymentPeriodMonths > 0) {
    terms.push([tr('inst.duration', 'Duration'), trf('inst.months', '{n} months', { n: p.paymentPeriodMonths })]);
  }

  node.innerHTML = `
    <div class="inst-cover">${cover}</div>
    <div class="p-4">
      <div class="flex items-start justify-between gap-2">
        <h3 class="font-body-md text-[14.5px] text-on-surface font-semibold">${esc(p.name || '')}</h3>
        ${p.verified === true ? `<span class="ps-badge ps-badge-verified inst-badge"><span class="material-symbols-outlined text-[13px]" aria-hidden="true">verified</span><span>${esc(tr('rp.verified', 'Verified'))}</span></span>` : ''}
      </div>
      ${place ? `<p class="font-body-md text-[12.5px] text-on-surface-variant mt-1">${esc(place)}</p>` : ''}
      ${terms.length ? `<dl class="inst-terms mt-3">${terms.map(([k, v]) => `<div class="inst-term"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${org ? `<p class="inst-provider mt-3">${esc(tr('inst.offeredBy', 'Offered by'))} <span>${esc(org)}</span></p>` : ''}
    </div>
  `;
  return node;
}

function renderList() {
  const grid = el('instGrid');
  const emptyEl = el('instEmpty');
  const f = readFilters();
  const shown = allProjects.filter((p) => matches(p, f));

  el('instCount').textContent = shown.length
    ? trf('inst.countLabel', '{n} installment offers', { n: shown.length })
    : '';

  grid.innerHTML = '';
  if (!shown.length) {
    const filtered = allProjects.length > 0;
    renderEmptyState(emptyEl, {
      icon: 'payments',
      // Two genuinely different situations, worded differently: nothing
      // exists at all, versus nothing matches what you asked for.
      title: filtered
        ? tr('inst.emptyFiltered', 'No installment properties match these filters.')
        : tr('inst.empty', 'No installment properties are currently available.'),
      hint: filtered ? tr('inst.emptyFilteredHint', 'Try widening the price, down payment, or duration.') : undefined
    });
    show('instEmpty');
    return;
  }
  hide('instEmpty');
  shown.forEach((p) => grid.appendChild(card(p)));
}

async function load() {
  hide('instEmpty');
  show('instLoading');
  try {
    // publicationStatus=='published' is required, not optional -- an
    // anonymous query missing it is denied outright by firestore.rules'
    // isProjectPubliclyVisible() gate, the same admin-approval-before-
    // publication invariant projects.html now enforces. City/price/
    // duration narrowing still happens client-side over this bounded set.
    // Needs a composite index on (installmentAvailable, publicationStatus)
    // -- see firestore.indexes.json.
    const snap = await getDocs(query(
      collection(db, 'projects'),
      where('installmentAvailable', '==', true),
      where('publicationStatus', '==', 'published'),
      limit(PROJECT_LIMIT)
    ));
    allProjects = [];
    snap.forEach((d) => allProjects.push({ id: d.id, ...d.data() }));
    await resolveOrgNames(allProjects);
    hide('instLoading');
    renderList();
  } catch {
    hide('instLoading');
    renderErrorState(el('instEmpty'), {
      message: tr('rp.errorGeneric', 'Something went wrong. Please try again.'),
      onRetry: load
    });
    show('instEmpty');
  }
}

['fCity', 'fMaxPrice', 'fMaxDown', 'fMaxMonthly', 'fMaxMonths'].forEach((id) => {
  el(id).addEventListener('input', renderList);
});
el('fVerified').addEventListener('click', () => {
  const btn = el('fVerified');
  btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  renderList();
});
el('fReset').addEventListener('click', () => {
  ['fCity', 'fMaxPrice', 'fMaxDown', 'fMaxMonthly', 'fMaxMonths'].forEach((id) => { el(id).value = ''; });
  el('fVerified').setAttribute('aria-pressed', 'false');
  renderList();
});

document.addEventListener('darwesh:langchange', renderList);
load();
