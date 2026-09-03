// Site-wide MAM companion launcher -- mounts the SAME orb component
// (js/mam-companion.js + css/mam-companion.css) already proven on
// map.html, on every other public page that wants an ambient
// AI-availability indicator. Never a second companion implementation
// and never a second chat UI: this module owns nothing about chat,
// network, or rendering a reply -- clicking the orb navigates to the
// one canonical Properties Map (map.html) with structured page context
// in the URL, where the existing, fully-built AI dock
// (js/mam-properties-map.js) opens automatically and picks that context
// up (see its own incomingPageContext()). This is the same "route to the
// canonical map with context" pattern index.html's hero search and
// services.html's CTA already used via ?ai=1/?q=, generalized to also
// carry ?page=/&listingId=/&projectId=/&professionalId=/&serviceType= --
// the same vocabulary backend/app/mam/schemas.py's KNOWN_PAGES already
// validates server-side (see also js/mam-v2.js's readPageContext(), the
// same contract mam-ai.html already used).
//
// Usage, once near the end of <body> on any public page that wants the
// ambient companion (never on map.html itself -- that page already
// mounts its own richer, request-lifecycle-aware instance):
//   <div id="mamCompanionLauncher" data-page="property" data-id="abc123"></div>
//   <script type="module" src="./js/mam-companion-launcher.js"></script>
// `data-page` is one of home/property/project/professional/services --
// omit it on a page with no specific context (About, a plain account
// page) to still get the orb with no context attached, which still
// opens map.html's AI dock ready to type into. `data-id`, if present, is
// that record's own id; if absent, this module reads the page's own
// `?id=` query param itself instead -- the SAME param listing.html,
// work.html and office.html already parse to fetch their own Firestore
// document, so no host page needs its own script touched just to wire
// the launcher up. Never scraped from page text either way.
// `data-service-type` is the services-page discipline slug, when the
// host page knows one (e.g. engineer.html -> "engineer").
import { MamCompanion } from './mam-companion.js';

const mount = document.getElementById('mamCompanionLauncher');
if (mount) {
  init();
}

function currentLang() {
  return localStorage.getItem('darwesh_lang') || 'en';
}

function init() {
  new MamCompanion({ mountTarget: mount, getLanguage: currentLang, interactive: true });
  const orb = mount.querySelector('.mamco-orb');
  if (!orb) return;

  orb.addEventListener('click', () => {
    const page = mount.getAttribute('data-page');
    const id = mount.getAttribute('data-id') || new URLSearchParams(window.location.search).get('id');
    const serviceType = mount.getAttribute('data-service-type');

    const params = new URLSearchParams();
    params.set('mam', '1');
    if (page) params.set('page', page);
    if (id && page === 'property') params.set('listingId', id);
    if (id && page === 'project') params.set('projectId', id);
    if (id && page === 'professional') params.set('professionalId', id);
    if (serviceType) params.set('serviceType', serviceType);

    window.location.href = 'map.html?' + params.toString();
  });
}
