// Darwesh Group -- Service Universe interaction engine (services.html).
//
// Renders the 5 real service domains from js/service-catalog.js as an
// orbital "carousel" of planets around a central Darwesh Core, driven
// entirely by CSS 3D transforms (perspective + rotateY + translateZ) and
// requestAnimationFrame -- no canvas, no WebGL, no external animation
// library (per this phase's explicit "prefer lightweight DOM/CSS 3D"
// instruction). A single JS number (`orbitAngle`, degrees) is the whole
// state driving every planet's position; drag/swipe/wheel/keyboard all
// just mutate that one number.
//
// FIRESTORE ISOLATION (per this phase's explicit "never connect
// Firestore reads to continuous rendering" instruction): the ONLY
// Firestore reads this module performs are five bounded COUNT
// aggregation queries (getCountFromServer -- never downloads documents),
// run exactly ONCE at init, fully decoupled from the animation loop.
// Nothing here ever issues a Firestore read from inside the drag handler,
// the rAF loop, or the focus-panel renderer -- those three consume only
// already-resolved, cached numbers.
//
// Firestore/firebase-init.js is imported DYNAMICALLY inside loadCounts()
// below, never as a static top-level import: a static `import ... from
// './firebase-init.js'` would fail the ENTIRE module (planets, drag,
// keyboard, panel -- none of which need Firestore at all) if the
// Firebase CDN is ever unreachable, which is exactly the "Fallback Mode"
// failure this phase explicitly says never to allow (section 26). A
// failed dynamic import inside a try/catch degrades to honest fallback
// copy in the panel instead (see renderPanel), same pattern buy.html
// already uses for its own optional Firestore-backed enhancements.
import { SERVICE_CATALOG } from './service-catalog.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initServiceUniverse(mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;

  try {
    build(mount);
  } catch (err) {
    // Fallback mode (section 26): anything going wrong in the 3D
    // interaction layer must never leave the user with a black screen,
    // an empty canvas, or dead controls -- fall back to the always-
    // present accessible list, which lives outside this module's DOM
    // entirely (see services.html) and needs no JS from this file to
    // work at all.
    console.error('Service Universe failed to initialize; accessible list remains available.', err);
    mount.innerHTML = '';
    mount.classList.add('hidden');
  }
}

function build(mount) {
  const N = SERVICE_CATALOG.length;
  const STEP = 360 / N;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  mount.innerHTML = `
    <div class="su-stage" id="suStage">
      <div class="su-core" aria-hidden="true">
        <div class="su-core-ring"></div>
        <div class="su-core-ring su-core-ring--2"></div>
        <div class="su-core-glow"></div>
      </div>
      <div class="su-orbit" id="suOrbit" role="listbox" aria-label="${esc(tr('svc.universeAriaLabel', 'Darwesh service planets'))}"></div>
      <div class="su-nav">
        <button type="button" class="su-nav-btn" id="suPrevBtn" aria-label="${esc(tr('svc.prevService', 'Previous service'))}">
          <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
        </button>
        <button type="button" class="su-nav-btn" id="suNextBtn" aria-label="${esc(tr('svc.nextService', 'Next service'))}">
          <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
      </div>
    </div>
    <div class="su-panel" id="suPanel" hidden>
      <button type="button" class="su-panel-close" id="suPanelClose" aria-label="${esc(tr('svc.closePanel', 'Close'))}">
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
      <div id="suPanelBody"></div>
    </div>
    <p class="su-hint" id="suHint">${esc(tr('svc.dragHint', 'Drag, swipe, or use the arrow keys to explore'))}</p>
  `;

  const orbitEl = document.getElementById('suOrbit');
  const stageEl = document.getElementById('suStage');
  const panelEl = document.getElementById('suPanel');
  const panelBodyEl = document.getElementById('suPanelBody');
  const hintEl = document.getElementById('suHint');

  // ---- Planet DOM (built once from the catalog; the ONLY thing the
  // rAF loop and drag handler ever mutate afterwards is CSS transforms/
  // classes on these already-built nodes). --------------------------
  const planetButtons = SERVICE_CATALOG.map((svc, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `su-planet su-planet--${svc.key}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-label', tr(svc.titleKey, svc.title));
    btn.dataset.index = String(i);
    btn.dataset.key = svc.key;
    btn.innerHTML = `
      <span class="su-planet-face">
        <span class="su-planet-glyph material-symbols-outlined" aria-hidden="true">${svc.icon}</span>
        <span class="su-planet-label">${esc(tr(svc.titleKey, svc.title))}</span>
      </span>
    `;
    orbitEl.appendChild(btn);
    return btn;
  });

  // ---- State ---------------------------------------------------------
  let orbitAngle = 0;       // degrees; the single source of truth
  let focusedIndex = null;  // index into SERVICE_CATALOG, or null
  let pointerActive = false;
  let dragging = false;
  let suppressNextClick = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartAngle = 0;
  let lastDragX = 0;
  let lastDragTime = 0;
  let dragVelocity = 0;     // degrees/ms, for release inertia
  const DRAG_THRESHOLD = 6; // px of movement before a pointerdown counts as a drag, not a click
  let idleRafId = null;
  let settleRafId = null;
  let paused = document.hidden;
  const counts = new Map(); // key -> { total, verified } | 'error' | undefined (loading)

  function normalize(deg) {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  function frontIndex() {
    // Whichever planet's own angle is closest to 0 (directly facing the
    // viewer) is the current "front" one -- used for idle de-emphasis
    // AND as the target when snapping after drag/wheel/keyboard input.
    let best = 0, bestAbs = Infinity;
    for (let i = 0; i < N; i++) {
      const a = Math.abs(normalize(i * STEP + orbitAngle));
      if (a < bestAbs) { bestAbs = a; best = i; }
    }
    return best;
  }

  function layout() {
    const isNarrow = window.innerWidth < 640;
    const radiusX = isNarrow ? 140 : window.innerWidth < 1024 ? 210 : 300;
    const arcDip = isNarrow ? 14 : 22;
    for (let i = 0; i < N; i++) {
      const planetAngle = i * STEP + orbitAngle;
      const rel = normalize(planetAngle);
      const rad = rel * Math.PI / 180;
      const depth = Math.cos(rad); // 1 = front, -1 = directly behind the front planet
      const btn = planetButtons[i];
      // Plain 2D screen-space placement, linear in `rel` (not sin(rel)):
      // with only 5 planets spaced 72deg apart, two of them always sit
      // beyond 90deg -- sin() stops being monotonic past 90deg, so it
      // swings those two back TOWARD center instead of further out,
      // overlapping their 72deg neighbors (found during this phase's own
      // QA pass). A plain linear map of angle-to-x is monotonic across
      // the whole range by construction, so every planet's left-to-right
      // ORDER always matches its actual position around the ring, with
      // no overlap regardless of N. `depth` (cos(rel)) still separately
      // drives the scale/opacity falloff below, which is what actually
      // produces the "near vs far" orbit read.
      const x = (rel / 180) * radiusX;
      const y = (1 - depth) * arcDip;
      const scale = focusedIndex === i ? 1.3 : 0.62 + 0.38 * ((depth + 1) / 2);
      const opacity = focusedIndex !== null && focusedIndex !== i ? 0.3 : 0.5 + 0.5 * ((depth + 1) / 2);
      btn.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
      btn.style.opacity = String(opacity);
      btn.style.zIndex = String(Math.round((depth + 1) * 100));
      btn.classList.toggle('su-planet--front', i === frontIndex() && focusedIndex === null);
    }
  }

  // ---- Idle auto-orbit (paused on reduced-motion, hidden tab, drag,
  // and while a planet is focused -- an enlarged focused planet must
  // hold still, not drift). Uses rAF with a delta-time step so it's
  // frame-rate independent and trivially pausable/resumable. ----------
  let lastFrameTime = null;
  function idleTick(t) {
    if (paused || dragging || focusedIndex !== null || reduceMotion) {
      lastFrameTime = null;
      idleRafId = requestAnimationFrame(idleTick);
      return;
    }
    if (lastFrameTime !== null) {
      const dt = t - lastFrameTime;
      orbitAngle += dt * 0.006; // very slow drift, ~1 rotation/minute
      layout();
    }
    lastFrameTime = t;
    idleRafId = requestAnimationFrame(idleTick);
  }
  idleRafId = requestAnimationFrame(idleTick);

  document.addEventListener('visibilitychange', () => { paused = document.hidden; });

  // ---- Snap-to-front animation (after drag release, wheel, keyboard,
  // or an explicit prev/next click) -- short eased tween, skipped
  // entirely under reduced-motion (snaps instantly instead). ----------
  function snapTo(targetIndex, { instant = false } = {}) {
    cancelAnimationFrame(settleRafId);
    const targetAngle = -targetIndex * STEP;
    // Choose the shortest angular path to the target.
    let delta = normalize(targetAngle - orbitAngle);
    const from = orbitAngle;
    const to = orbitAngle + delta;
    if (instant || reduceMotion) {
      orbitAngle = to;
      layout();
      return;
    }
    const duration = 420;
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      orbitAngle = from + (to - from) * eased;
      layout();
      if (p < 1) settleRafId = requestAnimationFrame(step);
    }
    settleRafId = requestAnimationFrame(step);
  }

  // ---- Pointer drag / swipe (unified mouse + touch via Pointer Events).
  // Deliberately NOT using setPointerCapture: capturing on pointerdown
  // redirects the subsequent synthesized click event away from whatever
  // planet button is under the pointer, to the stage itself -- which
  // silently broke every planet click (first-click-to-focus, section 6)
  // during this phase's own QA pass. Instead, a real drag is
  // distinguished from a plain click by a small movement threshold
  // (DRAG_THRESHOLD): pointermove/pointerup listen on `window` only
  // while a pointer is down, and orbitAngle is only touched once the
  // pointer has actually moved past the threshold -- a tap that never
  // crosses it leaves the native click event to fire on the button
  // exactly as normal.
  function onPointerDown(e) {
    pointerActive = true;
    dragging = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartAngle = orbitAngle;
    lastDragX = e.clientX;
    lastDragTime = performance.now();
    dragVelocity = 0;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }
  function onPointerMove(e) {
    if (!pointerActive) return;
    const dx = e.clientX - dragStartX;
    if (!dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(e.clientY - dragStartY) < DRAG_THRESHOLD) return;
      dragging = true;
      suppressNextClick = true;
    }
    orbitAngle = dragStartAngle + dx * 0.28;
    const now = performance.now();
    const dt = now - lastDragTime;
    if (dt > 0) dragVelocity = ((e.clientX - lastDragX) * 0.28) / dt;
    lastDragX = e.clientX;
    lastDragTime = now;
    layout();
  }
  function onPointerUp() {
    pointerActive = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    if (!dragging) return;
    dragging = false;
    // Small, capped inertia -- explicitly NOT uncontrolled spinning
    // (section 6): velocity is clamped and decays to zero quickly, then
    // the ring always settles on a real planet, never mid-orbit.
    const flung = Math.max(-6, Math.min(6, dragVelocity * 60));
    orbitAngle += flung;
    snapTo(frontIndex());
  }
  stageEl.addEventListener('pointerdown', onPointerDown);

  // ---- Wheel / trackpad -- only a strongly-horizontal gesture rotates
  // the universe; a normal vertical scroll wheel is left completely
  // alone so the page still scrolls normally (section 14: "use mouse
  // wheel / trackpad carefully"). Debounced snap-to-front on pause.
  let wheelSnapTimer = null;
  stageEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 4) return;
    e.preventDefault();
    orbitAngle -= e.deltaX * 0.15;
    layout();
    clearTimeout(wheelSnapTimer);
    wheelSnapTimer = setTimeout(() => snapTo(frontIndex()), 140);
  }, { passive: false });

  // ---- Keyboard: ArrowLeft/ArrowRight rotate to the neighboring
  // planet and move focus with it; Enter/Space selects (first press) or
  // navigates (second press on an already-focused planet). ------------
  function focusableIndex() {
    return focusedIndex !== null ? focusedIndex : frontIndex();
  }
  stageEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = ((focusableIndex() + dir) % N + N) % N;
      snapTo(next);
      planetButtons[next].focus();
    }
  });

  document.getElementById('suPrevBtn').addEventListener('click', () => {
    const next = ((focusableIndex() - 1) % N + N) % N;
    snapTo(next);
    planetButtons[next].focus();
  });
  document.getElementById('suNextBtn').addEventListener('click', () => {
    const next = ((focusableIndex() + 1) % N + N) % N;
    snapTo(next);
    planetButtons[next].focus();
  });

  // ---- Planet selection (click/tap AND Enter/Space, per section 19 --
  // every planet is a real <button>, so both are native for free). ----
  planetButtons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (suppressNextClick) { suppressNextClick = false; return; }
      selectPlanet(i);
    });
  });

  function selectPlanet(i) {
    if (focusedIndex === i) {
      // Second click on an already-focused planet == the explicit CTA.
      navigateTo(SERVICE_CATALOG[i]);
      return;
    }
    focusedIndex = i;
    planetButtons.forEach((b, bi) => b.setAttribute('aria-selected', String(bi === i)));
    snapTo(i);
    renderPanel(SERVICE_CATALOG[i]);
    hintEl.classList.add('su-hint--hidden');
    trackEvent('service_focus', { service: SERVICE_CATALOG[i].key });
    updateUrl(SERVICE_CATALOG[i].key);
  }

  function deselect() {
    focusedIndex = null;
    planetButtons.forEach((b) => b.setAttribute('aria-selected', 'false'));
    panelEl.hidden = true;
    hintEl.classList.remove('su-hint--hidden');
    layout();
    updateUrl(null);
  }
  document.getElementById('suPanelClose').addEventListener('click', deselect);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focusedIndex !== null) deselect();
  });

  function navigateTo(svc) {
    trackEvent('service_open', { service: svc.key });
    window.location.href = svc.directoryHref;
  }

  // ---- Focus panel (section 7) -- only ever renders REAL data: the
  // service's own catalog copy, plus real provider/verified counts
  // once the one-time count fetch below resolves. Never invents a
  // number, a rating, or a review count. -----------------------------
  function renderPanel(svc) {
    const c = counts.get(svc.key);
    let statsHtml;
    if (c === 'error' || c === undefined) {
      statsHtml = `<p class="su-panel-stats-fallback">${esc(tr('svc.exploreProfessionals', 'Explore available professionals'))}</p>`;
    } else if (c.total === 0) {
      statsHtml = `<p class="su-panel-stats-fallback">${esc(tr('svc.noneYetShort', 'Providers will appear here as they join Darwesh'))}</p>`;
    } else {
      statsHtml = `
        <div class="su-panel-stats">
          <div class="su-panel-stat">
            <span class="su-panel-stat-num">${c.total}</span>
            <span class="su-panel-stat-label">${esc(tr('svc.statAvailable', 'Available'))}</span>
          </div>
          <div class="su-panel-stat">
            <span class="su-panel-stat-num">${c.verified}</span>
            <span class="su-panel-stat-label">${esc(tr('svc.statVerified', 'Verified'))}</span>
          </div>
        </div>`;
    }
    panelBodyEl.innerHTML = `
      <div class="su-panel-icon"><span class="material-symbols-outlined" aria-hidden="true">${svc.icon}</span></div>
      <p class="su-panel-eyebrow">${esc(tr('svc.directoryEyebrow', 'Darwesh Service Providers'))}</p>
      <h2 class="su-panel-title">${esc(tr(svc.titleKey, svc.title))}</h2>
      <p class="su-panel-tagline">${esc(tr(svc.taglineKey, svc.tagline))}</p>
      ${statsHtml}
      <a class="su-panel-cta" href="${svc.directoryHref}">
        ${esc(tr(svc.ctaKey, svc.ctaFallback))}
        <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
      </a>
    `;
    panelEl.hidden = false;
  }

  // ---- Real provider counts -- ONE bounded aggregation query pair per
  // service, run exactly once here at init, never again, never inside
  // the render loop. A failed count degrades to honest fallback copy
  // (see renderPanel above), never a fabricated number. ---------------
  async function loadCounts() {
    let db, getCountFromServer, collection, query, where;
    try {
      const [firebaseInit, firestoreMod] = await Promise.all([
        import('./firebase-init.js'),
        import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js')
      ]);
      ({ db, getCountFromServer } = firebaseInit);
      ({ collection, query, where } = firestoreMod);
    } catch {
      // Firebase/network unreachable -- every service falls back to
      // honest copy in the panel (see renderPanel); the interactive
      // layer above never depended on this resolving at all.
      SERVICE_CATALOG.forEach((svc) => counts.set(svc.key, 'error'));
      if (focusedIndex !== null) renderPanel(SERVICE_CATALOG[focusedIndex]);
      return;
    }
    await Promise.all(SERVICE_CATALOG.map(async (svc) => {
      try {
        const base = collection(db, 'serviceProviders');
        const [totalSnap, verifiedSnap] = await Promise.all([
          getCountFromServer(query(base, where('serviceType', '==', svc.serviceType))),
          getCountFromServer(query(base, where('serviceType', '==', svc.serviceType), where('verified', '==', true)))
        ]);
        counts.set(svc.key, { total: totalSnap.data().count, verified: verifiedSnap.data().count });
      } catch {
        counts.set(svc.key, 'error');
      }
      // Refresh the panel in place if this exact service is already open
      // when its count resolves (counts load in parallel, in no
      // guaranteed order).
      if (focusedIndex !== null && SERVICE_CATALOG[focusedIndex].key === svc.key) {
        renderPanel(svc);
      }
    }));
  }
  loadCounts();

  // ---- Deep-linking (section 27) -- services.html?service=engineering
  // focuses that planet on load; selecting a different planet updates
  // the URL via replaceState (never pushState -- a continuous drag or
  // idle orbit must never touch history, only a deliberate selection). --
  function updateUrl(key) {
    const url = new URL(window.location.href);
    if (key) url.searchParams.set('service', key); else url.searchParams.delete('service');
    window.history.replaceState(null, '', url);
  }
  const requested = new URLSearchParams(window.location.search).get('service');
  const requestedIndex = SERVICE_CATALOG.findIndex((s) => s.key === requested);
  if (requestedIndex >= 0) {
    // Defer to next frame so initial layout has already run once.
    requestAnimationFrame(() => selectPlanet(requestedIndex));
  }

  // ---- Resize -- throttled via rAF, recomputes radius only (planet
  // count/angles never change). ---------------------------------------
  let resizeRafId = null;
  window.addEventListener('resize', () => {
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => { layout(); resizeRafId = null; });
  });

  // Language switch re-renders labels/panel copy without touching
  // orbitAngle/focus state.
  document.addEventListener('darwesh:langchange', () => {
    planetButtons.forEach((btn, i) => {
      const svc = SERVICE_CATALOG[i];
      btn.setAttribute('aria-label', tr(svc.titleKey, svc.title));
      btn.querySelector('.su-planet-label').textContent = tr(svc.titleKey, svc.title);
    });
    if (focusedIndex !== null) renderPanel(SERVICE_CATALOG[focusedIndex]);
    hintEl.textContent = tr('svc.dragHint', 'Drag, swipe, or use the arrow keys to explore');
  });

  layout();
}

// Analytics-ready events (section 28) -- no vendor wired up, just a
// structured, no-PII hook so one can be added later without touching
// this module's interaction logic. Never transmits personal data.
function trackEvent(name, detail) {
  if (typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('darwesh:analytics', { detail: { name, ...detail } }));
  }
}
