// MAM AI Command Center -- the adaptive spatial question/card flow's
// RENDERER: DOM, materialize/select/dissolve animation, and the ONE
// click/tap/keyboard/voice interaction surface. This file owns NO
// business logic at all -- it never decides what question to ask next,
// never fills in a slot, never synthesizes a sentence, never talks to the
// backend. It only ever does two things: (1) show whatever question/
// choice list js/mam-chat-panel.js hands it, and (2) resolve a Promise
// the moment a visitor picks one, however they picked it. See
// js/mam-spatial-flows.js's own header comment for the full pipeline this
// is one stage of:
//
//   MAM conversation/intent -> missing-information resolver -> choice
//   model -> spatial-choice renderer (HERE) -> selection event ->
//   existing action registry
//
// CRITICAL, from the brief this was built against: "The same state/action
// handler must serve VOICE, CLICK, TAP, KEYBOARD. Do not create separate
// business logic for each modality." That one handler is resolveChoice()
// below -- a click/tap/Enter-key listener calls it directly; a spoken or
// typed answer reaches it only through trySelectFromText(), which does
// nothing but MATCH text to a choice (js/mam-spatial-flows.js's pure
// matchChoiceForQuestion(), zero DOM) and then calls the exact same
// resolveChoice(). There is exactly one path from "a choice was picked"
// to "the card animates and the Promise resolves," regardless of how the
// pick arrived.
import { matchChoiceForQuestion } from './mam-spatial-flows.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

const MATERIALIZE_STAGGER_MS = 70;
const DISSOLVE_MS = 420;
const MOBILE_QUERY = '(max-width: 640px)';
const CAROUSEL_SETTLE_MS = 140;

function isMobileViewport() {
  return !!(window.matchMedia && window.matchMedia(MOBILE_QUERY).matches);
}

// ---- mobile carousel "which card is centered" tracker -- PRESENTATION
// ONLY: it toggles which card LOOKS focused (css/mam-spatial-choice.css's
// .is-active-mobile/.is-settled) as the visitor swipes the native
// scroll-snap row. It never resolves a choice, never reorders the real
// data, and every card stays tappable/selectable at any scroll position
// through the exact same click/keydown listeners buildCard() already
// wires -- this only decides which one currently reads as "in focus".
function markActiveCard(row) {
  const cards = Array.from(row.children);
  if (!cards.length) return;
  const rowRect = row.getBoundingClientRect();
  const center = rowRect.left + rowRect.width / 2;
  let nearest = cards[0], nearestDist = Infinity;
  cards.forEach((card) => {
    const r = card.getBoundingClientRect();
    const dist = Math.abs((r.left + r.width / 2) - center);
    if (dist < nearestDist) { nearestDist = dist; nearest = card; }
  });
  const wasActiveId = row.dataset.activeChoiceId;
  cards.forEach((card) => card.classList.toggle('is-active-mobile', card === nearest));
  if (nearest.dataset.choiceId !== wasActiveId) {
    row.dataset.activeChoiceId = nearest.dataset.choiceId;
    // A small gold settle pulse ONLY on the card that just became active,
    // and only when the active card genuinely changed -- never on every
    // scroll tick, which would read as jittery rather than a deliberate
    // "it snapped into place" moment.
    nearest.classList.remove('is-settled');
    void nearest.offsetWidth;
    nearest.classList.add('is-settled');
  }
}

function ensureStylesheet() {
  if (document.querySelector('link[data-mam-spatial-choice-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/mam-spatial-choice.css', import.meta.url).href;
  link.setAttribute('data-mam-spatial-choice-style', '1');
  document.head.appendChild(link);
}

/**
 * @param {Object} opts
 * @param {Element} opts.hostEl Empty container the card row/question text
 *   renders into -- owned entirely by this module while a question is
 *   active, cleared between questions and on cancel/destroy.
 */
export function createSpatialChoice({ hostEl }) {
  ensureStylesheet();

  let activeQuestion = null;
  let activeChoices = [];
  let resolver = null;
  let cardEls = [];
  let root = null;
  let carouselSettleTimer = null;

  function clear() {
    clearTimeout(carouselSettleTimer);
    if (root) { root.remove(); root = null; }
    cardEls = [];
  }

  function buildBreadcrumb(list) {
    const strip = document.createElement('div');
    strip.className = 'mam-choice-breadcrumb';
    list.forEach((label) => {
      const node = document.createElement('span');
      node.className = 'mam-choice-breadcrumb-node';
      node.textContent = label;
      strip.appendChild(node);
    });
    return strip;
  }

  function focusCard(index) {
    const clamped = Math.max(0, Math.min(cardEls.length - 1, index));
    if (cardEls[clamped]) cardEls[clamped].focus();
  }

  function onCardKeydown(e, index) {
    const rtl = document.documentElement.dir === 'rtl';
    const nextKey = rtl ? 'ArrowLeft' : 'ArrowRight';
    const prevKey = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === nextKey || e.key === 'ArrowDown') { e.preventDefault(); focusCard(index + 1); }
    else if (e.key === prevKey || e.key === 'ArrowUp') { e.preventDefault(); focusCard(index - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusCard(0); }
    else if (e.key === 'End') { e.preventDefault(); focusCard(cardEls.length - 1); }
    // Enter/Space activate the button natively -- no handling needed here.
  }

  function buildCard(choice, index) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mam-choice-card' + (choice.expandTo ? ' mam-choice-card-more' : '');
    card.dataset.choiceId = String(choice.id);
    card.style.animationDelay = Math.min(index, 7) * MATERIALIZE_STAGGER_MS + 'ms';
    card.tabIndex = index === 0 ? 0 : -1;
    card.setAttribute('role', 'option');

    const icon = document.createElement('span');
    icon.className = 'mam-choice-card-icon';
    icon.setAttribute('aria-hidden', 'true');
    card.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'mam-choice-card-label';
    label.textContent = choice.label || tr(choice.labelKey, choice.labelFallback || '');
    card.appendChild(label);

    card.addEventListener('click', () => resolveChoice(choice, 'click'));
    card.addEventListener('keydown', (e) => onCardKeydown(e, index));
    return card;
  }

  function renderCards(choices) {
    const row = root.querySelector('.mam-choice-row');
    row.innerHTML = '';
    delete row.dataset.activeChoiceId;
    cardEls = choices.map((choice, i) => {
      const card = buildCard(choice, i);
      row.appendChild(card);
      return card;
    });
    if (isMobileViewport()) markActiveCard(row);
  }

  function resolveChoice(choice, source) {
    if (!activeQuestion || !resolver) return;
    if (choice.expandTo) {
      // "More cities": swap the displayed row to the wider set under the
      // SAME question text and breadcrumb -- never resolves the Promise,
      // never a second question.
      activeChoices = choice.expandTo;
      renderCards(activeChoices);
      return;
    }
    const doResolve = resolver;
    resolver = null;
    activeQuestion = null;
    cardEls.forEach((el) => {
      if (el.dataset.choiceId === String(choice.id)) el.classList.add('is-selected');
      else el.classList.add('is-dissolving');
    });
    setTimeout(() => { clear(); doResolve(choice); }, DISSOLVE_MS);
  }

  /**
   * @param {{id:string, textKey:string, textFallback:string, choices:Object[], breadcrumb?:string[]}} question
   * @returns {Promise<Object|null>} the picked choice, or null if cancelled.
   */
  function ask(question) {
    return new Promise((resolve) => {
      clear();
      activeQuestion = question;
      activeChoices = question.choices;
      resolver = resolve;

      root = document.createElement('div');
      root.className = 'mam-choice-root';
      root.setAttribute('role', 'listbox');
      root.setAttribute('aria-label', tr(question.textKey, question.textFallback));

      if (question.breadcrumb && question.breadcrumb.length) {
        root.appendChild(buildBreadcrumb(question.breadcrumb));
      }

      const questionText = document.createElement('p');
      questionText.className = 'mam-choice-question';
      questionText.textContent = tr(question.textKey, question.textFallback);
      root.appendChild(questionText);

      const row = document.createElement('div');
      row.className = 'mam-choice-row';
      row.addEventListener('scroll', () => {
        clearTimeout(carouselSettleTimer);
        carouselSettleTimer = setTimeout(() => markActiveCard(row), CAROUSEL_SETTLE_MS);
      }, { passive: true });
      root.appendChild(row);

      hostEl.appendChild(root);
      renderCards(activeChoices);
    });
  }

  return {
    ask,
    /**
     * Matches spoken or typed text against the currently active question
     * (via js/mam-spatial-flows.js's pure matchChoiceForQuestion -- the
     * ONLY thing this function does besides calling resolveChoice, the
     * exact same handler a click/tap/Enter already calls). Returns true
     * if it consumed the text as a selection; false means "not a match,"
     * so the caller falls through to whatever it does with unmatched text.
     */
    trySelectFromText(text) {
      if (!activeQuestion) return false;
      const match = matchChoiceForQuestion(activeQuestion.id, activeChoices, text);
      if (!match) return false;
      resolveChoice(match, 'voice');
      return true;
    },
    isActive() { return !!activeQuestion; },
    /** Abandons the current question without resolving a real choice. */
    cancel() {
      if (!resolver) return;
      const doResolve = resolver;
      resolver = null;
      activeQuestion = null;
      clear();
      doResolve(null);
    },
    destroy() { resolver = null; activeQuestion = null; clear(); }
  };
}
