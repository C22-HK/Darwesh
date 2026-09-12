// Tiny shared behavior for the isolated design preview only.
(function () {
  var els = document.querySelectorAll('.dp-reveal');
  if ('IntersectionObserver' in window && els.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    els.forEach(function (el) { io.observe(el); });
  } else {
    els.forEach(function (el) { el.classList.add('in'); });
  }

  var mbtn = document.querySelector('[data-mnav-toggle]');
  var sheet = document.querySelector('[data-mnav-sheet]');
  if (mbtn && sheet) {
    mbtn.addEventListener('click', function () {
      var open = sheet.classList.toggle('open');
      mbtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  document.querySelectorAll('[data-tab-group]').forEach(function (group) {
    var tabs = group.querySelectorAll('[data-tab]');
    var panels = document.querySelectorAll('[data-panel]');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var name = tab.getAttribute('data-tab');
        panels.forEach(function (p) {
          p.hidden = p.getAttribute('data-panel') !== name;
        });
      });
    });
  });
})();
