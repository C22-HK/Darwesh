// Darwesh Group -- calm section-reveal on scroll.
//
// Purely a presentation nicety: every .cine-reveal element starts visible
// in markup (no [hidden]/display:none), and CSS gives it its "pre-reveal"
// opacity/transform state only once this script confirms IntersectionObserver
// is actually available -- so content is never blocked from appearing if JS
// fails to run or the browser lacks IntersectionObserver support.
// Never hijacks scroll position or blocks native scrolling.
(function () {
  const els = document.querySelectorAll('.cine-reveal');
  if (!els.length) return;

  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => el.classList.add('cine-in-view'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('cine-in-view');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  els.forEach((el) => io.observe(el));
})();
