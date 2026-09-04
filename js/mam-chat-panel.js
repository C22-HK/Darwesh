// MAM site-wide chat panel -- the ONE local, non-navigating conversation
// surface, mounted by js/mam-companion-launcher.js next to the shared
// compact dock (js/mam-dock.js, which carries the orb from
// js/mam-companion.js) on EVERY public page, map.html included.
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
import { sendMamChat, BackendUnavailableError, BackendResponseError } from './mam-api.js';

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
 * @param {Element[]} [opts.micEls] Extra mic buttons outside the panel
 *   (the dock's) to drive from the SAME voice state as the panel's own.
 * @param {import('./mam-companion.js').MamCompanion} opts.companion
 * @param {() => string} [opts.getLanguage]
 * @param {(state: {handsFree: boolean, listening: boolean}) => void} [opts.onVoiceUi]
 * @param {(text: string|null) => void} [opts.onResumeHint]
 * @param {(isOpen: boolean) => void} [opts.onOpenState] Told whenever the
 *   overlay opens/closes, so the caller can collapse the compact dock
 *   while the expanded state is on screen.
 * @param {Object} opts.pageContext Structured, ID-only context (never
 *   scraped DOM) -- same shape as backend/app/mam/schemas.py's
 *   PageContext: {page, listingId?, projectId?, professionalId?, serviceType?}.
 */
export function mountMamChatPanel({ orbEl, micEls = [], companion, getLanguage, pageContext, onVoiceUi, onResumeHint, onOpenState }) {
  if (mounted) {
    console.warn('[mam-chat-panel] already mounted on this page -- ignoring the second mount');
    return null;
  }
  mounted = true;
  const currentLang = currentLangFactory(getLanguage);
  ensureStylesheet();

  const panel = document.createElement('div');
  panel.className = 'mamcp-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'MAM');
  panel.hidden = true;

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
  voiceToggleIcon.className = 'material-symbols-outlined';
  voiceToggleIcon.style.fontSize = '18px';
  voiceToggleBtn.appendChild(voiceToggleIcon);
  headerActions.appendChild(voiceToggleBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mamcp-icon-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:20px;">close</span>';
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
  const micIcon = document.createElement('span');
  micIcon.className = 'material-symbols-outlined';
  micIcon.style.fontSize = '16px';
  micIcon.textContent = 'mic';
  micBtn.appendChild(micIcon);
  form.appendChild(micBtn);

  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.className = 'mamcp-bar-btn mamcp-send';
  sendBtn.setAttribute('aria-label', 'Send message');
  sendBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">send</span>';
  form.appendChild(sendBtn);
  panel.appendChild(form);

  // Appended to <body>, deliberately NOT inside orbRoot: `.mamco-root`
  // carries a CSS `transform` (see css/mam-companion.css), which would
  // make it the containing block for any `position: fixed` descendant
  // and silently break this panel's viewport-relative positioning/
  // stacking. Positioning it independently, the same way map.html's own
  // #drmAiWrap is a direct child of <body>, keeps it reliably on top of
  // page content regardless of where the orb's own root happens to sit
  // in the DOM.
  document.body.appendChild(panel);

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
  function setOpenState(isOpen) {
    panel.hidden = !isOpen;
    if (onOpenState) onOpenState(isOpen);
  }
  function open() { setOpenState(true); }
  function close() { setOpenState(false); }
  function toggle() { if (panel.hidden) { open(); input.focus(); } else close(); }
  closeBtn.addEventListener('click', close);
  if (orbEl) orbEl.addEventListener('click', toggle);

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
    companion.setState('thinking');
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
  function speak(text, { onDone } = {}) {
    if (!voiceOutputEnabled || !window.speechSynthesis || !text) { if (onDone) onDone(); return; }
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
      companion.setState('idle');
      if (onDone) onDone();
    }
    utterance.addEventListener('start', () => {
      clearTimeout(watchdog);          // speech really began -- not blocked
      companion.setState('speaking');
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
    voiceToggleIcon.textContent = voiceOutputEnabled ? 'volume_up' : 'volume_off';
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

  // ---- applying an allowlisted map filter/focus action, only when this
  // panel happens to be open on map.html itself (never a second search
  // implementation -- reuses the exact same real hook the map's own dock
  // uses). On every other page there is no map to update, so this is a
  // no-op there and the reply's cards/suggestedActions are all a visitor
  // gets, exactly as intended. --------------------------------------------
  function applyMapAction(mapAction) {
    if (!mapAction || mapAction.target !== 'map.html') return;
    if (mapAction.filters && Object.keys(mapAction.filters).length &&
        window.DarweshPropertiesMap && typeof window.DarweshPropertiesMap.applyFilters === 'function') {
      window.DarweshPropertiesMap.applyFilters(mapAction.filters);
    }
    if (mapAction.focusListingId && window.DarweshPropertiesMap && typeof window.DarweshPropertiesMap.focusListing === 'function') {
      window.DarweshPropertiesMap.focusListing(mapAction.focusListingId);
    }
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
      companion.setState('error');
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

  function clearVoiceIntent() {
    try { sessionStorage.removeItem(VOICE_INTENT_KEY); } catch { /* storage disabled */ }
  }

  if (!SpeechRecognitionCtor) {
    // No recognition in this browser. The mic controls stay hidden rather
    // than showing a button that would pretend to listen -- and a voice
    // intent carried from a browser that DID have it is dropped, so no
    // page offers to resume something it cannot do.
    allMicEls.forEach((el) => { el.hidden = true; });
    clearVoiceIntent();
    if (onResumeHint) onResumeHint(null);
  } else {
    // ONE instance for the life of the page. A second one would compete
    // for the same microphone and deliver the same utterance twice.
    const recognition = new SpeechRecognitionCtor();
    // `continuous` stays FALSE on purpose. The browser's own continuous
    // mode keeps the microphone stream open straight through MAM's spoken
    // reply and transcribes that reply back as the next question -- the
    // assistant ends up talking to itself. Capturing one utterance at a
    // time and reopening the mic only after speaking has finished is what
    // keeps the two voices apart.
    recognition.continuous = false;
    recognition.interimResults = false;

    // HANDS-FREE IS A MODE, NOT A CAPTURE.
    //
    // One click starts a conversation and it runs on its own:
    //
    //   listening -> processing -> speaking -> listening -> ...
    //
    // A second click ends it. The mic is never push-to-talk: nothing has
    // to be held, released, or pressed again between sentences.
    let listening = false;
    let handsFree = false;
    // Set between calling recognition.start() and the browser confirming
    // it. Without it, a fast end->restart can call start() twice before
    // the first has taken effect, which throws InvalidStateError and (on
    // some builds) leaves two capture sessions running.
    let starting = false;
    // A run of silences ends the mode instead of holding the microphone
    // open forever -- someone who walked away should not leave it live.
    let silentRounds = 0;
    const MAX_SILENT_ROUNDS = 3;
    // Engines can deliver the same final result twice (a `result` event
    // repeated as the session closes). Sending it twice would put the
    // same question in the log twice and burn a backend turn on it.
    let lastTranscript = '';
    let lastTranscriptAt = 0;
    const DUPLICATE_WINDOW_MS = 2500;

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
        el.setAttribute('aria-pressed', String(handsFree));
        el.setAttribute('aria-label', handsFree
          ? tr('mam.handsFreeStop', 'Stop the voice conversation')
          : tr('mam.handsFreeStart', 'Start a hands-free voice conversation'));
      });
      if (onVoiceUi) onVoiceUi({ handsFree, listening });
    }

    function voiceProblem(messageKey, fallback) {
      open();
      addAssistantBubble({ message: tr(messageKey, fallback) }, { failed: true });
    }

    function startListening() {
      if (listening || starting) return;
      // Never listen while MAM is still speaking, or its own voice becomes
      // the next question.
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      recognition.lang = speechLangTag();
      starting = true;
      try {
        recognition.start();
        listening = true;
        companion.setState('listening');
        open();
      } catch {
        // Already started, or the mic was refused: drop the mode rather
        // than leaving a button that claims to be listening.
        listening = false;
        starting = false;
        endHandsFree();
        return;
      }
      starting = false;
      updateMicUI();
    }

    function stopListening() {
      listening = false;
      if (companion.getState() === 'listening') companion.setState('idle');
      updateMicUI();
    }

    function endHandsFree() {
      handsFree = false;
      silentRounds = 0;
      clearVoiceIntent();
      if (onResumeHint) onResumeHint(null);
      // abort(), not stop(): stop() still delivers whatever it heard, so
      // an explicit Stop could be followed by one more question the
      // visitor never meant to ask.
      try { recognition.abort(); } catch { /* not running */ }
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      stopListening();
    }

    function beginHandsFree() {
      if (handsFree) return;
      handsFree = true;
      silentRounds = 0;
      if (onResumeHint) onResumeHint(null);
      try { sessionStorage.setItem(VOICE_INTENT_KEY, '1'); } catch { /* storage disabled */ }
      // The point of the mode is a spoken conversation, so replies are
      // read aloud while it is on even if the visitor had voice output
      // switched off for typing. The stored preference is left alone --
      // ending the mode restores whatever they had chosen.
      if (!voiceOutputEnabled && window.speechSynthesis) {
        voiceOutputEnabled = true;
        updateVoiceToggleUI();
      }
      startListening();
    }

    function toggleHandsFree() {
      if (handsFree) { endHandsFree(); return; }
      beginHandsFree();
    }
    voiceApi.isSupported = true;
    voiceApi.toggleHandsFree = toggleHandsFree;

    allMicEls.forEach((el) => {
      el.hidden = false;
      el.addEventListener('click', toggleHandsFree);
    });
    updateMicUI();

    recognition.addEventListener('result', (e) => {
      const transcript = (e.results[0][0].transcript || '').trim();
      stopListening();
      if (!transcript) return;
      const now = Date.now();
      if (transcript === lastTranscript && now - lastTranscriptAt < DUPLICATE_WINDOW_MS) return;
      lastTranscript = transcript;
      lastTranscriptAt = now;
      silentRounds = 0;
      sendMessage(transcript, {
        viaVoice: true,
        // Chained off the end of the spoken reply, so the next turn opens
        // the mic exactly when MAM stops talking -- never while it is
        // still speaking, which is what would feed its own voice back in.
        onReplySpoken: () => { if (handsFree) startListening(); },
        // A failed turn ends the mode: looping on an error would just
        // re-ask into a broken connection.
        onFailed: () => { if (handsFree) endHandsFree(); }
      });
    });

    recognition.addEventListener('end', () => {
      const wasListening = listening;
      stopListening();
      // Reached with no result = silence. Reopen the mic a few times, then
      // give up rather than listening indefinitely.
      if (!handsFree || !wasListening || sending) return;
      silentRounds += 1;
      if (silentRounds >= MAX_SILENT_ROUNDS) { endHandsFree(); return; }
      startListening();
    });

    recognition.addEventListener('error', (e) => {
      const kind = (e && e.error) || '';
      // 'no-speech' is ordinary silence and is handled by the end handler
      // that follows it -- not a failure worth telling anyone about.
      if (kind === 'no-speech') { stopListening(); return; }
      // 'aborted' is this module's own endHandsFree() calling abort();
      // reporting it would mean an error bubble on every deliberate stop.
      if (kind === 'aborted') { stopListening(); return; }
      endHandsFree();
      // Everything else is a real, distinct condition the visitor can act
      // on -- never a generic "voice failed".
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

    // ---- resuming voice after a page navigation (section J) -----------
    // The browser destroyed the previous page's microphone stream and its
    // SpeechRecognition object along with the document -- nothing can
    // carry those across, and this module does not pretend otherwise.
    // What did survive is the session, the conversation and the INTENT.
    //
    // Autostarting from that intent alone would be wrong twice over: most
    // browsers refuse to open a microphone without a user gesture on the
    // new document, and silently reopening a mic on a page the visitor
    // merely navigated to is not something to do behind their back. So
    // the dock says voice is paused and one tap resumes it.
    let carriedVoiceIntent = false;
    try { carriedVoiceIntent = sessionStorage.getItem(VOICE_INTENT_KEY) === '1'; } catch { /* storage disabled */ }
    if (carriedVoiceIntent && onResumeHint) {
      onResumeHint(tr('mam.voiceResume', 'Voice mode is paused — tap the microphone to continue talking.'));
    }
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
    isVoiceSupported: voiceApi.isSupported
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
