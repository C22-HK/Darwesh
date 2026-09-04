// MAM AI -- the ONLY user-facing MAM surface, living on the ONE public
// Properties Map (map.html) rather than a map of its own. (The former
// standalone mam-ai.html page and its js/mam-v2.js controller were
// removed once this became the single surface.) This module never re-implements property search: every reply
// comes from the exact same backend endpoint/tools mam-v2.js already
// used (POST /api/v1/mam/chat via js/mam-api.js), and the ONLY way a
// reply changes what's on screen is by calling window.DarweshPropertiesMap
// (defined in map.html's own inline script) with the same deal/q/types/
// minPrice/maxPrice/beds filter keys backend/app/mam/orchestrator.py's
// _search_filters_action and Tools.open_on_map both already use -- there
// is no second, AI-only search implementation here.
//
// Like mam-v2.js, rendering never inserts backend/model text as HTML --
// every dynamic value reaches the DOM via textContent/element properties.
import { auth } from './firebase-init.js';
import { sendMamChat, BackendUnavailableError, BackendResponseError } from './mam-api.js';
import { MamCompanion } from './mam-companion.js';

const MAX_MESSAGE_LENGTH = 1000;
const SESSION_KEY = 'darwesh_mam_properties_session_id';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  let s = tr(key, fallback);
  if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
  return s;
}
function currentLang() { return localStorage.getItem('darwesh_lang') || 'en'; }
function fmtPrice(p, currency) {
  if (typeof p !== 'number' || Number.isNaN(p)) return null;
  const symbol = currency === 'IQD' ? 'IQD ' : '$';
  return symbol + Math.round(p).toLocaleString();
}
function getSessionId() { return sessionStorage.getItem(SESSION_KEY) || ''; }
function setSessionId(id) { if (id) sessionStorage.setItem(SESSION_KEY, id); }

// Structured context a visitor arrived with -- from the site-wide MAM
// companion launcher (js/mam-companion-launcher.js) routing here from
// another page, e.g. map.html?mam=1&page=property&listingId=xyz -- the
// SAME URL-param contract mam-ai.html's own readPageContext() already
// used, backend/app/mam/schemas.py's KNOWN_PAGES is the source of truth
// for valid `page` values. Read once at load; every turn sent from this
// page reuses it (never re-scraped, never trusted beyond these IDs --
// see policy.py's server-side re-validation). Falls back to this page's
// own identity ('properties_map') when nothing more specific was passed
// in, exactly like the pre-existing behavior.
function incomingPageContext() {
  const p = new URLSearchParams(window.location.search);
  const page = p.get('page');
  if (!page) return { page: 'properties_map' };
  const ctx = { page };
  if (p.get('listingId')) ctx.listingId = p.get('listingId');
  if (p.get('projectId')) ctx.projectId = p.get('projectId');
  if (p.get('professionalId')) ctx.professionalId = p.get('professionalId');
  if (p.get('serviceType')) ctx.serviceType = p.get('serviceType');
  return ctx;
}

// ---- DOM refs --------------------------------------------------------
const wrap = document.getElementById('drmAiWrap');
const chipsEl = document.getElementById('drmAiChips');
const form = document.getElementById('drmAiForm');
const input = document.getElementById('drmAiInput');
const sendBtn = document.getElementById('drmAiSendBtn');
const panel = document.getElementById('drmAiPanel');
const log = document.getElementById('drmAiLog');
const closeBtn = document.getElementById('drmAiCloseBtn');
const micBtn = document.getElementById('drmAiMicBtn');
const micIcon = document.getElementById('drmAiMicIcon');

if (!wrap || !form) {
  // Defensive -- this module is only ever loaded from map.html, which
  // always has this markup, but never crash a page over a missing
  // optional widget.
  console.error('[mam-properties-map] expected DOM not found -- AI dock disabled');
} else {
  init();
}

function init() {
  const companion = new MamCompanion({ getLanguage: currentLang, interactive: true });
  // The companion is an ambient AI-availability indicator here, not a
  // launcher to a separate page (there is no standalone MAM page to
  // launch to anymore) -- clicking it just focuses/opens this page's own
  // AI dock. mam-companion.js doesn't expose its DOM node, so this
  // queries for the one instance this page ever mounts, the same way
  // any host page would.
  const companionOrb = document.querySelector('.mamco-orb');
  if (companionOrb) {
    companionOrb.style.cursor = 'pointer';
    companionOrb.addEventListener('click', () => { openPanel(); input.focus(); });
  }

  // ---- Suggested prompts (section: contextual, never fabricated) ------
  const CHIPS = [
    ['drm.ai.chip1', 'Houses for sale in Erbil'],
    ['drm.ai.chip2', 'Apartments for rent in Kirkuk'],
    ['drm.ai.chip3', 'Under 150 million'],
    ['drm.ai.chip4', '3 bedrooms'],
  ];
  CHIPS.forEach(([key, fallback]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drm-ai-chip';
    btn.textContent = tr(key, fallback);
    btn.addEventListener('click', () => sendMessage(btn.textContent));
    chipsEl.appendChild(btn);
  });

  function openPanel() {
    panel.classList.remove('hidden');
    chipsEl.classList.add('hidden');
  }
  function closePanel() {
    panel.classList.add('hidden');
    if (!log.childElementCount) chipsEl.classList.remove('hidden');
  }
  closeBtn.addEventListener('click', closePanel);

  function scrollLogToBottom() { log.scrollTop = log.scrollHeight; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'drm-ai-bubble drm-ai-bubble-user';
    b.textContent = text;
    log.appendChild(b);
    scrollLogToBottom();
  }

  function buildRefCard(card) {
    const a = document.createElement('a');
    a.className = 'drm-ai-ref-card';
    if (card.kind === 'property') {
      a.href = 'listing.html?id=' + encodeURIComponent(card.listingId);
      const media = document.createElement('div');
      media.className = 'drm-ai-ref-card-media';
      if (card.imageUrl) {
        const img = document.createElement('img');
        img.src = card.imageUrl;
        img.alt = '';
        img.loading = 'lazy';
        media.appendChild(img);
      }
      a.appendChild(media);
      const body = document.createElement('div');
      body.className = 'drm-ai-ref-card-body';
      const title = document.createElement('p');
      title.className = 'drm-ai-ref-card-title';
      title.textContent = card.title || tr('mam.property', 'Property');
      body.appendChild(title);
      const price = fmtPrice(card.price, card.currency);
      if (price) {
        const priceEl = document.createElement('p');
        priceEl.className = 'drm-ai-ref-card-price';
        priceEl.textContent = price + (card.dealType === 'rent' ? tr('mam.perMonth', ' / mo') : '');
        body.appendChild(priceEl);
      }
      a.appendChild(body);
      return a;
    }
    if (card.kind === 'project') {
      a.href = 'map.html?city=' + encodeURIComponent(card.city || '');
      const body = document.createElement('div');
      body.className = 'drm-ai-ref-card-body';
      const title = document.createElement('p');
      title.className = 'drm-ai-ref-card-title';
      title.textContent = card.name || tr('mam.project', 'Project');
      body.appendChild(title);
      a.appendChild(body);
      return a;
    }
    return null; // professional/other kinds: no dedicated reference card in this compact context -- the reply text already covers it honestly
  }

  function addAssistantBubble(data, { failed = false, retryText = null } = {}) {
    const b = document.createElement('div');
    b.className = 'drm-ai-bubble drm-ai-bubble-assistant' + (failed ? ' drm-ai-bubble-error' : '');
    if (data.message) {
      const p = document.createElement('p');
      p.textContent = data.message;
      b.appendChild(p);
    }
    if (retryText) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'drm-ai-retry';
      retryBtn.textContent = tr('mam.retry', 'Try again');
      retryBtn.addEventListener('click', () => { retryBtn.disabled = true; sendMessage(retryText); });
      b.appendChild(retryBtn);
    }
    const cards = (data.cards || []).map(buildRefCard).filter(Boolean);
    if (cards.length) {
      const row = document.createElement('div');
      row.className = 'drm-ai-ref-cards';
      cards.forEach((c) => row.appendChild(c));
      b.appendChild(row);
    }
    log.appendChild(b);
    scrollLogToBottom();
  }

  let thinkingEl = null;
  function showThinking() {
    if (thinkingEl) return;
    companion.setState('thinking');
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'drm-ai-bubble drm-ai-bubble-assistant drm-ai-thinking';
    thinkingEl.setAttribute('aria-label', tr('mam.orbThinking', 'MAM is thinking'));
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'drm-ai-dot';
      thinkingEl.appendChild(dot);
    }
    log.appendChild(thinkingEl);
    scrollLogToBottom();
  }
  function hideThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  // ---- Applying MAM's reply onto the REAL page state -------------------
  // The single integration point with map.html's own script -- this
  // module never filters/searches listings itself.
  function applyMapAction(mapAction) {
    if (!mapAction || mapAction.target !== 'map.html') return;
    if (mapAction.filters && Object.keys(mapAction.filters).length &&
        window.DarweshPropertiesMap && typeof window.DarweshPropertiesMap.applyFilters === 'function') {
      window.DarweshPropertiesMap.applyFilters(mapAction.filters);
    }
    // MAM identifying one specific property (not just filters) centers
    // that real card in the property wheel -- reuses the same selection
    // state a click/marker/keyboard move already uses, never a second,
    // MAM-only card.
    if (mapAction.focusListingId && window.DarweshPropertiesMap && typeof window.DarweshPropertiesMap.focusListing === 'function') {
      window.DarweshPropertiesMap.focusListing(mapAction.focusListingId);
    }
  }

  // ---- Sending a turn ----------------------------------------------------
  let sending = false;
  let pendingController = null;
  function setSendingState(isSending) {
    sending = isSending;
    input.disabled = isSending;
    sendBtn.disabled = isSending;
    sendBtn.setAttribute('aria-busy', String(isSending));
  }

  async function sendMessage(rawText) {
    const text = (rawText || '').trim();
    if (!text || sending) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      openPanel();
      addAssistantBubble({ message: trf('mam.tooLong', 'That message is too long (max {n} characters).', { n: MAX_MESSAGE_LENGTH }) });
      return;
    }
    openPanel();

    if (pendingController) pendingController.abort();
    pendingController = new AbortController();
    const thisController = pendingController;

    addUserBubble(text);
    input.value = '';
    setSendingState(true);
    showThinking();

    try {
      const data = await sendMamChat(
        { message: text, language: currentLang(), sessionId: getSessionId(), pageContext: incomingPageContext() },
        { user: auth.currentUser, signal: thisController.signal }
      );
      if (thisController.signal.aborted) return;
      hideThinking();
      if (data.sessionId) setSessionId(data.sessionId);
      addAssistantBubble(data);
      applyMapAction(data.mapAction);
      companion.setState('result-ready');
    } catch (err) {
      if (thisController.signal.aborted) { hideThinking(); return; }
      hideThinking();
      companion.setState('error');
      // Preserve whatever is already on screen (filters/results untouched)
      // -- a failed AI turn never clears or resets the real search state.
      if (err instanceof BackendResponseError && err.status === 429) {
        addAssistantBubble({ message: tr('mam.rateLimited', "You're sending messages a little fast -- please wait a moment and try again.") }, { failed: true, retryText: text });
      } else if (err && err.name === 'AbortError') {
        addAssistantBubble({ message: tr('mam.timeout', 'That took too long to answer. Please try again.') }, { failed: true, retryText: text });
      } else if (err instanceof BackendUnavailableError) {
        addAssistantBubble({ message: tr('mam.offline', "I couldn't reach the Darwesh server. Check your connection and try again.") }, { failed: true, retryText: text });
      } else {
        // Includes any other BackendResponseError -- never the raw
        // backend string (err.message), always translated copy.
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
  input.addEventListener('focus', openPanel);

  // ---- Voice input (mic only -- simple, graceful fallback) --------------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognitionCtor && micBtn) {
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
    micBtn.classList.remove('hidden');
    micBtn.addEventListener('click', () => {
      if (listening) { recognition.stop(); return; }
      recognition.lang = speechLangTag();
      try {
        recognition.start();
        listening = true;
        micBtn.classList.add('mic-listening');
        companion.setState('listening');
        openPanel();
      } catch { stopListening(); }
    });
    recognition.addEventListener('result', (e) => {
      const transcript = e.results[0][0].transcript;
      stopListening();
      if (transcript && transcript.trim()) sendMessage(transcript);
    });
    recognition.addEventListener('end', stopListening);
    recognition.addEventListener('error', stopListening);
  }

  // ---- Entry points from elsewhere on the site (index.html's hero
  // search, services.html/about.html CTAs -- see js/site-header.js's
  // module docstring) -- ?ai=1 opens the panel, an accompanying ?q=
  // auto-sends it as the first message, exactly like the old standalone
  // mam-ai.html's own `?q=` handling did. --------------------------------
  const params = new URLSearchParams(window.location.search);
  if (params.get('ai') === '1' || params.get('mam') === '1') openPanel();
  const initialQuery = params.get('q');
  if (initialQuery) sendMessage(initialQuery);

  document.addEventListener('darwesh:langchange', () => {
    chipsEl.innerHTML = '';
    CHIPS.forEach(([key, fallback]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drm-ai-chip';
      btn.textContent = tr(key, fallback);
      btn.addEventListener('click', () => sendMessage(btn.textContent));
      chipsEl.appendChild(btn);
    });
  });
}
