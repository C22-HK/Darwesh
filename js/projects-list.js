// Darwesh Group -- City Projects listing (projects.html).
//
// Reads the SAME real `projects` collection js/installments.js already
// queries (see that file's own header comment for why no new collection
// was created) -- filtered here by `city` (a real equality query, so it
// needs no composite index) and, client-side, by `projectType` (one of
// the two real category values this frontend defines as canonical:
// 'apartment' | 'residential_community' -- the same two organization
// types firestore.rules' orgTypeIsProjectCapable() already recognizes as
// project-capable, not an invented split). Nothing here calculates a
// price, infers a status, or renders a project this collection doesn't
// actually contain.
import { db, getDoc, getDocs } from './firebase-init.js';
import { doc, collection, query, where, limit } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { renderEmptyState, renderErrorState } from './profile-shell.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  const s = tr(key, fallback);
  return Object.keys(vars || {}).reduce((acc, k) => acc.replace(`{${k}}`, vars[k]), s);
}
function cityLabel(name) { return (window.cityLabel && window.cityLabel(name)) || name; }
const el = (id) => document.getElementById(id);
function show(id) { const n = el(id); if (n) n.classList.remove('hidden'); }
function hide(id) { const n = el(id); if (n) n.classList.add('hidden'); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}
function money(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const c = typeof currency === 'string' && currency.trim() ? currency.trim() : '';
  return `${c ? c + ' ' : '$'}${amount.toLocaleString()}`;
}

const PROJECT_LIMIT = 60;
const CATEGORY_LABELS = {
  apartment: () => tr('proj.categoryApartment', 'Apartments'),
  residential_community: () => tr('proj.categoryResidential', 'Residential Projects')
};
const STATUS_LABELS = {
  planning: () => tr('proj.statusPlanning', 'Planning'),
  under_construction: () => tr('proj.statusUnderConstruction', 'Under Construction'),
  nearing_completion: () => tr('proj.statusNearingCompletion', 'Nearing Completion'),
  completed: () => tr('proj.statusCompleted', 'Completed')
};

const params = new URLSearchParams(window.location.search);
const cityParam = (params.get('city') || '').trim();
let category = params.get('category') || 'all';
if (!['all', 'apartment', 'residential_community'].includes(category)) category = 'all';

let allProjects = [];
let orgNames = new Map();

async function resolveOrgNames(projects) {
  const ids = [...new Set(projects.map((p) => p.organizationId).filter((id) => typeof id === 'string' && id))]
    .filter((id) => !orgNames.has(id));
  if (!ids.length) return;
  await Promise.all(ids.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, 'organizations', id));
      orgNames.set(id, snap.exists() ? (snap.data().name || null) : null);
    } catch {
      orgNames.set(id, null);
    }
  }));
}

function priceRange(p) {
  const from = money(p.startingPrice, p.currency);
  const to = money(p.priceRangeMax, p.currency);
  if (from && to && to !== from) return `${from} - ${to}`;
  return from || null;
}

function card(p) {
  const a = document.createElement('a');
  a.className = 'proj-card';
  a.href = 'project.html?id=' + encodeURIComponent(p.id);

  const cover = isSafeHttpUrl(p.coverImageUrl)
    ? `<img src="${esc(p.coverImageUrl)}" alt="" loading="lazy" decoding="async"/>`
    : `<span class="proj-card-cover-fallback"><span class="material-symbols-outlined" aria-hidden="true">apartment</span></span>`;

  const catLabel = CATEGORY_LABELS[p.projectType] ? CATEGORY_LABELS[p.projectType]() : null;
  const statusLabel = STATUS_LABELS[p.constructionStatus] ? STATUS_LABELS[p.constructionStatus]() : null;
  const place = [p.city, p.district || p.neighborhood].filter(Boolean).join(' · ');
  const price = priceRange(p);
  const org = p.organizationId ? orgNames.get(p.organizationId) : null;

  a.innerHTML = `
    <div class="proj-card-cover">
      ${cover}
      <div class="proj-card-badges">
        ${catLabel ? `<span class="proj-badge proj-badge-category">${esc(catLabel)}</span>` : '<span></span>'}
        ${statusLabel ? `<span class="proj-badge proj-badge-status">${esc(statusLabel)}</span>` : ''}
      </div>
      ${p.verified === true ? `<span class="proj-badge proj-badge-verified" style="position:absolute;bottom:10px;left:10px;"><span class="material-symbols-outlined text-[12px]" aria-hidden="true">verified</span> ${esc(tr('rp.verified', 'Verified'))}</span>` : ''}
    </div>
    <div class="proj-card-body">
      <span class="proj-card-name">${esc(p.name || '')}</span>
      ${place ? `<span class="proj-card-place"><span class="material-symbols-outlined text-[14px]" aria-hidden="true">location_on</span>${esc(place)}</span>` : ''}
      ${price ? `<span class="proj-card-price">${esc(price)}</span>` : `<span class="proj-card-price" style="color:var(--ps-color-on-surface-variant);font-weight:600;">${esc(tr('proj.contactForPrice', 'Contact for price'))}</span>`}
      ${org ? `<span class="proj-card-dev">${esc(tr('proj.offeredBy', 'By'))} ${esc(org)}</span>` : ''}
    </div>
  `;
  return a;
}

function renderList() {
  const grid = el('projGrid');
  const emptyEl = el('projEmpty');
  const shown = category === 'all' ? allProjects : allProjects.filter((p) => p.projectType === category);

  el('projCount').textContent = shown.length
    ? trf('proj.countLabel', '{n} projects', { n: shown.length })
    : '';

  grid.innerHTML = '';
  if (!shown.length) {
    const catLabel = category === 'all' ? null : (CATEGORY_LABELS[category] ? CATEGORY_LABELS[category]() : category);
    renderEmptyState(emptyEl, {
      icon: 'apartment',
      title: catLabel
        ? trf('proj.emptyFiltered', 'No {category} projects are currently available in {city}.', { category: catLabel, city: cityLabel(cityParam) })
        : trf('proj.empty', 'No projects are currently available in {city}.', { city: cityLabel(cityParam) })
    });
    show('projEmpty');
    return;
  }
  hide('projEmpty');
  shown.forEach((p) => grid.appendChild(card(p)));
}

function setTabsUi() {
  document.querySelectorAll('.proj-tab').forEach((btn) => {
    const active = btn.dataset.category === category;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

function updateUrl() {
  const p = new URLSearchParams(window.location.search);
  p.set('city', cityParam);
  if (category === 'all') p.delete('category'); else p.set('category', category);
  const qs = p.toString();
  history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
}

function wireTabs() {
  document.querySelectorAll('.proj-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      category = btn.dataset.category;
      setTabsUi();
      updateUrl();
      renderList();
    });
  });
}

function renderHeader() {
  el('projPageTitle').textContent = trf('proj.pageTitle', '{city} Projects', { city: cityLabel(cityParam) });
  el('projCityCrumb').textContent = cityLabel(cityParam);
}

async function load() {
  if (!cityParam) {
    hide('projLoading');
    renderEmptyState(el('projEmpty'), { icon: 'location_city', title: tr('proj.noCitySelected', 'Choose a city to see its projects.') });
    show('projEmpty');
    el('projPageTitle').textContent = tr('proj.breadcrumbProjects', 'Projects');
    return;
  }
  renderHeader();
  hide('projEmpty');
  show('projLoading');
  try {
    // publicationStatus=='published' is not optional here -- it's the
    // ONLY thing firestore.rules' isProjectPubliclyVisible() lets an
    // anonymous/customer query see (a draft/pending/rejected project is
    // denied outright, not merely filtered client-side). Needs a
    // composite index on (city, publicationStatus) -- see
    // firestore.indexes.json.
    const snap = await getDocs(query(
      collection(db, 'projects'),
      where('city', '==', cityParam),
      where('publicationStatus', '==', 'published'),
      limit(PROJECT_LIMIT)
    ));
    allProjects = [];
    snap.forEach((d) => allProjects.push({ id: d.id, ...d.data() }));
    await resolveOrgNames(allProjects);
    hide('projLoading');
    renderList();
  } catch {
    hide('projLoading');
    renderErrorState(el('projEmpty'), { message: tr('rp.errorGeneric', 'Something went wrong. Please try again.'), onRetry: load });
    show('projEmpty');
  }
}

setTabsUi();
wireTabs();
document.addEventListener('darwesh:langchange', () => { renderHeader(); renderList(); });
load();
