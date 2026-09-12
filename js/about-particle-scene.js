// About page hero -- a volumetric particle field that assembles into a
// real, layered house (not a flat line-drawing) as `progress` (0..1,
// caller-supplied on every frame) advances, then blooms warm gold. Same
// WebGL2-gate-with-Canvas2D-fallback shape as js/mam-entity-3d.js, for the
// same reason: the primary visual moment on this page must not depend on
// a real WebGL2 context being available.
//
// This module owns rendering only -- it never reads scroll or DOM layout
// itself. The caller (about.html's inline module) supplies a
// `getProgress()` function returning 0..1 every frame; on desktop that
// reads the page's own --pp pin-progress custom property, on mobile
// (where the hero isn't pinned) it can instead be a short internal
// ramp-then-hold clock. Decoupling this way keeps the scene's own code
// identical in both cases.
import { HOUSE_VERTEX_SHADER, HOUSE_FRAGMENT_SHADER } from './about-particle-shaders.js';
import { BG_VERTEX_SHADER, BG_FRAGMENT_SHADER } from './mam-entity-shaders.js';

const THREE_MODULE_URL = new URL('../vendor/three/three.module.min.js', import.meta.url).href;

function mulberry32(seed) {
  return function rand() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function particleBudget() {
  if (prefersReducedMotion()) return 2200;
  const cores = navigator.hardwareConcurrency || 4;
  const narrow = window.innerWidth < 640;
  if (narrow) return cores >= 6 ? 4200 : 2800;
  return cores >= 8 ? 13000 : cores >= 4 ? 8500 : 5000;
}

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
function ramp(p, a, b) { return clamp01((p - a) / (b - a)); }

// ---- palettes ------------------------------------------------------------
// COOL: a blue-violet dust, deliberately echoing the reference video's own
// particle-cloud opening -- the motion/style language this hero is built
// to feel like. WARM: the Darwesh gold family (same hexes js/mam-entity-
// 3d.js already uses), what the cloud resolves INTO. The resolve from one
// to the other, not either alone, is the point: "the video's cinematic
// experience redesigned specifically for Darwesh Group."
//
// Colored PER REGION, not one flat pool for the whole entity -- a point
// cloud has no shading or surface normals to separate "wall" from "roof"
// the way a real render would, so distinct color families are what makes
// the resolved structure actually read as a house (walls, roof, glowing
// windows, a chimney) instead of one undifferentiated golden blob.
const REGION_PALETTES = {
  0: { // walls -- warm ivory/cream, closest to the site's own text color
    warm: [{ hex: [0xf4, 0xef, 0xe7], weight: 0.5 }, { hex: [0xe0, 0xd4, 0xb8], weight: 0.3 }, { hex: [0xc6, 0x9a, 0x4b], weight: 0.2 }],
    cool: [{ hex: [0x9a, 0xa3, 0xd9], weight: 0.6 }, { hex: [0x7c, 0x86, 0xc9], weight: 0.4 }]
  },
  1: { // roof -- deeper bronze/gold, visually heavier than the walls below
    warm: [{ hex: [0xc6, 0x9a, 0x4b], weight: 0.45 }, { hex: [0x8e, 0x74, 0x48], weight: 0.35 }, { hex: [0xd4, 0xaf, 0x60], weight: 0.2 }],
    cool: [{ hex: [0x38, 0x40, 0x74], weight: 0.65 }, { hex: [0x24, 0x28, 0x4a], weight: 0.35 }]
  },
  2: { // windows -- near-white; the shader's own uWarmth boost pushes this brighter still
    warm: [{ hex: [0xf4, 0xef, 0xe7], weight: 1 }],
    cool: [{ hex: [0x9a, 0xa3, 0xd9], weight: 0.7 }, { hex: [0xd8, 0xb6, 0x67], weight: 0.3 }]
  },
  3: { // landscaping ring -- an earthy, muted olive-gold, never neon green
    warm: [{ hex: [0xb8, 0xa2, 0x5a], weight: 0.5 }, { hex: [0xc6, 0x9a, 0x4b], weight: 0.5 }],
    cool: [{ hex: [0x5b, 0x64, 0xa8], weight: 1 }]
  },
  4: { // chimney -- bronze, distinct from both walls and roof
    warm: [{ hex: [0x8e, 0x74, 0x48], weight: 1 }],
    cool: [{ hex: [0x4a, 0x55, 0x8f], weight: 1 }]
  },
  5: { // apex accent -- the brightest point, a focal highlight at the ridge
    warm: [{ hex: [0xf4, 0xef, 0xe7], weight: 1 }],
    cool: [{ hex: [0xd8, 0xb6, 0x67], weight: 1 }]
  }
};

function pickWeighted(list, rand) {
  const total = list.reduce((s, c) => s + c.weight, 0);
  let r = rand() * total;
  for (const c of list) { r -= c.weight; if (r <= 0) return c.hex; }
  return list[0].hex;
}

// ---- geometry --------------------------------------------------------
// The source cloud: a wide, organic, slightly flattened blob -- loose
// enough that the opening "Idea" beat reads as genuinely formless drifting
// dust, not a tight sphere waiting to snap into shape.
function sampleCloud(rand) {
  const u = rand(), v = rand();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const r = 1.55 + (rand() - 0.5) * 1.0;
  return [
    r * Math.sin(phi) * Math.cos(theta) * 1.05,
    r * Math.sin(phi) * Math.sin(theta) * 0.82,
    r * Math.cos(phi) * 1.05
  ];
}

// Door void: a real opening in the front wall (z near the front face),
// not a rectangle drawn in a different color -- particles simply never
// land here, so it reads as an entrance the same way an unlit gap in a
// dense field reads as an opening in the reference video's own compositions.
function inDoorVoid(x, y, z) {
  return z > 0.60 && Math.abs(x) < 0.16 && y > -0.76 && y < -0.14;
}

// One layered architectural volume -- foundation, four walls (with the
// door void carved out), a real pitched roof (two sloped faces, not a
// triangle outline), a chimney, two glowing window planes, an apex accent,
// and a landscaping ring scattered around the base. Weighted rejection
// sampling, same technique js/mam-entity-3d.js's sampleHumanoid() already
// uses for a real volumetric read rather than a wireframe.
function sampleHouse(rand) {
  const layer = rand();
  if (layer < 0.05) {
    // Apex accent -- a small bright cluster right at the roof ridge peak.
    const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * 0.05;
    return [Math.cos(a) * rr, 0.79 + rand() * 0.05, Math.sin(a) * rr * 0.6, 5];
  }
  if (layer < 0.09) {
    // Chimney -- a thin vertical volume poking above the roofline.
    return [0.55 + rand() * 0.17, 0.32 + rand() * 0.75, 0.14 + rand() * 0.16, 4];
  }
  if (layer < 0.19) {
    // Two window planes on the front wall -- a recessed glass plane, not a
    // void, so it can carry its own glow color independent of the walls.
    const leftSide = rand() < 0.5;
    const wx = leftSide ? (-0.76 + rand() * 0.38) : (0.38 + rand() * 0.38);
    const wy = -0.36 + rand() * 0.42;
    return [wx, wy, 0.655, 2];
  }
  if (layer < 0.49) {
    // Walls -- perimeter shell of the footprint, door void excluded.
    let x = 0, y = 0, z = 0;
    for (let tries = 0; tries < 6; tries++) {
      y = -0.76 + rand() * 0.92;
      const side = Math.floor(rand() * 4);
      const jitter = (rand() - 0.5) * 0.028;
      if (side === 0) { x = -1.0 + jitter; z = (rand() * 2 - 1) * 0.66; }
      else if (side === 1) { x = 1.0 + jitter; z = (rand() * 2 - 1) * 0.66; }
      else if (side === 2) { z = 0.66 + jitter; x = (rand() * 2 - 1) * 1.02; }
      else { z = -0.66 + jitter; x = (rand() * 2 - 1) * 1.02; }
      if (!inDoorVoid(x, y, z)) break;
    }
    return [x, y, z, 0];
  }
  if (layer < 0.76) {
    // Roof -- two real sloped faces meeting at a ridge, not an outline.
    const side = rand() < 0.5 ? 1 : -1;
    const xr = -1.10 + rand() * 2.20;
    const tt = rand();
    const y = 0.16 + tt * 0.62;
    const zEdge = side * 0.70 * (1 - tt);
    const jitter = (rand() - 0.5) * 0.02;
    return [xr, y + jitter, zEdge, 1];
  }
  if (layer < 0.84) {
    // Foundation slab -- the plinth the house sits on.
    return [-1.12 + rand() * 2.24, -0.86 + rand() * 0.07, -0.74 + rand() * 1.48, 0];
  }
  // Landscaping ring -- scattered around the footprint, an elliptical band.
  const a = rand() * Math.PI * 2;
  const rad = 1.28 + rand() * 0.95;
  return [Math.cos(a) * rad, -0.81 + rand() * 0.11, Math.sin(a) * rad * 0.66, 3];
}

// ---- scroll -> visual target math -----------------------------------
// Every property ramps over its own window of `progress`, staggered so
// the composition is always mid-transition somewhere -- the "one
// continuous scene evolving" requirement, not five discrete slides.
function deriveTargets(p) {
  const coherence = ramp(p, 0.05, 0.80);   // cloud -> house
  const warmth = ramp(p, 0.32, 0.95);      // cool dust -> Darwesh gold
  const jitterMul = 1 - 0.72 * ramp(p, 0.0, 0.85);
  const brightness = 0.68 + 0.62 * ramp(p, 0.10, 1.0);
  const size = 1.35 + 1.35 * ramp(p, 0.0, 0.85);
  const bloom = ramp(p, 0.90, 1.0) * 0.6;
  const radius = 7.6 - 4.7 * ramp(p, 0.06, 0.88);       // the camera-push
  const elevation = 0.24 - 0.11 * ramp(p, 0.45, 1.0);
  const azimuthSettle = 1 - ramp(p, 0.70, 1.0);         // arrives at an angle, settles frontal
  return { coherence, warmth, jitterMul, brightness, size, bloom, radius, elevation, azimuthSettle };
}

function buildParticleData(rand, count) {
  const positions = new Float32Array(count * 3);
  const targets = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const colorsCool = new Float32Array(count * 3);
  const colorsWarm = new Float32Array(count * 3);
  const regions = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const [cx, cy, cz] = sampleCloud(rand);
    positions[i * 3] = cx; positions[i * 3 + 1] = cy; positions[i * 3 + 2] = cz;
    const [hx, hy, hz, region] = sampleHouse(rand);
    targets[i * 3] = hx; targets[i * 3 + 1] = hy; targets[i * 3 + 2] = hz;
    regions[i] = region;
    seeds[i] = rand() * 1000;
    const palette = REGION_PALETTES[region] || REGION_PALETTES[0];
    const cool = pickWeighted(palette.cool, rand);
    const warm = pickWeighted(palette.warm, rand);
    colorsCool[i * 3] = cool[0] / 255; colorsCool[i * 3 + 1] = cool[1] / 255; colorsCool[i * 3 + 2] = cool[2] / 255;
    colorsWarm[i * 3] = warm[0] / 255; colorsWarm[i * 3 + 1] = warm[1] / 255; colorsWarm[i * 3 + 2] = warm[2] / 255;
  }
  return { positions, targets, seeds, colorsCool, colorsWarm, regions };
}

// =========================================================================
// Renderer A: Three.js (WebGL2)
// =========================================================================
async function createThreeScene({ mountEl, getProgress }) {
  const three = await import(/* webpackIgnore: true */ THREE_MODULE_URL);
  const canvas = document.createElement('canvas');
  canvas.className = 'ab-particle-canvas';
  mountEl.appendChild(canvas);

  const count = particleBudget();
  const rand = mulberry32(0xd4e5 ^ count);
  const { positions, targets, seeds, colorsCool, colorsWarm, regions } = buildParticleData(rand, count);

  const geometry = new three.BufferGeometry();
  geometry.setAttribute('position', new three.BufferAttribute(positions, 3));
  geometry.setAttribute('aTarget', new three.BufferAttribute(targets, 3));
  geometry.setAttribute('aSeed', new three.BufferAttribute(seeds, 1));
  geometry.setAttribute('aColorCool', new three.BufferAttribute(colorsCool, 3));
  geometry.setAttribute('aColorWarm', new three.BufferAttribute(colorsWarm, 3));
  geometry.setAttribute('aRegion', new three.BufferAttribute(regions, 1));

  const material = new three.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uCoherence: { value: 0 }, uJitter: { value: 1 },
      uSpeed: { value: 0.55 }, uWarmth: { value: 0 }, uBloom: { value: 0 },
      uSize: { value: 1.4 }, uBrightness: { value: 0.7 }
    },
    vertexShader: HOUSE_VERTEX_SHADER,
    fragmentShader: HOUSE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: three.AdditiveBlending
  });
  const points = new three.Points(geometry, material);

  const scene = new three.Scene();
  scene.add(points);

  // Sparse distant atmosphere field, same shader js/mam-entity-3d.js's own
  // background uses, for depth without competing with the house field.
  const bgCount = prefersReducedMotion() ? 70 : (window.innerWidth < 640 ? 100 : 300);
  const bgPositions = new Float32Array(bgCount * 3);
  const bgSeeds = new Float32Array(bgCount);
  const bgRand = mulberry32(0x5eed ^ bgCount);
  for (let i = 0; i < bgCount; i++) {
    const a = bgRand() * Math.PI * 2, rad = 3.8 + bgRand() * 9.5;
    bgPositions[i * 3] = Math.cos(a) * rad;
    bgPositions[i * 3 + 1] = (bgRand() - 0.5) * 7.5;
    bgPositions[i * 3 + 2] = Math.sin(a) * rad - 2.4;
    bgSeeds[i] = bgRand() * 1000;
  }
  const bgGeometry = new three.BufferGeometry();
  bgGeometry.setAttribute('position', new three.BufferAttribute(bgPositions, 3));
  bgGeometry.setAttribute('aSeed', new three.BufferAttribute(bgSeeds, 1));
  const bgMaterial = new three.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uParallax: { value: 0 } },
    vertexShader: BG_VERTEX_SHADER,
    fragmentShader: BG_FRAGMENT_SHADER,
    transparent: true, depthWrite: false, blending: three.AdditiveBlending
  });
  const bgPoints = new three.Points(bgGeometry, bgMaterial);
  scene.add(bgPoints);

  const camera = new three.PerspectiveCamera(42, 1, 0.1, 100);
  const renderer = new three.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.className = 'ab-particle-canvas';
  canvas.remove();
  mountEl.appendChild(renderer.domElement);

  function resize() {
    const w = Math.max(1, mountEl.clientWidth), h = Math.max(1, mountEl.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(mountEl);

  // Smoothed target state -- --pp itself already updates on a scroll rAF,
  // but a light extra exponential smoothing here keeps the camera and
  // color transition reading as fluid rather than stepped.
  const current = { coherence: 0, warmth: 0, jitterMul: 1, brightness: 0.68, size: 1.35, bloom: 0, radius: 7.6, elevation: 0.24, azimuthSettle: 1 };
  // A fixed base angle, not an accumulating drift -- a real-time-accumulated
  // azimuth would put the resolved house at an unpredictable angle depending
  // on how long a visitor dwelled before scrolling, sometimes swinging the
  // brightest (window) particles right behind the headline text. This is
  // "controlled composition changes", not a random spin: a gentle sway
  // while still forming, settling to the SAME frontal-ish angle every time.
  const BASE_AZIMUTH = 0.24;
  let ambientTime = 0;
  let raf = null;
  let lastT = performance.now();
  let destroyed = false;
  const reduced = prefersReducedMotion();

  function loop() {
    if (destroyed) return;
    if (document.hidden) { raf = requestAnimationFrame(loop); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    const p = clamp01(getProgress());
    const target = deriveTargets(p);
    const a = 1 - Math.exp(-6 * dt);
    Object.keys(target).forEach((k) => { current[k] += (target[k] - current[k]) * a; });

    const speed = reduced ? 0.16 : 0.55;
    material.uniforms.uTime.value += dt * speed;
    material.uniforms.uCoherence.value = current.coherence;
    material.uniforms.uJitter.value = (reduced ? 0.28 : 1.0) * current.jitterMul;
    material.uniforms.uSpeed.value = speed;
    material.uniforms.uWarmth.value = current.warmth;
    material.uniforms.uBloom.value = current.bloom;
    material.uniforms.uSize.value = current.size;
    material.uniforms.uBrightness.value = current.brightness;

    ambientTime += dt * (reduced ? 0.2 : 1);
    const sway = (reduced ? 0.05 : 0.22) * current.azimuthSettle * Math.sin(ambientTime * 0.15);
    const azimuth = BASE_AZIMUTH + sway;
    camera.position.set(
      current.radius * Math.sin(azimuth) * Math.cos(current.elevation),
      current.radius * Math.sin(current.elevation) + 0.12,
      current.radius * Math.cos(azimuth) * Math.cos(current.elevation)
    );
    // Aim slightly below the structure's own center so the house sits in
    // the upper frame, leaving the lower third clear for the copy below.
    camera.lookAt(0, -0.16, 0);

    bgPoints.material.uniforms.uTime.value += dt;
    bgPoints.rotation.y += dt * 0.003;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  lastT = performance.now();
  loop();

  return {
    destroy() {
      destroyed = true;
      if (raf != null) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    }
  };
}

// =========================================================================
// Renderer B: Canvas2D fallback (no WebGL2)
// =========================================================================
function createCanvas2DScene({ mountEl, getProgress }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ab-particle-canvas';
  mountEl.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const count = particleBudget();
  const rand = mulberry32(0x51a1 ^ count);
  const { positions, targets, seeds, colorsCool, colorsWarm, regions } = buildParticleData(rand, count);
  const n = seeds.length;

  let w = 0, h = 0, dpr = 1;
  function resize() {
    w = Math.max(1, mountEl.clientWidth); h = Math.max(1, mountEl.clientHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(mountEl);

  function curl(x, y, z, t) {
    const f = 1.5;
    return [-Math.cos(z * f + t), -Math.cos(x * f + t), -Math.cos(y * f + t)];
  }

  const current = { coherence: 0, warmth: 0, jitterMul: 1, brightness: 0.68, size: 1.35, bloom: 0 };
  let time = 0;
  let raf = null;
  let lastT = performance.now();
  let destroyed = false;
  const reduced = prefersReducedMotion();

  function loop() {
    if (destroyed) return;
    if (document.hidden) { raf = requestAnimationFrame(loop); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    const p = clamp01(getProgress());
    const target = deriveTargets(p);
    const a = 1 - Math.exp(-6 * dt);
    Object.keys(current).forEach((k) => { current[k] += ((target[k] !== undefined ? target[k] : current[k]) - current[k]) * a; });
    const speed = reduced ? 0.16 : 0.5;
    time += dt * speed;

    // Camera "push": scale grows with progress instead of moving a real
    // camera -- cheaper, and reads the same on a small mobile canvas.
    const scaleGrow = 0.62 + 0.5 * ramp(p, 0.0, 0.86);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.52;
    const scale = Math.min(w, h) * 0.30 * scaleGrow;
    const cameraZ = 4.4;

    const projected = [];
    for (let i = 0; i < n; i++) {
      const seed = seeds[i];
      const t = time + seed * 0.0062831;
      const bx0 = positions[i * 3], by0 = positions[i * 3 + 1], bz0 = positions[i * 3 + 2];
      const hx = targets[i * 3], hy = targets[i * 3 + 1], hz = targets[i * 3 + 2];
      const radiusMod = 1 + (0.10 * Math.sin(t * 0.55 + seed * 4) + 0.04 * Math.sin(t * 1.6 + seed * 9)) * (1 - current.coherence);
      const bx = bx0 * radiusMod, by = by0 * radiusMod, bz = bz0 * radiusMod;
      let x = bx + (hx - bx) * current.coherence;
      let y = by + (hy - by) * current.coherence;
      let z = bz + (hz - bz) * current.coherence;
      const [fx, fy, fz] = curl(x * 1.15, y * 1.15, z * 1.15, t);
      const amp = 0.13 * current.jitterMul * (1 - 0.78 * current.coherence);
      x += fx * amp; y += fy * amp; z += fz * amp;
      const len = Math.hypot(x, y, z) || 1;
      const bloomAmt = current.bloom * 0.2;
      x += (x / len) * bloomAmt; y += (y / len) * bloomAmt; z += (z / len) * bloomAmt;
      const persp = cameraZ / (cameraZ - z);
      const region = regions[i];
      const isWindow = region > 1.5 && region < 2.5;
      const windowBoost = isWindow ? (1 + current.warmth * 0.9) : 1;
      const size = Math.max(0.4, current.size * persp * (0.6 + 0.5 * ((seed * 91.7) % 1)) * windowBoost);
      const wCool = colorsCool.slice(i * 3, i * 3 + 3);
      const wWarm = colorsWarm.slice(i * 3, i * 3 + 3);
      let cr = wCool[0] + (wWarm[0] - wCool[0]) * current.warmth;
      let cg = wCool[1] + (wWarm[1] - wCool[1]) * current.warmth;
      let cb = wCool[2] + (wWarm[2] - wCool[2]) * current.warmth;
      if (isWindow) {
        cr += (1.0 - cr) * current.warmth * 0.65 * 0.6;
        cg += (0.83 - cg) * current.warmth * 0.65 * 0.6;
        cb += (0.56 - cb) * current.warmth * 0.65 * 0.6;
      }
      const alpha = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 2 + seed * 13))) * current.brightness;
      projected.push({ sx: cx + x * scale * persp, sy: cy + y * scale * persp, size, z, cr, cg, cb, alpha });
    }
    projected.sort((p1, p2) => p1.z - p2.z);
    for (const pt of projected) {
      const r = Math.round(pt.cr * 255), g = Math.round(pt.cg * 255), b = Math.round(pt.cb * 255);
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
  lastT = performance.now();
  loop();

  return {
    destroy() {
      destroyed = true;
      if (raf != null) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      canvas.remove();
    }
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
 * @param {Object} opts
 * @param {Element} opts.mountEl
 * @param {() => number} opts.getProgress Returns 0..1 every frame.
 * @returns {Promise<{destroy: Function}>}
 */
export async function createAboutParticleScene(opts) {
  if (!supportsWebGL2()) return createCanvas2DScene(opts);
  try {
    return await createThreeScene(opts);
  } catch (err) {
    console.warn('[about-particle-scene] Three.js unavailable, falling back to Canvas2D:', err && err.message);
    return createCanvas2DScene(opts);
  }
}
