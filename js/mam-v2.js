// MAM Intelligence V2 -- frontend controller for mam-ai.html.
//
// This module talks to exactly one backend endpoint (js/mam-api.js ->
// POST /api/v1/mam/chat, backend/app/mam/routes.py) and renders exactly
// what that endpoint returns -- a typed ChatResponse (message, cards,
// comparison, mapAction, suggestedActions, degraded, sessionId). It
// NEVER computes an answer itself: there is no keyword table, no fake
// "AI valuation," and no client-side Firestore query for market data
// here -- every fact on this page came from a backend tool call. See
// docs/MAM_V2_ARCHITECTURE.md for the full request/response contract
// and the reasoning behind this split.
//
// Rendering is deliberately conservative: model/backend text is never
// inserted as HTML -- every dynamic value reaches the DOM via
// textContent/element properties, never string-built innerHTML, so
// there is no template-string path a malicious value could escape out
// of in the first place.
import { auth } from './firebase-init.js';
import { sendMamChat, BackendUnavailableError, BackendResponseError } from './mam-api.js';
import { MamCompanion } from './mam-companion.js';

// ---- Constants -------------------------------------------------------
const MAX_MESSAGE_LENGTH = 1000; // mirrors backend/app/mam/schemas.py MAX_MESSAGE_LENGTH
const SESSION_KEY = 'darwesh_mam_session_id';
const VOICE_OUTPUT_KEY = 'darwesh_mamai_voice_output'; // kept from the legacy MAM so an existing preference survives the rebuild
const SPEECH_RATE_KEY = 'darwesh_mam_speech_rate';
const SPEECH_NOTE_SHOWN_KEY = 'darwesh_mam_speech_fallback_noted';

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

// ---- DOM refs ----------------------------------------------------------
const chatLog = document.getElementById('chatLog');
const chatScroll = document.getElementById('chatScroll');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('mamSendBtn');
const mamSheet = document.getElementById('mamSheet');
const mamSheetBackdrop = document.getElementById('mamSheetBackdrop');
const mamSheetContent = document.getElementById('mamSheetContent');
const mamSheetClose = document.getElementById('mamSheetClose');

// ---- Session -------------------------------------------------------------
function getSessionId() { return sessionStorage.getItem(SESSION_KEY) || ''; }
function setSessionId(id) { if (id) sessionStorage.setItem(SESSION_KEY, id); }

// ---- Page context (section 5) --------------------------------------------
// Structured, backend-validated context only -- never arbitrary DOM or
// full page HTML (schemas.KNOWN_PAGES on the backend is the source of
// truth for which `page` values are honored; anything else is treated
// as absent server-side, so a bad/unexpected value here is harmless).
// Read once from the URL a visitor arrived with -- e.g. a future
// "Ask MAM about this property" link from listing.html would set
// page=property&listingId=<id>. No page in this repo sends these yet
// (only index.html's search box passes `q`, kept below for continuity);
// this is the honest, real receiving-end implementation described in
// docs/MAM_V2_ARCHITECTURE.md, ready for outbound links to adopt.
function readPageContext() {
  const p = new URLSearchParams(window.location.search);
  const page = p.get('page');
  const ctx = {};
  if (page) ctx.page = page;
  if (p.get('listingId')) ctx.listingId = p.get('listingId');
  if (p.get('projectId')) ctx.projectId = p.get('projectId');
  if (p.get('professionalId')) ctx.professionalId = p.get('professionalId');
  if (p.get('serviceType')) ctx.serviceType = p.get('serviceType');
  return ctx;
}

// ---- MAM visual identity (section 3) --------------------------------------
// idle | listening | thinking | speaking | result-ready | error
// The companion is a decoupled module (js/mam-companion.js + css/mam-
// companion.css) -- this page just owns telling it what state to be in,
// exactly as any future page mounting the same module would.
const mamCompanion = new MamCompanion({ getLanguage: currentLang });
function setMamState(state) { mamCompanion.setState(state); }

// ---- Chat log rendering ----------------------------------------------------
function scrollToBottom() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function addUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'flex justify-end';
  const bubble = document.createElement('div');
  bubble.className = 'mam-bubble mam-bubble-user';
  const p = document.createElement('p');
  p.className = 'font-body-md text-body-md';
  p.textContent = text;
  bubble.appendChild(p);
  row.appendChild(bubble);
  chatLog.appendChild(row);
  scrollToBottom();
}

function mamAvatar() {
  const el = document.createElement('div');
  el.className = 'mam-mini-orb';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function addAssistantMessage(data, { failed = false, retryText = null } = {}) {
  const row = document.createElement('div');
  row.className = 'flex items-start gap-3';
  row.appendChild(mamAvatar());

  const bubble = document.createElement('div');
  bubble.className = 'mam-bubble mam-bubble-assistant' + (failed ? ' mam-bubble-error' : '');
  if (data.degraded) bubble.classList.add('mam-bubble-degraded');

  if (data.message) {
    const p = document.createElement('p');
    p.className = 'font-body-md text-body-md text-on-surface';
    p.textContent = data.message;
    bubble.appendChild(p);
  }

  if (retryText) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'mam-retry-btn';
    retryBtn.textContent = tr('mam.retry', 'Try again');
    retryBtn.addEventListener('click', () => { retryBtn.disabled = true; sendMessage(retryText); });
    bubble.appendChild(retryBtn);
  }

  const hasResults = (data.cards && data.cards.length) || data.comparison || data.mapAction || (data.suggestedActions && data.suggestedActions.length);
  if (hasResults) {
    const inline = document.createElement('div');
    inline.className = 'mam-inline-results';
    renderResultsInto(inline, data, { compact: true });
    bubble.appendChild(inline);
    setMamState('result-ready');
  }

  row.appendChild(bubble);
  chatLog.appendChild(row);
  scrollToBottom();
  if (!failed) speakReply(data.message);
}

let thinkingEl = null;
function showThinking() {
  if (thinkingEl) return;
  setMamState('thinking');
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'flex items-start gap-3';
  thinkingEl.appendChild(mamAvatar());
  const bubble = document.createElement('div');
  bubble.className = 'mam-bubble mam-bubble-assistant mam-thinking';
  bubble.setAttribute('aria-label', tr('mam.orbThinking', 'MAM is thinking'));
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'mam-thinking-dot';
    bubble.appendChild(dot);
  }
  thinkingEl.appendChild(bubble);
  chatLog.appendChild(thinkingEl);
  scrollToBottom();
}
function hideThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

// ---- Structured result rendering (section 4) -------------------------------
// Renders ONLY what the backend actually returned -- there is no branch
// here that invents a card, a stat, or a filler row when a block is
// absent. Every field is inserted via textContent/DOM properties, never
// innerHTML, so a malicious listing title/professional bio (already
// delimited server-side as untrusted text -- see policy.wrap_untrusted)
// can never execute as markup here even if that boundary were somehow
// bypassed upstream -- defense in depth, not the only safeguard.

function statPill(labelKey, labelFallback, value) {
  const el = document.createElement('div');
  el.className = 'mam-pill';
  const l = document.createElement('span');
  l.className = 'mam-pill-label';
  l.textContent = tr(labelKey, labelFallback);
  const v = document.createElement('span');
  v.className = 'mam-pill-value';
  v.textContent = value;
  el.appendChild(l);
  el.appendChild(v);
  return el;
}

function buildPropertyCard(card) {
  const el = document.createElement('article');
  el.className = 'mam-card';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', trf('mam.cardOpenProperty', 'Open details for {title}', { title: card.title || tr('mam.property', 'Property') }));

  const media = document.createElement('div');
  media.className = 'mam-card-media';
  if (card.imageUrl) {
    const img = document.createElement('img');
    img.src = card.imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    media.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = 'home_work';
    media.appendChild(icon);
  }
  if (card.verified) {
    const badge = document.createElement('span');
    badge.className = 'mam-card-badge';
    badge.textContent = tr('mam.verified', 'Verified');
    media.appendChild(badge);
  }
  el.appendChild(media);

  const body = document.createElement('div');
  body.className = 'mam-card-body';
  const title = document.createElement('p');
  title.className = 'mam-card-title';
  title.textContent = card.title || tr('mam.property', 'Property');
  body.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'mam-card-meta';
  const parts = [];
  if (card.city) parts.push(card.city);
  if (card.beds) parts.push(trf('mam.beds', '{n} bd', { n: card.beds }));
  meta.textContent = parts.join(' · ');
  body.appendChild(meta);

  const price = fmtPrice(card.price, card.currency);
  if (price) {
    const priceEl = document.createElement('p');
    priceEl.className = 'mam-card-price';
    priceEl.textContent = price + (card.dealType === 'rent' ? tr('mam.perMonth', ' / mo') : '');
    body.appendChild(priceEl);
  }
  el.appendChild(body);

  const openDetail = () => openPropertySheet(card);
  el.addEventListener('click', openDetail);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); } });
  return el;
}

function buildProjectCard(card) {
  const el = document.createElement('article');
  el.className = 'mam-card mam-card-project';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', trf('mam.cardOpenProject', 'Open details for {name}', { name: card.name || tr('mam.project', 'Project') }));

  const media = document.createElement('div');
  media.className = 'mam-card-media';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.textContent = 'apartment';
  media.appendChild(icon);
  if (card.verified) {
    const badge = document.createElement('span');
    badge.className = 'mam-card-badge';
    badge.textContent = tr('mam.verified', 'Verified');
    media.appendChild(badge);
  }
  el.appendChild(media);

  const body = document.createElement('div');
  body.className = 'mam-card-body';
  const title = document.createElement('p');
  title.className = 'mam-card-title';
  title.textContent = card.name || tr('mam.project', 'Project');
  body.appendChild(title);
  const meta = document.createElement('p');
  meta.className = 'mam-card-meta';
  const parts = [];
  if (card.city) parts.push(card.city);
  if (card.constructionStatus) parts.push(card.constructionStatus);
  meta.textContent = parts.join(' · ');
  body.appendChild(meta);
  const price = fmtPrice(card.startingPrice, card.currency);
  if (price) {
    const priceEl = document.createElement('p');
    priceEl.className = 'mam-card-price';
    priceEl.textContent = trf('mam.startingFrom', 'From {p}', { p: price });
    body.appendChild(priceEl);
  }
  el.appendChild(body);

  const openDetail = () => openProjectSheet(card);
  el.addEventListener('click', openDetail);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); } });
  return el;
}

function buildProfessionalCard(card) {
  const el = document.createElement('article');
  el.className = 'mam-card mam-card-professional';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', trf('mam.cardOpenProfessional', 'Open profile for {name}', { name: card.displayName || tr('mam.professional', 'Professional') }));

  const media = document.createElement('div');
  media.className = 'mam-card-media mam-card-media-round';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.textContent = 'engineering';
  media.appendChild(icon);
  el.appendChild(media);

  const body = document.createElement('div');
  body.className = 'mam-card-body';
  const title = document.createElement('p');
  title.className = 'mam-card-title';
  title.textContent = card.displayName || tr('mam.professional', 'Professional');
  body.appendChild(title);
  const meta = document.createElement('p');
  meta.className = 'mam-card-meta';
  const parts = [card.serviceType];
  if (card.city) parts.push(card.city);
  meta.textContent = parts.filter(Boolean).join(' · ');
  body.appendChild(meta);
  if (card.verified) {
    const badge = document.createElement('span');
    badge.className = 'mam-card-badge mam-card-badge-inline';
    badge.textContent = tr('mam.verified', 'Verified');
    body.appendChild(badge);
  }
  el.appendChild(body);

  const openDetail = () => openProfessionalSheet(card);
  el.addEventListener('click', openDetail);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); } });
  return el;
}

function buildComparisonBlock(comparison) {
  if (!comparison) return null;
  if (comparison.marketSummary) {
    const s = comparison.marketSummary;
    const el = document.createElement('div');
    el.className = 'mam-stat-grid';
    if (typeof s.count === 'number') el.appendChild(statPill('mam.statListings', 'Listings', String(s.count)));
    if (typeof s.saleCount === 'number' && s.saleCount) el.appendChild(statPill('mam.statForSale', 'For sale', String(s.saleCount)));
    const min = fmtPrice(s.min); if (min) el.appendChild(statPill('mam.statMin', 'From', min));
    const max = fmtPrice(s.max); if (max) el.appendChild(statPill('mam.statMax', 'Up to', max));
    return el.childElementCount ? el : null;
  }
  if (comparison.items) return null; // already represented by the compared property cards themselves
  // Generic passthrough for any other tool result -- a conservative,
  // labeled key/value readout so nothing the backend sent is silently
  // dropped, without ever rendering it as markup.
  const keys = Object.keys(comparison);
  if (!keys.length) return null;
  const el = document.createElement('dl');
  el.className = 'mam-kv';
  keys.forEach((k) => {
    const v = comparison[k];
    if (v == null || typeof v === 'object') return;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    el.appendChild(dt); el.appendChild(dd);
  });
  return el.childElementCount ? el : null;
}

function buildMapActionButton(mapAction) {
  if (!mapAction) return null;
  const params = new URLSearchParams();
  // mapAction.filters uses the shared deal/q/types/maxPrice/beds/verified
  // vocabulary (backend/app/mam/orchestrator.py's _search_filters_action
  // and Tools.open_on_map both build it) -- translated here into
  // map.html's own actual URL param names (?type=/?city=) since this is
  // the one consumer that navigates via a real link rather than applying
  // filters to an already-open page in place.
  if (mapAction.filters && mapAction.filters.deal === 'rent') params.set('type', 'rent');
  if (mapAction.filters && mapAction.filters.q) params.set('city', mapAction.filters.q);
  const btn = document.createElement('a');
  btn.className = 'mam-action-btn';
  btn.href = mapAction.target + (params.toString() ? '?' + params.toString() : '');
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.textContent = 'map';
  btn.appendChild(icon);
  const label = document.createElement('span');
  label.textContent = tr('mam.openMap', 'Open on the map');
  btn.appendChild(label);
  return btn;
}

// Only ever renders an action whose destination this frontend can
// actually resolve to a real page -- an action type/payload this build
// doesn't know how to route to becomes a no-op (skipped entirely)
// rather than a dead '#' link, since a suggested action is a navigation
// aid, not a content claim that must always be shown.
function resolveActionHref(a) {
  if (a.action === 'open_url' && a.payload && typeof a.payload.url === 'string') return a.payload.url;
  if (a.action === 'open_map') return 'map.html';
  if (a.action === 'open_listing' && a.payload && a.payload.listingId) return 'listing.html?id=' + encodeURIComponent(a.payload.listingId);
  return null;
}
function buildSuggestedActions(actions) {
  if (!actions || !actions.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'mam-suggested-actions';
  actions.forEach((a) => {
    const href = resolveActionHref(a);
    if (!href) return;
    const btn = document.createElement('a');
    btn.className = 'mam-action-chip';
    btn.textContent = tr(a.labelKey, a.labelFallback);
    btn.href = href;
    wrap.appendChild(btn);
  });
  return wrap.childElementCount ? wrap : null;
}

function renderResultsInto(container, data, { compact }) {
  container.innerHTML = '';
  if (data.cards && data.cards.length) {
    const grid = document.createElement('div');
    grid.className = compact ? 'mam-card-row' : 'mam-card-grid';
    data.cards.forEach((card) => {
      let el;
      if (card.kind === 'project') el = buildProjectCard(card);
      else if (card.kind === 'professional') el = buildProfessionalCard(card);
      else el = buildPropertyCard(card);
      grid.appendChild(el);
    });
    container.appendChild(grid);
  }
  const cmp = buildComparisonBlock(data.comparison);
  if (cmp) container.appendChild(cmp);
  const mapBtn = buildMapActionButton(data.mapAction);
  if (mapBtn) container.appendChild(mapBtn);
  const suggested = buildSuggestedActions(data.suggestedActions);
  if (suggested) container.appendChild(suggested);
}

// ---- Detail bottom sheet (mobile-first, useful at any width) --------------
let sheetTrigger = null;
function openSheet(buildContent) {
  sheetTrigger = document.activeElement;
  mamSheetContent.innerHTML = '';
  mamSheetContent.appendChild(buildContent());
  mamSheet.classList.remove('hidden');
  mamSheetBackdrop.classList.remove('hidden');
  requestAnimationFrame(() => mamSheet.classList.add('mam-sheet-open'));
  mamSheetClose.focus();
  document.addEventListener('keydown', onSheetKeydown);
}
function closeSheet() {
  mamSheet.classList.remove('mam-sheet-open');
  document.removeEventListener('keydown', onSheetKeydown);
  setTimeout(() => {
    mamSheet.classList.add('hidden');
    mamSheetBackdrop.classList.add('hidden');
  }, 220);
  if (sheetTrigger && typeof sheetTrigger.focus === 'function') sheetTrigger.focus();
}
function onSheetKeydown(e) {
  if (e.key === 'Escape') { closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const focusable = mamSheet.querySelectorAll('button, a[href]');
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
mamSheetClose && mamSheetClose.addEventListener('click', closeSheet);
mamSheetBackdrop && mamSheetBackdrop.addEventListener('click', closeSheet);

function sheetActionRow(actions) {
  const row = document.createElement('div');
  row.className = 'mam-sheet-actions';
  actions.forEach(({ label, href }) => {
    const a = document.createElement('a');
    a.className = 'mam-action-btn';
    a.href = href;
    a.textContent = label;
    row.appendChild(a);
  });
  return row;
}

function openPropertySheet(card) {
  openSheet(() => {
    const wrap = document.createElement('div');
    wrap.appendChild(buildPropertyCard(card));
    const actions = [{ label: tr('mam.viewListing', 'View full listing'), href: 'listing.html?id=' + encodeURIComponent(card.listingId) }];
    if (card.city) {
      const p = new URLSearchParams();
      if (card.dealType === 'rent') p.set('type', 'rent');
      p.set('city', card.city);
      actions.push({ label: tr('mam.openMap', 'Open on the map'), href: 'map.html?' + p.toString() });
    }
    wrap.appendChild(sheetActionRow(actions));
    return wrap;
  });
}
function openProjectSheet(card) {
  openSheet(() => {
    const wrap = document.createElement('div');
    wrap.appendChild(buildProjectCard(card));
    const actions = [];
    if (card.city) {
      const p = new URLSearchParams(); p.set('city', card.city);
      actions.push({ label: tr('mam.openMap', 'Open on the map'), href: 'map.html?' + p.toString() });
    }
    if (actions.length) wrap.appendChild(sheetActionRow(actions));
    return wrap;
  });
}
function openProfessionalSheet(card) {
  openSheet(() => {
    const wrap = document.createElement('div');
    wrap.appendChild(buildProfessionalCard(card));
    const page = { engineer: 'engineer.html', designer: 'designer.html', lawyer: 'lawyer.html', landscaping: 'landscaping.html', cleaning: 'cleaning.html' }[card.serviceType];
    if (page) {
      wrap.appendChild(sheetActionRow([{ label: tr('mam.viewProfile', 'View profile'), href: page + '?id=' + encodeURIComponent(card.providerId) }]));
    }
    return wrap;
  });
}

// ---- Sending a turn (sections 6, 9) ----------------------------------------
let sending = false;
let pendingController = null;

function setSendingState(isSending) {
  sending = isSending;
  chatInput.disabled = isSending;
  sendBtn.disabled = isSending;
  sendBtn.setAttribute('aria-busy', String(isSending));
}

async function sendMessage(rawText) {
  const text = (rawText || '').trim();
  if (!text || sending) return; // send-dedup: a second submit while one is in flight is ignored, not queued
  if (text.length > MAX_MESSAGE_LENGTH) {
    addAssistantMessage({ message: trf('mam.tooLong', 'That message is too long (max {n} characters).', { n: MAX_MESSAGE_LENGTH }), language: currentLang() });
    return;
  }
  document.getElementById('mamSuggestedPrompts')?.remove();

  // A newer send always wins -- abort whatever the previous turn's
  // request is still doing so a stale response can never render after
  // a fresher one.
  if (pendingController) pendingController.abort();
  pendingController = new AbortController();
  const thisController = pendingController;

  addUserMessage(text);
  chatInput.value = '';
  setSendingState(true);
  showThinking();

  try {
    const data = await sendMamChat(
      { message: text, language: currentLang(), sessionId: getSessionId(), pageContext: readPageContext() },
      { user: auth.currentUser, signal: thisController.signal }
    );
    if (thisController.signal.aborted) return; // superseded by a newer send
    hideThinking();
    if (data.sessionId) setSessionId(data.sessionId);
    addAssistantMessage(data);
  } catch (err) {
    if (thisController.signal.aborted) { hideThinking(); return; } // cancelled -- nothing to show
    hideThinking();
    setMamState('error');
    if (err instanceof BackendResponseError && err.status === 429) {
      addAssistantMessage({ message: tr('mam.rateLimited', "You're sending messages a little fast -- please wait a moment and try again."), language: currentLang() }, { failed: true, retryText: text });
    } else if (err instanceof BackendResponseError) {
      // Never surface err.message here -- it's the raw backend string
      // (often literally "Request failed."), not translated, user-facing
      // copy. Always use the translated generic message instead, exactly
      // like every other branch in this catch block.
      addAssistantMessage({ message: tr('mam.genericError', "That didn't go through. Please try again."), language: currentLang() }, { failed: true, retryText: text });
    } else if (err && err.name === 'AbortError') {
      addAssistantMessage({ message: tr('mam.timeout', 'That took too long to answer. Please try again.'), language: currentLang() }, { failed: true, retryText: text });
    } else if (err instanceof BackendUnavailableError) {
      addAssistantMessage({ message: tr('mam.offline', "I couldn't reach the Darwesh server. Check your connection and try again."), language: currentLang() }, { failed: true, retryText: text });
    } else {
      addAssistantMessage({ message: tr('mam.genericError', "That didn't go through. Please try again."), language: currentLang() }, { failed: true, retryText: text });
    }
  } finally {
    if (pendingController === thisController) {
      setSendingState(false);
      pendingController = null;
    }
  }
}

chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(chatInput.value); });
document.querySelectorAll('.mam-prompt-chip').forEach((btn) => btn.addEventListener('click', () => sendMessage(btn.textContent)));

// ---- Voice: simplified fallback (sections 7, 8) ----------------------------
// Browser STT/TTS only, used strictly as a graceful fallback -- there is
// no dedicated Kurdish voice provider selected yet (see
// docs/MAM_SORANI_BENCHMARK.md and docs/MAM_V2_ARCHITECTURE.md). If
// neither API exists on this device/browser, the text experience above
// is already fully functional on its own -- nothing below is required
// for MAM to work.
function speechLangTag() {
  const lang = currentLang();
  return (lang === 'ar' || lang === 'ku') ? 'ar-IQ' : 'en-US';
}
function speechVoiceLangCandidates() {
  const lang = currentLang();
  if (lang === 'ku') return ['ku', 'ckb', 'kmr', 'ar'];
  if (lang === 'ar') return ['ar'];
  return ['en'];
}
let cachedVoices = [];
function refreshVoices() { cachedVoices = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) {
  refreshVoices();
  window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
}
const VOICE_QUALITY_HINTS = ['google', 'natural', 'neural', 'online', 'premium', 'enhanced', 'wavenet'];
function voiceScore(v, primaryLang) {
  let score = 0;
  if (v.lang.toLowerCase().startsWith(primaryLang)) score += 10;
  if (VOICE_QUALITY_HINTS.some((h) => v.name.toLowerCase().includes(h))) score += 5;
  if (!v.localService) score += 2;
  return score;
}
function pickVoice(langCandidates) {
  if (!cachedVoices.length) return null;
  for (const prefix of langCandidates) {
    const matching = cachedVoices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
    if (matching.length) return matching.slice().sort((a, b) => voiceScore(b, prefix) - voiceScore(a, prefix))[0];
  }
  const en = cachedVoices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  return en.length ? en.slice().sort((a, b) => voiceScore(b, 'en') - voiceScore(a, 'en'))[0] : null;
}

let voiceOutputEnabled = localStorage.getItem(VOICE_OUTPUT_KEY) === '1';
const voiceOutputToggle = document.getElementById('voiceOutputToggle');
const voiceOutputIcon = document.getElementById('voiceOutputIcon');
const speechRateInput = document.getElementById('mamSpeechRate');
const speechFallbackNote = document.getElementById('mamSpeechFallbackNote');

function speechRate() {
  const v = parseFloat(localStorage.getItem(SPEECH_RATE_KEY));
  return Number.isFinite(v) && v >= 0.75 && v <= 1.25 ? v : 1;
}
function updateVoiceOutputIcon() {
  if (!voiceOutputIcon) return;
  voiceOutputIcon.textContent = voiceOutputEnabled ? 'volume_up' : 'volume_off';
  voiceOutputToggle.classList.toggle('text-secondary', voiceOutputEnabled);
  voiceOutputToggle.setAttribute('aria-pressed', String(voiceOutputEnabled));
}

function speakReply(text) {
  if (!voiceOutputEnabled || !window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = speechRate();
  const candidates = speechVoiceLangCandidates();
  const voice = pickVoice(candidates);
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
  else utterance.lang = candidates[0] === 'en' ? 'en-US' : 'ar-IQ';

  // Honest Kurdish-fallback disclosure (never label Arabic pronunciation
  // as native Kurdish TTS) -- shown once per session, not on every reply.
  if (currentLang() === 'ku' && utterance.lang.toLowerCase().startsWith('ar') && speechFallbackNote && !sessionStorage.getItem(SPEECH_NOTE_SHOWN_KEY)) {
    speechFallbackNote.textContent = tr('mam.speechFallbackNote', 'No Kurdish voice was found on this device -- using an Arabic voice to read replies aloud, which will not sound like native Kurdish.');
    speechFallbackNote.classList.remove('hidden');
    sessionStorage.setItem(SPEECH_NOTE_SHOWN_KEY, '1');
  }

  utterance.addEventListener('start', () => { setMamState('speaking'); window.dispatchEvent(new CustomEvent('mam:speech-start')); });
  utterance.addEventListener('end', () => { setMamState('idle'); window.dispatchEvent(new CustomEvent('mam:speech-end')); });
  utterance.addEventListener('error', () => { setMamState('idle'); window.dispatchEvent(new CustomEvent('mam:speech-end')); });
  window.speechSynthesis.speak(utterance);
}

if (window.speechSynthesis && voiceOutputToggle) {
  voiceOutputToggle.classList.remove('hidden');
  updateVoiceOutputIcon();
  voiceOutputToggle.addEventListener('click', () => {
    voiceOutputEnabled = !voiceOutputEnabled;
    localStorage.setItem(VOICE_OUTPUT_KEY, voiceOutputEnabled ? '1' : '0');
    updateVoiceOutputIcon();
    if (!voiceOutputEnabled) { window.speechSynthesis.cancel(); window.dispatchEvent(new CustomEvent('mam:speech-end')); }
  });
}
if (speechRateInput) {
  speechRateInput.value = String(speechRate());
  speechRateInput.addEventListener('change', () => localStorage.setItem(SPEECH_RATE_KEY, speechRateInput.value));
}

const micBtn = document.getElementById('micBtn');
const micStatus = document.getElementById('micStatus');
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognitionCtor && micBtn) {
  const recognition = new SpeechRecognitionCtor();
  recognition.continuous = false;
  recognition.interimResults = false;
  let listening = false;

  function stopListening() {
    listening = false;
    micBtn.classList.remove('mic-listening');
    micStatus.classList.add('hidden');
    if (mamCompanion.getState() === 'listening') setMamState('idle');
  }

  micBtn.classList.remove('hidden');
  micBtn.classList.add('flex');
  micBtn.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    if (window.speechSynthesis) window.speechSynthesis.cancel(); // avoid the mic picking up MAM's own voice as new input
    recognition.lang = speechLangTag();
    try {
      recognition.start();
      listening = true;
      micBtn.classList.add('mic-listening');
      micStatus.classList.remove('hidden');
      setMamState('listening');
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

// ---- Initial load ----------------------------------------------------------
const initialQuery = new URLSearchParams(window.location.search).get('q');
if (initialQuery) sendMessage(initialQuery);
