// Site-wide MAM companion launcher -- mounts the SAME orb component
// (js/mam-companion.js + css/mam-companion.css) on every public page that
// wants an ambient AI-availability indicator, and opens the SAME shared
// local chat panel (js/mam-chat-panel.js) beside it. Never a second
// companion implementation and never a second chat/AI implementation:
// every reply still comes from the one canonical backend endpoint
// (js/mam-api.js -> POST /api/v1/mam/chat) map.html's own dock already
// uses.
//
// Clicking the orb NEVER navigates the visitor away from the current
// page -- it opens/toggles a small panel in place, right where the orb
// already is. This module used to route to map.html?mam=1&... instead;
// that behavior has been removed per an explicit product requirement
// that the site-wide orb must never act like a link to another page.
// map.html itself never mounts this launcher (see its own inline script
// wiring the orb straight to its bigger dock, js/mam-properties-map.js)
// so there is still only ever one MAM conversation surface open on any
// given page.
//
// Usage, once near the end of <body> on any public page that wants the
// ambient companion:
//   <div id="mamCompanionLauncher" data-page="property" data-id="abc123"></div>
//   <script type="module" src="./js/mam-companion-launcher.js"></script>
// `data-page` is one of home/property/project/professional/services --
// omit it on a page with no specific context (About, a plain account
// page) to still get the orb with no context attached. `data-id`, if
// present, is that record's own id; if absent, this module reads the
// page's own `?id=` query param itself instead -- the SAME param
// listing.html, work.html and office.html already parse to fetch their
// own Firestore document, so no host page needs its own script touched
// just to wire the launcher up. Never scraped from page text either way
// -- this is the structured, ID-only page context
// backend/app/mam/schemas.py's PageContext already validates server-side,
// never arbitrary DOM content.
// `data-service-type` is the services-page discipline slug, when the
// host page knows one (e.g. engineer.html -> "engineer").
import { MamCompanion } from './mam-companion.js';
import { mountMamChatPanel } from './mam-chat-panel.js';

const mount = document.getElementById('mamCompanionLauncher');
if (mount) {
  init();
}

function currentLang() {
  return localStorage.getItem('darwesh_lang') || 'en';
}

// Same structured-context shape/vocabulary map.html's own
// incomingPageContext() already builds from URL params -- here it comes
// from the host page's own data-attributes/`?id=` instead of a
// forwarded URL, since the visitor never leaves this page.
function readPageContext() {
  const page = mount.getAttribute('data-page') || 'home';
  const id = mount.getAttribute('data-id') || new URLSearchParams(window.location.search).get('id');
  const serviceType = mount.getAttribute('data-service-type');
  const ctx = { page };
  if (id && page === 'property') ctx.listingId = id;
  if (id && page === 'project') ctx.projectId = id;
  if (id && page === 'professional') ctx.professionalId = id;
  if (serviceType) ctx.serviceType = serviceType;
  return ctx;
}

function init() {
  const companion = new MamCompanion({ mountTarget: mount, getLanguage: currentLang, interactive: true });
  const orb = mount.querySelector('.mamco-orb');
  if (!orb) return;

  mountMamChatPanel({
    orbEl: orb,
    companion,
    getLanguage: currentLang,
    pageContext: readPageContext()
  });
}
