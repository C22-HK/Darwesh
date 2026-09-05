// MAM site-wide chat panel -- the ONE local, non-navigating conversation
// surface, mounted by js/mam-companion-launcher.js next to the shared
// compact dock (js/mam-dock.js, which carries the orb from
// js/mam-companion.js) on EVERY public page, map.html included. This
// panel and the compact dock are two states of ONE surface: opening it
// MORPHS the dock into the conversation, anchored to wherever the dock
// currently is (see computeAnchoredPosition() below), and closing it
// shrinks back to exactly that spot -- never a detached panel that pops
// up somewhere unrelated to where the visitor tapped.
//
// map.html used to be the exception: it ran its own parallel
// implementation (the removed js/mam-properties-map.js) with its own
// session id, its own bubbles, its own voice handling and its own orb.
// That meant a conversation started on the home page did not exist on the
// map and vice versa, two different voice implementations behaved
// differently, and the map showed two MAM identities at once. There is
// now one module, one session, one transcript and one voice state machine
// for the whole site; a page contributes structured context and nothing
// else. This module never implements
// a second AI backend: every reply comes from the exact same endpoint
// js/mam-api.js already calls (POST /api/v1/mam/chat), and every action
// this panel performs is dispatched through a small, explicit allowlist
// (see `dispatchSuggestedAction`) that only ever navigates to a real,
// existing page with a real id -- never eval(), never a model-generated
// selector, never an arbitrary URL.
//
// Like every other MAM surface in this codebase, rendering never inserts
// backend/model text as HTML -- every dynamic value reaches the DOM via
// textContent/element properties.
import { auth } from './firebase-init.js';
import { sendMamChat, BackendUnavailableError, BackendResponseError, fetchMamVoiceConfig, mamVoiceStt, mamVoiceTts } from './mam-api.js';
import { detectDirectCommand, resolvePage, filtersToMapUrlParams } from './mam-actions.js';

// Below this width the panel gives up trying to sit beside the dock and
// becomes a near-full-width sheet instead -- there simply is not enough
// room on a phone for "360px wide, anchored to one edge" to mean
// anything. It keeps the SAME vertical anchor logic as wide viewports
// (still grows from wherever the dock is, up or down), so it is still
// the dock expanding in place, just full-width while it does it.
const NARROW_VIEWPORT_PX = 480;
const PANEL_MARGIN_PX = 12;
const PANEL_WIDTH_PX = 360;
const PANEL_MAX_HEIGHT_PX = 560;
// How far the grab handle must be dragged down before a release counts as
// "collapse" rather than "snap back" -- see the grab-handle block below.
const COLLAPSE_DRAG_PX = 70;

// Inline SVG for every icon this panel's own chrome needs. Never
// `material-symbols-outlined`: that glyph only exists once the Material
// Symbols webfont has actually loaded, and a blocked/slow CDN (or, on the
// map's own filter bar, exactly the same font) renders the literal
// fallback text ("close", "mic", "send"...) instead of an icon. These
// controls are core to using MAM at all, so they never depend on a
// webfont loading in the first place.
const ICON_CLOSE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_MIC_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';
const ICON_SEND_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>';
const ICON_VOLUME_ON_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_VOLUME_OFF_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6"/><path d="m17 9 6 6"/></svg>';

const MAX_MESSAGE_LENGTH = 1000;
const SESSION_KEY = 'darwesh_mam_companion_session_id';
// Shared with the map's MAM dock voice-output toggle -- the same on/off
// preference should follow the user across the legacy MAM chat and this
// panel rather than resetting per surface.
const VOICE_OUTPUT_KEY = 'darwesh_mamai_voice_output';

// Professional service-provider profile pages this frontend actually
// has -- the only real destinations an `open_professional` suggested
// action can ever resolve to. This is now the single source of that
// mapping: the map's own copy went with js/mam-properties-map.js, so
// there is one place that decides where a serviceType's profile lives.
const PROFESSIONAL_PAGES = { engineer: 'engineer.html', designer: 'designer.html', lawyer: 'lawyer.html', landscaping: 'landscaping.html', cleaning: 'cleaning.html' };

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  let s = tr(key, fallback);
  if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
  return s;
}
function currentLangFactory(getLanguage) { return typeof getLanguage === 'function' ? getLanguage : () => (localStorage.getItem('darwesh_lang') || 'en'); }
function fmtPrice(p, currency) {
  if (typeof p !== 'number' || Number.isNaN(p)) return null;
  const symbol = currency === 'IQD' ? 'IQD ' : '$';
  return symbol + Math.round(p).toLocaleString();
}
function getSessionId() { return sessionStorage.getItem(SESSION_KEY) || ''; }
function setSessionId(id) { if (id) sessionStorage.setItem(SESSION_KEY, id); }

// ---- Conversation carried across page navigation ----------------------
// The session id already survived a navigation, so the BACKEND kept the
// history -- but the panel was rebuilt empty on every page, so the
// conversation looked lost even though MAM still remembered it. Asking a
// follow-up ("what about the second one?") worked while showing no trace
// of what it referred to.
//
// sessionStorage, deliberately, not localStorage: the conversation belongs
// to this tab and this visit, and should not reappear days later or in
// another tab -- which matches where the session id itself lives.
//
// Only what is needed to redraw a turn is stored: the text and any
// reference cards. No map action is kept, because replaying one on a later
// page would silently re-filter a map the visitor never asked to change.
const TRANSCRIPT_KEY = 'darwesh_mam_companion_transcript';
const TRANSCRIPT_MAX_TURNS = 24;

function readTranscript() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TRANSCRIPT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }   // corrupt or storage disabled -- start clean
}
function recordTurn(turn) {
  try {
    const turns = readTranscript();
    turns.push(turn);
    sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(turns.slice(-TRANSCRIPT_MAX_TURNS)));
  } catch { /* private mode or quota -- the conversation still works, it just won't carry over */ }
}
/** Drops the carried conversation AND the session id, so the next message starts fresh. */
export function clearMamConversation() {
  try { sessionStorage.removeItem(TRANSCRIPT_KEY); sessionStorage.removeItem(SESSION_KEY); } catch { /* nothing to clear */ }
}

// A suggested action is only ever rendered as a real link this frontend
// already knows how to serve -- an action type/payload this build can't
// resolve to a genuine, existing destination is silently skipped rather
// than becoming a dead '#' link or, worse, an arbitrary navigation. This
// is the explicit allowlist: five action names, all taken from
// backend/app/mam/schemas.py's own SuggestedAction.action contract --
// nothing invented client-side.
function resolveActionHref(a) {
  if (a.action === 'open_map') return 'map.html';
  if (a.action === 'open_listing' && a.payload && a.payload.listingId) {
    return 'listing.html?id=' + encodeURIComponent(a.payload.listingId);
  }
  if (a.action === 'open_professional' && a.payload && a.payload.professionalId) {
    const page = PROFESSIONAL_PAGES[a.payload.serviceType];
    return page ? page + '?id=' + encodeURIComponent(a.payload.professionalId) : null;
  }
  if (a.action === 'open_url' && a.payload && typeof a.payload.url === 'string') {
    // Same-origin, relative destinations only -- never an absolute/
    // external URL a model could fabricate.
    if (/^https?:\/\//i.test(a.payload.url) || a.payload.url.startsWith('//')) return null;
    return a.payload.url;
  }
  // 'save_property': no client-side save action is wired to MAM yet --
  // deliberately unresolved (never a fabricated capability) rather than
  // silently no-oping on a real button.
  return null;
}

// Voice mode is an INTENT that outlives a page, even though the
// microphone stream cannot. A full document navigation destroys the
// MediaStream and the SpeechRecognition object with the document; nothing
// can carry those across. What survives here is only the fact that the
// visitor had voice mode on, so the next page can offer to resume it --
// see the resume handling at the end of the voice block, and section J of
// the requirements.
const VOICE_INTENT_KEY = 'darwesh_mam_voice_intent';

// One MAM per page, enforced rather than assumed. Two launchers would
// mean two conversations, two recognition instances competing for one
// microphone, and two voices reading the same reply.
let mounted = false;
export function isMamMounted() { return mounted; }

/**
 * @param {Object} opts
 * @param {Element} opts.orbEl The orb itself -- this module wires its
 *   click/keyboard activation to open/toggle the panel; the caller
 *   never has to do that itself.
 * @param {Element} [opts.dockEl] The compact dock's OWN root element
 *   (js/mam-dock.js's `root`). Its live position is what the panel
 *   anchors to and morphs from/to on every open and close -- without it
 *   the panel falls back to a fixed centred position, which is only ever
 *   used defensively (every real caller passes this).
 * @param {Element[]} [opts.micEls] Extra mic buttons outside the panel
 *   (the dock's) to drive from the SAME voice state as the panel's own.
 * @param {import('./mam-companion.js').MamCompanion} opts.companion
 * @param {() => string} [opts.getLanguage]
 * @param {(state: {handsFree: boolean, listening: boolean, wakeEnabled: boolean, wakeListening: boolean}) => void} [opts.onVoiceUi]
 * @param {(text: string|null) => void} [opts.onResumeHint]
 * @param {(isOpen: boolean) => void} [opts.onOpenState] Told whenever the
 *   overlay opens/closes, so the caller can collapse the compact dock
 *   while the expanded state is on screen.
 * @param {Object} opts.pageContext Structured, ID-only context (never
 *   scraped DOM) -- same shape as backend/app/mam/schemas.py's
 *   PageContext: {page, listingId?, projectId?, professionalId?, serviceType?}.
 */
export function mountMamChatPanel({ orbEl, dockEl, micEls = [], companion, getLanguage, pageContext, onVoiceUi, onResumeHint, onOpenState }) {
  if (mounted) {
    console.warn('[mam-chat-panel] already mounted on this page -- ignoring the second mount');
    return null;
  }
  mounted = true;
  const currentLang = currentLangFactory(getLanguage);
  ensureStylesheet();

  // ---- KurdishTTS Sorani voice capability -------------------------------
  // Probed ONCE per page load, best-effort, never blocking anything --
  // both STT and TTS stay off (kurdishVoice.*Available === false) until
  // this resolves, and MAM's text chat and non-Sorani voice work exactly
  // as before regardless of the outcome. No key is ever involved here:
  // this only asks the backend which capabilities IT has configured (see
  // backend/app/mam/voice.py's GET /api/v1/mam/voice/config).
  const kurdishVoice = { sttAvailable: false, ttsAvailable: false };
  fetchMamVoiceConfig().then((cfg) => { kurdishVoice.sttAvailable = cfg.sttAvailable; kurdishVoice.ttsAvailable = cfg.ttsAvailable; });
  function soraniVoiceActive() { return currentLang() === 'ku'; }

  // ---- one authoritative voice state machine (section 3) -----------------
  // Lives at THIS outer scope, not inside the SpeechRecognition block
  // further down, because showThinking()/speak() run for every turn --
  // typed or spoken -- and need to update it regardless of whether this
  // browser even has SpeechRecognition at all. Every place that used to
  // call companion.setState(...) for a voice-related moment now goes
  // through setVoiceState() instead, so there is exactly ONE place that
  // decides what the visible state is and what side effects (starting/
  // stopping the barge-in watch) a transition triggers.
  const VOICE_STATES = ['IDLE', 'WAKE_LISTENING', 'LISTENING', 'PROCESSING', 'SPEAKING', 'INTERRUPTED', 'ERROR'];
  const VOICE_STATE_TO_COMPANION = {
    IDLE: 'idle', WAKE_LISTENING: 'wake-listening', LISTENING: 'listening',
    PROCESSING: 'thinking', SPEAKING: 'speaking', INTERRUPTED: 'listening', ERROR: 'error'
  };
  let voiceState = 'IDLE';
  // Shared with the SpeechRecognition block below, which is the only
  // thing that ever sets this true -- an active, multi-turn conversation
  // loop is running. Declared here (not there) for the same reason as
  // the state machine itself: setVoiceState needs to read it regardless
  // of whether recognition exists.
  let handsFree = false;
  // handleBargeIn genuinely needs startListening(), which only exists
  // once SpeechRecognition is confirmed to exist -- starts as a no-op
  // and is given its real body further down. On a browser without
  // SpeechRecognition, handsFree can never become true (nothing ever
  // sets it), so startBargeInWatch below never runs for lack of a caller
  // with handsFree=true, and this placeholder is never invoked either.
  let handleBargeIn = () => {};

  function setVoiceState(next) {
    if (!VOICE_STATES.includes(next)) return;
    const prev = voiceState;
    voiceState = next;
    companion.setState(VOICE_STATE_TO_COMPANION[next]);
    // Only on an ACTUAL transition into/out of SPEAKING -- not on a
    // same-state re-call -- so a second speak() while already SPEAKING
    // (e.g. a KurdishTTS failure falling back to the browser voice
    // within the same turn) never opens a second barge-in mic tap.
    if (next === 'SPEAKING' && prev !== 'SPEAKING' && handsFree) {
      startBargeInWatch(() => handleBargeIn());
    } else if (prev === 'SPEAKING' && next !== 'SPEAKING') {
      stopBargeInWatch();
    }
  }

  // ---- barge-in / interruption (section 8) --------------------------
  // A SEPARATE, minimal microphone tap -- never a second SpeechRecognition
  // or STT session -- that only ever runs while voiceState is SPEAKING.
  // It looks at raw volume (RMS), not content: a sustained loud stretch
  // is treated as "the visitor started talking over MAM", a single spike
  // (a click, a cough) is not. This is a real, physical limitation on a
  // device without echo cancellation between its own speakers and mic:
  // the guard delay + sustain requirement below reduce false triggers
  // from MAM's own voice bleeding back in, but cannot eliminate the
  // possibility on every device -- see startBargeInWatch's own comment.
  // Any environment missing AudioContext/getUserMedia simply never
  // starts this at all; barge-in is an enhancement, never a requirement
  // for the base conversation loop to work.
  const BARGE_IN_RMS_THRESHOLD = 0.06;
  const BARGE_IN_SUSTAIN_MS = 350;   // must stay loud this long -- rejects a single spike
  const BARGE_IN_GUARD_MS = 450;     // ignored window right after TTS starts -- its own onset is the likeliest false-positive moment
  let bargeInStream = null;
  let bargeInAudioCtx = null;
  let bargeInAnalyser = null;
  let bargeInRAF = null;

  function bargeInSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      !!(window.AudioContext || window.webkitAudioContext);
  }

  async function startBargeInWatch(onInterrupt) {
    if (!bargeInSupported() || bargeInStream) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return; // no permission / no device for this second consumer -- MAM just finishes speaking normally, uninterruptible
    }
    // The SPEAKING turn may have already ended (a fast reply) by the
    // time permission resolves -- don't open a mic for a watch nobody
    // needs any more.
    if (voiceState !== 'SPEAKING') { stream.getTracks().forEach((t) => t.stop()); return; }
    bargeInStream = stream;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      bargeInAudioCtx = new Ctor();
      const source = bargeInAudioCtx.createMediaStreamSource(bargeInStream);
      bargeInAnalyser = bargeInAudioCtx.createAnalyser();
      bargeInAnalyser.fftSize = 512;
      source.connect(bargeInAnalyser);
    } catch {
      stopBargeInWatch();
      return;
    }
    const data = new Uint8Array(bargeInAnalyser.fftSize);
    const startedAt = performance.now();
    let sustainedMs = 0;
    let lastTick = startedAt;
    function tick() {
      if (!bargeInAnalyser) return;
      const now = performance.now();
      const dt = now - lastTick;
      lastTick = now;
      bargeInAnalyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSquares += v * v; }
      const rms = Math.sqrt(sumSquares / data.length);
      if (now - startedAt < BARGE_IN_GUARD_MS) { bargeInRAF = requestAnimationFrame(tick); return; }
      if (rms > BARGE_IN_RMS_THRESHOLD) {
        sustainedMs += dt;
        if (sustainedMs >= BARGE_IN_SUSTAIN_MS) { onInterrupt(); return; }
      } else {
        sustainedMs = 0;
      }
      bargeInRAF = requestAnimationFrame(tick);
    }
    bargeInRAF = requestAnimationFrame(tick);
  }

  function stopBargeInWatch() {
    if (bargeInRAF) cancelAnimationFrame(bargeInRAF);
    bargeInRAF = null;
    if (bargeInAudioCtx) { try { bargeInAudioCtx.close(); } catch { /* already closed */ } }
    bargeInAudioCtx = null;
    bargeInAnalyser = null;
    if (bargeInStream) { bargeInStream.getTracks().forEach((t) => t.stop()); bargeInStream = null; }
  }

  const panel = document.createElement('div');
  panel.className = 'mamcp-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'MAM');
  // Closed by default. Visibility/interactivity/animation are all driven
  // by the `.is-open` class (css/mam-chat-panel.css) rather than the
  // `hidden` attribute now -- `hidden` forces `display:none`, which
  // cannot be transitioned, and an animated "grow from the dock" open is
  // exactly what this panel needs to not look detached (see
  // computeAnchoredPosition() below).
  panel.setAttribute('aria-hidden', 'true');

  // ---- grab handle -- replaces the old "popup with an X" pattern -------
  // A premium bottom-sheet/panel is grabbed and dragged away, not closed
  // with a button in the corner. This is the PRIMARY way to collapse:
  // drag it down past COLLAPSE_DRAG_PX and release (see the pointer
  // handlers below, wired after `close` exists). It is also a real
  // control for anyone who can't drag -- role="button" plus tabindex, so
  // Enter/Space collapses it from the keyboard exactly like a click would.
  const grabHandle = document.createElement('div');
  grabHandle.className = 'mamcp-grab-handle';
  grabHandle.setAttribute('role', 'button');
  grabHandle.tabIndex = 0;
  grabHandle.setAttribute('aria-label', tr('mam.collapseHandle', 'Collapse MAM'));
  const grabBar = document.createElement('span');
  grabBar.className = 'mamcp-grab-bar';
  grabBar.setAttribute('aria-hidden', 'true');
  grabHandle.appendChild(grabBar);
  panel.appendChild(grabHandle);

  const header = document.createElement('div');
  header.className = 'mamcp-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'mamcp-title-wrap';
  const title = document.createElement('span');
  title.className = 'mamcp-title';
  title.textContent = 'MAM';
  titleWrap.appendChild(title);
  header.appendChild(titleWrap);

  const headerActions = document.createElement('div');
  headerActions.className = 'mamcp-header-actions';
  const voiceToggleBtn = document.createElement('button');
  voiceToggleBtn.type = 'button';
  voiceToggleBtn.className = 'mamcp-icon-btn';
  voiceToggleBtn.hidden = true;
  voiceToggleBtn.title = 'Voice replies';
  voiceToggleBtn.setAttribute('aria-label', 'Toggle voice replies');
  const voiceToggleIcon = document.createElement('span');
  voiceToggleIcon.className = 'mamcp-icon';
  voiceToggleBtn.appendChild(voiceToggleIcon);
  headerActions.appendChild(voiceToggleBtn);

  // A small, quiet collapse control for keyboard/screen-reader use and
  // anyone who would rather click than drag -- deliberately NOT the
  // prominent circular X a popup normally gets; the grab handle above is
  // the surface's real, primary affordance for closing. Same action as
  // before (`close()`), a calmer icon and label for it.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mamcp-icon-btn mamcp-collapse-btn';
  closeBtn.setAttribute('aria-label', tr('mam.collapse', 'Collapse'));
  closeBtn.innerHTML = ICON_CLOSE_SVG;
  headerActions.appendChild(closeBtn);
  header.appendChild(headerActions);
  panel.appendChild(header);

  const log = document.createElement('div');
  log.className = 'mamcp-log';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  panel.appendChild(log);

  const emptyState = document.createElement('p');
  emptyState.className = 'mamcp-empty';
  emptyState.textContent = tr('mam.greeting', "Ask me about Darwesh listings, projects, or service providers.");
  log.appendChild(emptyState);

  const chipsEl = document.createElement('div');
  chipsEl.className = 'mamcp-chips';
  panel.appendChild(chipsEl);

  const form = document.createElement('form');
  form.className = 'mamcp-bar';
  const input = document.createElement('input');
  input.className = 'mamcp-input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.maxLength = MAX_MESSAGE_LENGTH;
  input.placeholder = tr('mam.inputPlaceholder', 'Ask MAM about the market…');
  input.setAttribute('aria-label', 'Ask MAM');
  form.appendChild(input);

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'mamcp-bar-btn mamcp-mic';
  micBtn.hidden = true;
  micBtn.setAttribute('aria-label', 'Speak your question');
  micBtn.innerHTML = ICON_MIC_SVG;
  form.appendChild(micBtn);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'mamcp-bar-btn mamcp-send';
  sendBtn.setAttribute('aria-label', 'Send message');
  sendBtn.innerHTML = ICON_SEND_SVG;
  form.appendChild(sendBtn);
  panel.appendChild(form);

  // Appended to <body>, deliberately NOT inside orbRoot: `.mamco-root`
  // carries a CSS `transform` (see css/mam-companion.css), which would
  // make it the containing block for any `position: fixed` descendant
  // and silently break this panel's viewport-relative positioning/
  // stacking. Positioning it independently, the same way map.html's own
  // #drmAiWrap used to be a direct child of <body>, keeps it reliably on
  // top of page content regardless of where the orb's own root happens to
  // sit in the DOM.
  document.body.appendChild(panel);

  // ---- anchoring the panel to the dock's CURRENT position --------------
  // This is the whole fix for "MAM jumps to a detached right-side panel":
  // the panel's position is computed fresh, every time, from where the
  // dock ACTUALLY is on screen right now -- never a fixed CSS position
  // independent of it. Measured and applied BEFORE the caller collapses
  // the dock (see open() below), so this always reads the dock's real,
  // uncollapsed layout position, not a slightly-transformed one.
  let lastAnchor = null;   // reused by close() so it shrinks back to the exact spot it grew from
  function computeAnchoredPosition() {
    if (!dockEl) return null;
    const r = dockEl.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;   // dock not laid out yet -- fall back to CSS defaults
    const vw = window.innerWidth, vh = window.innerHeight;
    const narrow = vw < NARROW_VIEWPORT_PX;

    // Horizontal anchor: whichever side of the viewport the dock's centre
    // is nearer to is the edge the panel grows from too -- docked right,
    // it expands leftward/inward; docked left, rightward/inward.
    const anchorRight = (r.left + r.width / 2) > vw / 2;
    // Vertical anchor: same idea. A dock sitting in the bottom half (the
    // map's own bottom-safe dock) makes the panel grow UPWARD from it;
    // one in the top half grows downward.
    const anchorBottom = (r.top + r.height / 2) > vh / 2;

    const style = {};
    if (narrow) {
      // Full-width-minus-margins: there is no meaningful "grow sideways"
      // on a phone screen, so only the vertical anchor still does real
      // work here.
      style.left = PANEL_MARGIN_PX + 'px';
      style.right = PANEL_MARGIN_PX + 'px';
      style.width = 'auto';
    } else {
      const w = Math.min(PANEL_WIDTH_PX, vw - 2 * PANEL_MARGIN_PX);
      style.width = w + 'px';
      if (anchorRight) {
        style.right = Math.max(PANEL_MARGIN_PX, vw - r.right) + 'px';
        style.left = 'auto';
      } else {
        style.left = Math.max(PANEL_MARGIN_PX, r.left) + 'px';
        style.right = 'auto';
      }
    }
    if (anchorBottom) {
      style.bottom = Math.max(PANEL_MARGIN_PX, vh - r.bottom) + 'px';
      style.top = 'auto';
      style.maxHeight = Math.min(PANEL_MAX_HEIGHT_PX, r.top - PANEL_MARGIN_PX) + 'px';
    } else {
      style.top = Math.max(PANEL_MARGIN_PX, r.top) + 'px';
      style.bottom = 'auto';
      style.maxHeight = Math.min(PANEL_MAX_HEIGHT_PX, vh - r.bottom - PANEL_MARGIN_PX) + 'px';
    }
    const transformOrigin = (narrow ? '50%' : (anchorRight ? '100%' : '0%')) + ' ' + (anchorBottom ? '100%' : '0%');
    return { style, transformOrigin };
  }
  function applyAnchor(anchor) {
    if (!anchor) return;
    Object.assign(panel.style, anchor.style);
    panel.style.transformOrigin = anchor.transformOrigin;
  }

  // ---- open/close -- panel state is never destroyed, only hidden;
  // conversation/session survive close/reopen for the whole page visit,
  // exactly like map.html's own dock. ----------------------------------
  // The compact dock and this overlay are two states of ONE surface, not
  // two things on screen at once: the overlay is the dock expanded. Both
  // are fixed-position and the visitor can park the dock anywhere, so
  // leaving the dock up would sooner or later put it on top of the
  // conversation (or the conversation on top of it, swallowing taps meant
  // for the dock -- which is exactly what happened before this). The
  // caller is told which state we are in and collapses the dock while the
  // overlay is up; the overlay's own close button brings it back.
  let isOpen = false;
  function setOpenState(nextOpen) {
    if (nextOpen === isOpen) return;
    isOpen = nextOpen;
    if (isOpen) {
      // Measure and position FIRST, while the dock is still in its normal
      // (uncollapsed) layout position -- onOpenState below is what
      // collapses it, and must run after this.
      lastAnchor = computeAnchoredPosition();
      applyAnchor(lastAnchor);
    } else if (lastAnchor) {
      // Shrink back to the exact spot it grew from, not wherever the dock
      // happens to measure right now (it's invisible/collapsed at this
      // point, so re-measuring it would be measuring a moving target).
      applyAnchor(lastAnchor);
    }
    panel.classList.toggle('is-open', isOpen);
    panel.setAttribute('aria-hidden', String(!isOpen));
    if (onOpenState) onOpenState(isOpen);
  }
  function open() { setOpenState(true); }
  function close() { setOpenState(false); }
  function toggle() { if (!isOpen) { open(); input.focus(); } else close(); }
  closeBtn.addEventListener('click', close);
  if (orbEl) orbEl.addEventListener('click', toggle);

  // Escape collapses from anywhere in the panel -- a real keyboard path
  // that needs no drag and no pointer at all. Also listened for on
  // `document`, since a voice- or action-triggered open() never moves
  // focus into the panel the way a manual tap-to-open does.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) { e.stopPropagation(); close(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen && !panel.contains(document.activeElement)) close();
  });
  // Enter/Space on the grab handle itself does the same thing a click on
  // it would (role="button" makes this expected, but is not automatic on
  // a <div>).
  grabHandle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); }
  });

  // ---- drag-the-handle-down-to-collapse --------------------------------
  // The primary gesture this surface offers instead of a popup's X: grab
  // the handle, pull it down, let go. Short of the threshold, it springs
  // back -- nothing closes on an accidental nudge. Horizontal movement is
  // ignored entirely (this is a vertical dismiss gesture, not a drag-to-
  // move -- the dock itself already owns repositioning).
  let handleDrag = null;
  grabHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    handleDrag = { pointerId: e.pointerId, startY: e.clientY, dy: 0 };
    try { grabHandle.setPointerCapture(e.pointerId); } catch { /* capture unsupported -- still works while over the handle */ }
    panel.classList.add('is-collapsing');
  });
  grabHandle.addEventListener('pointermove', (e) => {
    if (!handleDrag || e.pointerId !== handleDrag.pointerId) return;
    const dy = Math.max(0, e.clientY - handleDrag.startY);   // downward only
    handleDrag.dy = dy;
    panel.style.transform = 'translateY(' + dy + 'px)';
    panel.style.opacity = String(Math.max(0.4, 1 - dy / 500));
  });
  function endHandleDrag(e) {
    if (!handleDrag || e.pointerId !== handleDrag.pointerId) return;
    const dy = handleDrag.dy;
    handleDrag = null;
    panel.classList.remove('is-collapsing');
    panel.style.transform = '';
    panel.style.opacity = '';
    if (dy > COLLAPSE_DRAG_PX) close();   // past the threshold: finish the dismiss
    // otherwise: clearing the inline overrides above lets the panel's own
    // (now re-enabled) transition spring it straight back to fully open.
  }
  grabHandle.addEventListener('pointerup', endHandleDrag);
  grabHandle.addEventListener('pointercancel', endHandleDrag);

  // A resize/rotation while the panel is OPEN must keep it correctly
  // anchored and clamped. The dock is collapsed (invisible) at this point
  // but stays in normal layout, so re-measuring it still gives a usable
  // rect -- and js/mam-dock.js re-places the dock itself on the same kind
  // of debounce, so by the time this settles the dock's own position has
  // already caught up with the new viewport too.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!isOpen) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (isOpen && dockEl) { lastAnchor = computeAnchoredPosition() || lastAnchor; applyAnchor(lastAnchor); } }, 120);
  });

  function scrollLogToBottom() { log.scrollTop = log.scrollHeight; }
  function clearEmptyState() { if (emptyState.parentNode) emptyState.remove(); }

  function addUserBubble(text) {
    clearEmptyState();
    const b = document.createElement('div');
    b.className = 'mamcp-bubble mamcp-bubble-user';
    b.textContent = text;
    log.appendChild(b);
    scrollLogToBottom();
  }

  function buildRefCard(card) {
    const a = document.createElement('a');
    a.className = 'mamcp-ref-card';
    if (card.kind === 'property') {
      a.href = 'listing.html?id=' + encodeURIComponent(card.listingId);
      const media = document.createElement('div');
      media.className = 'mamcp-ref-card-media';
      if (card.imageUrl) {
        const img = document.createElement('img');
        img.src = card.imageUrl; img.alt = ''; img.loading = 'lazy';
        media.appendChild(img);
      }
      a.appendChild(media);
      const body = document.createElement('div');
      body.className = 'mamcp-ref-card-body';
      const t = document.createElement('p');
      t.className = 'mamcp-ref-card-title';
      t.textContent = card.title || tr('mam.property', 'Property');
      body.appendChild(t);
      const price = fmtPrice(card.price, card.currency);
      if (price) {
        const p = document.createElement('p');
        p.className = 'mamcp-ref-card-price';
        p.textContent = price + (card.dealType === 'rent' ? tr('mam.perMonth', ' / mo') : '');
        body.appendChild(p);
      }
      a.appendChild(body);
      return a;
    }
    if (card.kind === 'project') {
      a.href = 'map.html?city=' + encodeURIComponent(card.city || '');
      const body = document.createElement('div');
      body.className = 'mamcp-ref-card-body';
      const t = document.createElement('p');
      t.className = 'mamcp-ref-card-title';
      t.textContent = card.name || tr('mam.project', 'Project');
      body.appendChild(t);
      a.appendChild(body);
      return a;
    }
    if (card.kind === 'professional') {
      const page = PROFESSIONAL_PAGES[card.serviceType];
      if (!page) return null;
      a.href = page + '?id=' + encodeURIComponent(card.providerId);
      const body = document.createElement('div');
      body.className = 'mamcp-ref-card-body';
      const t = document.createElement('p');
      t.className = 'mamcp-ref-card-title';
      t.textContent = card.name || tr('mam.professional', 'Professional');
      body.appendChild(t);
      a.appendChild(body);
      return a;
    }
    return null;
  }

  function buildSuggestedActions(actions) {
    if (!actions || !actions.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'mamcp-actions';
    actions.forEach((a) => {
      const href = resolveActionHref(a);
      if (!href) return; // not a real, resolvable destination -- skipped, never a dead link
      const chip = document.createElement('a');
      chip.className = 'mamcp-action-chip';
      chip.textContent = tr(a.labelKey, a.labelFallback || 'Open');
      chip.href = href;
      wrap.appendChild(chip);
    });
    return wrap.childElementCount ? wrap : null;
  }

  function addAssistantBubble(data, { failed = false, retryText = null } = {}) {
    clearEmptyState();
    const b = document.createElement('div');
    b.className = 'mamcp-bubble mamcp-bubble-assistant' + (failed ? ' mamcp-bubble-error' : '');
    if (data.message) {
      const p = document.createElement('p');
      p.textContent = data.message;
      b.appendChild(p);
    }
    if (retryText) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'mamcp-retry';
      retryBtn.textContent = tr('mam.retry', 'Try again');
      retryBtn.addEventListener('click', () => { retryBtn.disabled = true; sendMessage(retryText); });
      b.appendChild(retryBtn);
    }
    const cards = (data.cards || []).map(buildRefCard).filter(Boolean);
    if (cards.length) {
      const row = document.createElement('div');
      row.className = 'mamcp-ref-cards';
      cards.forEach((c) => row.appendChild(c));
      b.appendChild(row);
    }
    const suggested = buildSuggestedActions(data.suggestedActions);
    if (suggested) b.appendChild(suggested);
    log.appendChild(b);
    scrollLogToBottom();
    return b;
  }

  let thinkingEl = null;
  function showThinking() {
    if (thinkingEl) return;
    setVoiceState('PROCESSING');
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'mamcp-bubble mamcp-bubble-assistant mamcp-thinking';
    thinkingEl.setAttribute('aria-label', tr('mam.orbThinking', 'MAM is thinking'));
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'mamcp-dot';
      thinkingEl.appendChild(dot);
    }
    log.appendChild(thinkingEl);
    scrollLogToBottom();
  }
  function hideThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

  // ---- Voice output (TTS) -- OFF by default (never autoplays on load),
  // the same localStorage preference the map's MAM dock uses so it
  // carries over between surfaces. Only ever speaks a reply that was
  // itself produced from a voice-initiated turn, or when the user has
  // explicitly turned voice replies on via this header toggle -- never
  // a surprise voice on a page the visitor never asked MAM to talk on. --
  let voiceOutputEnabled = localStorage.getItem(VOICE_OUTPUT_KEY) === '1';
  let cachedVoices = [];
  function refreshVoices() { cachedVoices = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
  if (window.speechSynthesis) {
    refreshVoices();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
  }
  function speechVoiceLangCandidates() {
    const lang = currentLang();
    if (lang === 'ku') return ['ku', 'ckb', 'ar']; // no browser ships native Kurdish TTS -- Arabic is the closest honest fallback, flagged to the user below
    if (lang === 'ar') return ['ar'];
    return ['en'];
  }
  function pickVoice(candidates) {
    for (const prefix of candidates) {
      const matching = cachedVoices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(prefix));
      if (matching.length) return matching[0];
    }
    const en = cachedVoices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
    return en.length ? en[0] : null;
  }
  let fallbackNoteShown = false;
  let ttsBlockedNoteShown = false;
  // onDone fires when the reply has finished being spoken -- or straight
  // away when there is nothing to speak. The hands-free loop chains on it,
  // so it must fire on EVERY path, including the disabled/unsupported ones
  // and the browser-refused one; a path that silently returns would strand
  // the loop mid-turn with the microphone shut and no way back.
  //
  // "Refused" is a real state, not a theoretical one: a browser that has
  // not seen a user gesture on this document simply never fires `start`
  // on the utterance -- no error event, no exception, nothing. A watchdog
  // is the only way to notice, so one runs on every spoken reply and is
  // cleared the moment speech genuinely begins.
  // ---- KurdishTTS audio playback (Sorani) --------------------------------
  // Reuses ONE <audio> element for the life of the panel rather than a new
  // one per reply -- both so at most one KurdishTTS clip is ever playing
  // (interrupting a previous one just replaces its source) and so it's a
  // single, obvious thing to stop from disableVoiceCompletely()/a new
  // sendMessage() interrupting an in-flight reply.
  const kurdishAudioEl = new Audio();
  kurdishAudioEl.preload = 'auto';
  let kurdishTtsController = null;   // aborts an in-flight (now-obsolete) synthesis request
  let lastKurdishTtsText = null;     // cost control: never re-synthesize the same reply twice in a row
  let lastKurdishTtsBlobUrl = null;
  function stopKurdishAudio() {
    if (kurdishTtsController) { kurdishTtsController.abort(); kurdishTtsController = null; }
    try { kurdishAudioEl.pause(); } catch { /* not playing */ }
  }
  // Returns true if it successfully started (or is in the process of
  // starting) KurdishTTS playback -- the caller must NOT also start
  // browser speechSynthesis in that case. Returns false (having called
  // nothing further) when KurdishTTS isn't usable right now, so the
  // caller falls through to the existing browser-voice path unchanged.
  async function speakWithKurdishTts(text, { onDone }) {
    kurdishTtsController = new AbortController();
    const thisController = kurdishTtsController;
    let blobUrl;
    if (lastKurdishTtsText === text && lastKurdishTtsBlobUrl) {
      blobUrl = lastKurdishTtsBlobUrl;   // identical reply already synthesized -- reuse it, never re-request
    } else {
      const blob = await mamVoiceTts(text, { signal: thisController.signal });
      if (thisController.signal.aborted) return; // superseded by a newer turn while awaiting
      if (!blob) {
        kurdishTtsController = null;
        speakWithBrowserVoice(text, { onDone }); // KurdishTTS unavailable/quota-exhausted -- fall back, never fake success
        return;
      }
      if (lastKurdishTtsBlobUrl) URL.revokeObjectURL(lastKurdishTtsBlobUrl);
      blobUrl = URL.createObjectURL(blob);
      lastKurdishTtsText = text;
      lastKurdishTtsBlobUrl = blobUrl;
    }
    if (thisController.signal.aborted) return;
    kurdishAudioEl.src = blobUrl;
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      // If a hands-free loop is running, the onDone callback below is
      // about to call startListening() itself (see the various onDone
      // sites in the recognition block), which sets LISTENING -- setting
      // IDLE here first would just be an instantly-overwritten flash.
      // Only force IDLE when nothing else is about to take over.
      if (!handsFree) setVoiceState('IDLE');
      kurdishTtsController = null;
      if (onDone) onDone();
    }
    kurdishAudioEl.onplay = () => setVoiceState('SPEAKING');
    kurdishAudioEl.onended = settle;
    kurdishAudioEl.onerror = () => { speakWithBrowserVoice(text, { onDone }); }; // playback itself failed -- fall back rather than going silent
    try {
      await kurdishAudioEl.play();
    } catch {
      // Same browser autoplay/gesture restriction speechSynthesis can hit
      // -- fall back to the existing browser path's own honest handling
      // of that case (its watchdog + "tap anywhere" note).
      speakWithBrowserVoice(text, { onDone });
    }
  }
  function speak(text, { onDone } = {}) {
    if (!voiceOutputEnabled || !text) { if (onDone) onDone(); return; }
    stopKurdishAudio();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (soraniVoiceActive() && kurdishVoice.ttsAvailable) {
      speakWithKurdishTts(text, { onDone });
      return;
    }
    speakWithBrowserVoice(text, { onDone });
  }
  function speakWithBrowserVoice(text, { onDone } = {}) {
    if (!window.speechSynthesis) { if (onDone) onDone(); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const candidates = speechVoiceLangCandidates();
    const voice = pickVoice(candidates);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
    if (currentLang() === 'ku' && voice && voice.lang.toLowerCase().startsWith('ar') && !fallbackNoteShown) {
      fallbackNoteShown = true;
      const note = document.createElement('p');
      note.className = 'mamcp-fallback-note';
      note.textContent = tr('mam.speechFallbackNote', 'No Kurdish voice was found on this device — using an Arabic voice to read replies aloud, which will not sound like native Kurdish.');
      log.appendChild(note);
      scrollLogToBottom();
    }
    // Exactly one of these paths may finish the turn, however many events
    // the engine decides to fire (some fire `end` after `error`).
    let settled = false;
    let watchdog = null;
    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      // See speakWithKurdishTts's settle() for why this is conditional.
      if (!handsFree) setVoiceState('IDLE');
      if (onDone) onDone();
    }
    utterance.addEventListener('start', () => {
      clearTimeout(watchdog);          // speech really began -- not blocked
      setVoiceState('SPEAKING');
    });
    utterance.addEventListener('end', settle);
    utterance.addEventListener('error', settle);
    watchdog = setTimeout(() => {
      if (settled) return;
      // Nothing started within a generous window: the browser is refusing
      // to speak (autoplay/gesture policy, or no usable voice). Say so
      // once, honestly, rather than leaving a silent assistant that looks
      // broken -- and let the loop continue rather than hang.
      if (!ttsBlockedNoteShown) {
        ttsBlockedNoteShown = true;
        const note = document.createElement('p');
        note.className = 'mamcp-fallback-note';
        note.textContent = tr('mam.speechBlockedNote', 'Your browser is not letting MAM speak aloud yet. Replies are shown here as text; tap anywhere on the page and try voice again to allow it.');
        log.appendChild(note);
        scrollLogToBottom();
      }
      try { window.speechSynthesis.cancel(); } catch { /* nothing queued */ }
      settle();
    }, 2500);
    window.speechSynthesis.speak(utterance);
  }
  function updateVoiceToggleUI() {
    voiceToggleIcon.innerHTML = voiceOutputEnabled ? ICON_VOLUME_ON_SVG : ICON_VOLUME_OFF_SVG;
    voiceToggleBtn.setAttribute('aria-pressed', String(voiceOutputEnabled));
  }
  if (window.speechSynthesis) {
    voiceToggleBtn.hidden = false;
    updateVoiceToggleUI();
    voiceToggleBtn.addEventListener('click', () => {
      voiceOutputEnabled = !voiceOutputEnabled;
      localStorage.setItem(VOICE_OUTPUT_KEY, voiceOutputEnabled ? '1' : '0');
      updateVoiceToggleUI();
      if (!voiceOutputEnabled) window.speechSynthesis.cancel();
    });
  }

  // ---- applying an allowlisted map filter/focus action -----------------
  // Reuses the exact same real hook the map's own dock uses -- never a
  // second search implementation. When this panel happens to already be
  // open ON map.html, the filters/focus apply immediately in place. From
  // ANY other page, MAM operating the frontend still has to be able to
  // reach the map: the same filter values are translated (see
  // js/mam-actions.js's filtersToMapUrlParams -- the SAME vocabulary
  // backend/app/mam/orchestrator.py's tool calls already use) into
  // map.html's own URL query state, and the visitor is taken there, so a
  // search made from Home lands exactly like the same search made
  // directly on the map. -------------------------------------------------
  function applyMapAction(mapAction) {
    if (!mapAction || mapAction.target !== 'map.html') return;
    const onMapPage = window.DarweshPropertiesMap && typeof window.DarweshPropertiesMap.applyFilters === 'function';
    if (onMapPage) {
      if (mapAction.filters && Object.keys(mapAction.filters).length) {
        window.DarweshPropertiesMap.applyFilters(mapAction.filters);
      }
      if (mapAction.focusListingId && typeof window.DarweshPropertiesMap.focusListing === 'function') {
        window.DarweshPropertiesMap.focusListing(mapAction.focusListingId);
      }
      return;
    }
    const hasFilters = mapAction.filters && Object.keys(mapAction.filters).length;
    if (!hasFilters && !mapAction.focusListingId) return;
    const params = filtersToMapUrlParams(mapAction.filters || {});
    if (mapAction.focusListingId) params.set('listing', String(mapAction.focusListingId));
    location.href = 'map.html' + (params.toString() ? '?' + params.toString() : '');
  }

  // ---- direct commands -- the small, deterministic action layer --------
  // A handful of requests (navigate, go back, clear filters, collapse/
  // open MAM) need no NLU and no backend round trip at all: detected here
  // via js/mam-actions.js's fixed allowlist and executed immediately,
  // offline of the backend, identically every time. Everything this does
  // NOT confidently recognize (a property search, a filter value, small
  // talk) falls straight through to the real backend conversation just
  // below, completely unaffected -- this is deliberately narrow, never a
  // second, competing intent parser. Typed and spoken input both arrive
  // through this SAME sendMessage(), so a direct command works identically
  // either way, in the same session/transcript as everything else.
  function executeDirectCommand(command) {
    if (command.type === 'navigate') {
      const page = resolvePage(command.page);
      if (!page) return null;
      return { confirm: trf('mam.actionOpenedPage', 'Opening {page}…', { page: command.page }), run: () => { location.href = page; } };
    }
    if (command.type === 'back') {
      return { confirm: tr('mam.actionWentBack', 'Going back…'), run: () => { history.back(); } };
    }
    if (command.type === 'clear_filters') {
      if (window.DarweshPropertiesMap && typeof window.DarweshPropertiesMap.clearFilters === 'function') {
        return { confirm: tr('mam.actionClearedFilters', 'Filters cleared.'), run: () => { window.DarweshPropertiesMap.clearFilters(); } };
      }
      return { confirm: tr('mam.actionNoFiltersHere', "There's nothing to clear here — the filters live on the map."), run: () => {} };
    }
    if (command.type === 'collapse_mam') {
      return { confirm: null, run: () => { close(); } };
    }
    if (command.type === 'open_mam') {
      return { confirm: null, run: () => { open(); } };
    }
    return null;
  }

  // ---- sending a turn -----------------------------------------------
  let sending = false;
  let pendingController = null;
  let lastTurnWasVoice = false;
  function setSendingState(isSending) {
    sending = isSending;
    input.disabled = isSending;
    sendBtn.disabled = isSending;
    sendBtn.setAttribute('aria-busy', String(isSending));
  }

  async function sendMessage(rawText, { viaVoice = false, onReplySpoken, onFailed } = {}) {
    const text = (rawText || '').trim();
    if (!text || sending) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      open();
      addAssistantBubble({ message: trf('mam.tooLong', 'That message is too long (max {n} characters).', { n: MAX_MESSAGE_LENGTH }) });
      if (onFailed) onFailed();
      return;
    }

    // Direct commands short-circuit the entire backend round trip -- see
    // executeDirectCommand() above. Typed or spoken, this is the exact
    // same check either way, in the exact same session/transcript as a
    // normal turn.
    const direct = detectDirectCommand(text);
    const resolved = direct && executeDirectCommand(direct);
    if (resolved) {
      open();
      lastTurnWasVoice = viaVoice;
      addUserBubble(text);
      recordTurn({ role: 'user', text });
      if (resolved.confirm) {
        addAssistantBubble({ message: resolved.confirm });
        recordTurn({ role: 'assistant', text: resolved.confirm, cards: [] });
      }
      resolved.run();
      if (viaVoice && resolved.confirm) speak(resolved.confirm, { onDone: onReplySpoken });
      else if (onReplySpoken) onReplySpoken();
      return;
    }

    open();
    lastTurnWasVoice = viaVoice;

    if (pendingController) pendingController.abort();
    pendingController = new AbortController();
    const thisController = pendingController;

    addUserBubble(text);
    recordTurn({ role: 'user', text });
    input.value = '';
    setSendingState(true);
    showThinking();

    try {
      const data = await sendMamChat(
        { message: text, language: currentLang(), sessionId: getSessionId(), pageContext },
        { user: auth.currentUser, signal: thisController.signal }
      );
      if (thisController.signal.aborted) return;
      hideThinking();
      if (data.sessionId) setSessionId(data.sessionId);
      addAssistantBubble(data);
      recordTurn({ role: 'assistant', text: data.message || '', cards: Array.isArray(data.cards) ? data.cards : [] });
      applyMapAction(data.mapAction);
      companion.setState('result-ready');
      if (lastTurnWasVoice && data.message) speak(data.message, { onDone: onReplySpoken });
      else if (onReplySpoken) onReplySpoken();   // nothing to say -- keep the loop moving
    } catch (err) {
      if (thisController.signal.aborted) { hideThinking(); return; }
      hideThinking();
      setVoiceState('ERROR');
      if (err instanceof BackendResponseError && err.status === 429) {
        addAssistantBubble({ message: tr('mam.rateLimited', "You're sending messages a little fast — please wait a moment and try again.") }, { failed: true, retryText: text });
      } else if (err && err.name === 'AbortError') {
        addAssistantBubble({ message: tr('mam.timeout', 'That took too long to answer. Please try again.') }, { failed: true, retryText: text });
      } else if (err instanceof BackendUnavailableError) {
        addAssistantBubble({ message: tr('mam.offline', "I couldn't reach the Darwesh server. Check your connection and try again.") }, { failed: true, retryText: text });
      } else {
        addAssistantBubble({ message: tr('mam.genericError', "That didn't go through. Please try again.") }, { failed: true, retryText: text });
      }
      if (onFailed) onFailed();
    } finally {
      if (pendingController === thisController) {
        setSendingState(false);
        pendingController = null;
      }
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(input.value); });
  input.addEventListener('focus', open);

  // ---- Voice input (STT) -- browser SpeechRecognition only, and honest
  // about it: if the browser/platform has no
  // SpeechRecognition constructor, the mic button simply never appears
  // -- never a fake "listening" state with nothing behind it. There is
  // no dedicated Kurdish speech-recognition service wired up, so a
  // Sorani speaker's audio is sent using the closest available
  // recognition locale (ar-IQ) exactly like the existing map dock
  // already does; this is a known, reported limitation, not a claim of
  // native Kurdish STT. ---------------------------------------------------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  // Every mic control on the page -- the panel's own plus the dock's --
  // driven from ONE state. Two buttons for one microphone must never be
  // able to disagree about whether it is open.
  const allMicEls = [micBtn, ...micEls.filter(Boolean)];

  // Surfaced to the caller so a host page can offer voice from its own
  // control without reaching into this module's internals -- and so
  // "unsupported" is a fact it can read rather than guess at.
  const voiceApi = { isSupported: false, toggleHandsFree: () => {} };

  // ---- the wake phrase, "MAM AI" ----------------------------------------
  // Whether the visitor wants MAM listening for the phrase is a STANDING
  // preference -- set once, the first time they explicitly turn voice on,
  // and remembered in localStorage (not sessionStorage: it is meant to
  // survive well past one tab/visit, exactly like "remember that the user
  // wants wake mode enabled" asks for) -- not a per-turn or per-session
  // flag. It is also what auto-resumes wake-listening on the next page
  // (see the bottom of this block) and what a real mic failure clears, so
  // a permanently denied/missing microphone does not keep silently
  // retrying on every future navigation.
  const WAKE_ENABLED_KEY = 'darwesh_mam_wake_enabled';
  let wakeEnabled = false;
  try { wakeEnabled = localStorage.getItem(WAKE_ENABLED_KEY) === '1'; } catch { /* storage disabled */ }
  function persistWakeEnabled(on) {
    wakeEnabled = on;
    try { if (on) localStorage.setItem(WAKE_ENABLED_KEY, '1'); else localStorage.removeItem(WAKE_ENABLED_KEY); } catch { /* storage disabled */ }
  }

  // Loose, not exact-match: SpeechRecognition transcribes "MAM AI" as
  // whatever its language model thinks it heard, and that varies by
  // accent/engine ("mam ai", "mom eye", "mamai"...). Normalizing case,
  // punctuation and collapsing whitespace before testing keeps the match
  // forgiving without turning it into a fuzzy-match rabbit hole. The
  // Arabic-script Kurdish/Arabic spelling the product asked for is
  // matched on the ORIGINAL transcript (Arabic script has no case, and
  // \p{L} normalization is what already strips the diacritics/punctuation
  // that would otherwise break a literal substring match).
  function normalizeForPhraseMatch(s) {
    return (s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  // "MAM AI" and "MAMA" match anywhere in the transcript -- both are
  // distinctive enough (two syllables, an unusual pairing/repetition) that
  // a stray mid-sentence match is very unlikely. Bare "MAM" is the
  // opposite case: a common short word ("my mam", "mam and dad") that
  // genuinely could turn up buried in an unrelated sentence, which is
  // exactly the "dangerously broad substring matching" this must avoid.
  // It is therefore only accepted at the START of the utterance --
  // real wake-word usage says the name FIRST ("MAM, three bedrooms in
  // Erbil" / a bare "MAM") rather than trailing off a sentence about
  // something else, so anchoring to `^` keeps the explicit, narrow
  // pattern the product asked for without opening a substring hole.
  const WAKE_PATTERNS = [/\bmam\s*a+\s*i\b/, /\bmamai\b/, /^mama\b/, /^mam\b/, /مام\s*ا[يی]/, /مام\s*آی/, /^مام\b/];
  function heardWakePhrase(transcript) {
    const norm = normalizeForPhraseMatch(transcript);
    return WAKE_PATTERNS.some((re) => re.test(norm));
  }
  // A short wake word like bare "MAM" is naturally said in the SAME
  // breath as the request that follows it ("mam show me villas in
  // erbil") far more often than "MAM AI" is -- continuous stays off (see
  // above), so that whole utterance arrives as one wake-mode `result` and
  // waiting for a second one nobody is going to say would just look like
  // MAM ignored the request. If real words follow the matched phrase in
  // the SAME transcript, they are sent immediately as the request itself
  // instead of being discarded once wake-mode's own listener has decided
  // this session heard the trigger.
  function extractWakeTrailingText(transcript) {
    const norm = normalizeForPhraseMatch(transcript);
    for (const re of WAKE_PATTERNS) {
      const m = re.exec(norm);
      if (m) {
        const rest = norm.slice(m.index + m[0].length).trim();
        return rest.length >= 2 ? rest : null;
      }
    }
    return null;
  }
  const STOP_PATTERNS = [/\bstop\s*mam\b/, /\bmam\s*stop\b/, /وەستە\s*مام/, /مام\s*وەستە/, /توقف\s*مام/, /مام\s*توقف/];
  function heardStopPhrase(transcript) {
    const norm = normalizeForPhraseMatch(transcript);
    return STOP_PATTERNS.some((re) => re.test(norm));
  }

  function clearVoiceIntent() {
    // Legacy key from before wakeEnabled existed -- still cleared so a
    // browser that carries an old value from a previous deploy doesn't
    // resurrect stale resume logic. Not written anywhere any more.
    try { sessionStorage.removeItem(VOICE_INTENT_KEY); } catch { /* storage disabled */ }
  }

  if (!SpeechRecognitionCtor) {
    // No recognition in this browser. The mic controls stay hidden rather
    // than showing a button that would pretend to listen -- and a wake
    // preference carried from a browser that DID have it is dropped, so
    // no page offers to resume something it cannot do.
    allMicEls.forEach((el) => { el.hidden = true; });
    clearVoiceIntent();
    persistWakeEnabled(false);
    if (onResumeHint) onResumeHint(null);
  } else {
    // ONE instance for the life of the page, shared by BOTH the passive
    // wake loop and the active conversation loop -- never two recognition
    // objects competing for one microphone. `recogMode` records which
    // purpose the CURRENTLY RUNNING session serves, since `result` and
    // `end` both need to know that to decide what happens next.
    const recognition = new SpeechRecognitionCtor();
    // `continuous` stays FALSE on purpose, for both modes. The browser's
    // own continuous mode keeps the microphone stream open straight
    // through MAM's spoken reply and transcribes that reply back as the
    // next question -- the assistant ends up talking to itself. Capturing
    // one utterance at a time and reopening the mic only when it is
    // actually safe to (never while MAM is speaking) is what keeps the
    // two voices apart, and is also exactly what lets ONE instance serve
    // both a passive wake loop and an active conversation loop in turn.
    recognition.continuous = false;
    recognition.interimResults = false;

    let recogMode = null;       // 'wake' | 'conversation' | null -- purpose of the running session
    let listening = false;      // conversation recognition currently open
    let wakeListening = false;  // wake recognition currently open
    // handsFree ('an active, multi-turn conversation loop is running') is
    // declared at the outer scope, alongside setVoiceState -- see that
    // declaration's own comment for why. Set/read here exactly as before.
    // Set between calling recognition.start() and the browser confirming
    // it. Without it, a fast end->restart can call start() twice before
    // the first has taken effect, which throws InvalidStateError and (on
    // some builds) leaves two capture sessions running.
    let starting = false;
    // A run of silences ends a CONVERSATION turn instead of holding the
    // microphone open forever -- someone who walked away should not leave
    // it capturing. It does not turn wake mode off; see
    // naturalConversationEnd() below.
    let silentRounds = 0;
    const MAX_SILENT_ROUNDS = 3;
    // Engines can deliver the same final result twice (a `result` event
    // repeated as the session closes). Sending it twice would put the
    // same question in the log twice and burn a backend turn on it.
    let lastTranscript = '';
    let lastTranscriptAt = 0;
    const DUPLICATE_WINDOW_MS = 2500;
    // A SECOND duplicate guard, on the FINAL text actually about to be
    // sent -- lastTranscript above only ever sees the browser's own raw
    // guess, but a Sorani turn may instead send KurdishTTS's transcript
    // (see the 'end' handler below), which lastTranscript never observed.
    // Without this, two back-to-back turns that both resolve to the same
    // KurdishTTS transcript (a very plausible false "did I mishear that
    // twice" case) would each burn a real backend/TTS turn.
    let lastSentVoiceText = null;
    let lastSentVoiceTextAt = 0;
    // Decided inside `result` (while `recognition` may still technically
    // be finishing its current session) and acted on inside `end` --
    // calling recognition.start() again before the browser has actually
    // finished the previous session throws InvalidStateError, so every
    // transition waits for `end`, exactly like the original hands-free
    // loop already did for its own restart decisions.
    let pendingWakeToConversation = false;
    let pendingWakeInlineCommand = null;   // real words heard trailing the wake word in the same utterance
    let pendingStopCommand = false;
    let pendingSendText = null;

    function speechLangTag() {
      const lang = currentLang();
      return (lang === 'ar' || lang === 'ku') ? 'ar-IQ' : 'en-US';
    }

    function updateMicUI() {
      allMicEls.forEach((el) => {
        el.classList.toggle('mic-listening', listening);
        el.classList.toggle('is-listening', listening);
        el.classList.toggle('mic-handsfree', handsFree);
        el.classList.toggle('is-handsfree', handsFree);
        el.classList.toggle('is-wake', wakeListening || (wakeEnabled && !handsFree));
        // Not a strict boolean once wake mode exists, but aria-pressed only
        // takes true/false/mixed -- "engaged in any form" is what a screen
        // reader needs to know before it reads the label below, which is
        // where the actual distinction (off vs. waiting vs. talking) lives.
        el.setAttribute('aria-pressed', String(handsFree || wakeEnabled));
        el.setAttribute('aria-label', handsFree
          ? tr('mam.handsFreeStop', 'Stop the voice conversation')
          : (wakeEnabled
            ? tr('mam.wakeModeOn', 'Voice on — say “MAM AI” to talk, or tap to turn it off')
            : tr('mam.handsFreeStart', 'Start a hands-free voice conversation')));
      });
      if (onVoiceUi) onVoiceUi({ handsFree, listening, wakeEnabled, wakeListening, voiceState });
    }

    function voiceProblem(messageKey, fallback) {
      open();
      addAssistantBubble({ message: tr(messageKey, fallback) }, { failed: true });
    }

    voiceApi.getVoiceState = () => voiceState;

    // Gives the outer-scope placeholder (declared near setVoiceState,
    // above -- see its own comment) its real body, now that
    // SpeechRecognition/startListening genuinely exist. Confirmed
    // interruption: stop whichever voice is actually playing (KurdishTTS
    // audio and/or browser speechSynthesis -- only one is ever really
    // active, but both are safe to stop unconditionally), cancel any
    // obsolete in-flight TTS request, then hand straight into a fresh
    // conversation-mode capture for the new thing the visitor is saying.
    // startListening()'s own re-entrancy guard makes this safe even if
    // the interrupted speak()'s own onDone callback also later fires.
    handleBargeIn = function () {
      stopBargeInWatch();
      stopKurdishAudio();
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      setVoiceState('INTERRUPTED');
      startListening();
    };

    // ---- KurdishTTS STT (Sorani conversation-turn capture) ----------------
    // The browser's own SpeechRecognition (above/below) has no real Sorani
    // support on most engines -- see the module's opening comment. Rather
    // than replacing the whole wake/conversation state machine, a SEPARATE
    // MediaRecorder captures the SAME conversation-mode turn in parallel
    // (started right after recognition.start() succeeds, in
    // startListening() below) purely as raw audio, sent to the backend STT
    // proxy once the turn ends (finishKurdishRecording(), called from the
    // 'end' handler). recognition itself still drives every start/stop
    // timing decision exactly as before -- only WHICH transcript gets used
    // changes when Sorani KurdishTTS STT is available.
    let kurdishMediaStream = null;
    let kurdishRecorder = null;
    let kurdishRecordedChunks = [];
    let kurdishSttController = null;

    async function ensureKurdishMediaStream() {
      if (kurdishMediaStream) return kurdishMediaStream;
      try {
        kurdishMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return kurdishMediaStream;
      } catch {
        return null; // mic denied/unavailable for this second consumer -- the browser's own recognition still works
      }
    }

    function pickKurdishRecorderMimeType() {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      for (const type of candidates) {
        if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(type)) return type;
      }
      return '';
    }

    function startKurdishRecording() {
      if (!soraniVoiceActive() || !kurdishVoice.sttAvailable || !navigator.mediaDevices || !window.MediaRecorder) return;
      ensureKurdishMediaStream().then((stream) => {
        if (!stream || recogMode !== 'conversation') return; // turn already ended before permission resolved
        kurdishRecordedChunks = [];
        try {
          kurdishRecorder = new MediaRecorder(stream, { mimeType: pickKurdishRecorderMimeType() });
        } catch {
          kurdishRecorder = null;
          return;
        }
        kurdishRecorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) kurdishRecordedChunks.push(e.data); });
        try { kurdishRecorder.start(); } catch { kurdishRecorder = null; }
      });
    }

    // Aborts an in-progress recording/transcription without sending it --
    // used when the turn is being torn down for a reason other than a
    // normal end (voice turned off, a stop phrase heard).
    function stopKurdishRecording() {
      if (kurdishSttController) { kurdishSttController.abort(); kurdishSttController = null; }
      if (kurdishRecorder && kurdishRecorder.state !== 'inactive') { try { kurdishRecorder.stop(); } catch { /* already stopped */ } }
      kurdishRecorder = null;
      kurdishRecordedChunks = [];
    }

    // Stops the recorder, sends what it captured to the backend STT proxy,
    // and resolves with the transcript -- or null if there was no
    // recording, nothing was captured, or the proxy call failed/was
    // unavailable, so the caller falls back to the browser's own guess
    // rather than losing the turn.
    async function finishKurdishRecording() {
      const recorder = kurdishRecorder;
      kurdishRecorder = null;
      if (!recorder) return null;
      if (recorder.state === 'inactive') return null;
      const stopped = new Promise((resolve) => { recorder.addEventListener('stop', resolve, { once: true }); });
      try { recorder.stop(); } catch { return null; }
      await stopped;
      const chunks = kurdishRecordedChunks;
      kurdishRecordedChunks = [];
      if (!chunks.length) return null;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      kurdishSttController = new AbortController();
      const thisController = kurdishSttController;
      const transcript = await mamVoiceStt(blob, { signal: thisController.signal });
      if (kurdishSttController === thisController) kurdishSttController = null;
      return transcript;
    }

    // Begins/continues one CONVERSATION turn -- the active, "capture a
    // real question" mode. Unchanged in spirit from the original
    // hands-free loop; only now it also hands off cleanly from wake mode.
    function startListening() {
      if (listening || starting) return;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      stopKurdishAudio();
      recognition.lang = speechLangTag();
      starting = true;
      try {
        recognition.start();
        recogMode = 'conversation';
        listening = true;
        setVoiceState('LISTENING');
        open();
        startKurdishRecording();
      } catch {
        // Already started, or the mic was refused: drop the mode rather
        // than leaving a button that claims to be listening.
        listening = false; starting = false; recogMode = null;
        naturalConversationEnd();
        return;
      }
      starting = false;
      updateMicUI();
    }

    function stopListening() {
      listening = false;
      if (voiceState === 'LISTENING') setVoiceState('IDLE');
      updateMicUI();
    }

    // Begins the PASSIVE wake loop -- listening only for "MAM AI", never
    // open()-ing the panel or touching the log. Requires wakeEnabled: it
    // is never armed on its own initiative.
    function startWakeListening() {
      if (listening || wakeListening || starting || handsFree || !wakeEnabled) return;
      recognition.lang = speechLangTag();
      starting = true;
      try {
        recognition.start();
        recogMode = 'wake';
        wakeListening = true;
        setVoiceState('WAKE_LISTENING');
      } catch {
        // Most likely: the browser is refusing to start recognition
        // without a fresh gesture on THIS document (see the resume
        // handling below). wakeEnabled itself is left alone -- this is a
        // "not right now" refusal, not the visitor asking for voice off.
        wakeListening = false; starting = false; recogMode = null;
        if (onResumeHint) onResumeHint(tr('mam.voiceResume', 'Voice mode is paused — tap the microphone to continue talking.'));
        updateMicUI();
        return;
      }
      starting = false;
      updateMicUI();
    }

    function stopWakeListening() {
      wakeListening = false;
      if (voiceState === 'WAKE_LISTENING') setVoiceState('IDLE');
      updateMicUI();
    }

    // A conversation turn ending on its OWN (silence timeout, a failed
    // backend call) -- as opposed to the visitor explicitly asking for
    // quiet. The standing wake preference is not touched: if it is still
    // on, listening does not truly stop, it drops back to passively
    // waiting for "MAM AI" so the next question needs no button press.
    function naturalConversationEnd() {
      handsFree = false;
      silentRounds = 0;
      stopListening();
      if (wakeEnabled) startWakeListening();
    }

    // The one, total, explicit stop -- the mic/voice button while
    // anything is on, or the "Stop MAM" / "MAM stop" voice command.
    // Turns the WHOLE system off, including the standing wake preference,
    // and does not restart itself.
    function disableVoiceCompletely() {
      persistWakeEnabled(false);
      handsFree = false; silentRounds = 0;
      pendingWakeToConversation = false; pendingWakeInlineCommand = null; pendingStopCommand = false; pendingSendText = null;
      // abort(), not stop(): stop() still delivers whatever it heard, so
      // an explicit Stop could be followed by one more question the
      // visitor never meant to ask.
      try { recognition.abort(); } catch { /* not running */ }
      recogMode = null;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      stopKurdishAudio();
      stopKurdishRecording();
      if (onResumeHint) onResumeHint(null);
      stopListening();
      stopWakeListening();
      // Belt-and-suspenders: stopListening()/stopWakeListening() above
      // already reach IDLE from LISTENING/WAKE_LISTENING, but this is the
      // one place that must GUARANTEE MAM is never left claiming to still
      // be listening/thinking/speaking (e.g. voice turned off mid-reply,
      // straight out of SPEAKING). The one exception is ERROR: the
      // 'error' handler below calls setVoiceState('ERROR') and THEN this
      // function in the same call stack, so forcing IDLE here too would
      // make the error transition invisible -- ERROR is left standing
      // until the next real voice action instead (starting to listen
      // again naturally moves off it), which is itself a settled,
      // non-busy state, not a "stuck" one.
      if (voiceState !== 'ERROR') setVoiceState('IDLE');
    }

    // `viaWake`: true when a heard wake phrase is what started this turn,
    // as opposed to the visitor pressing the mic button themselves. Only
    // the explicit-click path counts as the "enable voice once" gesture
    // that persists the standing preference -- a wake-triggered turn
    // requires wakeEnabled to already be true to have been listening for
    // the phrase at all, so re-persisting it there is redundant, not
    // wrong, but skipping it keeps the intent of the flag legible: it
    // means "the visitor asked for this," not "a turn happened."
    // `skipListen`: the caller already has a real command to send (a
    // command spoken trailing the wake word in the very same utterance --
    // see extractWakeTrailingText) and will call sendMessage itself right
    // after this returns, so opening the mic to wait for a second
    // utterance that was never coming would just add a pointless capture
    // round before the one that actually matters.
    function beginHandsFree({ viaWake = false, skipListen = false } = {}) {
      if (handsFree) return;
      handsFree = true;
      silentRounds = 0;
      if (onResumeHint) onResumeHint(null);
      if (!viaWake) persistWakeEnabled(true);
      // The point of the mode is a spoken conversation, so replies are
      // read aloud while it is on even if the visitor had voice output
      // switched off for typing. The stored preference is left alone --
      // ending the mode restores whatever they had chosen.
      if (!voiceOutputEnabled && window.speechSynthesis) {
        voiceOutputEnabled = true;
        updateVoiceToggleUI();
      }
      if (skipListen) return; // caller already has a real command and will send it itself
      // A short, natural Sorani greeting on the visitor's OWN explicit
      // gesture (never on a wake-word re-entry, and never on the silent
      // auto-resume after navigation -- see the bottom of this block) --
      // section 4's "first interaction" shape. Fixed text, never an LLM
      // call: nothing here costs a chat-provider turn, and speak()'s own
      // KurdishTTS cache (see speakWithKurdishTts) means the audio itself
      // is only ever synthesized once per page, however many times the
      // visitor toggles the mic.
      if (!viaWake && soraniVoiceActive()) { speakGreeting(); return; }
      startListening();
    }

    const GREETING_TEXT_KU = 'سڵاو، من مامم. چۆن دەتوانم یارمەتیت بدەم؟';
    function speakGreeting() {
      open();
      addAssistantBubble({ message: GREETING_TEXT_KU });
      recordTurn({ role: 'assistant', text: GREETING_TEXT_KU, cards: [] });
      setVoiceState('PROCESSING'); // acknowledgement beat, mirrors the wake-handoff one above
      speak(GREETING_TEXT_KU, { onDone: () => { if (handsFree) startListening(); } });
    }

    // ONE predictable on/off switch for the mic/voice button: anything
    // currently on (an active conversation, the standing wake preference,
    // or the passive loop that preference drives) turns EVERYTHING off;
    // otherwise this both persists the standing preference (the required
    // "explicit enable" gesture) and starts talking immediately, so the
    // very first use does not require the visitor to already know and say
    // the wake phrase.
    function toggleMicButton() {
      if (handsFree || wakeEnabled || wakeListening) { disableVoiceCompletely(); return; }
      beginHandsFree();
    }
    voiceApi.isSupported = true;
    voiceApi.toggleHandsFree = toggleMicButton;

    allMicEls.forEach((el) => {
      el.hidden = false;
      el.addEventListener('click', toggleMicButton);
    });
    updateMicUI();

    recognition.addEventListener('result', (e) => {
      const transcript = (e.results[0][0].transcript || '').trim();
      if (recogMode === 'wake') {
        // Wake mode is a trigger, not a transcription service: anything
        // that isn't the phrase is simply not acted on. The restart (or
        // the hand-off into a real conversation) happens uniformly in
        // 'end' below, once the browser has actually finished this
        // session -- starting a new one from here would race it.
        if (transcript && heardWakePhrase(transcript)) {
          pendingWakeToConversation = true;
          pendingWakeInlineCommand = extractWakeTrailingText(transcript);
        }
        return;
      }
      if (recogMode === 'conversation') {
        if (!transcript) return;
        if (heardStopPhrase(transcript)) { pendingStopCommand = true; return; }
        const now = Date.now();
        if (transcript === lastTranscript && now - lastTranscriptAt < DUPLICATE_WINDOW_MS) return;
        lastTranscript = transcript;
        lastTranscriptAt = now;
        silentRounds = 0;
        pendingSendText = transcript;
      }
    });

    recognition.addEventListener('end', () => {
      const mode = recogMode;
      recogMode = null;
      if (mode === 'wake') {
        stopWakeListening();
        if (pendingWakeToConversation) {
          pendingWakeToConversation = false;
          const inline = pendingWakeInlineCommand;
          pendingWakeInlineCommand = null;
          if (inline) {
            beginHandsFree({ viaWake: true, skipListen: true });
            setVoiceState('LISTENING');   // a brief acknowledgement beat, per the wake-flow states
            sendMessage(inline, {
              viaVoice: true,
              onReplySpoken: () => { if (handsFree) startListening(); },
              onFailed: () => { naturalConversationEnd(); }
            });
          } else {
            beginHandsFree({ viaWake: true });
          }
        } else if (wakeEnabled && !handsFree) {
          startWakeListening();   // heard nothing useful -- keep waiting for the phrase
        }
        return;
      }
      if (mode === 'conversation') {
        const wasListening = listening;
        stopListening();
        if (pendingStopCommand) { pendingStopCommand = false; stopKurdishRecording(); disableVoiceCompletely(); return; }

        // Sorani, with KurdishTTS STT available and a recording actually
        // running: prefer ITS transcript (the browser's own recognition
        // rarely has real Sorani support -- see the module's opening
        // comment) over the browser's guess, falling back to that guess
        // only if the proxy call fails or is unavailable -- never losing
        // the turn over a KurdishTTS hiccup.
        const browserGuess = pendingSendText;
        pendingSendText = null;
        const soraniSttInFlight = soraniVoiceActive() && kurdishVoice.sttAvailable && !!kurdishRecorder;
        let textPromise;
        if (soraniSttInFlight) {
          textPromise = finishKurdishRecording().then((ko) => (ko && ko.trim()) || browserGuess);
        } else {
          stopKurdishRecording();
          textPromise = Promise.resolve(browserGuess);
        }

        // Shared by both "nothing usable was heard" and "the exact same
        // thing was just sent a moment ago" -- reopen the mic a few
        // times, then give up (dropping to wake-listening if that
        // preference is still on) rather than capturing indefinitely.
        function retryListeningOrGiveUp() {
          if (!handsFree || !wasListening || sending) return;
          silentRounds += 1;
          if (silentRounds >= MAX_SILENT_ROUNDS) { naturalConversationEnd(); return; }
          startListening();
        }

        textPromise.then((text) => {
          if (!text) { retryListeningOrGiveUp(); return; }
          const now = Date.now();
          if (text === lastSentVoiceText && now - lastSentVoiceTextAt < DUPLICATE_WINDOW_MS) {
            retryListeningOrGiveUp();
            return;
          }
          lastSentVoiceText = text;
          lastSentVoiceTextAt = now;
          sendMessage(text, {
            viaVoice: true,
            // Chained off the end of the spoken reply, so the next turn
            // opens the mic exactly when MAM stops talking -- never while
            // it is still speaking, which is what would feed its own
            // voice back in.
            onReplySpoken: () => { if (handsFree) startListening(); },
            // A failed turn ends the conversation loop (not the standing
            // wake preference): looping on an error would just re-ask
            // into a broken connection.
            onFailed: () => { naturalConversationEnd(); }
          });
        });
      }
    });

    recognition.addEventListener('error', (e) => {
      const kind = (e && e.error) || '';
      // 'no-speech' is ordinary silence, handled by the 'end' handler
      // that follows it -- not a failure worth telling anyone about, in
      // either mode.
      if (kind === 'no-speech') { return; }
      // 'aborted' is this module's own disableVoiceCompletely() calling
      // abort(); reporting it would mean an error bubble on every
      // deliberate stop.
      if (kind === 'aborted') { return; }
      // A real failure. Disabling outright (rather than letting 'end'
      // run its normal restart/wake-drop-back logic) matters most for
      // 'not-allowed'/'audio-capture': retrying those would just fail
      // again, silently, forever, on every future page.
      pendingWakeToConversation = false; pendingWakeInlineCommand = null; pendingStopCommand = false; pendingSendText = null;
      setVoiceState('ERROR');
      disableVoiceCompletely();
      if (kind === 'not-allowed' || kind === 'service-not-allowed') {
        voiceProblem('mam.micDenied', 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try voice again.');
      } else if (kind === 'audio-capture') {
        voiceProblem('mam.micUnavailable', "No microphone was found. Connect one, or type your question instead.");
      } else if (kind === 'network') {
        voiceProblem('mam.micNetwork', "Speech recognition couldn't reach its service. Check your connection, or type your question instead.");
      } else {
        voiceProblem('mam.micFailed', "Voice input stopped unexpectedly. You can try again, or type your question.");
      }
    });

    // ---- resuming wake mode after a page navigation (section 7) -------
    // The browser destroyed the previous page's microphone stream and its
    // SpeechRecognition object along with the document -- nothing can
    // carry those across, and this module does not pretend otherwise.
    // What survives is `wakeEnabled` itself (localStorage, so it outlives
    // this one tab/session, not just this page).
    //
    // Unlike TTS autoplay, most browsers do NOT require a fresh user
    // gesture to call SpeechRecognition.start() once microphone
    // permission has already been granted for the origin -- permission is
    // an origin-level grant, not a per-navigation one. So this actually
    // ATTEMPTS to resume (the "strongest reliable web behaviour" this was
    // asked to implement), rather than only ever showing a static "tap to
    // resume" hint: startWakeListening()'s own catch above is what falls
    // back to that hint on the (real, still-possible) browsers/situations
    // that do refuse it.
    clearVoiceIntent();
    if (wakeEnabled) startWakeListening();
  }

  // ---- suggested prompts ----------------------------------------------
  // Carried over from the map dock this panel replaced, so the same four
  // starting points exist everywhere instead of only on the map. They are
  // hidden as soon as there is a real conversation to look at.
  const CHIPS = [
    ['drm.ai.chip1', 'Houses for sale in Erbil'],
    ['drm.ai.chip2', 'Apartments for rent in Kirkuk'],
    ['drm.ai.chip3', 'Under 150 million'],
    ['drm.ai.chip4', '3 bedrooms'],
  ];
  function renderChips() {
    chipsEl.textContent = '';
    if (log.querySelector('.mamcp-bubble')) return;   // a conversation is under way
    CHIPS.forEach(([key, fallback]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mamcp-chip';
      btn.textContent = tr(key, fallback);
      btn.addEventListener('click', () => { sendMessage(btn.textContent); renderChips(); });
      chipsEl.appendChild(btn);
    });
  }

  document.addEventListener('darwesh:langchange', () => {
    input.placeholder = tr('mam.inputPlaceholder', 'Ask MAM about the market…');
    renderChips();
  });

  // Whether a real conversation already exists is decided ONCE, before
  // replaying it below adds bubbles to the log -- callers (the map's
  // first-time greeting) need to know "was there already a conversation
  // when this page loaded," not "is the log non-empty right now," which
  // replaying would otherwise make trivially true.
  const hadExistingConversation = readTranscript().length > 0;

  // Redraw whatever was said before this page loaded. Runs last so every
  // helper it uses exists and the log is still empty; a failed turn was
  // never recorded, so nothing here can resurrect an error bubble.
  (function replayCarriedConversation() {
    const turns = readTranscript();
    if (!turns.length) return;
    turns.forEach((t) => {
      if (!t || typeof t.text !== 'string') return;
      if (t.role === 'user') addUserBubble(t.text);
      else addAssistantBubble({ message: t.text, cards: Array.isArray(t.cards) ? t.cards : [] });
    });
  })();
  renderChips();

  // ---- entry points from elsewhere on the site --------------------------
  // index.html's hero search, about.html/services.html CTAs and the footer
  // all link to `map.html?ai=1[&q=...]`. That contract used to be handled
  // by the map's own dock; it lives here now so those links keep working
  // and behave the same way on every page.
  const bootParams = new URLSearchParams(window.location.search);
  if (bootParams.get('ai') === '1' || bootParams.get('mam') === '1') open();
  const initialQuery = bootParams.get('q');
  if (initialQuery) sendMessage(initialQuery);

  return {
    open, close, toggle, sendMessage,
    /** Present only where the browser really has speech recognition. */
    toggleHandsFree: voiceApi.toggleHandsFree,
    isVoiceSupported: voiceApi.isSupported,
    /** True if a conversation was already carried in when this page loaded. */
    hasExistingConversation: hadExistingConversation
  };
}

function ensureStylesheet() {
  if (document.querySelector('link[data-mamcp-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/mam-chat-panel.css', import.meta.url).href;
  link.setAttribute('data-mamcp-style', '1');
  document.head.appendChild(link);
}
