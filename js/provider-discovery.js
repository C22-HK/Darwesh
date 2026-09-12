// Darwesh Group -- shared verified-professional discovery.
//
// ONE provider card and ONE query path, used by every surface that shows
// professionals: service.html (a single role), build.html and
// renovate.html (several roles at once). Before this module each of
// those would have grown its own card markup and its own filter
// handling, which is exactly how two "the same" cards drift apart.
//
// WHERE THE DATA COMES FROM. serviceProviders/{id} is `allow read: if
// true` in firestore.rules and its `serviceType` is validated against a
// closed enum there. This module reads that collection and nothing else.
// It creates no buildExperts/renovationExperts collection and mints no
// provider records -- the roles it shows are the roles people really
// sign up as.
//
// WHAT IT WILL NOT RENDER. Only fields the serviceProviders schema
// actually defines. There is no ratings field, no jobs-completed
// counter and no availability calendar in that schema, so no card here
// shows a star rating, a job count or an "available now" badge -- a
// number a visitor would act on has to be one a provider really
// published. `verified` is admin-controlled (owners cannot set it; see
// the rules' locked-field checks), so the badge means what it says.
//
// CONTACT PRIVACY. Phone/email/WhatsApp live in the owner-gated
// private/contact subcollection, and this module never reads it. Cards
// carry a link to the provider's profile, where the existing contact
// flow applies its own visibility rules. Nothing here can leak a
// contact detail because nothing here ever fetches one.
import { SERVICE_CATALOG, getService } from './service-catalog.js';
import { renderEmptyState, renderErrorState } from './profile-shell.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  const s = tr(key, fallback);
  return Object.keys(vars || {}).reduce((acc, k) => acc.replace(`{${k}}`, vars[k]), s);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Same guard every other listing surface applies before emitting a URL
// into markup.
function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

// Bounded read, like every other discovery surface here. Firestore's
// `in` accepts up to 30 values and we pass at most a handful, so this
// stays one query no matter how many roles a page asks for.
const PAGE_SIZE = 60;

/** serviceType -> catalog entry, so a mixed-role grid can send each card
 *  to the right profile page instead of assuming one destination. */
function catalogByType(type) {
  return SERVICE_CATALOG.find((s) => s.serviceType === type) || null;
}

/**
 * Mounts a provider directory into `root`.
 *
 * @param {HTMLElement} root
 * @param {object} opts
 * @param {string[]} opts.services  catalog keys to include, e.g.
 *                                  ['engineer','designer']. Entries with
 *                                  no serviceType (Installments) are not
 *                                  provider-backed and are ignored.
 * @param {boolean} [opts.roleChips=true]  show role filter chips when the
 *                                  page covers more than one role.
 * @param {string}  [opts.emptyTitleKey]   i18n key for "nothing at all".
 * @param {string}  [opts.emptyTitleFallback]
 */
export function mountProviderDiscovery(root, opts) {
  if (!root) return;
  const services = (opts.services || [])
    .map(getService)
    .filter((s) => s && s.serviceType);
  if (!services.length) return;

  const types = services.map((s) => s.serviceType);
  const showRoleChips = opts.roleChips !== false && services.length > 1;

  // Cleaning is the one role whose schema really carries providerType
  // (individual | team | company); firestore.rules requires every other
  // role to be 'individual'. So these chips appear only where they would
  // actually partition anything.
  const showProviderTypes = services.length === 1 && services[0].key === 'cleaning';

  let all = [];
  let roleFilter = null;      // serviceType | null
  let providerTypeFilter = null; // 'individual' | 'team' | 'company' | null
  let cityFilter = '';
  let verifiedOnly = false;

  root.innerHTML = `
    <div class="svc-toolbar mb-5" role="group" aria-label="${esc(tr('pd.filtersLabel', 'Filter professionals'))}">
      <input class="ps-input svc-city-input" type="text" maxlength="100" autocomplete="off"
             data-pd="city" data-i18n-placeholder="svc.filterCityPlaceholder" placeholder="Filter by city"/>
      <button type="button" class="svc-filter-chip" data-pd="verified" aria-pressed="false">
        <span class="material-symbols-outlined text-[16px]" aria-hidden="true">verified</span>
        <span data-i18n="svc.verifiedOnly">Verified only</span>
      </button>
      ${showRoleChips ? `<div class="flex flex-wrap gap-2" data-pd="roles" role="group" aria-label="${esc(tr('pd.roleLabel', 'Filter by profession'))}"></div>` : ''}
      ${showProviderTypes ? `<div class="flex flex-wrap gap-2" data-pd="ptypes" role="group" aria-label="${esc(tr('pd.providerTypeLabel', 'Filter by provider type'))}"></div>` : ''}
    </div>
    <p class="font-body-md text-[12.5px] text-on-surface-variant mb-4" data-pd="count" role="status" aria-live="polite"></p>
    <div class="ps-grid" data-pd="loading" aria-live="polite">
      <div class="ps-skeleton" style="height:180px;border-radius:16px;"></div>
      <div class="ps-skeleton" style="height:180px;border-radius:16px;"></div>
      <div class="ps-skeleton" style="height:180px;border-radius:16px;"></div>
    </div>
    <div data-pd="error" class="hidden"></div>
    <div data-pd="empty" class="hidden"></div>
    <div class="ps-grid hidden" data-pd="grid"></div>
  `;

  const q = (name) => root.querySelector(`[data-pd="${name}"]`);
  const show = (n) => n && n.classList.remove('hidden');
  const hide = (n) => n && n.classList.add('hidden');

  if (showRoleChips) {
    const wrap = q('roles');
    const chips = [{ v: null, key: 'pd.allRoles', fallback: 'All' }]
      .concat(services.map((s) => ({ v: s.serviceType, key: s.titleKey, fallback: s.title })));
    wrap.innerHTML = chips
      .map((c) => `<button type="button" class="svc-filter-chip${c.v === null ? ' is-active' : ''}" data-role="${esc(c.v || '')}">${esc(tr(c.key, c.fallback))}</button>`)
      .join('');
    wrap.querySelectorAll('[data-role]').forEach((btn) => {
      btn.addEventListener('click', () => {
        roleFilter = btn.dataset.role || null;
        wrap.querySelectorAll('[data-role]').forEach((b) => b.classList.toggle('is-active', b === btn));
        render();
      });
    });
  }

  if (showProviderTypes) {
    const wrap = q('ptypes');
    const opts2 = [
      { v: null, key: 'svc.cleaning.typeAll', fallback: 'All' },
      { v: 'individual', key: 'svc.cleaning.typeIndividual', fallback: 'Individual' },
      { v: 'team', key: 'svc.cleaning.typeTeam', fallback: 'Team' },
      { v: 'company', key: 'svc.cleaning.typeCompany', fallback: 'Company' }
    ];
    wrap.innerHTML = opts2
      .map((o) => `<button type="button" class="svc-filter-chip${o.v === null ? ' is-active' : ''}" data-ptype="${esc(o.v || '')}">${esc(tr(o.key, o.fallback))}</button>`)
      .join('');
    wrap.querySelectorAll('[data-ptype]').forEach((btn) => {
      btn.addEventListener('click', () => {
        providerTypeFilter = btn.dataset.ptype || null;
        wrap.querySelectorAll('[data-ptype]').forEach((b) => b.classList.toggle('is-active', b === btn));
        render();
      });
    });
  }

  function matches(p) {
    if (roleFilter && p.serviceType !== roleFilter) return false;
    if (providerTypeFilter && p.providerType !== providerTypeFilter) return false;
    if (verifiedOnly && p.verified !== true) return false;
    if (cityFilter) {
      const where = `${p.city || ''} ${p.district || ''}`.toLowerCase();
      if (!where.includes(cityFilter.toLowerCase())) return false;
    }
    return true;
  }

  function card(p) {
    const svc = catalogByType(p.serviceType);
    // A provider whose serviceType is not in the catalog has no profile
    // page to open. Rather than emit a broken or invented href, such a
    // record is skipped entirely by render() -- see the filter there.
    const name = esc(p.displayName || p.companyName || '');
    const place = [p.city, p.district].filter(Boolean).map(esc).join(' · ');
    const specialties = Array.isArray(p.specialties) ? p.specialties.filter(Boolean).slice(0, 3) : [];
    const media = isSafeHttpUrl(p.photoOrLogoUrl)
      ? `<div class="svc-card-media" style="background-image:url('${esc(p.photoOrLogoUrl)}')"></div>`
      : `<div class="svc-card-media svc-card-media--fallback"><span class="material-symbols-outlined" aria-hidden="true">${esc(svc.fallbackIcon)}</span></div>`;
    const badge = p.verified === true
      ? `<span class="ps-badge ps-badge-verified"><span class="material-symbols-outlined text-[13px]" aria-hidden="true">verified</span>${esc(tr('rp.verified', 'Verified'))}</span>`
      : '';
    // Experience is rendered only when it is a real number on the
    // document -- never defaulted to 0 or to "new".
    const years = typeof p.experienceYears === 'number' && p.experienceYears > 0
      ? `<p class="svc-card-meta mt-1">${esc(trf('pd.years', '{n} years experience', { n: p.experienceYears }))}</p>`
      : '';
    return `
      <a class="svc-provider-card" href="${esc(svc.profileHref)}?id=${encodeURIComponent(p.id)}">
        ${media}
        <div class="svc-card-body">
          <div class="flex items-center gap-2 mb-1">
            <p class="svc-card-name">${name}</p>
            ${badge}
          </div>
          ${services.length > 1 ? `<p class="svc-card-role">${esc(tr(svc.titleKey, svc.title))}</p>` : ''}
          ${place ? `<p class="svc-card-meta">${place}</p>` : ''}
          ${years}
          ${specialties.length ? `<div class="flex flex-wrap gap-1.5 mt-2">${specialties.map((s) => `<span class="rp-chip">${esc(s)}</span>`).join('')}</div>` : ''}
        </div>
      </a>`;
  }

  function render() {
    hide(q('loading'));
    const shown = all.filter((p) => matches(p) && catalogByType(p.serviceType));
    q('count').textContent = shown.length
      ? trf('pd.count', '{n} verified professionals', { n: shown.length })
      : '';

    if (!shown.length) {
      hide(q('grid'));
      // Two genuinely different situations. "Nothing here at all" is a
      // statement about this market; "nothing matches" is a statement
      // about the filters the visitor just set -- and when they named a
      // city, saying it back is more useful than a generic line.
      const narrowed = all.length > 0;
      renderEmptyState(q('empty'), {
        icon: services[0].fallbackIcon,
        title: narrowed
          ? (cityFilter
            ? trf('pd.emptyCity', 'No professionals match "{city}" yet.', { city: cityFilter })
            : tr('pd.emptyFiltered', 'No professionals match these filters yet.'))
          : tr(opts.emptyTitleKey || 'pd.emptyNone', opts.emptyTitleFallback || 'No verified professionals are available here yet.'),
        hint: narrowed ? tr('pd.emptyHint', 'Try a different city or clear the filters.') : undefined
      });
      show(q('empty'));
      return;
    }
    hide(q('empty'));
    q('grid').innerHTML = shown.map(card).join('');
    show(q('grid'));
  }

  async function load() {
    hide(q('empty'));
    hide(q('error'));
    show(q('loading'));
    try {
      // Imported here rather than at the top of the module so that a
      // page whose Firebase CDN is unreachable still renders its own
      // shell and shows the real error state below, instead of failing
      // the whole module before any of it runs.
      const [{ db, getDocs }, fs] = await Promise.all([
        import('./firebase-init.js'),
        import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js')
      ]);
      const { collection, query, where, limit } = fs;
      // One equality-style filter plus a limit, so Firestore's automatic
      // single-field index serves this -- no composite index needed.
      const snap = await getDocs(query(
        collection(db, 'serviceProviders'),
        where('serviceType', 'in', types),
        limit(PAGE_SIZE)
      ));
      all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    } catch {
      hide(q('loading'));
      hide(q('grid'));
      renderErrorState(q('error'), {
        message: tr('svc.loadError', "Couldn't load providers. Please check your connection and try again."),
        onRetry: load
      });
      show(q('error'));
    }
  }

  let cityDebounce = null;
  q('city').addEventListener('input', (e) => {
    clearTimeout(cityDebounce);
    const v = e.target.value.trim();
    cityDebounce = setTimeout(() => { cityFilter = v; render(); }, 150);
  });
  q('verified').addEventListener('click', () => {
    verifiedOnly = !verifiedOnly;
    q('verified').setAttribute('aria-pressed', String(verifiedOnly));
    q('verified').classList.toggle('is-active', verifiedOnly);
    render();
  });
  document.addEventListener('darwesh:langchange', () => { if (all.length) render(); });

  load();
}
