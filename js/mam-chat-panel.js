// MAM site-wide chat panel -- the ONE local, non-navigating conversation
// surface mounted by js/mam-companion-launcher.js next to the shared orb
// (js/mam-companion.js) on every public page other than map.html (which
// keeps its own richer, request-lifecycle-aware dock -- see
// js/mam-properties-map.js -- clicking the orb there focuses that same
// panel rather than opening a second one). This module never implements
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
// Shared with js/mam-v2.js's own voice-output toggle -- the same on/off
// preference should follow the user across the legacy MAM chat and this
// panel rather than resetting per surface.
const VOICE_OUTPUT_KEY = 'darwesh_mamai_voice_output';

// Professional service-provider profile pages this frontend actually
// has -- the only real destinations an `open_professional` suggested
// action can ever resolve to. Mirrors js/mam-v2.js's own mapping
// (section: sheetActionRow professional links) so both surfaces agree
// on where a given serviceType's profile really lives.
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

/**
 * @param {Object} opts
 * @param {Element} opts.orbEl The orb itself -- this module wires its
 *   click/keyboard activation to open/toggle the panel; the caller
 *   never has to do that itself.
 * @param {import('./mam-companion.js').MamCompanion} opts.companion
 * @param {() => string} [opts.getLanguage]
 * @param {Object} opts.pageContext Structured, ID-only context (never
 *   scraped DOM) -- same shape as backend/app/mam/schemas.py's
 *   PageContext: {page, listingId?, projectId?, professionalId?, serviceType?}.
 */
export function mountMamChatPanel({ orbEl, companion, getLanguage, pageContext }) {
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
  function open() { panel.hidden = false; }
  function close() { panel.hidden = true; }
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
  // the same localStorage preference js/mam-v2.js already uses so it
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
  function speak(text) {
    if (!voiceOutputEnabled || !window.speechSynthesis || !text) return;
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
    utterance.addEventListener('start', () => companion.setState('speaking'));
    utterance.addEventListener('end', () => companion.setState('idle'));
    utterance.addEventListener('error', () => companion.setState('idle'));
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

  async function sendMessage(rawText, { viaVoice = false } = {}) {
    const text = (rawText || '').trim();
    if (!text || sending) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      open();
      addAssistantBubble({ message: trf('mam.tooLong', 'That message is too long (max {n} characters).', { n: MAX_MESSAGE_LENGTH }) });
      return;
    }
    open();
    lastTurnWasVoice = viaVoice;

    if (pendingController) pendingController.abort();
    pendingController = new AbortController();
    const thisController = pendingController;

    addUserBubble(text);
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
      applyMapAction(data.mapAction);
      companion.setState('result-ready');
      if (lastTurnWasVoice && data.message) speak(data.message);
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
    } finally {
      if (pendingController === thisController) {
        setSendingState(false);
        pendingController = null;
      }
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(input.value); });
  input.addEventListener('focus', open);

  // ---- Voice input (STT) -- browser SpeechRecognition only, the same
  // honest, graceful-fallback pattern already proven on map.html's own
  // dock (js/mam-properties-map.js): if the browser/platform has no
  // SpeechRecognition constructor, the mic button simply never appears
  // -- never a fake "listening" state with nothing behind it. There is
  // no dedicated Kurdish speech-recognition service wired up, so a
  // Sorani speaker's audio is sent using the closest available
  // recognition locale (ar-IQ) exactly like the existing map dock
  // already does; this is a known, reported limitation, not a claim of
  // native Kurdish STT. ---------------------------------------------------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognitionCtor) {
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    let listening = false;
    function speechLangTag() {
      const lang = currentLang();
      return (lang === 'ar' || lang === 'ku') ? 'ar-IQ' : 'en-US';
    }
    function stopListening() {
      listening = false;
      micBtn.classList.remove('mic-listening');
      if (companion.getState() === 'listening') companion.setState('idle');
    }
    micBtn.hidden = false;
    micBtn.addEventListener('click', () => {
      if (listening) { recognition.stop(); return; }
      if (window.speechSynthesis) window.speechSynthesis.cancel(); // don't let MAM's own voice be picked up as new input
      recognition.lang = speechLangTag();
      try {
        recognition.start();
        listening = true;
        micBtn.classList.add('mic-listening');
        companion.setState('listening');
        open();
      } catch { stopListening(); }
    });
    recognition.addEventListener('result', (e) => {
      const transcript = e.results[0][0].transcript;
      stopListening();
      if (transcript && transcript.trim()) sendMessage(transcript, { viaVoice: true });
    });
    recognition.addEventListener('end', stopListening);
    recognition.addEventListener('error', stopListening);
  }

  document.addEventListener('darwesh:langchange', () => {
    input.placeholder = tr('mam.inputPlaceholder', 'Ask MAM about the market…');
  });

  return { open, close, toggle, sendMessage };
}

function ensureStylesheet() {
  if (document.querySelector('link[data-mamcp-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/mam-chat-panel.css', import.meta.url).href;
  link.setAttribute('data-mamcp-style', '1');
  document.head.appendChild(link);
}
