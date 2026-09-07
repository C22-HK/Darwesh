// GLSL for the MAM AI Command Center's living particle entity
// (js/mam-entity-3d.js). Kept in its own file so the shader source reads
// as what it is -- a small program, not a JS template-string buried mid
// controller logic.
//
// Deliberately simple, hand-written noise (a handful of summed sines),
// not a ported Perlin/Simplex library: this only has to look alive at the
// scale of one on-screen entity, not hold up as a general-purpose noise
// primitive, and pulling in a whole noise library for that would be the
// same "install a dependency for something already sufficient" mistake
// the rest of this task was told to avoid for Three.js itself.

export const ENTITY_VERTEX_SHADER = `
attribute float aSeed;
attribute vec3 aColor;

uniform float uTime;
uniform float uGather;      // 0 = diffuse ambient cloud, 1 = tightly drawn in
uniform float uJitter;      // turbulence amplitude (THINKING dissolves, etc.)
uniform float uSpeed;       // overall time multiplier for this state
uniform float uEnergy;      // 0..1 live voice amplitude (mic or MAM's own TTS)
uniform float uPulse;       // 0..1 transient outward bloom (result-ready / wake)
uniform float uSize;

varying vec3 vColor;
varying float vAlpha;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// A cheap curl-noise-LIKE flow field: not a real curl of a scalar
// potential, just three phase-offset sine combinations that give a
// swirling, non-repeating look at entity scale -- see file header.
vec3 flowField(vec3 p, float t) {
  float x = sin(p.y * 1.7 + t) + sin(p.z * 1.3 - t * 0.7);
  float y = sin(p.z * 1.9 - t * 0.8) + sin(p.x * 1.4 + t * 0.6);
  float z = sin(p.x * 1.5 + t * 0.9) + sin(p.y * 1.2 - t * 0.5);
  return vec3(x, y, z);
}

void main() {
  float seed = aSeed;
  float t = uTime * uSpeed + seed * 6.2831;

  // An irregular, breathing shell -- never a perfect uniform sphere, which
  // reads as a technical diagram rather than a living thing (the same
  // lesson js/mam-companion.js's own halo already had to learn for its 2D
  // body). uGather pulls the whole shell inward, toward a denser core.
  float radiusMod = 1.0 + 0.12 * sin(t * 0.6 + seed * 4.0) + 0.05 * sin(t * 1.7 + seed * 9.0);
  float gathered = mix(1.0, 0.42, uGather);
  vec3 p = position * radiusMod * gathered;

  // The living part: displacement grows with uJitter (THINKING's internal
  // churn) and with live audio energy (LISTENING answers the mic,
  // SPEAKING answers MAM's own voice) -- silence genuinely looks still.
  vec3 flow = flowField(position * 1.3, t) * (0.16 * uJitter + 0.22 * uEnergy);
  p += flow;

  // A brief outward bloom for transient states (result-ready, the
  // awakening flash) -- radial, so it reads as the whole body lighting up
  // rather than one more turbulence term.
  p += normalize(position + 0.0001) * uPulse * 0.35;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float perspectiveSize = uSize * (300.0 / max(0.001, -mvPosition.z));
  gl_PointSize = perspectiveSize * (0.65 + 0.5 * hash(seed * 91.7));

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
  float glow = pow(smoothstep(0.5, 0.0, d), 1.6);
  gl_FragColor = vec4(vColor * uBrightness, glow * vAlpha);
}
`;
