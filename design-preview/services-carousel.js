// Darwesh Group — Services Carousel controller (PREVIEW ONLY).
//
// Real service data copied verbatim from js/service-catalog.js (title,
// tagline, and directoryHref for all 7 entries; MAM AI is handled
// separately as its own row below the carousel, per spec).
//
// Photography: photos below are recreations generated to match a supplied
// design reference (NOT extracted originals -- see design-preview/assets/
// services/README for provenance). Maintenance & Repair and Installments
// have no photo asset available; those two cards fall back to the
// inline-SVG icon treatment used everywhere else in this preview, and are
// the only two cards still carrying a "Preview art" tag -- the five real
// photo cards are not tagged, per the approved reference.
//
// Inline SVG icons, one per service (plus MAM AI + "all services" grid).
// Deliberately NOT a webfont ligature (Material Symbols): production's own
// ci-checks.js enforces "map controls are inline-SVG + labelled" for the
// same robustness reason -- a blocked/slow font request must never leave a
// raw ligature word ("architecture") rendered at icon size. 24x24 viewBox,
// stroke-based, matching the line-icon style already used for the arrow
// buttons on this page.
window.SC_ICONS = {
  engineer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21 12 3l9 18"/><path d="M7.5 12h9"/><path d="M9.2 16.5h5.6"/></svg>',
  designer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-.9-.5-1.3-.3-.3-.5-.7-.5-1.2 0-.9.7-1.5 1.5-1.5H16a4 4 0 0 0 4-4c0-4.4-3.6-8-8-8Z"/><circle cx="7.5" cy="10.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.5" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="7" r="1.1" fill="currentColor" stroke="none"/></svg>',
  lawyer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 3.5 6 6M2.5 21.5l6-6"/><path d="m8 8 8 8M5 11l6 6M11 5l6 6"/><path d="M3 21.5h7"/></svg>',
  landscaping: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21v-8"/><path d="M12 13c0-4-3-6-7-6 0 4 3 7 7 7Z"/><path d="M12 10c0-3.5 2.5-6 6-6 0 3.5-2.5 6-6 6Z"/></svg>',
  cleaning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4M9 3l3 2-3 2"/><path d="M7 9h9l1.5 11a1 1 0 0 1-1 1.1H6.5a1 1 0 0 1-1-1.1L7 9Z"/><path d="M9.5 13v4M14.5 13v4"/></svg>',
  maintenance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8Z"/></svg>',
  installment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18"/><path d="M7 15h4"/></svg>',
  mamai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>'
};

// Catalog order (matches js/service-catalog.js) -- drives the "All
// services" chip row and the mobile sheet list, which the approved
// reference keeps in this natural order even though the carousel itself
// shows a different arrangement (see SC_CAROUSEL_ORDER below).
window.SC_SERVICES = [
  { key: 'engineer', title: 'Engineering', tagline: 'Structural, civil, and MEP engineering from verified professionals.', href: 'service.html?type=engineer', cta: 'Browse Engineers', photo: 'assets/services/engineering.jpg' },
  { key: 'designer', title: 'Interior & Architectural Design', tagline: 'Interior and architectural design work, published by real Darwesh designers.', href: 'design.html', cta: 'Explore Design Work', photo: 'assets/services/interior-design.jpg' },
  { key: 'lawyer', title: 'Legal', tagline: 'Real estate and property legal services from verified professionals.', href: 'service.html?type=lawyer', cta: 'Browse Lawyers', photo: 'assets/services/legal-services.jpg' },
  { key: 'landscaping', title: 'Landscaping', tagline: 'Garden, yard, and outdoor space design from verified professionals.', href: 'service.html?type=landscaping', cta: 'Browse Landscapers', photo: 'assets/services/landscaping.jpg' },
  { key: 'cleaning', title: 'Cleaning', tagline: 'Home, office, and move-in/move-out cleaning from individuals, teams, and companies.', href: 'service.html?type=cleaning', cta: 'Browse Cleaning Providers', photo: 'assets/services/cleaning.jpg' },
  { key: 'maintenance', title: 'Maintenance & Repair', tagline: 'Repairs, upkeep, and property maintenance from verified providers.', href: 'service.html?type=maintenance', cta: 'Browse Maintenance Providers', photo: null },
  { key: 'installment', title: 'Installments', tagline: 'Properties offered on real instalment plans, with the terms published by the developer.', href: 'installments.html', cta: 'Browse Installment Offers', photo: null }
];

// Carousel-only presentation order (indices into SC_SERVICES). Chosen so
// that, combined with an initial selection of position 1 and circular
// wrapping, the five visible cards reproduce the approved reference's
// balanced initial arrangement exactly:
//   Landscaping, Engineering, [Interior Design], Legal, Cleaning  (02/07)
// Each card still links to its own real, unchanged destination -- only
// the visual arrangement differs from catalog order.
window.SC_CAROUSEL_ORDER = [0, 1, 2, 4, 5, 6, 3];

// ---------------------------------------------------------------------
// PREVIEW-ONLY translations (NOT part of js/service-catalog.js / i18n.js).
// New copy, written for this preview, not yet reviewed against the site's
// production translation conventions -- flagged for review in the report.
// ---------------------------------------------------------------------
window.SC_SERVICE_I18N = {
  engineer: {
    ku: { title: 'ئەندازیاری', tagline: 'ئەندازیاریی سازە، شارستانی و میکانیک/کارەبا لە لایەن پیشەگەرانی پشتڕاستکراوەوە.' },
    ar: { title: 'الهندسة', tagline: 'هندسة إنشائية ومدنية وكهروميكانيكية من محترفين موثّقين.' }
  },
  designer: {
    ku: { title: 'دیزاینی ناوخۆیی و تەلارسازی', tagline: 'کاری دیزاینی ناوخۆیی و تەلارسازی، بڵاوکراوەتەوە لەلایەن دیزاینەرە ڕاستەقینەکانی دەروێش.' },
    ar: { title: 'التصميم الداخلي والمعماري', tagline: 'أعمال تصميم داخلي ومعماري، منشورة من قبل مصممي درويش الحقيقيين.' }
  },
  lawyer: {
    ku: { title: 'یاسایی', tagline: 'خزمەتگوزاری یاسایی موڵک و خانووبەرە لە لایەن پیشەگەرانی پشتڕاستکراوەوە.' },
    ar: { title: 'الخدمات القانونية', tagline: 'خدمات قانونية عقارية من محترفين موثّقين.' }
  },
  landscaping: {
    ku: { title: 'باخچەکاری', tagline: 'دیزاینی باخچە، حەوش و شوێنی دەرەوە لە لایەن پیشەگەرانی پشتڕاستکراوەوە.' },
    ar: { title: 'تنسيق الحدائق', tagline: 'تصميم الحدائق والساحات والمساحات الخارجية من محترفين موثّقين.' }
  },
  cleaning: {
    ku: { title: 'پاکژکردنەوە', tagline: 'پاکژکردنەوەی ماڵ، ئۆفیس و کۆچکردن لە لایەن کەسانی تاک، تیم و کۆمپانیاکانەوە.' },
    ar: { title: 'التنظيف', tagline: 'تنظيف المنازل والمكاتب وخدمات الانتقال من أفراد وفرق وشركات.' }
  },
  maintenance: {
    ku: { title: 'چاککردنەوە', tagline: 'چاککردنەوە، چاودێری و ڕاگرتنی موڵک لە لایەن دابینکەرانی پشتڕاستکراوەوە.' },
    ar: { title: 'الصيانة والإصلاح', tagline: 'إصلاحات وصيانة دورية للعقار من مزوّدين موثّقين.' }
  },
  installment: {
    ku: { title: 'قیستبەندی', tagline: 'خانووبەرەی بەشێوەی قیستی ڕاستەقینە پێشکەشکراون، بە مەرجەکانی بڵاوکراوەتەوە لەلایەن گەشەپێدەرەکەوە.' },
    ar: { title: 'الأقساط', tagline: 'عقارات معروضة بخطط تقسيط حقيقية، بشروط منشورة من قِبل المطوّر.' }
  }
};

window.scLocalizeService = function (svc, lang) {
  if (lang === 'en' || !window.SC_SERVICE_I18N[svc.key]) return { title: svc.title, tagline: svc.tagline };
  var t = window.SC_SERVICE_I18N[svc.key][lang];
  return t ? { title: t.title, tagline: t.tagline } : { title: svc.title, tagline: svc.tagline };
};

(function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function ServicesCarousel(root) {
    this.root = root;
    this.stage = root.querySelector('.sc-stage');
    this.services = window.SC_SERVICES;                 // catalog order (chips/sheet)
    this.order = window.SC_CAROUSEL_ORDER || this.services.map(function (_, i) { return i; });
    this.n = this.order.length;
    this.lang = 'en';

    // `index`/`target` are UNBOUNDED reals representing accumulated
    // circular position -- rendering always re-derives each card's actual
    // angular offset via `_shortestOffset` (mod n), so the spring never
    // needs to know about wrap boundaries. Initial position 1 = the
    // Interior Design slot in SC_CAROUSEL_ORDER, matching the approved
    // reference's initial centered selection.
    this.index = 1;
    this.target = 1;
    this.dragging = false;
    this.dragStartX = 0;
    this.dragStartIndex = 0;
    this.dragMoved = 0;
    this.samples = [];     // {t, index} for velocity calc
    this.rafId = null;
    this.settled = true;
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

  // Shortest signed circular distance from `pos` to card `i`, in
  // (-n/2, n/2]. This is what makes the roulette wrap seamlessly: there is
  // no first/last card, just the nearest way around.
  ServicesCarousel.prototype._shortestOffset = function (i, pos) {
    var n = this.n;
    var raw = ((i - pos) % n + n) % n;
    if (raw > n / 2) raw -= n;
    return raw;
  };

  ServicesCarousel.prototype._svcAt = function (orderPos) {
    var n = this.n;
    var p = ((Math.round(orderPos) % n) + n) % n;
    return this.services[this.order[p]];
  };

  ServicesCarousel.prototype._buildCards = function () {
    var self = this;
    this.order.forEach(function (svcIdx, i) {
      var svc = self.services[svcIdx];
      var card = document.createElement('div');
      card.className = 'sc-card';
      card.setAttribute('role', 'group');
      card.setAttribute('aria-roledescription', 'slide');
      card.setAttribute('aria-label', (i + 1) + ' of ' + self.n + ': ' + svc.title);
      // Cards themselves are not individually tabbable (avoids confusing
      // off-screen focus stops) -- Prev/Next buttons, the carousel region
      // itself (arrow keys), and the always-visible chip list below are
      // the real keyboard-operable paths to the same selection state.
      var artHtml;
      if (svc.photo) {
        artHtml = '<img class="sc-card-photo" src="' + svc.photo + '" alt="" loading="lazy" draggable="false"/>';
      } else {
        // No source photograph available for this service (disclosed in
        // the report) -- falls back to the same restrained icon treatment
        // used site-wide, and stays tagged so it's never mistaken for a
        // real photograph.
        artHtml =
          '<div class="sc-card-illustrative-tag">Preview art</div>' +
          '<div class="sc-card-art" style="background:' + self._artBg(i) + '" aria-hidden="true">' +
            (window.SC_ICONS[svc.key] || '') +
          '</div>';
      }
      card.innerHTML = artHtml + '<div class="sc-card-caption"><span class="sc-card-caption-text">' + svc.title + '</span></div>';
      card.dataset.svcKey = svc.key;
      card.addEventListener('click', function (e) {
        if (self.suppressNextClick) { self.suppressNextClick = false; return; }
        self.goTo(i, { userInitiated: true });
      });
      self.stage.appendChild(card);
      self.cardEls.push(card);
    });
  };

  // Fallback tint for the two services with no photo asset (gold-family
  // hue shift, not literal photography).
  ServicesCarousel.prototype._artBg = function (i) {
    var hues = [38, 28, 45, 96, 200, 20, 50];
    var h = hues[i % hues.length];
    return 'radial-gradient(circle at 50% 35%, hsl(' + h + ' 35% 22%), hsl(' + h + ' 30% 10%) 70%)';
  };

  ServicesCarousel.prototype._buildEvents = function () {
    var self = this;

    this.stage.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      self.dragging = true;
      self.dragMoved = 0;
      self.dragStartX = e.clientX;
      self.dragStartIndex = self.index;
      self.samples = [{ t: performance.now(), index: self.index }];
      self.stage.setPointerCapture && self.stage.setPointerCapture(e.pointerId);
      self._stopAnim();
    }, { passive: true });

    this.stage.addEventListener('pointermove', function (e) {
      if (!self.dragging) return;
      var dx = e.clientX - self.dragStartX;
      self.dragMoved = Math.max(self.dragMoved, Math.abs(dx));
      var cardStep = self._cardStep();
      var deltaIndex = dx / cardStep;
      // No edge resistance needed: the roulette is circular, so dragging
      // just keeps following the pointer 1:1 in either direction forever.
      self.index = self._isRtl() ? self.dragStartIndex + deltaIndex : self.dragStartIndex - deltaIndex;
      self.samples.push({ t: performance.now(), index: self.index });
      if (self.samples.length > 6) self.samples.shift();
      self._render();
    });

    function endDrag(e) {
      if (!self.dragging) return;
      self.dragging = false;
      if (self.dragMoved > 6) self.suppressNextClick = true;

      var velocity = self._velocity(); // index-units per ms
      var nearest = Math.round(self.index);
      var targetUnbounded = nearest;
      var FLICK = 0.0016; // tuned empirically; a firm flick, not a light tap
      if (Math.abs(velocity) > FLICK) {
        var dir = velocity > 0 ? 1 : -1;
        var flickTarget = Math.round(self.index) + (self.index - self.dragStartIndex > 0 === dir > 0 ? dir : 0);
        // Limit momentum to at most one extra step beyond the nearest
        // snap, never a multi-card skip.
        if (Math.abs(flickTarget - nearest) <= 1) targetUnbounded = flickTarget;
      }
      // Settle to the actual unbounded position the drag reached (never
      // reinterpreted as a "shortest path" from wherever navigation last
      // left off) -- a big multi-revolution drag continues smoothly in
      // the same direction instead of snapping backward.
      self._settleTo(targetUnbounded, { userInitiated: true });
    }
    this.stage.addEventListener('pointerup', endDrag);
    this.stage.addEventListener('pointercancel', endDrag);
    this.stage.addEventListener('lostpointercapture', endDrag);

    // Keyboard on the stage region itself (role="group", tabindex 0):
    // arrow keys / Home / End move selection without requiring focus to
    // land on individual cards.
    this.stage.addEventListener('keydown', function (e) {
      var rtl = self._isRtl();
      var prevKey = rtl ? 'ArrowRight' : 'ArrowLeft';
      var nextKey = rtl ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === nextKey) { e.preventDefault(); self.step(1); }
      else if (e.key === prevKey) { e.preventDefault(); self.step(-1); }
      else if (e.key === 'Home') { e.preventDefault(); self.goTo(0, { userInitiated: true }); }
      else if (e.key === 'End') { e.preventDefault(); self.goTo(self.n - 1, { userInitiated: true }); }
    });

    window.addEventListener('resize', function () { self._render(); });

    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function (ev) {
      self.reduced = ev.matches;
    });
  };

  ServicesCarousel.prototype._velocity = function () {
    if (this.samples.length < 2) return 0;
    var last = this.samples[this.samples.length - 1];
    var first = this.samples[0];
    var dt = last.t - first.t;
    if (dt <= 0) return 0;
    return (last.index - first.index) / dt;
  };

  ServicesCarousel.prototype._cardStep = function () {
    var w = this.stage.clientWidth;
    // Spacing between card centers. Must stay wide enough that the
    // selected (highest z-index) card's screen footprint doesn't cover a
    // neighbor's caption text -- verified empirically: at step 168 with a
    // 232px-wide card, the ~64px overlap put the immediate neighbor's
    // left-aligned caption directly under the center card, making it
    // invisible despite correct DOM/CSS (a real layout bug, not a paint
    // bug). 198px keeps the reference's nested look with a ~34px overlap,
    // clear of every caption's text.
    return w < 700 ? w * 0.56 : 198;
  };

  ServicesCarousel.prototype.step = function (dir) {
    var n = this.n;
    var curPos = ((Math.round(this.target) % n) + n) % n;
    this.goTo(curPos + dir, { userInitiated: true });
  };

  // Public API: `pos` is a position in order-space (0..n-1). Takes the
  // shortest circular path from the current target -- correct for
  // discrete jumps (arrows, chips, keyboard, direct card clicks).
  ServicesCarousel.prototype.goTo = function (pos, opts) {
    var n = this.n;
    pos = ((Math.round(pos) % n) + n) % n;
    var curPos = ((Math.round(this.target) % n) + n) % n;
    var delta = pos - curPos;
    if (delta > n / 2) delta -= n;
    else if (delta < -n / 2) delta += n;
    this._settleTo(this.target + delta, opts);
  };

  // Internal: sets the unbounded target directly (no shortest-path
  // reinterpretation) and starts the settle animation. Used by goTo()
  // (after it computes the shortest delta) and directly by drag-release
  // (which already knows the true continuous distance travelled).
  ServicesCarousel.prototype._settleTo = function (unboundedTarget, opts) {
    opts = opts || {};
    this.target = unboundedTarget;
    this._syncDetail(false);
    this._startAnim();
  };

  ServicesCarousel.prototype._startAnim = function () {
    var self = this;
    if (this.reduced) {
      this.index = this.target;
      this._render();
      this._onSettled();
      return;
    }
    this._stopAnim();
    var lastT = performance.now();
    var velocity = 0;
    // Critically-damped spring, integrated with dt in SECONDS (performance.now()
    // deltas are milliseconds -- using raw ms here previously made every frame
    // overshoot by ~16-32x, so the "settle" never converged and _onSettled()
    // never fired). STIFFNESS/DAMPING are tuned in seconds^-2 / seconds^-1 for
    // a ~350-400ms full-card settle, matching the spec's 300-450ms target.
    var STIFFNESS = 420;
    var DAMPING = 41;
    function frame(t) {
      var dt = Math.min(0.032, (t - lastT) / 1000);
      lastT = t;
      var diff = self.target - self.index;
      var accel = diff * STIFFNESS - velocity * DAMPING;
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
    var self = this;
    var rtl = this._isRtl();
    var step = this._cardStep();
    this.cardEls.forEach(function (card, i) {
      var offset = self._shortestOffset(i, self.index);
      var physicalOffset = rtl ? -offset : offset;
      var scale = clamp(1 - Math.abs(offset) * 0.16, 0.58, 1);
      var opacity = clamp(1 - Math.abs(offset) * 0.34, 0.25, 1);
      var rotate = self.reduced ? 0 : clamp(-offset * 7, -14, 14) * (rtl ? -1 : 1);
      var tx = physicalOffset * step;
      var z = -Math.round(Math.abs(offset) * 10);
      var visible = Math.abs(offset) < 2.6;
      card.style.display = visible ? '' : 'none';
      if (!visible) return;
      card.style.transform = 'translate(-50%,-50%) translateX(' + tx.toFixed(1) + 'px) scale(' + scale.toFixed(3) + ') rotateY(' + rotate.toFixed(1) + 'deg)';
      card.style.opacity = opacity.toFixed(2);
      card.style.zIndex = String(100 + z);
      var selected = Math.abs(offset) < 0.02;
      card.classList.toggle('is-selected', selected);
    });

    this._updateIndicator(this.index);
  };

  ServicesCarousel.prototype._updateIndicator = function (fractional) {
    var n = this.n;
    var rounded = ((Math.round(fractional) % n) + n) % n;
    if (this.countEl) {
      var pad = function (v) { return String(v).length < 2 ? '0' + v : String(v); };
      this.countEl.textContent = pad(rounded + 1) + ' / ' + pad(n);
    }
    if (this.dotsEl) {
      Array.prototype.forEach.call(this.dotsEl.children, function (d, i) {
        d.classList.toggle('is-active', i === rounded);
      });
    }
  };

  // Title/description/Explore-href update AS SOON AS the target changes
  // (not waiting for the settle animation) -- "do not delay the
  // functional response until the animation finishes" -- while the
  // *visual* crossfade + live-region announcement wait for onSettled().
  ServicesCarousel.prototype._syncDetail = function (immediate) {
    var svc = this._svcAt(this.target);
    if (this.exploreLink) {
      this.exploreLink.href = svc.href;
      // Label text is intentionally NOT set here: it stays the generic,
      // actively-translated "Explore service" string owned by the page's
      // language toggle (applyLang). Only the destination changes per
      // service -- svc.cta exists as real catalog metadata but is
      // English-only, so using it here would leave an untranslated label
      // after a KU/AR switch and race against applyLang's own text set.
    }
    if (this.chipsEl) {
      Array.prototype.forEach.call(this.chipsEl.children, function (chip) {
        chip.setAttribute('aria-current', chip.dataset.key === svc.key ? 'true' : 'false');
      });
    }
    this._pendingSvc = svc;
    if (immediate) this._commitDetailText(svc);
  };

  ServicesCarousel.prototype._commitDetailText = function (svc) {
    var loc = window.scLocalizeService(svc, this.lang);
    if (this.titleEl) this.titleEl.textContent = loc.title;
    if (this.descEl) this.descEl.textContent = loc.tagline;
  };

  ServicesCarousel.prototype._onSettled = function () {
    var svc = this._pendingSvc;
    var loc = window.scLocalizeService(svc, this.lang);
    if (this.detailEl && this.titleEl.textContent !== loc.title) {
      var self = this;
      this.detailEl.classList.add('is-changing');
      window.setTimeout(function () {
        self._commitDetailText(svc);
        self.detailEl.classList.remove('is-changing');
      }, this.reduced ? 0 : 90);
    } else {
      this._commitDetailText(svc);
    }
    if (this.liveEl) this.liveEl.textContent = loc.title + ' selected.';
  };

  // Switches the carousel's own text content (card captions + detail
  // block) to `lang`, immediately (no crossfade -- this is a whole-page
  // language change, not a navigation step). Position math (RTL mirroring)
  // is re-run via the caller's own _render() call after this.
  ServicesCarousel.prototype.setLang = function (lang) {
    this.lang = lang;
    var self = this;
    this.order.forEach(function (svcIdx, i) {
      var svc = self.services[svcIdx];
      var loc = window.scLocalizeService(svc, lang);
      var span = self.cardEls[i].querySelector('.sc-card-caption-text');
      if (span) span.textContent = loc.title;
      self.cardEls[i].setAttribute('aria-label', (i + 1) + ' of ' + self.n + ': ' + loc.title);
    });
    this._syncDetail(true);
  };

  window.ServicesCarousel = ServicesCarousel;
})();
