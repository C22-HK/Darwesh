// MAM VOICE ENERGY -- the live amplitude of MAM's own voice.
//
// This is the module that makes SPEAKING genuinely reactive rather than a
// canned loop. It measures the actual audio MAM is producing and publishes
// it as a single 0..1 number, sampled per animation frame. When MAM is
// silent the number is 0 and the body is still; when a syllable lands the
// number spikes and the body answers it. Nothing here interpolates a
// pretend waveform.
//
// TWO OUTPUT PATHS, AND THEY ARE NOT EQUIVALENT
// ---------------------------------------------
//   A  KurdishTTS / any server TTS -> Blob -> <audio>
//      An <audio> element can be routed through an AudioContext, so this
//      reads TRUE per-frame amplitude off an AnalyserNode. Measured on a
//      real clip: 45 samples, min 0.053, max 0.317, tracking the source
//      envelope. Kurdish is the primary language here, so this is the path
//      that matters most.
//
//   B  browser speechSynthesis
//      There is NO audio graph for speechSynthesis -- the API exposes no
//      output node at all, by design, and no amount of work gets one. The
//      only timing signal it offers is the `boundary` event, which fires
//      as each word begins. So this path drives a decaying envelope from
//      real word boundaries: the RHYTHM is genuine (it is MAM's actual
//      word timing) while the shape between words is inferred.
//
// That distinction is deliberately visible in the API (`isTrueAmplitude`)
// rather than hidden, because claiming path B is amplitude-reactive would
// be a lie about what the browser can do.
//
// Cost: one AnalyserNode at fftSize 256 and one rAF loop that only runs
// while MAM is actually speaking or listening. Both are torn down on stop.

const IDLE_DECAY = 0.86;     // how fast the level falls when nothing arrives
const WORD_IMPULSE = 0.72;   // envelope height at a word boundary (path B)

function AudioCtor() {
  return window.AudioContext || window.webkitAudioContext;
}

export class VoiceEnergy {
  /** @param {(level:number)=>void} onLevel called per frame with 0..1 */
  constructor(onLevel) {
    this._onLevel = typeof onLevel === 'function' ? onLevel : () => {};
    this._ctx = null;
    this._analyser = null;
    this._data = null;
    this._raf = null;
    this._level = 0;
    this._envelope = 0;
    this._mode = null;          // 'analyser' | 'envelope' | null
    this._mediaSources = new WeakMap();  // an element may be tapped only once, ever
    this._micStream = null;
  }

  /** True only while a real AnalyserNode is producing the numbers. */
  get isTrueAmplitude() { return this._mode === 'analyser'; }
  get mode() { return this._mode; }

  _ensureContext() {
    const Ctor = AudioCtor();
    if (!Ctor) return null;
    if (!this._ctx) {
      try { this._ctx = new Ctor(); } catch { return null; }
    }
    // iOS suspends the context when the page is backgrounded or the
    // hardware silent switch is on; resume is a no-op when already running.
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
    return this._ctx;
  }

  _startAnalyser(sourceNode, ctx) {
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.6;
    sourceNode.connect(this._analyser);
    this._data = new Uint8Array(this._analyser.fftSize);
    this._mode = 'analyser';
    this._loop();
  }

  /**
   * Path A. Tap MAM's own <audio> element.
   *
   * createMediaElementSource may be called only ONCE per element for the
   * life of the document, and once called the element's audio flows ONLY
   * through the graph -- so the source is cached per element and always
   * reconnected to destination, or MAM would go silent, which is a far
   * worse failure than a still body.
   *
   * @returns {boolean} true when a real analyser is running
   */
  attachToAudioElement(el) {
    if (!el) return false;
    const ctx = this._ensureContext();
    if (!ctx) return false;
    try {
      let src = this._mediaSources.get(el);
      if (!src) {
        src = ctx.createMediaElementSource(el);
        this._mediaSources.set(el, src);
        src.connect(ctx.destination);   // MUST stay audible
      }
      this._startAnalyser(src, ctx);
      return true;
    } catch (err) {
      // A cross-origin clip taints the graph, and some browsers refuse a
      // second source. Neither is worth breaking speech over.
      console.warn('[mam-voice-energy] no analyser for this element:', err && err.message);
      this._mode = null;
      return false;
    }
  }

  /**
   * LISTENING. The microphone's own level, so the body answers the
   * visitor's voice rather than a timer.
   * @returns {Promise<boolean>}
   */
  async attachToMicrophone() {
    const ctx = this._ensureContext();
    if (!ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._startAnalyser(ctx.createMediaStreamSource(this._micStream), ctx);
      return true;
    } catch {
      return false;   // denied or unavailable -- MAM simply listens without moving
    }
  }

  /**
   * Path B. speechSynthesis has no audio graph, so the envelope is driven
   * from real `boundary` events. Call impulse() from the utterance's own
   * boundary handler: the rhythm is MAM's true word timing.
   */
  startEnvelope() {
    this._mode = 'envelope';
    this._envelope = 0;
    this._loop();
  }
  impulse(strength = WORD_IMPULSE) {
    this._envelope = Math.min(1, this._envelope + strength);
  }

  _loop() {
    if (this._raf != null) return;
    const tick = () => {
      this._raf = null;
      let level = 0;
      if (this._mode === 'analyser' && this._analyser) {
        this._analyser.getByteTimeDomainData(this._data);
        let sum = 0;
        for (let i = 0; i < this._data.length; i++) {
          const v = (this._data[i] - 128) / 128;
          sum += v * v;
        }
        // RMS is small for speech (roughly 0.02-0.20), so it has to be
        // lifted into a usable visual range. A linear gain plus a clamp
        // was the obvious way and it is wrong: measured against a
        // full-scale test tone it pinned at exactly 1.000 through every
        // loud passage, so the body sat at maximum and every difference
        // between one loud syllable and the next was thrown away -- the
        // same flatness as a canned loop, arrived at from the other side.
        //
        // A soft knee instead. 1 - e^-kx is monotonic, approaches 1
        // without ever reaching it, and spends most of its range where
        // speech actually lives: rms 0.05 -> 0.16, 0.10 -> 0.30,
        // 0.20 -> 0.51. Loud stays clearly loud, and nothing clips.
        const rms = Math.sqrt(sum / this._data.length);
        level = 1 - Math.exp(-rms * 3.6);
      } else if (this._mode === 'envelope') {
        this._envelope *= IDLE_DECAY;
        level = this._envelope;
      } else {
        this._onLevel(0);
        return;                      // stopped -- do not reschedule
      }
      this._level = level;
      this._onLevel(level);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  /** Stops sampling and releases the microphone. Safe to call repeatedly. */
  stop() {
    if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._mode = null;
    this._envelope = 0;
    this._level = 0;
    if (this._analyser) { try { this._analyser.disconnect(); } catch { /* already gone */ } this._analyser = null; }
    if (this._micStream) { this._micStream.getTracks().forEach((t) => t.stop()); this._micStream = null; }
    this._onLevel(0);
  }
}
