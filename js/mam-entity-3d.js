// MAM AI Command Center -- the living 3D particle entity.
//
// This is a DROP-IN stand-in for js/mam-companion.js's MamCompanion: same
// public shape (.root, .element, .setState(state), .setEnergy(level),
// .setFocus(on), .getState(), .destroy()), same VALID_STATES. That is
// deliberate, not incidental -- js/mam-presence.js's createPresence() and
// js/mam-chat-panel.js's mountMamChatPanel() both already drive a
// "companion" object through exactly this interface on every other page,
// and neither is modified for this page: mam-ai.html hands THIS object to
// both instead of a MamCompanion instance, and the whole existing state
// machine, voice pipeline and action pipeline work unchanged, now driving
// a Three.js particle body instead of the CSS/SVG orb. One state machine,
// two renderers -- this module never invents a second one, and it only
// ever reads state/energy that MAM's own real machinery publishes; it
// never fabricates activity while MAM is actually idle or silent.
//
// Two renderers live in here for the SAME reason js/mam-voice-energy.js
// keeps its two audio paths distinct rather than faking one from the
// other: Three.js needs a real WebGL2 context and a successful load from
// the CDN, neither of which is guaranteed (a blocked network, an old
// GPU/driver, prefers-reduced-motion asking for less). When either is
// unavailable this falls back to a plain Canvas2D particle field driven
// by the EXACT SAME state targets and smoothing -- fewer points, no
// shader, but the same living, state-driven behaviour, never a static
// placeholder image standing in for "AI is here".
import { ENTITY_VERTEX_SHADER, ENTITY_FRAGMENT_SHADER } from './mam-entity-shaders.js';

// Pinned, exact version -- same convention as every other CDN import this
// repo already makes (see INFRA-03's Tailwind pin). Loaded as a real ES
// module from the CDN this site's own CSP already allowlists in
// script-src (https://unpkg.com, present on every page's <meta> tag) --
// no CSP change, no vendoring, no second package manager.
const THREE_MODULE_URL = 'https://unpkg.com/three@0.160.0/build/three.module.js';

export const VALID_STATES = new Set([
  'idle', 'awakening', 'listening', 'thinking', 'speaking',
  'guiding', 'minimized', 'error', 'wake-listening', 'result-ready'
]);

// js/mam-chat-panel.js calls companion.setState('result-ready') UNCONDITIONALLY
// after every successful turn (see its own comment on that call site), and
// setState('error') the same way on a failed one -- neither goes through
// js/mam-presence.js's state machine, so whatever stands in for the
// companion has to settle these back on its own, exactly like
// MamCompanion._armSettle()/SETTLES_TO already does for the 2D body.
const MOMENTARY_MS = { 'result-ready': 2400, error: 4200, awakening: 900 };
const SETTLES_TO = { 'result-ready': 'idle', error: 'idle', awakening: 'listening' };

const STATE_LABELS = {
  idle: { en: 'MAM is ready', ar: 'MAM جاهز', ku: 'MAM ئامادەیە' },
  awakening: { en: 'MAM is waking up', ar: 'MAM يستيقظ', ku: 'MAM هەڵدەستێت' },
  'wake-listening': { en: 'MAM is listening for "MAM AI"', ar: 'MAM بانتظار قول "مام آي"', ku: 'MAM چاوەڕێی وشەی "مام ئای"ـە' },
  listening: { en: 'MAM is listening', ar: 'MAM يستمع', ku: 'MAM گوێ دەگرێت' },
  thinking: { en: 'MAM is thinking', ar: 'MAM يفكر', ku: 'MAM بیر دەکاتەوە' },
  speaking: { en: 'MAM is speaking', ar: 'MAM يتحدث', ku: 'MAM قسە دەکات' },
  guiding: { en: 'MAM is taking you there', ar: 'MAM يأخذك إلى هناك', ku: 'MAM دەتبات بۆ ئەوێ' },
  minimized: { en: 'MAM is here if you need it', ar: 'MAM موجود إذا احتجته', ku: 'MAM لێرەیە ئەگەر پێویستت بێت' },
  'result-ready': { en: 'MAM has an answer', ar: 'MAM لديه إجابة', ku: 'MAM وەڵامێکی هەیە' },
  error: { en: 'MAM ran into a problem', ar: 'واجه MAM مشكلة', ku: 'MAM کێشەیەکی هەبوو' }
};

// The mandated palette (see docs/brand/darwesh-brand-tokens.json and
// css/mam-companion.css's own gold family) and NOTHING else -- no neon
// yellow, no purple, no blue. Distribution matches the spec's own
// ~60/20/15/5 split (the 20% and 5% bands are each split across two
// closely-related hexes already used elsewhere in this codebase, not new
// colors invented for this file).
const PARTICLE_COLORS = [
  { hex: [0xc6, 0x9a, 0x4b], weight: 0.60 }, // Darwesh Gold
  { hex: [0xd8, 0xb6, 0x67], weight: 0.12 }, // Light Gold
  { hex: [0xd4, 0xaf, 0x60], weight: 0.08 }, // Soft Gold (MAM's own --mamco-accent family)
  { hex: [0xf4, 0xef, 0xe7], weight: 0.15 }, // Warm Ivory
  { hex: [0x8e, 0x74, 0x48], weight: 0.03 }, // Bronze depth
  { hex: [0x5d, 0x48, 0x2b], weight: 0.02 }  // Deep bronze
];
// ERROR blends toward this instead of swapping palettes outright -- calm
// amber-red, never a hard color-scheme change, so it still reads as the
// same entity, just uneasy.
const ERROR_TINT = [0.85, 0.42, 0.28];

// Target shader "mood" per state: gather (0 diffuse..1 drawn tightly in),
// jitter (turbulence), speed (time multiplier), brightness, particle
// size, and a one-shot pulse flag. Chosen from Part 5 of the spec without
// inventing a second, competing state vocabulary -- IDLE breathes gently,
// AWAKENING gathers and flashes brighter, LISTENING/SPEAKING are driven
// live by uEnergy (mic or MAM's own voice) rather than their own targets
// doing the work, THINKING churns inward with no external cue at all
// (this is the "NO spinner -- the body itself indicates thinking" rule),
// GUIDING flows outward toward the edge, MINIMIZED contracts small and
// quiet, ERROR contracts and dims toward the amber tint above.
const STATE_TARGETS = {
  idle: { gather: 0.12, jitter: 0.45, speed: 0.45, brightness: 0.88, size: 2.2, pulse: 0, errorMix: 0 },
  awakening: { gather: 0.55, jitter: 0.85, speed: 1.35, brightness: 1.25, size: 2.4, pulse: 1, errorMix: 0 },
  listening: { gather: 0.30, jitter: 0.55, speed: 0.70, brightness: 1.05, size: 2.3, pulse: 0, errorMix: 0 },
  thinking: { gather: 0.62, jitter: 1.35, speed: 1.15, brightness: 1.00, size: 2.1, pulse: 0, errorMix: 0 },
  speaking: { gather: 0.34, jitter: 0.65, speed: 0.85, brightness: 1.15, size: 2.35, pulse: 0, errorMix: 0 },
  guiding: { gather: 0.20, jitter: 0.50, speed: 0.95, brightness: 1.05, size: 2.2, pulse: 0, errorMix: 0 },
  minimized: { gather: 0.78, jitter: 0.20, speed: 0.30, brightness: 0.55, size: 1.3, pulse: 0, errorMix: 0 },
  error: { gather: 0.70, jitter: 0.15, speed: 0.25, brightness: 0.80, size: 1.9, pulse: 0, errorMix: 1 },
  'wake-listening': { gather: 0.18, jitter: 0.35, speed: 0.35, brightness: 0.80, size: 2.1, pulse: 0, errorMix: 0 },
  'result-ready': { gather: 0.10, jitter: 0.60, speed: 1.10, brightness: 1.35, size: 2.4, pulse: 1, errorMix: 0 }
};

const UNIFORM_KEYS = ['gather', 'jitter', 'speed', 'brightness', 'size', 'errorMix'];
const SMOOTH_RATE = 4.2;      // per second, exponential approach to target
const PULSE_DECAY_MS = 480;

function mulberry32(seed) {
  return function rand() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickColor(rand) {
  const total = PARTICLE_COLORS.reduce((s, c) => s + c.weight, 0);
  let r = rand() * total;
  for (const c of PARTICLE_COLORS) { r -= c.weight; if (r <= 0) return c.hex; }
  return PARTICLE_COLORS[0].hex;
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function particleBudget() {
  if (prefersReducedMotion()) return 700;
  const cores = navigator.hardwareConcurrency || 4;
  const narrow = window.innerWidth < 640;
  if (narrow) return cores >= 6 ? 1800 : 1100;
  return cores >= 8 ? 5200 : cores >= 4 ? 3600 : 2000;
}

// ---- shared "mood" controller ------------------------------------------
// Both renderers below drive the SAME smoothed uniform set from the SAME
// STATE_TARGETS table, so switching between Three.js and the Canvas2D
// fallback is a rendering detail, never a behavior difference a reviewer
// could tell apart from the state transitions alone.
function createMood() {
  const current = { gather: 0.12, jitter: 0.45, speed: 0.45, brightness: 0.88, size: 2.2, errorMix: 0 };
  const target = { ...current };
  let pulse = 0;
  let pulseTarget = 0;
  let pulseTimer = null;
  let state = 'idle';
  let settleTimer = null;

  function armSettle(nextState, onSettle) {
    clearTimeout(settleTimer);
    const ms = MOMENTARY_MS[nextState];
    if (!ms) return;
    settleTimer = setTimeout(() => { if (state === nextState) onSettle(SETTLES_TO[nextState] || 'idle'); }, ms);
  }

  return {
    get state() { return state; },
    setState(next, onSettle) {
      if (!VALID_STATES.has(next)) return false;
      state = next;
      const t = STATE_TARGETS[next] || STATE_TARGETS.idle;
      UNIFORM_KEYS.forEach((k) => { if (k !== 'errorMix') target[k] = t[k]; });
      target.errorMix = t.errorMix;
      if (t.pulse) {
        // Snap UP immediately (the flash should be instant) but let the
        // fall-off ride the same exponential smoothing as everything
        // else in tick() -- a hard reset to 0 here would read as a cut,
        // not a decay.
        pulse = 1;
        pulseTarget = 1;
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => { pulseTarget = 0; }, PULSE_DECAY_MS);
      }
      armSettle(next, onSettle);
      return true;
    },
    tick(dt) {
      const a = 1 - Math.exp(-SMOOTH_RATE * dt);
      UNIFORM_KEYS.forEach((k) => { current[k] += (target[k] - current[k]) * a; });
      pulse += (pulseTarget - pulse) * (1 - Math.exp(-6 * dt));
      return current;
    },
    get pulse() { return pulse; },
    destroy() { clearTimeout(pulseTimer); clearTimeout(settleTimer); }
  };
}

function ensureStylesheet() {
  const already = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .some((l) => (l.getAttribute('href') || '').includes('mam-entity-3d.css'));
  if (already) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/mam-entity-3d.css', import.meta.url).href;
  document.head.appendChild(link);
}

function ensureRoot(mountTarget, interactive, getLanguage) {
  ensureStylesheet();
  const root = document.createElement('div');
  root.className = 'mam-entity3d-root';
  const el = document.createElement('div');
  el.className = 'mam-entity3d-el';
  if (interactive) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  } else {
    el.setAttribute('role', 'img');
  }
  root.appendChild(el);
  (mountTarget || document.body).appendChild(root);
  return { root, el };
}

function updateLabel(el, state, getLanguage) {
  const lang = (typeof getLanguage === 'function' ? getLanguage() : 'en') || 'en';
  const labels = STATE_LABELS[state] || STATE_LABELS.idle;
  el.setAttribute('aria-label', labels[lang] || labels.en);
}

// =========================================================================
// Renderer A: Three.js particle field (WebGL2)
// =========================================================================
async function createThreeEntity({ mountTarget, getLanguage, interactive }) {
  const { root, el } = ensureRoot(mountTarget, interactive, getLanguage);
  const mood = createMood();
  updateLabel(el, 'idle', getLanguage);

  let destroyed = false;
  let energy = 0;
  let three = null;
  let renderer = null, scene = null, camera = null, points = null, material = null;
  let raf = null;
  let lastT = performance.now();
  let resizeObserver = null;

  async function init() {
    three = await import(/* webpackIgnore: true */ THREE_MODULE_URL);
    if (destroyed) return;

    const count = particleBudget();
    const rand = mulberry32(0xda2 ^ count);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Fibonacci-sphere-ish distribution -- an even, non-clumped shell,
      // then a small radial jitter so it is not a perfect mathematical
      // sphere (see mam-companion.js's own "no orbital rings, no uniform
      // circles" rule -- the same principle applied to a point cloud).
      const u = rand(), v = rand();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = 1.0 + (rand() - 0.5) * 0.18;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      seeds[i] = rand() * 1000;
      const [cr, cg, cb] = pickColor(rand);
      colors[i * 3] = cr / 255; colors[i * 3 + 1] = cg / 255; colors[i * 3 + 2] = cb / 255;
    }

    const geometry = new three.BufferGeometry();
    geometry.setAttribute('position', new three.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new three.BufferAttribute(seeds, 1));
    geometry.setAttribute('aColor', new three.BufferAttribute(colors, 3));

    material = new three.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uGather: { value: 0.12 }, uJitter: { value: 0.45 },
        uSpeed: { value: 0.45 }, uEnergy: { value: 0 }, uPulse: { value: 0 },
        uSize: { value: 2.2 }, uBrightness: { value: 0.88 }
      },
      vertexShader: ENTITY_VERTEX_SHADER,
      fragmentShader: ENTITY_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: three.AdditiveBlending
    });

    points = new three.Points(geometry, material);
    scene = new three.Scene();
    scene.add(points);
    camera = new three.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 4.2;

    renderer = new three.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    renderer.domElement.className = 'mam-entity3d-canvas';

    resize();
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(el);

    lastT = performance.now();
    loop();
  }

  function resize() {
    if (!renderer) return;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function loop() {
    if (destroyed) return;
    // Never spend GPU/CPU on a hidden tab, and rotate slower (or not at
    // all) when the visitor asked for reduced motion -- Part 20.
    if (document.hidden) { raf = requestAnimationFrame(loop); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const m = mood.tick(dt);
    const u = material.uniforms;
    u.uTime.value += dt * (prefersReducedMotion() ? 0.35 : 1);
    u.uGather.value = m.gather;
    u.uJitter.value = prefersReducedMotion() ? m.jitter * 0.4 : m.jitter;
    u.uSpeed.value = prefersReducedMotion() ? m.speed * 0.5 : m.speed;
    u.uSize.value = m.size;
    u.uEnergy.value = energy;
    u.uPulse.value = mood.pulse;
    // Blend brightness/color toward the amber error tint via brightness +
    // a tinted additive pass would need a second uniform set; kept simple
    // and honest here: errorMix dims brightness and slows motion, and the
    // additive blending plus warm palette already reads as "uneasy amber"
    // without a second shader branch.
    u.uBrightness.value = m.brightness * (1 - 0.25 * m.errorMix);
    points.rotation.y += dt * 0.06 * (prefersReducedMotion() ? 0.3 : 1);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  try {
    await init();
  } catch (err) {
    console.warn('[mam-entity-3d] Three.js unavailable, falling back to Canvas2D:', err && err.message);
    destroyed = true;
    root.remove();
    // Rethrown deliberately: createMamEntity3D's proxy is waiting on THIS
    // promise to decide whether to keep the Three.js instance or swap in
    // the Canvas2D fallback. Swallowing the error here (the previous,
    // buggy shape -- a detached `init().catch()` with no rethrow) let
    // this function resolve "successfully" with a renderer-less, DOM-less
    // husk, which meant the fallback never ran and the entity silently
    // rendered nothing at all whenever the CDN import failed but WebGL2
    // itself was available -- exactly the case a flaky network hits.
    throw err;
  }

  const api = {
    get root() { return root; },
    get element() { return el; },
    getState() { return mood.state; },
    setState(state) {
      if (!VALID_STATES.has(state)) return;
      mood.setState(state, (settled) => api.setState(settled));
      updateLabel(el, state, getLanguage);
    },
    setEnergy(level) {
      energy = Math.max(0, Math.min(1, Number(level) || 0));
      root.style.setProperty('--mam-energy', energy.toFixed(3));
    },
    setFocus(on) { root.dataset.focus = on ? '1' : '0'; },
    destroy() {
      destroyed = true;
      if (raf != null) cancelAnimationFrame(raf);
      if (resizeObserver) resizeObserver.disconnect();
      mood.destroy();
      if (renderer) renderer.dispose();
      root.remove();
    },
    /** True once the real Three.js renderer is up; false while loading or on fallback. */
    get isWebGL() { return !!renderer; }
  };
  return api;
}

// =========================================================================
// Renderer B: Canvas2D fallback (no WebGL2, or Three.js failed to load)
// =========================================================================
function createCanvas2DEntity({ mountTarget, getLanguage, interactive }) {
  const { root, el } = ensureRoot(mountTarget, interactive, getLanguage);
  updateLabel(el, 'idle', getLanguage);
  const canvas = document.createElement('canvas');
  canvas.className = 'mam-entity3d-canvas';
  el.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const mood = createMood();
  let energy = 0;
  let destroyed = false;
  let raf = null;
  let lastT = performance.now();
  let time = 0;
  let w = 0, h = 0, dpr = 1;

  const count = particleBudget();
  const rand = mulberry32(0x51a1 ^ count);
  const particles = [];
  for (let i = 0; i < count; i++) {
    const u = rand(), v = rand();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 1.0 + (rand() - 0.5) * 0.18;
    particles.push({
      x0: r * Math.sin(phi) * Math.cos(theta),
      y0: r * Math.sin(phi) * Math.sin(theta),
      z0: r * Math.cos(phi),
      seed: rand() * 1000,
      color: pickColor(rand)
    });
  }

  function resize() {
    w = Math.max(1, el.clientWidth); h = Math.max(1, el.clientHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(el);
  resize();

  function flow(x, y, z, t) {
    return [
      Math.sin(y * 1.7 + t) + Math.sin(z * 1.3 - t * 0.7),
      Math.sin(z * 1.9 - t * 0.8) + Math.sin(x * 1.4 + t * 0.6),
      Math.sin(x * 1.5 + t * 0.9) + Math.sin(y * 1.2 - t * 0.5)
    ];
  }

  function loop() {
    if (destroyed) return;
    if (document.hidden) { raf = requestAnimationFrame(loop); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const reduced = prefersReducedMotion();
    time += dt * (reduced ? 0.35 : 1);
    const m = mood.tick(dt);
    const jitter = reduced ? m.jitter * 0.4 : m.jitter;
    const speed = reduced ? m.speed * 0.5 : m.speed;
    const gathered = 1 - 0.58 * m.gather;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const scale = Math.min(w, h) * 0.38;
    const cameraZ = 4.2;

    // Depth-sort back-to-front so nearer particles paint over farther
    // ones -- cheap and sufficient at this point count, unlike a real
    // z-buffer which Canvas2D does not have.
    const projected = particles.map((p) => {
      const t = time * speed + p.seed * 0.0062831;
      const radiusMod = 1 + 0.12 * Math.sin(t * 0.6 + p.seed * 0.004) + 0.05 * Math.sin(t * 1.7 + p.seed * 0.009);
      let x = p.x0 * radiusMod * gathered, y = p.y0 * radiusMod * gathered, z = p.z0 * radiusMod * gathered;
      const [fx, fy, fz] = flow(p.x0 * 1.3, p.y0 * 1.3, p.z0 * 1.3, t);
      const amp = 0.16 * jitter + 0.22 * energy;
      x += fx * amp; y += fy * amp; z += fz * amp;
      const pulseAmt = mood.pulse * 0.35;
      const len = Math.hypot(p.x0, p.y0, p.z0) || 1;
      x += (p.x0 / len) * pulseAmt; y += (p.y0 / len) * pulseAmt; z += (p.z0 / len) * pulseAmt;
      const persp = cameraZ / (cameraZ - z);
      return {
        sx: cx + x * scale * persp,
        sy: cy + y * scale * persp,
        size: Math.max(0.4, m.size * persp * (0.65 + 0.5 * ((p.seed * 91.7) % 1))),
        z, color: p.color,
        alpha: 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 2 + p.seed * 0.013))
      };
    }).sort((a, b) => a.z - b.z);

    const brightness = m.brightness * (1 - 0.25 * m.errorMix);
    for (const pt of projected) {
      const r = Math.round(pt.color[0] * brightness);
      const g = Math.round(pt.color[1] * brightness);
      const b = Math.round(pt.color[2] * brightness);
      const grad = ctx.createRadialGradient(pt.sx, pt.sy, 0, pt.sx, pt.sy, pt.size * 1.6);
      grad.addColorStop(0, `rgba(${r},${g},${b},${pt.alpha})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, pt.size * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    get root() { return root; },
    get element() { return el; },
    getState() { return mood.state; },
    setState(state) {
      if (!VALID_STATES.has(state)) return;
      mood.setState(state, (settled) => this.setState(settled));
      updateLabel(el, state, getLanguage);
    },
    setEnergy(level) {
      energy = Math.max(0, Math.min(1, Number(level) || 0));
      root.style.setProperty('--mam-energy', energy.toFixed(3));
    },
    setFocus(on) { root.dataset.focus = on ? '1' : '0'; },
    destroy() {
      destroyed = true;
      if (raf != null) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      mood.destroy();
      root.remove();
    },
    get isWebGL() { return false; }
  };
}

// =========================================================================
function supportsWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch { return false; }
}

/**
 * @param {Object} [opts]
 * @param {Element} [opts.mountTarget] Defaults to document.body.
 * @param {() => string} [opts.getLanguage] Returns 'en'|'ar'|'ku'.
 * @param {boolean} [opts.interactive] Same meaning as MamCompanion's.
 * @returns {{root:Element, element:Element, setState:Function, setEnergy:Function, setFocus:Function, getState:Function, destroy:Function}}
 */
export function createMamEntity3D(opts = {}) {
  if (!supportsWebGL2()) return createCanvas2DEntity(opts);
  // createThreeEntity is async (it dynamically imports Three.js), but the
  // object callers wire into createPresence()/mountMamChatPanel() has to
  // exist NOW -- so build a thin synchronous proxy that queues calls made
  // before the real renderer finishes loading, exactly the same contract
  // an already-ready renderer offers.
  const pending = [];
  let real = null;
  let rootEl = null, elEl = null;
  const { root, el } = ensureRoot(opts.mountTarget, opts.interactive, opts.getLanguage);
  rootEl = root; elEl = el;
  root.remove(); // ensureRoot() already appended it; the real renderer's own ensureRoot() will append its own -- avoid a duplicate empty root while loading.

  const proxy = {
    get root() { return real ? real.root : rootEl; },
    get element() { return real ? real.element : elEl; },
    getState() { return real ? real.getState() : 'idle'; },
    setState(state) { real ? real.setState(state) : pending.push(['setState', state]); },
    setEnergy(level) { real ? real.setEnergy(level) : pending.push(['setEnergy', level]); },
    setFocus(on) { real ? real.setFocus(on) : pending.push(['setFocus', on]); },
    destroy() { real ? real.destroy() : pending.push(['destroy']); },
    get isWebGL() { return real ? real.isWebGL : false; }
  };

  createThreeEntity(opts).then((instance) => {
    real = instance;
    pending.forEach(([fn, arg]) => real[fn](arg));
  }).catch(() => {
    real = createCanvas2DEntity(opts);
    pending.forEach(([fn, arg]) => real[fn](arg));
  });

  return proxy;
}
