// GLSL for the About page's hero -- a volumetric particle field that
// coalesces from a formless drifting cloud into a real, dimensional house
// (walls, a pitched roof, a chimney, glowing windows, a door void,
// landscaping around the base) as the visitor scrolls, then blooms warm
// gold. Built on the SAME technique as js/mam-entity-shaders.js (analytic
// curl noise for organic drift, two real particle-position attributes
// blended per-vertex by a single coherence uniform) -- deliberately not a
// copy-paste, since this entity has no voice/energy/guide concepts and
// instead needs a COLOR transition (cool dust -> Darwesh gold) the MAM
// entity never does, so its own shader pair lives here rather than trying
// to overload the other file's uniform set.
export const HOUSE_VERTEX_SHADER = `
attribute float aSeed;
attribute vec3 aColorCool;
attribute vec3 aColorWarm;
attribute vec3 aTarget;
attribute float aRegion; // 0 wall, 1 roof, 2 window, 3 ground/landscape, 4 chimney, 5 apex accent

uniform float uTime;
uniform float uCoherence; // 0 = formless cloud .. 1 = the house, fully resolved
uniform float uJitter;
uniform float uSpeed;
uniform float uWarmth;    // 0 = cool blueprint dust .. 1 = Darwesh gold, lit
uniform float uBloom;     // 0..1, the Together finale's outward pulse
uniform float uSize;

varying vec3 vColor;
varying float vAlpha;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// Analytic curl of a hand-written vector potential -- divergence-free by
// construction, the same construction js/mam-entity-shaders.js uses (see
// that file's header for why this reads as fluid/organic rather than a
// sum-of-sines approximation).
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

  // A gentle per-particle breathing modulation on the CLOUD position only
  // -- once coherence pulls a particle toward its house target this fades
  // out, so the resolved structure never wobbles.
  float radiusMod = 1.0 + (0.10 * sin(t * 0.55 + seed * 4.0) + 0.04 * sin(t * 1.6 + seed * 9.0)) * (1.0 - uCoherence);
  vec3 cloudPos = position * radiusMod;
  vec3 basePos = mix(cloudPos, aTarget, uCoherence);

  // Curl-flow drift -- strong while the cloud is still formless, damped as
  // the structure resolves so the finished house reads as intentional,
  // not still boiling.
  vec3 flow = curlNoise(basePos * 1.15, t) * (0.13 * uJitter) * mix(1.0, 0.09, uCoherence);
  vec3 p = basePos + flow;

  // The Together finale: a brief radial bloom, the whole composition
  // lighting up at once rather than one more turbulence term.
  p += normalize(basePos + 0.0001) * uBloom * 0.20;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Screen-pixel-size target (see mam-entity-shaders.js's own comment on
  // this exact constant) -- keeps thousands of points reading as
  // individually visible grains instead of fusing into a blob.
  float perspectiveSize = uSize * (9.0 / max(0.001, -mvPosition.z));
  float twinkle = 0.65 + 0.35 * sin(t * 3.0 + seed * 17.0);
  // Windows (region 2) grow and brighten as warmth arrives -- the
  // moment the lights come on, not a size/color trick applied uniformly.
  bool isWindow = aRegion > 1.5 && aRegion < 2.5;
  float windowBoost = isWindow ? (1.0 + uWarmth * 0.9) : 1.0;
  gl_PointSize = perspectiveSize * (0.6 + 0.5 * hash(seed * 91.7)) * twinkle * windowBoost;

  vColor = mix(aColorCool, aColorWarm, uWarmth);
  if (isWindow) {
    vColor = mix(vColor, vec3(1.0, 0.83, 0.56), uWarmth * 0.65);
  }
  vAlpha = 0.35 + 0.65 * (0.5 + 0.5 * sin(t * 2.0 + seed * 13.0));
}
`;

export const HOUSE_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
uniform float uBrightness;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.5) discard;
  float glow = pow(smoothstep(0.5, 0.0, d), 2.2);
  gl_FragColor = vec4(vColor * uBrightness, glow * vAlpha);
}
`;
