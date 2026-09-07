// GLSL for the MAM AI Command Center's living particle entity
// (js/mam-entity-3d.js) -- V2. Kept in its own file so the shader source
// reads as what it is, a small program, not a JS template-string buried
// mid controller logic.
//
// Two things V1 approximated that V2 does for real:
//
// 1. CURL NOISE, not a sum of sines pretending to be one. A vector FIELD
//    built as the analytic curl (∇×) of a hand-written vector potential is
//    divergence-free BY CONSTRUCTION -- exactly the "fluid, incompressible,
//    swirling" look curl noise is used for, and cheap (a handful of cosines,
//    no permutation-table gradient noise). Two octaves (base + a smaller,
//    faster detail layer) for the fractal-curl look real curl-noise fields
//    have, rather than one flat frequency.
// 2. A REAL SECOND SHAPE, not a size/color trick. Every particle carries
//    TWO base positions -- `position` (the free-form cloud, generated once
//    in JS) and `aHumanoid` (a rough head/neck/shoulders volume, also
//    generated once in JS, same particle count) -- and `uCoherence`
//    mixes between them per-vertex. At uCoherence=0 the entity is a
//    diffuse cloud; near 1 the SAME particles have gathered into a
//    head-and-shoulders suggestion, continuously, because it's the real
//    particle positions moving, not a model swap.

export const ENTITY_VERTEX_SHADER = `
attribute float aSeed;
attribute vec3 aColor;
attribute vec3 aHumanoid;

uniform float uTime;
uniform float uGather;       // 0 = spread out .. 1 = drawn in toward center
uniform float uCoherence;    // 0 = formless cloud .. 1 = humanoid suggestion
uniform float uJitter;       // curl-flow amplitude (THINKING's inner churn, etc.)
uniform float uSpeed;        // overall time multiplier for this state
uniform float uEnergy;       // 0..1 live voice amplitude (mic or MAM's own TTS)
uniform float uPulse;        // 0..1 transient outward bloom (result-ready / wake)
uniform float uGuideBias;    // 0..1 -- GUIDING's directional arc-flow toward an action
uniform vec3 uGuideDir;      // unit vector the guide bias flows toward
uniform float uSize;

varying vec3 vColor;
varying float vAlpha;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// ---- curl noise: analytic curl of a hand-written vector potential -------
// psi = (sin(p.y*f+t), sin(p.z*f+t), sin(p.x*f+t))
// curl(psi) = ( -cos(p.z*f+t)*f, -cos(p.x*f+t)*f, -cos(p.y*f+t)*f )
// True curl of a real potential -> divergence-free by construction, not an
// approximation. Two octaves summed (different freq/amp/phase) for a
// fractal, non-repeating swirl instead of one flat frequency.
vec3 curl(vec3 p, float t, float freq, float phase) {
  float f = freq;
  return vec3(
    -cos(p.z * f + t + phase) * f,
    -cos(p.x * f + t + phase * 1.3) * f,
    -cos(p.y * f + t + phase * 0.7) * f
  );
}
vec3 curlNoise(vec3 p, float t) {
  vec3 c0 = curl(p, t, 1.6, 0.0);
  vec3 c1 = curl(p * 2.3 + 11.0, t * 1.4, 0.9, 4.7) * 0.4;
  return c0 + c1;
}

void main() {
  float seed = aSeed;
  float t = uTime * uSpeed + seed * 6.2831;

  // Two real shapes, one continuous blend -- see file header. A gentle
  // per-particle breathing modulation keeps the cloud shape from reading
  // as a static mathematical sphere even at low coherence.
  float radiusMod = 1.0 + 0.12 * sin(t * 0.6 + seed * 4.0) + 0.05 * sin(t * 1.7 + seed * 9.0);
  vec3 cloudPos = position * radiusMod;
  vec3 basePos = mix(cloudPos, aHumanoid, uCoherence);
  vec3 p = basePos * mix(1.0, 0.42, uGather);

  // The living part: curl-flow displacement grows with uJitter (THINKING's
  // internal churn) and with live audio energy (LISTENING answers the
  // mic, SPEAKING answers MAM's own voice) -- silence genuinely looks
  // still. Higher coherence damps the flow slightly so the humanoid
  // suggestion reads as gathered/intentional rather than still boiling.
  vec3 flow = curlNoise(basePos * 1.3, t) * (0.16 * uJitter + 0.24 * uEnergy) * mix(1.0, 0.55, uCoherence);
  p += flow;

  // GUIDING's directional stream -- particles drift toward the action
  // being performed along a shallow arc (never a straight rigid line;
  // the same curl term still runs underneath), a sparing nod to
  // architectural arch/bridge geometry rather than a literal logo trace.
  if (uGuideBias > 0.0001) {
    float along = dot(normalize(p + 0.0001), uGuideDir);
    float arc = sin(seed * 3.0 + t * 0.8) * 0.18;
    p += uGuideDir * uGuideBias * (0.5 + 0.5 * along) * 0.6;
    p += vec3(-uGuideDir.z, uGuideDir.y, uGuideDir.x) * arc * uGuideBias;
  }

  // A brief outward bloom for transient states (result-ready, the
  // awakening flash) -- radial, so it reads as the whole body lighting up
  // rather than one more turbulence term.
  p += normalize(basePos + 0.0001) * uPulse * 0.35;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // The constant here is a screen-pixel target size, not a free
  // aesthetic knob: at this rig's camera distance (~4 units) a value
  // anywhere near the old 300 makes every point ~150px across, so a
  // 6-9k-particle field is thousands of heavily overlapping soft discs
  // -- which additive blending then sums into a solid white sphere, not
  // a field of individually visible grains. 9.0 keeps a typical point a
  // few pixels wide, so the gaps between particles that actually make
  // "thousands of individually visible particles" true stay visible.
  float perspectiveSize = uSize * (9.0 / max(0.001, -mvPosition.z));
  // A slight per-particle twinkle in size (not just position) is what
  // keeps a dense field reading as thousands of individual points rather
  // than fusing into a soft blob once particle count goes up.
  float twinkle = 0.65 + 0.35 * sin(t * 3.1 + seed * 17.0);
  gl_PointSize = perspectiveSize * (0.6 + 0.5 * hash(seed * 91.7)) * twinkle;

  vColor = aColor;
  vAlpha = 0.35 + 0.65 * (0.5 + 0.5 * sin(t * 2.0 + seed * 13.0));
}
`;

export const ENTITY_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
uniform float uBrightness;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.5) discard;
  // A tighter falloff than a plain smoothstep glow -- keeps each point
  // reading as a small bright grain with a soft edge, not a fuzzy orb,
  // which is what "individually visible particles" actually requires at
  // the fragment level, not just at the point-count level.
  float glow = pow(smoothstep(0.5, 0.0, d), 2.2);
  gl_FragColor = vec4(vColor * uBrightness, glow * vAlpha);
}
`;

// ---- background environment: sparse, distant, parallaxing -- NOT the
// entity's own field. Deliberately a simpler shader (no curl, no
// coherence, no color ramp beyond a single dim warm tone) so it never
// competes with MAM's own much denser field for attention.
export const BG_VERTEX_SHADER = `
attribute float aSeed;
uniform float uTime;
uniform float uParallax; // 0..1, driven by pointer position for a subtle depth cue
void main() {
  vec3 p = position;
  float t = uTime * 0.03 + aSeed * 6.2831;
  p.x += sin(t + aSeed * 3.0) * 0.15;
  p.y += cos(t * 0.8 + aSeed * 2.0) * 0.15;
  p.xy += uParallax * position.z * 0.04;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // Same screen-pixel-size fix as the entity's own field (see
  // ENTITY_VERTEX_SHADER's comment on this) -- small and sparse, never
  // competing with the entity for size or attention.
  gl_PointSize = (4.0 / max(0.001, -mv.z)) * (0.4 + 0.6 * fract(aSeed * 91.7));
}
`;
export const BG_FRAGMENT_SHADER = `
precision mediump float;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.5) discard;
  float glow = pow(smoothstep(0.5, 0.0, d), 2.0);
  gl_FragColor = vec4(vec3(0.62, 0.52, 0.38), glow * 0.35);
}
`;
