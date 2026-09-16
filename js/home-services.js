// Darwesh Home -- SERVICES DISCOVERY, rotating cover-flow card system.
//
// Replaces the shared js/services-carousel.js MOUNT on the Home page only
// (services.html's own hero keeps that module, completely untouched --
// see index.html's comment above this section for why). This is a
// dedicated Home component, deliberately NOT shared with services.html,
// so this redesign's own sizing/pagination/card-content rules can never
// leak into that page and vice versa.
//
// One JS-driven transform model on EVERY breakpoint -- no native scroll
// container anywhere. Each card's position is a pure function of its
// signed offset from `focus` (translateX/translateY/rotateY/scale/opacity,
// see paint()): the active card sits full-size and unrotated in the
// centre, its immediate neighbours sit partially behind it curved inward,
// and a further ring shows only a narrow sliver. Moving next/previous
// (arrows, keyboard, or a swipe -- same synthetic gesture handler on every
// breakpoint) animates every card along that same curved path via a CSS
// transition, never an instant swap. data-near="0|1" and the "01 / NN +
// progress line" pagination are the same proven pattern City Discovery's
// gallery already established, reapplied here with their own .w-svc-*
// classes (see css/home-world.css) so neither section's CSS can
// accidentally resize or restyle the other.
//
// Data: the real SERVICE_CATALOG (js/service-catalog.js), the same single
// source of truth services.html and service.html already use. MAM AI
// (SERVICE_CATALOG's 8th, non-provider-directory entry) is not a provider
// listing, so it stays out of this carousel entirely -- reachable from the
// navbar, its own dedicated page, and elsewhere, not duplicated here.
// Every card's href is that service's real, unchanged directoryHref; no
// service page is invented and no route is altered.
import { SERVICE_CATALOG } from './service-catalog.js';

const mount = document.getElementById('svcGallery');

if (mount) {
  // 7 real provider/offer services; MAM AI is excluded (not a directory listing).
  const SERVICES = SERVICE_CATALOG.filter((s) => s.key !== 'mamai');

  // Deterministic, muted per-card fallback gradient (h/s/l) -- only ever
  // visible on the two catalog entries with no photo yet (maintenance,
  // installment); every photo card's --img fully covers it. Desaturated
  // warm neutrals, consistent with the graphite/champagne Home palette --
  // never a bright/neon placeholder.
  const TONES = [
    { h: 30, s: 14, l: 22 }, { h: 40, s: 16, l: 26 }, { h: 24, s: 12, l: 24 },
    { h: 36, s: 18, l: 20 }, { h: 20, s: 14, l: 28 }, { h: 44, s: 16, l: 22 },
    { h: 28, s: 12, l: 26 }
  ];

  // window.t() reads js/i18n.js's internal `translations` cache, which is
  // only populated inside its DOMContentLoaded handler -- this module (a
  // deferred ES module, per spec executed before DOMContentLoaded) can run
  // earlier than that on a fresh non-English load, when window.t() would
  // still return null even though the dictionary itself has already
  // finished loading (js/i18n.js's synchronous document.write bootstrap).
  // Falling back to the raw window.__DARWESH_I18N__ dictionary the
  // language script itself sets keeps every card correctly translated on
  // first paint, not just after a live language switch.
  function tr(k, fallback) {
    if (window.t) {
      const v = window.t(k);
      if (v) return v;
    }
    try {
      const lang = localStorage.getItem('darwesh_lang') || 'en';
      const dict = window.__DARWESH_I18N__ && window.__DARWESH_I18N__[lang];
      if (dict && dict[k]) return dict[k];
    } catch (e) { /* localStorage may be unavailable; fall through */ }
    return fallback;
  }
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s));
  const pad2 = (n) => String(n).padStart(2, '0');

  let focus = 0;

  const arrow =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

  // service-catalog.js's `photo` paths are page-relative ("images/...",
  // correct for every other consumer of that field). A url() inside a CSS
  // custom property resolves against wherever the var() consuming it
  // lives -- css/home-world.css's .w-svc-plane-face rule, not this page --
  // so it must be root-relative here specifically (same fix already
  // applied in js/city-gallery.js for the identical --img mechanism).
  function rootRelative(path) {
    return /^(\/|https?:)/.test(path) ? path : '/' + path;
  }

  function cardHtml(svc, i) {
    const tone = TONES[i % TONES.length];
    return (
      '<a class="w-svc-plane" href="' + esc(svc.directoryHref) + '"' +
        ' data-i="' + i + '" style="--h:' + tone.h + ';--s:' + tone.s + ';--l:' + tone.l +
        (svc.photo ? ';--img:url(' + rootRelative(svc.photo) + ')' : '') + '">' +
        '<span class="w-svc-plane-face" aria-hidden="true"></span>' +
        '<span class="w-svc-plane-scrim" aria-hidden="true"></span>' +
        '<span class="w-svc-plane-icon" aria-hidden="true"><span class="material-symbols-outlined">' + esc(svc.icon) + '</span></span>' +
        '<span class="w-svc-plane-body">' +
          '<span class="w-svc-plane-title" data-svc-title>' + esc(tr(svc.titleKey, svc.title)) + '</span>' +
          '<span class="w-svc-plane-desc" data-svc-desc>' + esc(tr(svc.taglineKey, svc.tagline)) + '</span>' +
          '<span class="w-svc-plane-go"><span data-svc-cta>' + esc(tr(svc.ctaKey, svc.ctaFallback)) + '</span>' + arrow + '</span>' +
        '</span>' +
      '</a>'
    );
  }

  mount.innerHTML =
    '<div class="w-svc-stage-wrap">' +
      '<button type="button" class="w-icon-btn w-svc-arrow w-svc-arrow-prev" data-svc-prev aria-label="' + esc(tr('common.previous', 'Previous')) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>' +
      '</button>' +
      '<div class="w-svc-gallery" id="svcWall">' +
        '<div class="w-svc-wall">' +
          SERVICES.map(cardHtml).join('') +
        '</div>' +
      '</div>' +
      '<button type="button" class="w-icon-btn w-svc-arrow w-svc-arrow-next" data-svc-next aria-label="' + esc(tr('common.next', 'Next')) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="w-svc-gallery-nav">' +
      '<div class="w-svc-gallery-progress">' +
        '<span class="w-svc-gallery-count" aria-live="polite">' +
          '<span data-svc-current>01</span><span class="w-svc-gallery-count-sep">/</span><span data-svc-total>' + pad2(SERVICES.length) + '</span>' +
        '</span>' +
        '<span class="w-svc-gallery-track" aria-hidden="true"><span class="w-svc-gallery-fill" data-svc-fill></span></span>' +
      '</div>' +
    '</div>';

  const planes = Array.prototype.slice.call(mount.querySelectorAll('.w-svc-plane'));
  const currentEl = mount.querySelector('[data-svc-current]');
  const fillEl = mount.querySelector('[data-svc-fill]');
  // #svcWall is the outer '.w-svc-gallery' div -- the positioning context
  // every plane's transform is relative to, and the element keyboard/
  // swipe listeners bind to, on every breakpoint.
  const wall = mount.querySelector('#svcWall');

  const isMobileCarousel = () => window.matchMedia('(max-width: 767px)').matches;

  // Rotating cover-flow geometry -- the SAME model on every breakpoint (no
  // native scroll container anywhere; a swipe/arrow/key press always moves
  // `focus` and paint() animates every card along the curved path).
  // translateX fractions are shared since a card's own rendered width
  // already scales with viewport (clamp()), so the proportions stay
  // correct -- but rotateY/translateY/opacity are lighter on mobile per
  // spec (a smaller card standing closer to the viewer needs a gentler
  // depth cue than the wider desktop cluster, or the effect reads as too
  // heavy for its own size).
  //   tier 0 (active):    translateX 0,             scale 1,    rotateY 0
  //   tier 1 (neighbour):  ~60% of the card's own width, scale ~0.92, rotateY ~14deg (8deg mobile)
  //   tier 2 (outer):      a further ~25% beyond that,  scale ~0.85, rotateY ~22deg (13deg mobile)
  // rotateY sign is derived from the card's PHYSICAL side (not array
  // order): physically-left cards rotate positive, physically-right cards
  // rotate negative, so both appear to angle toward the viewer/centre --
  // this falls out of the existing --dir/RTL physicalSign math for free.
  // Desktop's translateX fractions (0.6/0.25) were tuned against its own
  // wider cluster (~54rem stage, multiple cards genuinely side by side).
  // On mobile's narrower, full-bleed single-card layout the SAME fractions
  // leave most of the neighbour sitting directly behind the active card
  // (active has the higher z-index), so only the active card's own side
  // margin -- not the fraction -- ends up governing how much peeks out,
  // and that margin alone measured ~19%, above the 12-16% target. A larger
  // mobile-only fraction moves the neighbour further along the arc before
  // the active card's edge, so the exposed sliver is set by the ARC
  // position again, not just by how much of the viewport the active card
  // leaves bare. Verified live via pixel-sampled elementFromPoint (not
  // just bounding-box math, which reports the neighbour's full extent even
  // where the active card is actually painted over it).
  const TIER1_FRACTION_DESKTOP = 0.6, TIER2_EXTRA_FRACTION_DESKTOP = 0.25;
  const TIER1_FRACTION_MOBILE = 1.0, TIER2_EXTRA_FRACTION_MOBILE = 0.22;
  const TIER1_SCALE = 0.92, TIER2_SCALE = 0.85;
  const TIER1_OPACITY_DESKTOP = 0.76, TIER2_OPACITY_DESKTOP = 0.42;
  const TIER1_OPACITY_MOBILE = 0.70, TIER2_OPACITY_MOBILE = 0.36;
  const TIER1_TY_DESKTOP = 10, TIER2_TY_DESKTOP = 16;
  const TIER1_TY_MOBILE = 7, TIER2_TY_MOBILE = 12;
  const TIER1_ROTATE_DESKTOP = 14, TIER2_ROTATE_DESKTOP = 22;
  const TIER1_ROTATE_MOBILE = 8, TIER2_ROTATE_MOBILE = 13;

  function cardWidth() {
    return (planes[0] && planes[0].getBoundingClientRect().width) || 0;
  }

  function paint() {
    const mobile = isMobileCarousel();
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    const w = cardWidth();
    const tier1Fraction = mobile ? TIER1_FRACTION_MOBILE : TIER1_FRACTION_DESKTOP;
    const tier2ExtraFraction = mobile ? TIER2_EXTRA_FRACTION_MOBILE : TIER2_EXTRA_FRACTION_DESKTOP;
    const step1 = w * tier1Fraction;
    const step2 = step1 + w * tier2ExtraFraction;
    const rot1 = mobile ? TIER1_ROTATE_MOBILE : TIER1_ROTATE_DESKTOP;
    const rot2 = mobile ? TIER2_ROTATE_MOBILE : TIER2_ROTATE_DESKTOP;
    const ty1 = mobile ? TIER1_TY_MOBILE : TIER1_TY_DESKTOP;
    const ty2 = mobile ? TIER2_TY_MOBILE : TIER2_TY_DESKTOP;
    const op1 = mobile ? TIER1_OPACITY_MOBILE : TIER1_OPACITY_DESKTOP;
    const op2 = mobile ? TIER2_OPACITY_MOBILE : TIER2_OPACITY_DESKTOP;
    for (let i = 0; i < planes.length; i++) {
      const o = i - focus;
      const absO = Math.abs(o);
      // "Readable" tier for a11y purposes -- the active card and its
      // immediate neighbour; tier-2 outer slivers are too narrow to read
      // and are hidden from assistive tech, same reasoning City Discovery's
      // gallery already uses for its own near/far cutoff.
      const ariaNear = absO <= 1;
      const dirSign = o === 0 ? 0 : (o > 0 ? 1 : -1);
      const physicalSign = dirSign * (rtl ? -1 : 1);

      let tx = 0, ty = 0, ry = 0, scale = 1, opacity = 1, z = 30, sat = 1, bright = 1, visible = true;
      if (absO === 1) {
        tx = physicalSign * step1; ty = ty1; ry = -physicalSign * rot1;
        scale = TIER1_SCALE; opacity = op1; z = 20; bright = 0.94;
      } else if (absO === 2) {
        tx = physicalSign * step2; ty = ty2; ry = -physicalSign * rot2;
        scale = TIER2_SCALE; opacity = op2; z = 10; sat = 0.82; bright = 0.82;
      } else if (absO > 2) {
        visible = false;
      }

      planes[i].style.setProperty('--tx', tx.toFixed(1) + 'px');
      planes[i].style.setProperty('--ty', ty.toFixed(1) + 'px');
      planes[i].style.setProperty('--ry', ry.toFixed(1) + 'deg');
      planes[i].style.setProperty('--scale', String(scale));
      planes[i].style.opacity = visible ? String(opacity) : '0';
      planes[i].style.zIndex = String(z);
      planes[i].style.filter = 'saturate(' + sat + ') brightness(' + bright + ')';
      planes[i].style.pointerEvents = visible ? '' : 'none';
      planes[i].setAttribute('data-focus', o === 0 ? '1' : '0');
      planes[i].setAttribute('data-near', ariaNear ? '1' : '0');
      // Only the focused card is a real tab stop on every breakpoint --
      // arrows (desktop) and swipe (mobile) are the actual keyboard/touch
      // path past it, so a wall of partially-hidden links behind each
      // other is never a keyboard trap.
      planes[i].tabIndex = o === 0 ? 0 : -1;
      planes[i].setAttribute('aria-hidden', ariaNear ? 'false' : 'true');
    }
    if (currentEl) currentEl.textContent = pad2(focus + 1);
    if (fillEl) fillEl.style.width = ((focus / Math.max(1, SERVICES.length - 1)) * 100) + '%';
  }

  function go(next) {
    focus = Math.max(0, Math.min(SERVICES.length - 1, next));
    paint();
  }

  // Clicking a partially-visible card brings it to the centre instead of
  // navigating away immediately -- only the already-active card's own real
  // href (or its "Explore Service" CTA, same element) actually leaves the
  // page. Applies on every breakpoint now: there is no native scroller
  // anywhere any more, so a tap on a neighbour card is the mobile
  // equivalent of a click on one too.
  planes.forEach((el, i) => {
    el.addEventListener('click', (e) => {
      if (i !== focus) { e.preventDefault(); go(i); }
    });
  });

  mount.querySelector('[data-svc-prev]').addEventListener('click', () => go(focus - 1));
  mount.querySelector('[data-svc-next]').addEventListener('click', () => go(focus + 1));

  wall.tabIndex = 0;
  wall.setAttribute('role', 'group');
  wall.setAttribute('aria-label', tr('svc.carouselAriaLabel', 'Darwesh services carousel'));
  wall.addEventListener('keydown', (e) => {
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    if (e.key === 'ArrowRight') { e.preventDefault(); go(focus + (rtl ? -1 : 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(focus + (rtl ? 1 : -1)); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(SERVICES.length - 1); }
  });

  // Synthetic swipe drives every breakpoint now -- there is no native
  // scroller for a real drag to hand off to any more (a swipe rotates the
  // set one card at a time, "controlled snap-to-card", not a free scroll).
  // touch-action:pan-y (home-world.css) keeps vertical page scroll working
  // while this handler owns horizontal gestures.
  let sx = 0, sy = 0, tracking = false;
  wall.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  wall.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    go(focus + ((dx < 0) === !rtl ? 1 : -1));
  }, { passive: true });

  // Service titles/descriptions/CTAs are real translated strings (unlike
  // City Discovery's proper-noun city names), so a live language switch
  // needs to relabel every card -- mirrors js/services-carousel.js's own
  // existing darwesh:langchange handler for the same content.
  document.addEventListener('darwesh:langchange', () => {
    planes.forEach((el, i) => {
      const svc = SERVICES[i];
      const titleEl = el.querySelector('[data-svc-title]');
      const descEl = el.querySelector('[data-svc-desc]');
      const ctaEl = el.querySelector('[data-svc-cta]');
      if (titleEl) titleEl.textContent = tr(svc.titleKey, svc.title);
      if (descEl) descEl.textContent = tr(svc.taglineKey, svc.tagline);
      if (ctaEl) ctaEl.textContent = tr(svc.ctaKey, svc.ctaFallback);
    });
    mount.querySelector('[data-svc-prev]').setAttribute('aria-label', tr('common.previous', 'Previous'));
    mount.querySelector('[data-svc-next]').setAttribute('aria-label', tr('common.next', 'Next'));
    wall.setAttribute('aria-label', tr('svc.carouselAriaLabel', 'Darwesh services carousel'));
  });

  // A resize/orientation-change that crosses the 768px breakpoint changes
  // both the card's own rendered width (--tx/--ty depend on it) and which
  // rotate-angle constants apply -- unlike the old CSS-override mobile
  // path, nothing here recomputes on its own without a repaint.
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(paint);
  });

  paint();
}
