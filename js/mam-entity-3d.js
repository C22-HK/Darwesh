// MAM AI Command Center -- the living 3D particle entity. V2: a
// continuous, curl-noise-driven point cloud that can gather into a
// head/neck/shoulders SUGGESTION while speaking and dissolve back to a
// formless cloud, with its own slow cinematic camera drift and a sparse
// background field for depth -- see js/mam-entity-shaders.js's header for
// the two concrete things this does for real rather than approximates.
//
// Still a DROP-IN stand-in for js/mam-companion.js's MamCompanion: same
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
// other: Three.js needs a real WebGL2 context, which is not guaranteed
// (an old GPU/driver, prefers-reduced-motion asking for less). When
// unavailable this falls back to a plain Canvas2D particle field driven
// by the SAME state targets and a simplified coherence blend -- fewer
// points, no shader, no camera, but still living and state-driven, never
// a static placeholder standing in for "AI is here".
import { ENTITY_VERTEX_SHADER, ENTITY_FRAGMENT_SHADER, BG_VERTEX_SHADER, BG_FRAGMENT_SHADER } from './mam-entity-shaders.js';

// Vendored, not CDN-loaded -- see vendor/three/README.md. The primary
// experience must not depend on unpkg.com being reachable/fast; this is
// the exact r160 (three@0.160.0) build already used, now local and
// pinned the same way every other exact-version dependency in this repo
// already is.
const THREE_MODULE_URL = new URL('../vendor/three/three.module.min.js', import.meta.url).href;

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

// Target "mood" per state: gather (0 spread..1 drawn in), coherence (0
// formless cloud..1 humanoid suggestion), jitter (curl-flow amplitude),
// speed (time multiplier), brightness, particle size, a one-shot pulse
// flag, and guideBias (0..1, the directional arc-flow GUIDING adds).
// Chosen from the spec's own per-state description, not invented:
// IDLE breathes as a loose, mostly-formless presence; AWAKENING gathers
// and flashes brighter; LISTENING orients toward the visitor, driven live
// by uEnergy; THINKING partially dissolves with accelerated internal
// churn (coherence DOWN, jitter UP -- the opposite of "gathering");
// SPEAKING becomes more coherent/humanoid and answers MAM's own voice
// energy; GUIDING streams toward the action; MINIMIZED contracts small
// and quiet; ERROR contracts without dissolving (present, but uneasy);
// wake-listening is a slow ambient pulse; result-ready is the momentary
// bloom.
const STATE_TARGETS = {
  idle: { gather: 0.10, coherence: 0.12, jitter: 0.55, speed: 0.45, brightness: 0.88, size: 2.1, pulse: 0, errorMix: 0, guideBias: 0 },
  awakening: { gather: 0.50, coherence: 0.40, jitter: 0.85, speed: 1.35, brightness: 1.25, size: 2.4, pulse: 1, errorMix: 0, guideBias: 0 },
  listening: { gather: 0.28, coherence: 0.42, jitter: 0.50, speed: 0.65, brightness: 1.05, size: 2.25, pulse: 0, errorMix: 0, guideBias: 0 },
  thinking: { gather: 0.55, coherence: 0.18, jitter: 1.55, speed: 1.25, brightness: 1.00, size: 2.0, pulse: 0, errorMix: 0, guideBias: 0 },
  speaking: { gather: 0.32, coherence: 0.88, jitter: 0.45, speed: 0.75, brightness: 1.18, size: 2.3, pulse: 0, errorMix: 0, guideBias: 0 },
  guiding: { gather: 0.20, coherence: 0.35, jitter: 0.60, speed: 0.95, brightness: 1.05, size: 2.15, pulse: 0, errorMix: 0, guideBias: 0.85 },
  minimized: { gather: 0.80, coherence: 0.55, jitter: 0.18, speed: 0.28, brightness: 0.52, size: 1.2, pulse: 0, errorMix: 0, guideBias: 0 },
  error: { gather: 0.62, coherence: 0.50, jitter: 0.15, speed: 0.22, brightness: 0.78, size: 1.85, pulse: 0, errorMix: 1, guideBias: 0 },
  'wake-listening': { gather: 0.16, coherence: 0.20, jitter: 0.35, speed: 0.35, brightness: 0.80, size: 2.05, pulse: 0, errorMix: 0, guideBias: 0 },
  'result-ready': { gather: 0.10, coherence: 0.55, jitter: 0.65, speed: 1.10, brightness: 1.35, size: 2.4, pulse: 1, errorMix: 0, guideBias: 0 }
};

// Camera target per state -- radius (distance from the entity), azimuth
// drift SPEED (radians/sec the camera autonomously orbits at; idle only),
// and a "settle" flag meaning "stop drifting and ease to dead-frontal"
// (speaking/error/minimized: calm and centered, never spinning while MAM
// is trying to be understood). Kept deliberately small -- Part "CAMERA"
// is explicit that this must never be disorienting.
const CAMERA_TARGETS = {
  idle: { radius: 4.3, driftSpeed: 0.028, settle: false },
  awakening: { radius: 3.9, driftSpeed: 0.02, settle: false },
  listening: { radius: 3.75, driftSpeed: 0.006, settle: false }, // focus-in: drift nearly stops
  thinking: { radius: 4.1, driftSpeed: 0.09, settle: false },     // a few degrees of extra orbit
  speaking: { radius: 3.85, driftSpeed: 0.0, settle: true },      // calm, frontal
  guiding: { radius: 4.0, driftSpeed: 0.03, settle: false },
  minimized: { radius: 4.6, driftSpeed: 0.01, settle: true },
  error: { radius: 4.2, driftSpeed: 0.0, settle: true },
  'wake-listening': { radius: 4.2, driftSpeed: 0.015, settle: false },
  'result-ready': { radius: 3.9, driftSpeed: 0.02, settle: false }
};

const UNIFORM_KEYS = ['gather', 'coherence', 'jitter', 'speed', 'brightness', 'size', 'errorMix', 'guideBias'];
const SMOOTH_RATE = 4.2;      // per second, exponential approach to target
const CAMERA_SMOOTH_RATE = 1.1;
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
  if (prefersReducedMotion()) return 1200;
  const cores = navigator.hardwareConcurrency || 4;
  const narrow = window.innerWidth < 640;
  if (narrow) return cores >= 6 ? 3200 : 2200;
  return cores >= 8 ? 9000 : cores >= 4 ? 6400 : 3600;
}

// ---- the humanoid-suggestion volume -------------------------------
// Four weighted layers -- head, neck, shoulders, a tapering partial
// torso -- and NOTHING else (no arms, no hands, no legs, no face
// geometry): exactly what Part "HUMAN PRESENCE" asks for, "an
// intelligence choosing to temporarily take a human-like form", not a
// figure. Rejection-sampled inside simple volumes so the result is a
// solid-feeling suggestion of mass, not a hollow shell. Coordinates in
// the same normalized unit-sphere-ish space the cloud's own base
// positions live in (roughly [-1,1]), y-up, so `mix(cloud, humanoid,
// coherence)` in the shader never needs a rescale.
function sampleHumanoid(rand) {
  const layer = rand();
  if (layer < 0.22) {
    // Head: a slightly flattened sphere near the top.
    let x, y, z;
    do {
      x = (rand() * 2 - 1); y = (rand() * 2 - 1); z = (rand() * 2 - 1);
    } while (x * x + y * y + z * z > 1);
    return [x * 0.30, 0.72 + y * 0.26, z * 0.30];
  }
  if (layer < 0.32) {
    // Neck: a thin vertical cylinder joining head to shoulders.
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.13;
    return [Math.cos(a) * r, 0.40 + rand() * 0.22, Math.sin(a) * r * 0.8];
  }
  if (layer < 0.62) {
    // Shoulders: a wide, flattened arc -- not a full sphere, so it reads
    // as shoulder-width mass rather than a second head.
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand());
    return [Math.cos(a) * r * 0.78, 0.20 + Math.sin(a) * r * 0.14, Math.sin(a) * r * 0.42];
  }
  // Partial upper torso: tapers wider going down, cut off well above the
  // waist -- "partial torso", per spec, not a full figure.
  const a = rand() * Math.PI * 2;
  const depth = rand();
  const width = 0.55 + depth * 0.30;
  const r = Math.sqrt(rand()) * width;
  return [Math.cos(a) * r, -0.05 - depth * 0.55, Math.sin(a) * r * 0.55];
}

// ---- shared "mood" controller ------------------------------------------
// Both renderers below drive the SAME smoothed uniform set from the SAME
// STATE_TARGETS table, so switching between Three.js and the Canvas2D
// fallback is a rendering detail, never a behavior difference a reviewer
// could tell apart from the state transitions alone.
function createMood() {
  const current = { gather: 0.10, coherence: 0.12, jitter: 0.55, speed: 0.45, brightness: 0.88, size: 2.1, errorMix: 0, guideBias: 0 };
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
      UNIFORM_KEYS.forEach((k) => { target[k] = t[k]; });
      if (t.pulse) {
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

// ---- camera controller ---------------------------------------------
// A calm, always-looking-at-origin orbit camera. `radius` and
// `driftSpeed` ease toward their state target exponentially (same
// technique as the mood uniforms); azimuth accumulates at the CURRENT
// (already-smoothed) drift speed, so a state change never snaps the
// orbit, it just gradually speeds up, slows down, or stops. Pointer
// proximity nudges radius closer, per "user approaches/interacts: camera
// subtly moves closer" -- released back to the state's own target on
// pointer-leave.
function createCameraRig() {
  let radius = 4.3, radiusTarget = 4.3;
  let driftSpeed = 0.028, driftSpeedTarget = 0.028;
  let azimuth = 0.15;
  let elevation = 0.06;
  let settle = false;
  let hover = 0; // 0..1, pointer proximity

  return {
    setState(name) {
      const t = CAMERA_TARGETS[name] || CAMERA_TARGETS.idle;
      radiusTarget = t.radius;
      driftSpeedTarget = t.driftSpeed;
      settle = t.settle;
    },
    setHover(v) { hover = Math.max(0, Math.min(1, v)); },
    tick(dt, reduced) {
      const a = 1 - Math.exp(-CAMERA_SMOOTH_RATE * dt);
      radius += (radiusTarget - hover * 0.35 - radius) * a;
      driftSpeed += (driftSpeedTarget - driftSpeed) * a;
      const effectiveDrift = reduced ? driftSpeed * 0.15 : driftSpeed;
      if (settle) {
        // Ease azimuth/elevation back toward dead-frontal rather than
        // stopping abruptly wherever the orbit happened to be.
        azimuth += (0 - azimuth) * (1 - Math.exp(-0.6 * dt));
        elevation += (0.06 - elevation) * (1 - Math.exp(-0.6 * dt));
      } else {
        azimuth += effectiveDrift * dt;
        elevation = 0.06 + Math.sin(azimuth * 0.7) * 0.02;
      }
      return {
        x: radius * Math.sin(azimuth) * Math.cos(elevation),
        y: radius * Math.sin(elevation) + 0.15,
        z: radius * Math.cos(azimuth) * Math.cos(elevation)
      };
    }
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
  const camera_ = createCameraRig();
  updateLabel(el, 'idle', getLanguage);

  let destroyed = false;
  let energy = 0;
  let three = null;
  let renderer = null, scene = null, camera = null, points = null, material = null;
  let bgPoints = null;
  let raf = null;
  let lastT = performance.now();
  let resizeObserver = null;
  let hoverX = 0, hoverY = 0, hoverActive = false;

  function onPointerMove(e) {
    const r = el.getBoundingClientRect();
    hoverX = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    hoverY = ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1;
    hoverActive = true;
    camera_.setHover(1);
  }
  function onPointerLeave() { hoverActive = false; camera_.setHover(0); }

  async function init() {
    three = await import(/* webpackIgnore: true */ THREE_MODULE_URL);
    if (destroyed) return;

    const count = particleBudget();
    const rand = mulberry32(0xda2 ^ count);
    const positions = new Float32Array(count * 3);
    const humanoid = new Float32Array(count * 3);
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
      const [hx, hy, hz] = sampleHumanoid(rand);
      humanoid[i * 3] = hx; humanoid[i * 3 + 1] = hy; humanoid[i * 3 + 2] = hz;
      seeds[i] = rand() * 1000;
      const [cr, cg, cb] = pickColor(rand);
      colors[i * 3] = cr / 255; colors[i * 3 + 1] = cg / 255; colors[i * 3 + 2] = cb / 255;
    }

    const geometry = new three.BufferGeometry();
    geometry.setAttribute('position', new three.BufferAttribute(positions, 3));
    geometry.setAttribute('aHumanoid', new three.BufferAttribute(humanoid, 3));
    geometry.setAttribute('aSeed', new three.BufferAttribute(seeds, 1));
    geometry.setAttribute('aColor', new three.BufferAttribute(colors, 3));

    material = new three.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uGather: { value: 0.10 }, uCoherence: { value: 0.12 },
        uJitter: { value: 0.55 }, uSpeed: { value: 0.45 }, uEnergy: { value: 0 },
        uPulse: { value: 0 }, uGuideBias: { value: 0 }, uGuideDir: { value: new three.Vector3(1, -0.15, 0.2).normalize() },
        uSize: { value: 2.1 }, uBrightness: { value: 0.88 }
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

    // ---- background environment: sparse, distant, parallaxing --------
    // Narrower on mobile than the desktop count, and cut further still --
    // the background field is depth-cue only, and Part "MOBILE VISUAL
    // POLISH"'s own instruction is explicit: thin the ambient field before
    // ever touching the main entity's own particleBudget() (untouched
    // here), so the question/card text reads cleanly against it.
    const bgCount = prefersReducedMotion() ? 60 : (window.innerWidth < 640 ? 85 : 260);
    const bgPositions = new Float32Array(bgCount * 3);
    const bgSeeds = new Float32Array(bgCount);
    const bgRand = mulberry32(0x5eed ^ bgCount);
    for (let i = 0; i < bgCount; i++) {
      const a = bgRand() * Math.PI * 2, rad = 3.5 + bgRand() * 8.5;
      bgPositions[i * 3] = Math.cos(a) * rad;
      bgPositions[i * 3 + 1] = (bgRand() - 0.5) * 7;
      bgPositions[i * 3 + 2] = Math.sin(a) * rad - 2; // biased behind the entity
      bgSeeds[i] = bgRand() * 1000;
    }
    const bgGeometry = new three.BufferGeometry();
    bgGeometry.setAttribute('position', new three.BufferAttribute(bgPositions, 3));
    bgGeometry.setAttribute('aSeed', new three.BufferAttribute(bgSeeds, 1));
    const bgMaterial = new three.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uParallax: { value: 0 } },
      vertexShader: BG_VERTEX_SHADER,
      fragmentShader: BG_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: three.AdditiveBlending
    });
    bgPoints = new three.Points(bgGeometry, bgMaterial);
    scene.add(bgPoints);

    camera = new three.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0.6, 0.15, 4.3);
    camera.lookAt(0, 0.1, 0);

    renderer = new three.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    renderer.domElement.className = 'mam-entity3d-canvas';
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerleave', onPointerLeave);

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
    // all) when the visitor asked for reduced motion -- Part 20/"PERFORMANCE".
    if (document.hidden) { raf = requestAnimationFrame(loop); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const reduced = prefersReducedMotion();
    const m = mood.tick(dt);
    const u = material.uniforms;
    u.uTime.value += dt * (reduced ? 0.35 : 1);
    u.uGather.value = m.gather;
    u.uCoherence.value = m.coherence;
    u.uJitter.value = reduced ? m.jitter * 0.4 : m.jitter;
    u.uSpeed.value = reduced ? m.speed * 0.5 : m.speed;
    u.uSize.value = m.size;
    u.uEnergy.value = energy;
    u.uPulse.value = mood.pulse;
    u.uGuideBias.value = m.guideBias;
    // errorMix dims brightness and slows motion; combined with additive
    // blending over the warm palette this reads as "uneasy amber" without
    // a second shader branch or a color swap.
    u.uBrightness.value = m.brightness * (1 - 0.25 * m.errorMix);

    const camPos = camera_.tick(dt, reduced);
    camera.position.set(camPos.x, camPos.y, camPos.z);
    camera.lookAt(0, 0.08, 0);

    bgPoints.material.uniforms.uTime.value += dt;
    bgPoints.material.uniforms.uParallax.value = hoverActive ? hoverX : 0;
    bgPoints.rotation.y += dt * 0.004;

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
    // the Canvas2D fallback. Swallowing the error here would let this
    // function resolve "successfully" with a renderer-less, DOM-less
    // husk, which would mean the fallback never runs and the entity
    // silently renders nothing -- exactly the case a flaky network hits.
    throw err;
  }

  const api = {
    get root() { return root; },
    get element() { return el; },
    getState() { return mood.state; },
    setState(state) {
      if (!VALID_STATES.has(state)) return;
      mood.setState(state, (settled) => api.setState(settled));
      camera_.setState(state);
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
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerleave', onPointerLeave);
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
    const [hx, hy, hz] = sampleHumanoid(rand);
    particles.push({
      x0: r * Math.sin(phi) * Math.cos(theta),
      y0: r * Math.sin(phi) * Math.sin(theta),
      z0: r * Math.cos(phi),
      hx, hy, hz,
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

  // Same analytic curl construction as the shader (see
  // mam-entity-shaders.js), evaluated on the CPU -- fewer points here, so
  // this stays cheap.
  function curl(x, y, z, t) {
    const f = 1.6;
    return [-Math.cos(z * f + t), -Math.cos(x * f + t) , -Math.cos(y * f + t)];
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

    const projected = particles.map((p) => {
      const t = time * speed + p.seed * 0.0062831;
      const radiusMod = 1 + 0.12 * Math.sin(t * 0.6 + p.seed * 0.004) + 0.05 * Math.sin(t * 1.7 + p.seed * 0.009);
      const bx = p.x0 * radiusMod, by = p.y0 * radiusMod, bz = p.z0 * radiusMod;
      let x = bx + (p.hx - bx) * m.coherence;
      let y = by + (p.hy - by) * m.coherence;
      let z = bz + (p.hz - bz) * m.coherence;
      x *= gathered; y *= gathered; z *= gathered;
      const [fx, fy, fz] = curl(bx * 1.3, by * 1.3, bz * 1.3, t);
      const amp = (0.16 * jitter + 0.24 * energy) * (1 - 0.45 * m.coherence);
      x += fx * amp; y += fy * amp; z += fz * amp;
      const pulseAmt = mood.pulse * 0.35;
      const len = Math.hypot(bx, by, bz) || 1;
      x += (bx / len) * pulseAmt; y += (by / len) * pulseAmt; z += (bz / len) * pulseAmt;
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
