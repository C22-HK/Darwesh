// Touch/no-hover activation for the Buy/Rent/Build/Renovate/Sell panel wall
// (.w-panels, index.html section 2). Desktop expansion is pure CSS
// (:hover / :focus-within on .w-panel) and needs no JS at all. This file
// exists only for viewports with no hover -- there, the row becomes a
// horizontal snap-scroller and the "active" (widened, horizontal-title)
// panel is whichever one sits nearest the row's center, tracked here via
// scroll position rather than pointer events that don't exist on touch.
(function () {
  var track = document.querySelector('.w-panels');
  if (!track) return;
  var panels = Array.prototype.slice.call(track.querySelectorAll('.w-panel'));
  if (!panels.length) return;

  var hoverMq = window.matchMedia('(hover: hover)');

  function setActiveByScroll() {
    if (hoverMq.matches) return; // desktop: CSS :hover/:focus-within owns this
    var trackRect = track.getBoundingClientRect();
    var centerX = trackRect.left + trackRect.width / 2;
    var closest = null;
    var closestDist = Infinity;
    for (var i = 0; i < panels.length; i++) {
      var r = panels[i].getBoundingClientRect();
      var dist = Math.abs(r.left + r.width / 2 - centerX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = panels[i];
      }
    }
    panels.forEach(function (p) {
      p.classList.toggle('is-active', p === closest);
    });
  }

  var ticking = false;
  track.addEventListener(
    'scroll',
    function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        setActiveByScroll();
        ticking = false;
      });
    },
    { passive: true }
  );

  window.addEventListener('resize', setActiveByScroll);
  if (typeof hoverMq.addEventListener === 'function') {
    hoverMq.addEventListener('change', setActiveByScroll);
  }
  setActiveByScroll();
})();
