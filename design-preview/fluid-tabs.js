// Darwesh Group -- fluid segmented-tab controller (PREVIEW ONLY).
// Implements: one continuous indicator that stretches toward its target
// and settles, smooth retargeting mid-flight (no jump/queue), keyboard
// roving-tabindex, RTL via real getBoundingClientRect (no logical-direction
// math needed), reduced-motion, and optional linked content panels.
(function () {
  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initGroup(seg) {
    var indicator = seg.querySelector('.fl-seg-indicator');
    var tabs = Array.prototype.slice.call(seg.querySelectorAll('.fl-tab'));
    var panelsHost = seg.hasAttribute('data-panels-for')
      ? document.getElementById(seg.getAttribute('data-panels-for'))
      : null;
    var panels = panelsHost ? Array.prototype.slice.call(panelsHost.querySelectorAll('.fl-panel')) : [];

    function rectRelativeTo(el, container) {
      var r = el.getBoundingClientRect();
      var c = container.getBoundingClientRect();
      return { left: r.left - c.left, width: r.width };
    }

    function currentIndicatorRect() {
      // Read the indicator's OWN live box (mid-animation or at rest) --
      // this is what lets rapid switching retarget smoothly instead of
      // jumping back to the animation's original start point.
      var r = indicator.getBoundingClientRect();
      var c = seg.getBoundingClientRect();
      return { left: r.left - c.left, width: r.width };
    }

    function placeIndicatorInstant(tab) {
      var rect = rectRelativeTo(tab, seg);
      indicator.style.left = rect.left + 'px';
      indicator.style.width = rect.width + 'px';
    }

    function glideIndicatorTo(tab) {
      var from = currentIndicatorRect();
      var to = rectRelativeTo(tab, seg);

      indicator.getAnimations().forEach(function (a) { a.cancel(); });

      if (prefersReduced) {
        indicator.style.left = to.left + 'px';
        indicator.style.width = to.width + 'px';
        return;
      }

      // Union bounding box = the "bridge" the surface stretches across
      // mid-transit, like a droplet reaching toward the new position
      // before the trailing edge catches up.
      var unionLeft = Math.min(from.left, to.left);
      var unionRight = Math.max(from.left + from.width, to.left + to.width);

      var anim = indicator.animate([
        { left: from.left + 'px', width: from.width + 'px', top: '4px', bottom: '4px', offset: 0 },
        { left: unionLeft + 'px', width: (unionRight - unionLeft) + 'px', top: '6px', bottom: '6px', offset: 0.5 },
        { left: to.left + 'px', width: to.width + 'px', top: '4px', bottom: '4px', offset: 1 }
      ], {
        duration: 300,
        easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
        fill: 'forwards'
      });

      anim.onfinish = function () {
        indicator.style.left = to.left + 'px';
        indicator.style.width = to.width + 'px';
        indicator.style.top = '4px';
        indicator.style.bottom = '4px';
      };
    }

    function activate(tab, opts) {
      opts = opts || {};
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
        t.tabIndex = selected ? 0 : -1;
      });
      glideIndicatorTo(tab); // text-color transition (CSS, keyed off aria-selected) starts in the same tick

      if (panels.length) {
        var targetId = tab.getAttribute('aria-controls');
        panels.forEach(function (p) {
          var active = p.id === targetId;
          p.classList.toggle('is-active', active);
          if (active) { p.removeAttribute('inert'); p.removeAttribute('aria-hidden'); }
          else { p.setAttribute('inert', ''); p.setAttribute('aria-hidden', 'true'); }
        });
      }

      if (!opts.silent && typeof seg.__onActivate === 'function') seg.__onActivate(tab);
      if (opts.focus) tab.focus();
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function (e) {
        if (tab.hasAttribute('data-real-nav')) {
          // Glide the indicator immediately for visual feedback, then let
          // the browser follow the real href normally -- no SPA
          // interception, no preventDefault, no delayed navigation.
          glideIndicatorTo(tab);
          return;
        }
        activate(tab);
      });
      tab.addEventListener('keydown', function (e) {
        var idx = tabs.indexOf(tab);
        var isRtl = getComputedStyle(seg).direction === 'rtl';
        var prevKey = isRtl ? 'ArrowRight' : 'ArrowLeft';
        var nextKey = isRtl ? 'ArrowLeft' : 'ArrowRight';
        var target = null;
        if (e.key === nextKey) target = tabs[(idx + 1) % tabs.length];
        else if (e.key === prevKey) target = tabs[(idx - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') target = tabs[0];
        else if (e.key === 'End') target = tabs[tabs.length - 1];
        if (target) {
          e.preventDefault();
          if (target.hasAttribute('data-real-nav')) { target.focus(); return; }
          activate(target, { focus: true });
        }
      });
    });

    var initial = seg.querySelector('.fl-tab[aria-selected="true"]') || tabs[0];
    placeIndicatorInstant(initial);
    if (panels.length) {
      var initialId = initial.getAttribute('aria-controls');
      panels.forEach(function (p) {
        var active = p.id === initialId;
        p.classList.toggle('is-active', active);
        if (!active) { p.setAttribute('inert', ''); p.setAttribute('aria-hidden', 'true'); }
      });
    }

    // Re-snap on resize (label widths reflow, e.g. orientation change).
    window.addEventListener('resize', function () {
      var sel = seg.querySelector('.fl-tab[aria-selected="true"]');
      if (sel) placeIndicatorInstant(sel);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.fl-seg[data-fluid]').forEach(initGroup);
  });
})();
