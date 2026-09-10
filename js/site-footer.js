// Darwesh shared site footer -- the ONE canonical corporate footer for
// every real public marketing/content page.
//
// A `type="module"` script (needs `import` for the real
// js/service-catalog.js data), which is a DIFFERENT timing contract than
// js/site-header.js's classic script: module scripts always execute
// after every classic script on the page has already run during parsing
// (js/i18n.js included, wherever it sits in the document), so this file
// never relies on js/i18n.js's one-time data-i18n DOM scan finding
// content that doesn't exist yet. Instead, every string here is rendered
// directly through the SAME real tr()/window.t() lookup every other
// dynamically-built MAM surface in this codebase already uses (see
// js/mam-spatial-choice.js, js/mam-spatial-ui.js) -- correct regardless
// of load order, and re-rendered from scratch on a live language switch
// (document's 'darwesh:langchange' event, dispatched by
// window.setLanguage() in js/i18n.js) rather than depending on a
// generic external scan to catch up.
//
// REAL ROUTES ONLY. Every href below is a page that actually exists in
// this repository and was verified during a full repo audit before this
// file was written:
//   - Properties: buy.html, rent.html, map.html, sell.html, account.html
//     (My Account's own Favorites tab -- there is no separate "saved
//     properties" page).
//   - Services: the exact js/service-catalog.js SERVICE_CATALOG list
//     (imported, not duplicated) -- engineer/designer/lawyer/landscaping/
//     cleaning/maintenance/installments. MAM AI is also in that catalog
//     but gets its OWN distinct footer treatment below rather than being
//     buried in a plain link list, per the brief's "tasteful footer
//     presence" ask.
//   - Professionals: the SAME catalog's real "browse this service"
//     destinations (service.html?type=X / design.html), reusing each
//     entry's own ctaKey/ctaFallback so this never invents a second
//     label for a link the Services column already names once.
//   - Company: about.html, services.html, mam-ai.html -- the only three
//     that exist. There is no dedicated contact/support page in this
//     repo, so "Contact / Support" from the brief's own example list is
//     NOT included (inventing a href="#" for it was explicitly
//     forbidden).
//   - Support: login.html, signup.html, account.html. Privacy Policy,
//     Terms & Conditions, Cookie Policy and a Help/Support page do NOT
//     exist anywhere in this repository (confirmed by a full-repo grep)
//     -- also omitted, never faked, per the same instruction.
//   - No social links: none exist anywhere in the codebase today.
//   - No newsletter form: no backend/mailing endpoint exists to receive
//     a real subscription.
//
// Usage, placed once per page immediately after </main>:
//   <div id="siteFooter"></div>
//   <script type="module" src="./js/site-footer.js"></script>
import { SERVICE_CATALOG } from './service-catalog.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

function ensureStylesheet() {
  if (document.querySelector('link[data-site-footer-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/site-footer.css', import.meta.url).href;
  link.setAttribute('data-site-footer-style', '1');
  document.head.appendChild(link);
}

// The MAM AI catalog entry gets its own highlighted row (see mamAiRow()
// below), never duplicated inside the plain Services list.
const PLAIN_SERVICES = SERVICE_CATALOG.filter((s) => s.key !== 'mamai');
const MAMAI_SERVICE = SERVICE_CATALOG.find((s) => s.key === 'mamai');

function linkItem(href, label) {
  return '<li><a class="sf-link" href="' + href + '">' + label + '</a></li>';
}

// MAM AI's own tasteful footer presence -- a small highlighted row under
// the brand column, using its REAL existing title/tagline from the same
// catalog services.html itself renders (never new copy invented for
// this file), linking straight to mam-ai.html. This is plain footer
// navigation, not the floating orb/chat widget -- no widget code here.
function mamAiRow() {
  if (!MAMAI_SERVICE) return '';
  return (
    '<a class="sf-mamai" href="' + MAMAI_SERVICE.directoryHref + '">' +
      '<span class="sf-mamai-icon material-symbols-outlined" aria-hidden="true">' + MAMAI_SERVICE.icon + '</span>' +
      '<span class="sf-mamai-text">' +
        '<span class="sf-mamai-title">' + tr(MAMAI_SERVICE.titleKey, MAMAI_SERVICE.title) + '<span class="sf-mamai-spark material-symbols-outlined" aria-hidden="true">auto_awesome</span></span>' +
        '<span class="sf-mamai-tagline">' + tr(MAMAI_SERVICE.taglineKey, MAMAI_SERVICE.tagline) + '</span>' +
        '<span class="sf-mamai-cta">' + tr(MAMAI_SERVICE.ctaKey, MAMAI_SERVICE.ctaFallback) + '</span>' +
      '</span>' +
    '</a>'
  );
}

// Heading icon glyphs -- real Material Symbols Outlined names already used
// site-wide (see SERVICE_CATALOG's own icon field, mam-ai.html, etc.), not
// a new icon set. Purely decorative labels for each column's real content,
// chosen to match the column's own existing heading key/meaning.
function headingWithIcon(icon, label) {
  return (
    '<span class="sf-heading-main">' +
      '<span class="sf-heading-icon material-symbols-outlined" aria-hidden="true">' + icon + '</span>' +
      '<span class="sf-heading-label">' + label + '</span>' +
    '</span>'
  );
}

function brandBlock() {
  // Same real brand lockup js/site-header.js uses -- "Darwesh" + the
  // approved official mark (images/brand/darwesh-approved-new-logo.png,
  // never redrawn, never recolored) inside the same shared white circular
  // badge the header uses (.brand-logo-circle, css/profile-tokens.css),
  // just larger here (.sf-brand-circle / .sf-brand-mark, css/site-
  // footer.css) since the footer wants a more prominent brand presence.
  // dir="ltr" pinned for the same reason as the header's own copy: a flex
  // row's visual order follows container direction, and under RTL that
  // would silently reverse the lockup to "Group [mark] Darwesh" -- the
  // brand name is a fixed Latin proper noun, never mirrored.
  return (
    '<div class="sf-brand">' +
      '<a href="index.html" dir="ltr" class="sf-brand-lockup" aria-label="Darwesh Group — Home" data-i18n-aria="nav.brandHomeLabel">' +
        '<span class="sf-brand-word">Darwesh</span>' +
        '<span class="brand-logo-circle sf-brand-circle">' +
          '<img src="images/brand/darwesh-approved-new-logo.png" alt="" decoding="async" class="sf-brand-mark object-contain">' +
        '</span>' +
        '<span class="sf-brand-word">Group</span>' +
      '</a>' +
      '<p class="sf-tagline">' + tr('footer.tagline', 'Darwesh Group connects property seekers, owners, professionals and services across Kurdistan through one trusted platform.') + '</p>' +
      mamAiRow() +
    '</div>'
  );
}

function propertiesColumn() {
  return (
    '<div class="sf-col">' +
      '<p class="sf-heading">' + headingWithIcon('home', tr('footer.propertiesHeading', 'Properties')) + '</p>' +
      '<ul class="sf-list">' +
        linkItem('buy.html', tr('nav.buy', 'Buy')) +
        linkItem('rent.html', tr('nav.rent', 'Rent')) +
        linkItem('map.html', tr('nav.propertiesMap', 'Properties Map')) +
        linkItem('sell.html', tr('nav.sell', 'Sell')) +
        linkItem('account.html', tr('footer.savedProperties', 'Saved Properties')) +
      '</ul>' +
    '</div>'
  );
}

function servicesColumn() {
  const items = PLAIN_SERVICES.map((s) => linkItem(s.directoryHref, tr(s.titleKey, s.title))).join('');
  return (
    '<div class="sf-col">' +
      '<p class="sf-heading">' + headingWithIcon('design_services', tr('nav.services', 'Services')) + '</p>' +
      '<ul class="sf-list">' + items + '</ul>' +
    '</div>'
  );
}

function professionalsColumn() {
  // The SAME real destinations as the Services column, framed as "browse
  // providers" rather than repeating the service-domain name -- reuses
  // each catalog entry's own real ctaKey/ctaFallback
  // (services.html/service-universe.js already show this exact text on
  // their own "Browse Engineers"/"Browse Lawyers"/etc. buttons).
  // 'installment' has no ctaKey framed as a profession (it is developer
  // projects, not people), so it is not repeated here.
  const items = SERVICE_CATALOG
    .filter((s) => s.serviceType) // real serviceProviders-backed roles only
    .map((s) => linkItem(s.directoryHref, tr(s.ctaKey, s.ctaFallback)))
    .join('');
  return (
    '<div class="sf-col">' +
      '<p class="sf-heading">' + headingWithIcon('groups', tr('footer.professionalsHeading', 'Professionals')) + '</p>' +
      '<ul class="sf-list">' + items + '</ul>' +
    '</div>'
  );
}

function companyColumn() {
  return (
    '<div class="sf-col">' +
      '<p class="sf-heading">' + headingWithIcon('apartment', tr('footer.company', 'Company')) + '</p>' +
      '<ul class="sf-list">' +
        linkItem('about.html', tr('nav.about', 'About')) +
        linkItem('services.html', tr('nav.services', 'Services')) +
        linkItem('mam-ai.html', tr('mamai.navLabel', 'MAM AI')) +
      '</ul>' +
    '</div>'
  );
}

function supportColumn() {
  // No Privacy Policy / Terms & Conditions / Cookie Policy / Help page
  // exists anywhere in this repository (verified by a full-repo grep
  // before this file was written) -- deliberately not listed here rather
  // than pointing at a fake href="#".
  return (
    '<div class="sf-col">' +
      '<p class="sf-heading">' + headingWithIcon('person', tr('footer.account', 'Account')) + '</p>' +
      '<ul class="sf-list">' +
        linkItem('login.html', tr('nav.login', 'Login')) +
        linkItem('signup.html', tr('nav.signUp', 'Sign Up')) +
        linkItem('account.html', tr('footer.myAccount', 'My Account')) +
      '</ul>' +
    '</div>'
  );
}

// Thin gold crest divider at the very top of the footer -- hand-authored
// abstract arch/line ornament (three simple strokes), NOT a copy of the
// real logo's bridge glyph and not derived from the logo file in any way.
// Purely decorative, per the brief's "subtle architectural line-art"ask.
function crest() {
  return (
    '<div class="sf-crest" aria-hidden="true">' +
      '<span class="sf-crest-line"></span>' +
      '<svg class="sf-crest-glyph" viewBox="0 0 48 20" width="48" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M2 18 L16 6 L24 2 L32 6 L46 18" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M24 2 L24 18" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
      '</svg>' +
      '<span class="sf-crest-line"></span>' +
    '</div>'
  );
}

function bottomStrip() {
  const year = new Date().getFullYear();
  return (
    '<div class="sf-bottom">' +
      '<span class="sf-copyright"><span class="sf-year">' + year + '</span> Darwesh Group. ' + tr('footer.rights', 'All rights reserved.') + '</span>' +
      '<span class="sf-location">' +
        '<span class="sf-location-icon material-symbols-outlined" aria-hidden="true">location_on</span>' +
        tr('footer.location', 'Kurdistan') +
      '</span>' +
    '</div>'
  );
}

// ---- mobile accordion -- headings become buttons that expand/collapse
// their own list; the brand block and bottom strip stay visible outside
// the accordion at every width (see css/site-footer.css's own media
// query for exactly which breakpoint this activates at). Re-wired after
// every render() since render() rebuilds the whole subtree.
function wireAccordion(root) {
  const cols = Array.prototype.slice.call(root.querySelectorAll('.sf-col'));
  cols.forEach((col, i) => {
    const heading = col.querySelector('.sf-heading');
    const list = col.querySelector('.sf-list');
    if (!heading || !list) return;
    const id = 'sfPanel' + i;
    list.id = id;
    heading.setAttribute('role', 'button');
    heading.setAttribute('tabindex', '0');
    heading.setAttribute('aria-expanded', 'false');
    heading.setAttribute('aria-controls', id);
    function toggle() {
      const open = col.classList.toggle('is-open');
      heading.setAttribute('aria-expanded', String(open));
    }
    heading.addEventListener('click', toggle);
    heading.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

(function () {
  const mount = document.getElementById('siteFooter');
  if (!mount) return;
  ensureStylesheet();

  function render() {
    mount.innerHTML =
      '<footer class="sf-root">' +
        '<div class="sf-inner">' +
          crest() +
          '<div class="sf-grid">' +
            brandBlock() +
            '<div class="sf-columns">' +
              propertiesColumn() +
              servicesColumn() +
              professionalsColumn() +
              companyColumn() +
              supportColumn() +
            '</div>' +
          '</div>' +
          bottomStrip() +
        '</div>' +
      '</footer>';
    wireAccordion(mount);
  }

  render();
  document.addEventListener('darwesh:langchange', render);
})();
