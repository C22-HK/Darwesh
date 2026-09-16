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
// LIGHTER v3 PASS: dropped the ornamental top crest/skyline watermark and
// the large highlighted MAM AI panel (was mamAiRow()/.sf-mamai) -- MAM AI
// is still reachable, just as a plain text link inside Company, same as
// every other real destination here. Also dropped the standalone
// Professionals column: every one of its links was the exact same
// directoryHref the Services column already lists (see SERVICE_CATALOG),
// just under a different label ("Browse Engineers" vs "Engineering") --
// two columns pointing at the same five pages was the duplication, not a
// feature. Structure is now brand (left) / three compact nav groups,
// Properties+Services+Company (center) / a quiet Account utility group
// (right) -- three real destinations each, per the brief.
//
// REAL ROUTES ONLY. Every href below is a page that actually exists in
// this repository and was verified during a full repo audit:
//   - Properties: buy.html, rent.html, map.html, sell.html, account.html
//     (My Account's own Favorites tab -- there is no separate "saved
//     properties" page).
//   - Services: engineer/lawyer/cleaning (service.html?type=X) + design.html
//     (its own richer discovery page, reused as-is) + a "More Services"
//     link to services.html for the remaining catalog entries
//     (landscaping, maintenance, installments) rather than listing every
//     one -- keeps this column to 6 rows, per the brief's own suggested
//     grouping.
//   - Company: about.html, projects.html, arena.html (the real "Challenge"
//     route, see js/site-header.js), mam-ai.html.
//   - Account: login.html, signup.html, account.html.
//   - No social links, no newsletter form, no Privacy/Terms/Cookie/Help
//     pages -- none exist anywhere in this repository (confirmed by a
//     full-repo grep before this file was first written) -- never faked.
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

const SVC = {};
SERVICE_CATALOG.forEach((s) => { SVC[s.key] = s; });

function linkItem(href, label) {
  return '<li><a class="sf-link" href="' + href + '">' + label + '</a></li>';
}

function brandBlock() {
  // Same real brand lockup js/site-header.js uses -- "Darwesh" + the
  // approved official mark (images/brand/darwesh-approved-new-logo.png,
  // never redrawn, never recolored) inside the same shared white circular
  // badge the header uses (.brand-logo-circle, css/profile-tokens.css).
  // dir="ltr" pinned for the same reason as the header's own copy: a flex
  // row's visual order follows container direction, and under RTL that
  // would silently reverse the lockup to "Group [mark] Darwesh" -- the
  // brand name is a fixed Latin proper noun, never mirrored.
  return (
    '<div class="sf-brand">' +
      '<a href="index.html" dir="ltr" class="sf-brand-lockup" aria-label="Darwesh Group — Home" data-i18n-aria="nav.brandHomeLabel">' +
        '<span class="sf-brand-word">Darwesh</span>' +
        '<span class="brand-logo-circle sf-brand-circle">' +
          '<picture><source srcset="images/brand/darwesh-approved-new-logo-192.webp" type="image/webp"><img src="images/brand/darwesh-approved-new-logo-192.png" alt="" decoding="async" class="sf-brand-mark object-contain"></picture>' +
        '</span>' +
        '<span class="sf-brand-word">Group</span>' +
      '</a>' +
      '<p class="sf-tagline">' + tr('footer.tagline', 'Connecting property, people and trusted services across Kurdistan and Iraq.') + '</p>' +
    '</div>'
  );
}

// One shared column shape for both the three nav groups and the Account
// utility group, so wireAccordion() below (which just looks for `.sf-col`)
// wires all four identically on mobile without special-casing any of them.
function col(heading, listHtml, extraClass) {
  return (
    '<div class="sf-col' + (extraClass ? ' ' + extraClass : '') + '">' +
      '<p class="sf-heading">' + heading + '</p>' +
      '<ul class="sf-list">' + listHtml + '</ul>' +
    '</div>'
  );
}

function propertiesColumn() {
  return col(
    tr('footer.propertiesHeading', 'Properties'),
    linkItem('buy.html', tr('nav.buy', 'Buy')) +
    linkItem('rent.html', tr('nav.rent', 'Rent')) +
    linkItem('map.html', tr('nav.propertiesMap', 'Properties Map')) +
    linkItem('sell.html', tr('nav.sell', 'Sell')) +
    linkItem('account.html', tr('footer.savedProperties', 'Saved Properties'))
  );
}

function servicesColumn() {
  const eng = SVC.engineer, design = SVC.designer, lawyer = SVC.lawyer, cleaning = SVC.cleaning;
  return col(
    tr('nav.services', 'Services'),
    (eng ? linkItem(eng.directoryHref, tr(eng.titleKey, eng.title)) : '') +
    (design ? linkItem(design.directoryHref, tr('footer.serviceDesign', 'Design')) : '') +
    (lawyer ? linkItem(lawyer.directoryHref, tr(lawyer.titleKey, lawyer.title)) : '') +
    (cleaning ? linkItem(cleaning.directoryHref, tr(cleaning.titleKey, cleaning.title)) : '') +
    linkItem('services.html', tr('footer.moreServices', 'More Services'))
  );
}

function companyColumn() {
  return col(
    tr('footer.company', 'Company'),
    linkItem('about.html', tr('nav.about', 'About')) +
    linkItem('projects.html', tr('proj.breadcrumbProjects', 'Projects')) +
    linkItem('arena.html', tr('arena.navLabel', 'Challenge')) +
    linkItem('mam-ai.html', tr('mamai.navLabel', 'MAM AI'))
  );
}

function accountGroup() {
  return col(
    tr('footer.account', 'Account'),
    linkItem('login.html', tr('nav.login', 'Login')) +
    linkItem('signup.html', tr('nav.signUp', 'Sign Up')) +
    linkItem('account.html', tr('footer.myAccount', 'My Account')),
    'sf-col--utility'
  );
}

function backToTopButton() {
  return (
    '<button type="button" class="sf-backtotop" id="sfBackToTop">' +
      '<span class="material-symbols-outlined" aria-hidden="true">arrow_upward</span>' +
      '<span>' + tr('footer.backToTop', 'Back to top') + '</span>' +
    '</button>'
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
      backToTopButton() +
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

function wireBackToTop(root) {
  const btn = root.querySelector('#sfBackToTop');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
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
          '<div class="sf-grid">' +
            brandBlock() +
            '<nav class="sf-groups" aria-label="' + tr('footer.navLabel', 'Footer') + '">' +
              propertiesColumn() +
              servicesColumn() +
              companyColumn() +
            '</nav>' +
            '<div class="sf-utility">' + accountGroup() + '</div>' +
          '</div>' +
          bottomStrip() +
        '</div>' +
      '</footer>';
    wireAccordion(mount);
    wireBackToTop(mount);
  }

  render();
  document.addEventListener('darwesh:langchange', render);
})();
