// Darwesh Group — Services Carousel (production).
//
// Replaces the Service Universe orbital widget's MOUNT on services.html
// only. js/service-universe.js and css/service-universe.css are left
// fully intact -- installments.html/renovate.html/build.html/service.html
// still load the stylesheet for shared classes, and nothing here touches
// that file.
//
// Card photography: 5 of the 7 carousel services have a real `photo`
// field on their SERVICE_CATALOG entry (recreated stand-in photographs
// approved against a supplied design reference -- see
// images/services/README if present). Maintenance & Repair and
// Installments have no photo yet and use the same material-symbols-
// outlined icon treatment the rest of the site already uses for these
// services (service-universe.js's own planets, signup-professional.html,
// etc.) -- not a placeholder invented for this component.
//
// Engine (circular wrap math, spring settle physics, drag/pointer
// handling) is carried over unchanged from the approved design preview;
// only data source (real SERVICE_CATALOG import) and text source (real
// window.t()/i18n keys, not a preview-local table) changed.
import { SERVICE_CATALOG } from './service-catalog.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

// The 7 real provider/offer services shown in the carousel itself; MAM AI
// (SERVICE_CATALOG's 8th entry) is not a provider directory and is
// presented separately below, per the approved design.
const CAROUSEL_SERVICES = SERVICE_CATALOG.filter((s) => s.key !== 'mamai');
const MAM_SERVICE = SERVICE_CATALOG.find((s) => s.key === 'mamai');

// Carousel-only presentation order (indices into CAROUSEL_SERVICES).
// Chosen so that, combined with an initial selection of position 1 and
// circular wrapping, the five visible cards read:
//   Landscaping, Engineering, [Interior Design], Legal, Cleaning  (02/07)
// -- matching the approved reference's balanced initial arrangement.
// Each card still links to its own real, unchanged destination.
const CAROUSEL_ORDER = [0, 1, 2, 4, 5, 6, 3];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function ServicesCarousel(root) {
  this.root = root;
  this.stage = root.querySelector('.svcc-stage');
  this.services = CAROUSEL_SERVICES;
  this.order = CAROUSEL_ORDER;
  this.n = this.order.length;

  // `index`/`target` are UNBOUNDED reals representing accumulated
  // circular position -- rendering always re-derives each card's actual
  // angular offset via `_shortestOffset` (mod n), so the spring never
  // needs to know about wrap boundaries. Initial position 1 = the
  // Interior Design slot, matching the approved reference.
  this.index = 1;
  this.target = 1;
  this.dragging = false;
  this.dragStartX = 0;
  this.dragStartIndex = 0;
  this.dragMoved = 0;
  this.samples = [];
  this.rafId = null;
  this.suppressNextClick = false;

  this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  this.cardEls = [];
  this._buildCards();
  this._buildEvents();
  this._syncDetail(true);
  this._render();
}

ServicesCarousel.prototype._isRtl = function () {
  return getComputedStyle(this.root).direction === 'rtl';
};

ServicesCarousel.prototype._shortestOffset = function (i, pos) {
  const n = this.n;
  let raw = ((i - pos) % n + n) % n;
  if (raw > n / 2) raw -= n;
  return raw;
};

ServicesCarousel.prototype._svcAt = function (orderPos) {
  const n = this.n;
  const p = ((Math.round(orderPos) % n) + n) % n;
  return this.services[this.order[p]];
};

ServicesCarousel.prototype._buildCards = function () {
  const self = this;
  this.order.forEach((svcIdx, i) => {
    const svc = self.services[svcIdx];
    const card = document.createElement('div');
    card.className = 'svcc-card';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-roledescription', 'slide');
    card.setAttribute('aria-label', (i + 1) + ' of ' + self.n + ': ' + tr(svc.titleKey, svc.title));
    // Cards themselves are not individually tabbable (avoids confusing
    // off-screen focus stops) -- Prev/Next buttons, the carousel region
    // itself (arrow keys), and the "All services" strip already on this
    // page are the real keyboard-operable paths to the same services.
    const artHtml = svc.photo
      ? '<img class="svcc-card-photo" src="' + esc(svc.photo) + '" alt="" loading="lazy" draggable="false"/>'
      : '<div class="svcc-card-art" aria-hidden="true"><span class="material-symbols-outlined">' + esc(svc.fallbackIcon || svc.icon) + '</span></div>';
    card.innerHTML = artHtml + '<div class="svcc-card-caption"><span class="svcc-card-caption-text">' + esc(tr(svc.titleKey, svc.title)) + '</span></div>';
    card.dataset.svcKey = svc.key;
    card.addEventListener('click', () => {
      if (self.suppressNextClick) { self.suppressNextClick = false; return; }
      self.goTo(i, { userInitiated: true });
    });
    self.stage.appendChild(card);
    self.cardEls.push(card);
  });
};

ServicesCarousel.prototype._buildEvents = function () {
  const self = this;

  this.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    self.dragging = true;
    self.dragMoved = 0;
    self.dragStartX = e.clientX;
    self.dragStartIndex = self.index;
    self.samples = [{ t: performance.now(), index: self.index }];
    // setPointerCapture redirects this gesture's pointerup (and the
    // resulting synthetic click) to target `stage` itself, per the
    // Pointer Events spec -- so a card's own 'click' listener never
    // fires for a pointer/touch tap once capture is set (confirmed via
    // per-event target logging, not assumed). Record which card the
    // gesture actually started on now, while e.target is still correct,
    // so a short tap (no real drag) can still select it from endDrag().
    const cardEl = e.target.closest && e.target.closest('.svcc-card');
    self._pointerDownCardIndex = cardEl ? self.cardEls.indexOf(cardEl) : -1;
    self.stage.setPointerCapture && self.stage.setPointerCapture(e.pointerId);
    self._stopAnim();
  }, { passive: true });

  this.stage.addEventListener('pointermove', (e) => {
    if (!self.dragging) return;
    const dx = e.clientX - self.dragStartX;
    self.dragMoved = Math.max(self.dragMoved, Math.abs(dx));
    const cardStep = self._cardStep();
    const deltaIndex = dx / cardStep;
    // No edge resistance needed: the roulette is circular, so dragging
    // just keeps following the pointer 1:1 in either direction forever.
    self.index = self._isRtl() ? self.dragStartIndex + deltaIndex : self.dragStartIndex - deltaIndex;
    self.samples.push({ t: performance.now(), index: self.index });
    if (self.samples.length > 6) self.samples.shift();
    self._render();
  });

  function endDrag() {
    if (!self.dragging) return;
    self.dragging = false;

    // A short tap (not a real drag) that started on a specific card
    // selects that card directly -- this is the reliable path (see the
    // pointerdown handler above for why the card's own 'click' listener
    // can't be relied on once pointer capture is active).
    if (self.dragMoved <= 6 && self._pointerDownCardIndex >= 0) {
      self.goTo(self._pointerDownCardIndex, { userInitiated: true });
      self._pointerDownCardIndex = -1;
      return;
    }
    self._pointerDownCardIndex = -1;
    if (self.dragMoved > 6) self.suppressNextClick = true;

    const velocity = self._velocity();
    const nearest = Math.round(self.index);
    let targetUnbounded = nearest;
    const FLICK = 0.0016; // tuned empirically; a firm flick, not a light tap
    if (Math.abs(velocity) > FLICK) {
      const dir = velocity > 0 ? 1 : -1;
      const flickTarget = Math.round(self.index) + (self.index - self.dragStartIndex > 0 === dir > 0 ? dir : 0);
      // Limit momentum to at most one extra step beyond the nearest
      // snap, never a multi-card skip.
      if (Math.abs(flickTarget - nearest) <= 1) targetUnbounded = flickTarget;
    }
    // Settle to the actual unbounded position the drag reached (never
    // reinterpreted as a "shortest path" from wherever navigation last
    // left off).
    self._settleTo(targetUnbounded);
  }
  this.stage.addEventListener('pointerup', endDrag);
  this.stage.addEventListener('pointercancel', endDrag);
  this.stage.addEventListener('lostpointercapture', endDrag);

  // Keyboard on the stage region itself (role="group", tabindex 0):
  // arrow keys / Home / End move selection without requiring focus to
  // land on individual cards.
  this.stage.addEventListener('keydown', (e) => {
    const rtl = self._isRtl();
    const prevKey = rtl ? 'ArrowRight' : 'ArrowLeft';
    const nextKey = rtl ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === nextKey) { e.preventDefault(); self.step(1); }
    else if (e.key === prevKey) { e.preventDefault(); self.step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); self.goTo(0, { userInitiated: true }); }
    else if (e.key === 'End') { e.preventDefault(); self.goTo(self.n - 1, { userInitiated: true }); }
  });

  window.addEventListener('resize', () => self._render());

  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (ev) => {
    self.reduced = ev.matches;
  });
};

ServicesCarousel.prototype._velocity = function () {
  if (this.samples.length < 2) return 0;
  const last = this.samples[this.samples.length - 1];
  const first = this.samples[0];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.index - first.index) / dt;
};

ServicesCarousel.prototype._cardStep = function () {
  const w = this.stage.clientWidth;
  return w < 700 ? w * 0.56 : 198; // spacing between card centers (overlapping, per reference)
};

ServicesCarousel.prototype.step = function (dir) {
  const n = this.n;
  const curPos = ((Math.round(this.target) % n) + n) % n;
  this.goTo(curPos + dir, { userInitiated: true });
};

// Public API: `pos` is a position in order-space (0..n-1). Takes the
// shortest circular path from the current target -- correct for
// discrete jumps (arrows, keyboard, direct card clicks).
ServicesCarousel.prototype.goTo = function (pos) {
  const n = this.n;
  pos = ((Math.round(pos) % n) + n) % n;
  const curPos = ((Math.round(this.target) % n) + n) % n;
  let delta = pos - curPos;
  if (delta > n / 2) delta -= n;
  else if (delta < -n / 2) delta += n;
  this._settleTo(this.target + delta);
};

// Internal: sets the unbounded target directly (no shortest-path
// reinterpretation) and starts the settle animation.
ServicesCarousel.prototype._settleTo = function (unboundedTarget) {
  this.target = unboundedTarget;
  this._syncDetail(false);
  this._startAnim();
};

ServicesCarousel.prototype._startAnim = function () {
  const self = this;
  if (this.reduced) {
    this.index = this.target;
    this._render();
    this._onSettled();
    return;
  }
  this._stopAnim();
  let lastT = performance.now();
  let velocity = 0;
  // Critically-damped spring, integrated with dt in SECONDS. STIFFNESS/
  // DAMPING tuned for a ~350-400ms full-card settle.
  const STIFFNESS = 420;
  const DAMPING = 41;
  function frame(t) {
    const dt = Math.min(0.032, (t - lastT) / 1000);
    lastT = t;
    const diff = self.target - self.index;
    const accel = diff * STIFFNESS - velocity * DAMPING;
    velocity += accel * dt;
    self.index += velocity * dt;
    self._render();
    if (Math.abs(diff) < 0.001 && Math.abs(velocity) < 0.02) {
      self.index = self.target;
      self._render();
      self._onSettled();
      return;
    }
    self.rafId = requestAnimationFrame(frame);
  }
  this.rafId = requestAnimationFrame(frame);
};

ServicesCarousel.prototype._stopAnim = function () {
  if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
};

ServicesCarousel.prototype._render = function () {
  const self = this;
  const rtl = this._isRtl();
  const step = this._cardStep();
  this.cardEls.forEach((card, i) => {
    const offset = self._shortestOffset(i, self.index);
    const physicalOffset = rtl ? -offset : offset;
    const scale = clamp(1 - Math.abs(offset) * 0.16, 0.58, 1);
    const opacity = clamp(1 - Math.abs(offset) * 0.34, 0.25, 1);
    const rotate = self.reduced ? 0 : clamp(-offset * 7, -14, 14) * (rtl ? -1 : 1);
    const tx = physicalOffset * step;
    const z = -Math.round(Math.abs(offset) * 10);
    const visible = Math.abs(offset) < 2.6;
    card.style.display = visible ? '' : 'none';
    if (!visible) return;
    card.style.transform = 'translate(-50%,-50%) translateX(' + tx.toFixed(1) + 'px) scale(' + scale.toFixed(3) + ') rotateY(' + rotate.toFixed(1) + 'deg)';
    card.style.opacity = opacity.toFixed(2);
    card.style.zIndex = String(100 + z);
    card.classList.toggle('is-selected', Math.abs(offset) < 0.02);
  });
  this._updateIndicator(this.index);
};

ServicesCarousel.prototype._updateIndicator = function (fractional) {
  const n = this.n;
  const rounded = ((Math.round(fractional) % n) + n) % n;
  if (this.countEl) {
    const pad = (v) => String(v).length < 2 ? '0' + v : String(v);
    this.countEl.textContent = pad(rounded + 1) + ' / ' + pad(n);
  }
  if (this.dotsEl) {
    Array.prototype.forEach.call(this.dotsEl.children, (d, i) => d.classList.toggle('is-active', i === rounded));
  }
};

// Title/description/Explore-href/CTA-label update AS SOON AS the target
// changes (not waiting for the settle animation) -- the *visual*
// crossfade + live-region announcement wait for onSettled().
ServicesCarousel.prototype._syncDetail = function (immediate) {
  const svc = this._svcAt(this.target);
  if (this.exploreLink) {
    this.exploreLink.href = svc.directoryHref;
    const label = this.exploreLink.querySelector('.svcc-explore-label');
    if (label) label.textContent = tr(svc.ctaKey, svc.ctaFallback);
  }
  this._pendingSvc = svc;
  if (immediate) this._commitDetailText(svc);
};

ServicesCarousel.prototype._commitDetailText = function (svc) {
  if (this.titleEl) this.titleEl.textContent = tr(svc.titleKey, svc.title);
  if (this.descEl) this.descEl.textContent = tr(svc.taglineKey, svc.tagline);
};

ServicesCarousel.prototype._onSettled = function () {
  const svc = this._pendingSvc;
  const title = tr(svc.titleKey, svc.title);
  if (this.detailEl && this.titleEl.textContent !== title) {
    const self = this;
    this.detailEl.classList.add('is-changing');
    window.setTimeout(() => {
      self._commitDetailText(svc);
      self.detailEl.classList.remove('is-changing');
    }, this.reduced ? 0 : 90);
  } else {
    this._commitDetailText(svc);
  }
  if (this.liveEl) this.liveEl.textContent = title + ' selected.';
};

// Re-renders all of this carousel's own text content (card captions,
// detail block, CTA label) for the current language -- called on
// darwesh:langchange. Position math (RTL mirroring) is re-run separately
// via _render().
ServicesCarousel.prototype.relabel = function () {
  const self = this;
  this.order.forEach((svcIdx, i) => {
    const svc = self.services[svcIdx];
    const span = self.cardEls[i].querySelector('.svcc-card-caption-text');
    if (span) span.textContent = tr(svc.titleKey, svc.title);
    self.cardEls[i].setAttribute('aria-label', (i + 1) + ' of ' + self.n + ': ' + tr(svc.titleKey, svc.title));
  });
  this._syncDetail(true);
};

function buildMarkup() {
  const mamHtml = MAM_SERVICE ? `
    <div class="svcc-mamrow">
      <div class="svcc-mam-card">
        <div class="svcc-mam-left">
          <div class="svcc-mam-icon"><span class="material-symbols-outlined" aria-hidden="true">${esc(MAM_SERVICE.fallbackIcon || MAM_SERVICE.icon)}</span></div>
          <div>
            <p class="svcc-mam-title" id="svccMamTitle">${esc(tr(MAM_SERVICE.titleKey, MAM_SERVICE.title))}</p>
            <p class="svcc-mam-sub" id="svccMamSub">${esc(tr(MAM_SERVICE.taglineKey, MAM_SERVICE.tagline))}</p>
          </div>
        </div>
        <a class="svcc-mam-btn" href="${esc(MAM_SERVICE.directoryHref)}" id="svccMamBtn">
          <span>${esc(tr(MAM_SERVICE.ctaKey, MAM_SERVICE.ctaFallback))}</span>
          <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
        </a>
      </div>
    </div>` : '';

  return `
    <section class="svc-carousel">
      <div class="svc-carousel-hero">
        <h1 class="font-headline-md text-headline-md text-primary" id="svccHeroTitle">${esc(tr('svc.universeTitle', 'Explore the Darwesh Service Universe'))}</h1>
        <p class="font-body-md text-body-md text-on-surface-variant" id="svccHeroSub">${esc(tr('svc.universeSubtitle', 'Real professionals, verified by Darwesh. Drag, swipe, or select a service to learn more.'))}</p>
      </div>

      <div class="svcc-stage-wrap">
        <button type="button" class="svcc-arrow svcc-arrow-left" id="svccPrevBtn" aria-label="${esc(tr('svc.prevService', 'Previous service'))}">
          <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
        </button>
        <div class="svcc-stage" id="svccStage" role="group" tabindex="0" aria-roledescription="carousel" aria-label="${esc(tr('svc.carouselAriaLabel', 'Darwesh services carousel'))}"></div>
        <button type="button" class="svcc-arrow svcc-arrow-right" id="svccNextBtn" aria-label="${esc(tr('svc.nextService', 'Next service'))}">
          <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
        </button>
      </div>

      <div class="svcc-indicator-row">
        <span class="svcc-indicator-count" id="svccCount" aria-hidden="true"></span>
        <div class="svcc-dots" id="svccDots" aria-hidden="true"></div>
      </div>
      <p class="svcc-swipe-hint" id="svccSwipeHint">${esc(tr('svc.dragHint', 'Drag, swipe, or use the arrow keys to explore'))}</p>

      <div class="svcc-mobile-arrows">
        <button type="button" class="svcc-arrow" id="svccMPrevBtn" aria-label="${esc(tr('svc.prevService', 'Previous service'))}">
          <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
        </button>
        <button type="button" class="svcc-arrow" id="svccMNextBtn" aria-label="${esc(tr('svc.nextService', 'Next service'))}">
          <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
        </button>
      </div>

      <div class="svcc-detail" id="svccDetail">
        <h2 class="font-headline-md text-headline-md text-primary svcc-detail-title" id="svccDetailTitle"></h2>
        <p class="font-body-md text-body-md text-on-surface-variant svcc-detail-desc" id="svccDetailDesc"></p>
        <a class="svcc-explore-btn" id="svccExploreLink" href="#">
          <span class="svcc-explore-label"></span>
          <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
        </a>
      </div>
    </section>
    ${mamHtml}
    <div class="svcc-visually-hidden" role="status" aria-live="polite" id="svccLive"></div>
  `;
}

export function initServicesCarousel(mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return null;
  mount.innerHTML = buildMarkup();

  const carousel = new ServicesCarousel(mount);
  carousel.prevBtn = document.getElementById('svccPrevBtn');
  carousel.nextBtn = document.getElementById('svccNextBtn');
  carousel.mPrevBtn = document.getElementById('svccMPrevBtn');
  carousel.mNextBtn = document.getElementById('svccMNextBtn');
  carousel.countEl = document.getElementById('svccCount');
  carousel.dotsEl = document.getElementById('svccDots');
  carousel.detailEl = document.getElementById('svccDetail');
  carousel.titleEl = document.getElementById('svccDetailTitle');
  carousel.descEl = document.getElementById('svccDetailDesc');
  carousel.exploreLink = document.getElementById('svccExploreLink');
  carousel.liveEl = document.getElementById('svccLive');

  carousel.order.forEach(() => {
    const dot = document.createElement('span');
    dot.className = 'svcc-dot';
    carousel.dotsEl.appendChild(dot);
  });

  // Re-sync once DOM refs are attached (the constructor's own _syncDetail
  // call ran before titleEl/descEl/exploreLink existed on the instance,
  // so its _commitDetailText no-op'd) -- re-run it now, immediate, so the
  // initial selection's title/description/href/CTA render without
  // requiring a first interaction.
  carousel._syncDetail(true);
  carousel._render();

  [carousel.prevBtn, carousel.mPrevBtn].forEach((b) => b.addEventListener('click', () => carousel.step(-1)));
  [carousel.nextBtn, carousel.mNextBtn].forEach((b) => b.addEventListener('click', () => carousel.step(1)));

  document.addEventListener('darwesh:langchange', () => {
    document.getElementById('svccHeroTitle').textContent = tr('svc.universeTitle', 'Explore the Darwesh Service Universe');
    document.getElementById('svccHeroSub').textContent = tr('svc.universeSubtitle', 'Real professionals, verified by Darwesh. Drag, swipe, or select a service to learn more.');
    document.getElementById('svccSwipeHint').textContent = tr('svc.dragHint', 'Drag, swipe, or use the arrow keys to explore');
    [carousel.prevBtn, carousel.mPrevBtn].forEach((b) => b.setAttribute('aria-label', tr('svc.prevService', 'Previous service')));
    [carousel.nextBtn, carousel.mNextBtn].forEach((b) => b.setAttribute('aria-label', tr('svc.nextService', 'Next service')));
    carousel.stage.setAttribute('aria-label', tr('svc.carouselAriaLabel', 'Darwesh services carousel'));
    if (MAM_SERVICE) {
      const mamTitle = document.getElementById('svccMamTitle');
      const mamSub = document.getElementById('svccMamSub');
      const mamBtn = document.getElementById('svccMamBtn');
      if (mamTitle) mamTitle.textContent = tr(MAM_SERVICE.titleKey, MAM_SERVICE.title);
      if (mamSub) mamSub.textContent = tr(MAM_SERVICE.taglineKey, MAM_SERVICE.tagline);
      if (mamBtn) mamBtn.querySelector('span').textContent = tr(MAM_SERVICE.ctaKey, MAM_SERVICE.ctaFallback);
    }
    carousel.relabel();
    carousel._render(); // re-run physical-direction math for RTL
  });

  return carousel;
}
