// Darwesh Group -- Social Universe interaction engine (index.html, below
// the hero). A lighter, more compact sibling of js/service-universe.js --
// same spatial language (one JS angle number driving every tile's
// position, plain 2D translate/scale/opacity, drag/swipe/wheel/keyboard,
// first-click-to-focus/second-click-to-open) but its own composition: a
// short single stage of squircle "tiles" with a slim caption bar below
// it, not a two-column hero with a tall editorial info panel. Not a
// copy/paste of that file -- rebuilt at a smaller scale on purpose.
//
// STATIC DATA ONLY: unlike the Service Universe, this component reads
// nothing from Firestore -- js/social-links.js is a plain hardcoded
// config module (real, manually-verified official URLs, see that file's
// header comment), so there is no async loading state, no network
// failure mode, and no "Fallback Mode" to design for beyond the
// always-present accessible link strip built alongside this module (see
// index.html's own inline script, which renders js/social-links.js's
// getConfiguredSocialLinks() as real <a> elements independently of
// whether this interactive layer initializes at all).
import { getConfiguredSocialLinks } from './social-links.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Local, lightweight brand glyphs -- no icon font/SDK, no external
// request. Reused verbatim from the paths already live in about.html's
// "Follow Us" section (same visual mark used elsewhere on the site), so
// this file never invents new brand artwork. Only platforms that can
// actually appear here (i.e. have a configured URL in social-links.js)
// need an entry -- add one here the day a new platform's URL is added.
const ICONS = {
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><rect height="18" rx="5" width="18" x="3" y="3"></rect><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37Z"></path><line x1="17.5" x2="17.51" y1="6.5" y2="6.5"></line></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82c-.9-.98-1.4-2.26-1.4-3.6h-3.05v13.4a3.15 3.15 0 1 1-2.24-3.02V9.5a6.2 6.2 0 1 0 5.29 6.13V9.4a8.3 8.3 0 0 0 4.8 1.53V7.88a4.8 4.8 0 0 1-3.4-2.06Z"></path></svg>',
  facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.47h-1.26c-1.24 0-1.63.77-1.63 1.56v1.87h2.78l-.44 2.91h-2.34V22c4.78-.76 8.44-4.92 8.44-9.94Z"></path></svg>',
};

export function initSocialUniverse(mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;

  const platforms = getConfiguredSocialLinks();
  if (platforms.length === 0) {
    // Architecture-only state: no real official URL is configured for
    // any supported platform. Never fabricate one -- just don't render
    // an interactive layer that would have nothing real to point at.
    mount.classList.add('hidden');
    return;
  }

  try {
    build(mount, platforms);
  } catch (err) {
    console.error('Social Universe failed to initialize; the accessible link strip remains available.', err);
    mount.innerHTML = '';
    mount.classList.add('hidden');
  }
}

function build(mount, platforms) {
  const N = platforms.length;
  const STEP = 360 / N;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  mount.innerHTML = `
    <div class="so-layout so-atmosphere">
      <div class="so-stage" id="soStage" tabindex="-1">
        <div class="so-orbit" id="soOrbit" role="listbox" aria-label="${esc(tr('social.universeAriaLabel', 'Darwesh social channels'))}"></div>
        <div class="so-nav">
          <button type="button" class="so-nav-btn" id="soPrevBtn" aria-label="${esc(tr('social.prevPlatform', 'Previous channel'))}">
            <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
          </button>
          <button type="button" class="so-nav-btn" id="soNextBtn" aria-label="${esc(tr('social.nextPlatform', 'Next channel'))}">
            <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
          </button>
        </div>
      </div>
      <div class="so-caption" id="soCaption" aria-live="polite" aria-atomic="true"></div>
      <p class="so-hint" id="soHint">${esc(tr('social.dragHint', 'Drag, swipe, or use the arrow keys to explore'))}</p>
    </div>
  `;

  const orbitEl = document.getElementById('soOrbit');
  const stageEl = document.getElementById('soStage');
  const captionEl = document.getElementById('soCaption');
  const hintEl = document.getElementById('soHint');

  const planetButtons = platforms.map((svc, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `so-planet so-planet--${svc.key}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-label', svc.label);
    btn.dataset.index = String(i);
    btn.innerHTML = `<span class="so-planet-face"><span class="so-planet-glyph" aria-hidden="true">${ICONS[svc.key] || ''}</span></span>`;
    orbitEl.appendChild(btn);
    return btn;
  });

  // ---- State (identical shape to service-universe.js's, on purpose --
  // this is a proven, tested interaction model, not something worth
  // re-deriving for a second component). --------------------------------
  let orbitAngle = 0;
  let focusedIndex = null;
  let pointerActive = false;
  let dragging = false;
  let suppressNextClick = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartAngle = 0;
  let lastDragX = 0;
  let lastDragTime = 0;
  let dragVelocity = 0;
  const DRAG_THRESHOLD = 6;
  let idleRafId = null;
  let settleRafId = null;
  let paused = document.hidden;

  function normalize(deg) {
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  function frontIndex() {
    let best = 0, bestAbs = Infinity;
    for (let i = 0; i < N; i++) {
      const a = Math.abs(normalize(i * STEP + orbitAngle));
      if (a < bestAbs) { bestAbs = a; best = i; }
    }
    return best;
  }

  function metrics() {
    const w = window.innerWidth;
    if (w < 640) return { base: 64, radiusX: 96 };
    if (w < 900) return { base: 78, radiusX: 132 };
    if (w < 1280) return { base: 90, radiusX: 160 };
    return { base: 96, radiusX: 176 };
  }

  function layout() {
    const { base, radiusX } = metrics();
    orbitEl.style.setProperty('--so-base', base + 'px');
    for (let i = 0; i < N; i++) {
      const rel = normalize(i * STEP + orbitAngle);
      const rad = rel * Math.PI / 180;
      const depth = Math.cos(rad);
      const btn = planetButtons[i];
      const x = N > 1 ? (rel / 180) * radiusX : 0;
      const scale = focusedIndex === i ? 1.42 : 0.5 + 0.5 * ((depth + 1) / 2);
      const opacity = focusedIndex !== null && focusedIndex !== i ? 0.32 : 0.55 + 0.45 * ((depth + 1) / 2);
      btn.style.transform = `translate(-50%, -50%) translate(${x}px, 0px) scale(${scale})`;
      btn.style.opacity = String(opacity);
      btn.style.zIndex = String(Math.round((depth + 1) * 100));
      btn.classList.toggle('so-planet--front', i === frontIndex() && focusedIndex === null);
      btn.classList.toggle('so-planet--far', depth < -0.3 && focusedIndex !== i);
    }
  }

  let lastFrameTime = null;
  function idleTick(t) {
    if (paused || dragging || focusedIndex !== null || reduceMotion || N <= 1) {
      lastFrameTime = null;
      idleRafId = requestAnimationFrame(idleTick);
      return;
    }
    if (lastFrameTime !== null) {
      const dt = t - lastFrameTime;
      orbitAngle += dt * 0.003;
      layout();
    }
    lastFrameTime = t;
    idleRafId = requestAnimationFrame(idleTick);
  }
  idleRafId = requestAnimationFrame(idleTick);
  document.addEventListener('visibilitychange', () => { paused = document.hidden; });

  function snapTo(targetIndex, { instant = false } = {}) {
    cancelAnimationFrame(settleRafId);
    const targetAngle = -targetIndex * STEP;
    let delta = normalize(targetAngle - orbitAngle);
    const from = orbitAngle;
    const to = orbitAngle + delta;
    if (instant || reduceMotion) {
      orbitAngle = to;
      layout();
      return;
    }
    const duration = 380;
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

  function onPointerDown(e) {
    if (N <= 1) return;
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
    orbitAngle = dragStartAngle + dx * 0.32;
    const now = performance.now();
    const dt = now - lastDragTime;
    if (dt > 0) dragVelocity = ((e.clientX - lastDragX) * 0.32) / dt;
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
    const flung = Math.max(-6, Math.min(6, dragVelocity * 60));
    orbitAngle += flung;
    snapTo(frontIndex());
    // See js/service-universe.js's onPointerUp for why this reset must
    // happen on the NEXT task (setTimeout(0)), not synchronously.
    setTimeout(() => { suppressNextClick = false; }, 0);
  }
  stageEl.addEventListener('pointerdown', onPointerDown);

  let wheelSnapTimer = null;
  stageEl.addEventListener('wheel', (e) => {
    if (N <= 1 || Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 4) return;
    e.preventDefault();
    orbitAngle -= e.deltaX * 0.15;
    layout();
    clearTimeout(wheelSnapTimer);
    wheelSnapTimer = setTimeout(() => snapTo(frontIndex()), 140);
  }, { passive: false });

  function focusableIndex() {
    return focusedIndex !== null ? focusedIndex : frontIndex();
  }
  stageEl.addEventListener('keydown', (e) => {
    if (N <= 1) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = ((focusableIndex() + dir) % N + N) % N;
      snapTo(next);
      planetButtons[next].focus();
    }
  });

  document.getElementById('soPrevBtn').addEventListener('click', () => {
    const next = ((focusableIndex() - 1) % N + N) % N;
    snapTo(next);
    planetButtons[next].focus();
  });
  document.getElementById('soNextBtn').addEventListener('click', () => {
    const next = ((focusableIndex() + 1) % N + N) % N;
    snapTo(next);
    planetButtons[next].focus();
  });
  if (N <= 1) {
    document.getElementById('soPrevBtn').classList.add('hidden');
    document.getElementById('soNextBtn').classList.add('hidden');
  }

  planetButtons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (suppressNextClick) { suppressNextClick = false; return; }
      selectPlanet(i);
    });
  });

  function selectPlanet(i) {
    if (focusedIndex === i) {
      openPlatform(platforms[i]);
      return;
    }
    focusedIndex = i;
    planetButtons.forEach((b, bi) => b.setAttribute('aria-selected', String(bi === i)));
    snapTo(i);
    renderFocusedCaption(platforms[i]);
    hintEl.classList.add('so-hint--hidden');
  }

  function deselect() {
    focusedIndex = null;
    planetButtons.forEach((b) => b.setAttribute('aria-selected', 'false'));
    renderIdleCaption();
    hintEl.classList.remove('so-hint--hidden');
    layout();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focusedIndex !== null) deselect();
  });

  // Every real navigation -- the ONLY way this module ever opens a real
  // external URL -- goes through window.open with the explicit
  // 'noopener,noreferrer' feature list, the programmatic equivalent of
  // rel="noopener noreferrer" on an <a>. The visible CTA rendered in
  // renderFocusedCaption() below is itself a real <a rel="noopener
  // noreferrer" target="_blank"> for the same reason -- this function is
  // only reached via a second click on an already-focused tile.
  function openPlatform(svc) {
    window.open(svc.url, '_blank', 'noopener,noreferrer');
  }

  function renderIdleCaption() {
    captionEl.innerHTML = `
      <p class="so-caption-eyebrow">${esc(tr('social.eyebrow', 'Stay Connected'))}</p>
      <p class="so-caption-title">${esc(tr('social.title', 'Follow Darwesh Group'))}</p>
    `;
  }

  function renderFocusedCaption(svc) {
    const handleHtml = svc.handle ? `<span class="so-caption-handle">${esc(svc.handle)}</span>` : '';
    captionEl.innerHTML = `
      <p class="so-caption-eyebrow">${esc(tr('social.eyebrow', 'Stay Connected'))}</p>
      <div class="so-caption-row">
        <span class="so-caption-title">${esc(svc.label)}</span>
        ${handleHtml}
        <a class="so-caption-cta" href="${esc(svc.url)}" target="_blank" rel="noopener noreferrer">
          ${esc(tr('social.openCta', 'Open'))}
          <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
        </a>
        <button type="button" class="so-caption-close" id="soCaptionClose">${esc(tr('social.close', 'Close'))}</button>
      </div>
    `;
    document.getElementById('soCaptionClose').addEventListener('click', deselect);
  }

  renderIdleCaption();

  let resizeRafId = null;
  window.addEventListener('resize', () => {
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => { layout(); resizeRafId = null; });
  });

  document.addEventListener('darwesh:langchange', () => {
    if (focusedIndex !== null) renderFocusedCaption(platforms[focusedIndex]); else renderIdleCaption();
    hintEl.textContent = tr('social.dragHint', 'Drag, swipe, or use the arrow keys to explore');
  });

  layout();
}
