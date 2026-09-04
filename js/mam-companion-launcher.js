// Site-wide MAM launcher -- the single wiring point that puts MAM on a
// page. It composes three modules and owns no behaviour of its own:
//
//   js/mam-dock.js        the compact draggable assistant surface, with
//                         the living orb (js/mam-companion.js) inside it
//   js/mam-chat-panel.js  the conversation overlay, session, transcript,
//                         voice state machine and allowlisted actions
//
// EVERY public page uses this, map.html included. map.html used to be the
// exception -- it loaded its own js/mam-properties-map.js, a second full
// implementation with a separate session id, separate bubbles, separate
// voice handling and a second orb mounted straight onto <body> alongside
// the one already in its assistant bar. That module has been removed:
// there is one MAM surface per page, one conversation across pages, and a
// host page supplies structured context and layout hints only.
//
// Clicking the dock NEVER navigates the visitor away from the current
// page -- it opens/toggles the overlay in place. Dragging it moves it and
// deliberately does not open anything (see js/mam-dock.js's threshold).
//
// Usage, once near the end of <body>:
//   <div id="mamCompanionLauncher" data-page="property" data-id="abc123"></div>
//   <script type="module" src="./js/mam-companion-launcher.js"></script>
// `data-page` is one of home/property/project/professional/services/
// properties_map -- omit it on a page with no specific context (About, a
// plain account page) to still get MAM with no context attached.
// `data-id`, if present, is that record's own id; if absent, this module
// reads the page's own `?id=` query param instead -- the SAME param
// listing.html, work.html and office.html already parse to fetch their own
// Firestore document, so no host page needs its own script touched just to
// wire the launcher up. Never scraped from page text either way -- this is
// the structured, ID-only page context backend/app/mam/schemas.py's
// PageContext already validates server-side, never arbitrary DOM content.
// `data-service-type` is the services-page discipline slug, when the host
// page knows one (e.g. engineer.html -> "engineer").
// `data-label` overrides the dock's visible prompt text (map.html asks
// about properties; a services page can ask about something else).
import { mountMamDock } from './mam-dock.js';
import { mountMamChatPanel, isMamMounted } from './mam-chat-panel.js';

const mount = document.getElementById('mamCompanionLauncher');
if (mount && !isMamMounted()) {
  init();
}

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function currentLang() {
  return localStorage.getItem('darwesh_lang') || 'en';
}

// Same structured-context shape/vocabulary the backend already validates
// -- built from the host page's own data-attributes/`?id=`, never from a
// forwarded URL and never from page text.
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
  const label = mount.getAttribute('data-label')
    || tr('mam.dockPrompt', 'Ask MAM about properties…');

  const dock = mountMamDock({ getLanguage: currentLang, label });

  const panel = mountMamChatPanel({
    orbEl: dock.openBtn,          // the whole compact bar opens the overlay
    micEls: [dock.micBtn],        // the dock's mic drives the SAME voice state
    companion: dock.companion,
    getLanguage: currentLang,
    pageContext: readPageContext(),
    onResumeHint: (text) => dock.setResumeHint(text),
    // Compact bar and conversation overlay are one surface in two states,
    // so exactly one of them is on screen at a time.
    onOpenState: (isOpen) => dock.setCollapsed(isOpen)
  });

  if (!panel) return;   // a second mount was refused -- nothing more to wire

  document.addEventListener('darwesh:langchange', () => {
    dock.setLabel(mount.getAttribute('data-label') || tr('mam.dockPrompt', 'Ask MAM about properties…'));
  });
}
