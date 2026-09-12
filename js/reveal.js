// Darwesh Group -- calm section-reveal on scroll.
//
// Purely a presentation nicety: every .cine-reveal/.cine-card-reveal element
// starts visible in markup (no [hidden]/display:none), and CSS gives it its
// "pre-reveal" opacity/transform state only once this script confirms
// IntersectionObserver is actually available -- so content is never blocked
// from appearing if JS fails to run or the browser lacks IntersectionObserver
// support. Never hijacks scroll position or blocks native scrolling.
//
// ONE shared IntersectionObserver instance for the whole page (never one per
// section/card) -- window.DarweshReveal.observe(el) lets code that renders
// content AFTER this script ran (the city/fast-sale/active carousels, built
// from Firestore data) add their own cards into the same observer instead of
// spinning up a second one, matching the "single centralized controller, no
// duplicate listeners" brief this page's 3D scroll system already follows.
(function () {
  const SELECTOR = '.cine-reveal, .cine-card-reveal';
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const supported = 'IntersectionObserver' in window;

  let io = null;
  if (supported && !reduced) {
    io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('cine-in-view');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  }

  function observe(el) {
    if (!el) return;
    if (!io) { el.classList.add('cine-in-view'); return; }
    io.observe(el);
  }

  function observeAll(els) {
    Array.prototype.forEach.call(els, observe);
  }

  document.querySelectorAll(SELECTOR).forEach(observe);

  window.DarweshReveal = { observe, observeAll };
})();
