// MAM AI Command Center -- the adaptive spatial question/card flow's
// PURE logic layer: no DOM, no rendering, no animation. This is the
// "missing-information resolver" + "choice model" half of the pipeline
// the brief asks for:
//
//   MAM conversation/intent -> missing-information resolver -> choice
//   model -> spatial-choice renderer (js/mam-spatial-choice.js) ->
//   selection event -> existing action registry
//
// Everything in here is either read directly from an existing, real
// vocabulary this frontend/backend already uses, or a DIRECT PORT of the
// exact keyword lists backend/app/mam/intent_resolver.py already matches
// on (CITY_KEYWORDS, PROPERTY_TYPE_KEYWORDS, DEAL_TYPE_*_KEYWORDS) --
// never a second, competing set of city/type names invented for this
// file. The point of keeping these lists in sync is narrow and concrete:
// once enough cards are answered, this module SYNTHESIZES an ordinary
// natural-language sentence in the visitor's own language and hands it
// to the EXACT SAME real conversation pipeline (js/mam-chat-panel.js's
// sendMessage(), which calls js/mam-api.js -> backend/app/mam/routes.py
// -> the SAME deterministic resolver or live provider every other MAM
// turn already goes through) -- so the backend/action registry stays
// authoritative, exactly as required. A spatial card never bypasses
// that; it only ever produces the same kind of message a visitor could
// have typed themselves.

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

// ---- real city vocabulary -----------------------------------------------
// Keys match backend/app/mam/intent_resolver.py's CITY_KEYWORDS exactly
// (English canonical name -> native-script synonyms the resolver already
// recognizes) and js/mam-command-registry.js's SELL_CITY_KEYS (same 8
// cities sell.html's own Location step offers). Kirkuk stays the
// platform's own current default/first city per the brief -- it is
// listed first in PRIMARY, not invented ordering.
export const CITY_KEYWORDS = {
  Kirkuk: ['kirkuk', 'کەرکووک', 'کرکوک'],
  Erbil: ['erbil', 'هەولێر', 'اربیل', 'ھەولێر'],
  Sulaymaniyah: ['sulaymaniyah', 'slemani', 'سلێمانی', 'سلیمانی', 'السلیمانیه'],
  Duhok: ['duhok', 'dohuk', 'دهۆک', 'دهوک', 'دھۆک'],
  Zakho: ['zakho', 'زاخۆ', 'زاخو'],
  Soran: ['soran', 'سۆران', 'سوران'],
  Koya: ['koya', 'کۆیە', 'کویه'],
  Halabja: ['halabja', 'هەڵەبجە', 'حەلەبجە', 'حلبجه']
};
export const CITY_PRIMARY = ['Kirkuk', 'Erbil', 'Sulaymaniyah', 'Duhok'];
export const CITY_MORE = ['Zakho', 'Soran', 'Koya', 'Halabja'];
export function cityLabel(name) { return (window.cityLabel && window.cityLabel(name)) || name; }

// ---- real property-type vocabulary --------------------------------------
// Matches backend's PROPERTY_TYPE_KEYWORDS + the same map.* i18n labels
// map.html's own filter bar and js/mam-actions.js's HOME_TYPES already
// use. 'shop' is the one real backend-recognized keyword for the "Shop /
// Commercial" card -- HOME_TYPES' separate 'commercialProperty' entry has
// no resolver keyword of its own, so the card's REAL synthesized word is
// always "shop", even though its label reads "Shop / Commercial".
export const PROPERTY_TYPES = [
  { id: 'house', labelKey: 'map.house', fallback: 'House', word: 'house' },
  { id: 'apartment', labelKey: 'map.apartment', fallback: 'Apartment', word: 'apartment' },
  { id: 'villa', labelKey: 'map.villa', fallback: 'Villa', word: 'villa' },
  { id: 'land', labelKey: 'map.land', fallback: 'Land', word: 'land' },
  { id: 'office', labelKey: 'map.office', fallback: 'Office', word: 'office' },
  { id: 'shop', labelKey: 'map.shop', fallback: 'Shop / Commercial', word: 'shop' }
];
const PROPERTY_TYPE_KEYWORDS = {
  house: ['house', 'خانوو', 'خانووی', 'منزل', 'بیت'],
  villa: ['villa', 'ڤیلا', 'فيلا'],
  apartment: ['apartment', 'flat', 'ئاپارتمان', 'شوقه', 'شوقە', 'شقه'],
  land: ['land', 'plot', 'زەوی', 'قطعه ارض', 'أرض', 'ارض'],
  building: ['building', 'بینا', 'بنایە', 'مبنى', 'عمارة'],
  office: ['office', 'ofîs', 'ئۆفیس', 'فەرمانگە', 'مکتب'],
  shop: ['shop', 'store', 'دوکان', 'محل تجاري', 'متجر']
};
// "Rooms" only means anything for these three -- a real relevance rule,
// not a guess: land/office/shop have no bedroom count to ask about.
const ROOM_RELEVANT_TYPES = new Set(['house', 'apartment', 'villa']);

// ---- real deal-type / intent vocabulary ---------------------------------
// nav.buy / nav.rent / nav.sell are the SAME strings the shared header
// nav already shows (js/i18n.js) -- reused verbatim as both this
// question's card labels AND the literal word embedded in the
// synthesized sentence, because they are already proven (by that same
// normalize_text() pipeline) to match backend's DEAL_TYPE_*_KEYWORDS /
// SELL_NAV_TOPIC_KEYWORDS. No separate translation was written for this
// file; using a second, near-duplicate phrase risks one that LOOKS right
// but doesn't survive normalize_text's diacritic/letter-unification pass.
export const INTENT_CHOICES = [
  { id: 'buy', labelKey: 'nav.buy', fallback: 'Buy' },
  { id: 'rent', labelKey: 'nav.rent', fallback: 'Rent' },
  { id: 'sell', labelKey: 'nav.sell', fallback: 'Sell' }
];

// ---- signal detection (client-side triage only) -------------------------
// This is NOT a second NLU competing with backend/app/mam/intent_resolver.py
// -- it never decides what a message MEANS, only whether it already looks
// specific enough that asking clarifying questions would be redundant
// (the brief's own "do not ask questions the user already answered").
// The real parse -- the one that actually runs a search -- always happens
// server-side, once, on the final synthesized (or original, if already
// specific) sentence. Mirrors intent_resolver.py's own normalize_text()
// closely enough for keyword matching (case-fold, strip a few diacritics)
// without porting the full Python implementation into the browser.
function normalize(text) {
  return (text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ك/g, 'ک')
    .replace(/[يى]/g, 'ی')
    .replace(/ة/g, 'ه')
    .trim();
}
const DEAL_RENT_WORDS = ['rent', 'rental', 'renting', 'بەکرێدان', 'بکرێ', 'کرێ', 'ایجار', 'استئجار'];
const DEAL_BUY_WORDS = ['buy', 'purchase', 'بکڕم', 'بۆ فرۆشتن', 'فرۆشتن', 'بیع', 'شراء'];
const PRICE_CONTEXT_WORDS = ['$', 'dollar', 'دۆلار', 'دولار', 'usd', 'دینار', 'iqd', 'دينار', 'million', 'ملیۆن', 'میلیون', 'thousand', 'هەزار'];
const BEDROOM_PATTERN = /(\d+)\s*(bedroom|bed|ژووری نوستن|ژوور|غرفه نوم|غرفه)/;

function detectCity(norm) {
  for (const [city, words] of Object.entries(CITY_KEYWORDS)) {
    if (words.some((w) => norm.includes(normalize(w)))) return city;
  }
  return null;
}
function detectPropertyType(norm) {
  for (const [type, words] of Object.entries(PROPERTY_TYPE_KEYWORDS)) {
    if (words.some((w) => norm.includes(normalize(w)))) return type;
  }
  return null;
}
function detectDealType(norm) {
  if (DEAL_RENT_WORDS.some((w) => norm.includes(normalize(w)))) return 'rent';
  if (DEAL_BUY_WORDS.some((w) => norm.includes(normalize(w)))) return 'buy';
  return null;
}

/**
 * Read-only triage of a real utterance -- how many concrete property
 * signals it already carries. Used only to decide whether the spatial
 * clarification flow should start at all; the resolved VALUES themselves
 * are never trusted for anything beyond that -- once a turn is actually
 * sent, the real backend resolver re-parses it from scratch.
 */
export function detectPropertySignals(text) {
  const norm = normalize(text);
  const city = detectCity(norm);
  const propertyType = detectPropertyType(norm);
  const dealType = detectDealType(norm);
  const hasPrice = PRICE_CONTEXT_WORDS.some((w) => norm.includes(normalize(w))) && /\d/.test(norm);
  const hasBedrooms = BEDROOM_PATTERN.test(norm);
  const signalCount = [propertyType, dealType, hasPrice, hasBedrooms].filter(Boolean).length;
  return { city, propertyType, dealType, hasPrice, hasBedrooms, signalCount };
}

// A SMALL, specific "I have a vague property need" trigger list -- never
// a broad guess. Anything not matching one of these falls straight
// through to the existing, already-correct sendMessage() pipeline
// unchanged, exactly as it worked before this file existed.
const PROPERTY_NEED_PATTERNS = [
  /\bi need a (property|house|home|place|apartment)\b/,
  /\bi'?m looking for a (property|house|home|place|apartment)\b/,
  /\bfind me a (property|house|home|place)\b/,
  /\bhelp me find (a|an) (property|house|home|place)\b/,
  /\bshow me properties\b/,
  /پێویستم بە (خانووبەرە|خانوو|شوقە|شوقه)/,
  /دەمەوێت خانووبەرەیەک/,
  /محتاج (عقار|بیت|منزل|شقه)/,
  /ابحث عن (عقار|بیت|منزل|شقه)/
];

/** True only for a SHORT, genuinely underspecified property request. */
export function isVaguePropertyNeed(text) {
  const norm = normalize(text);
  if (!norm || norm.length > 60) return false; // a long sentence is never "just a vague need"
  if (!PROPERTY_NEED_PATTERNS.some((re) => re.test(norm))) return false;
  const { signalCount, city } = detectPropertySignals(text);
  // Already specific enough on its own (mirrors intent_resolver.py's own
  // bar) -- let the real backend handle it directly, nothing to clarify.
  if ((city && signalCount >= 1) || (!city && signalCount >= 2)) return false;
  return true;
}

// ---- real profession vocabulary (search_professionals) ------------------
// Matches backend's SERVICE_TYPE_KEYWORDS exactly -- the 5 canonical
// serviceType slugs js/mam-chat-panel.js's PROFESSIONAL_PAGES already
// resolves to a real profile page.
const SERVICE_TYPE_KEYWORDS = {
  engineer: ['engineer', 'ئەندازیار', 'مهندس'],
  designer: ['designer', 'دیزاینەر', 'دیزاین', 'مصمم'],
  lawyer: ['lawyer', 'attorney', 'پارێزەر', 'محامي'],
  landscaping: ['landscap', 'گوڵکاری', 'تنسیق حدائق', 'منسق حدائق'],
  cleaning: ['cleaning', 'پاکژکردنەوە', 'تنظیف']
};
export function detectProfessionCategory(text) {
  const norm = normalize(text);
  for (const [type, words] of Object.entries(SERVICE_TYPE_KEYWORDS)) {
    if (words.some((w) => norm.includes(normalize(w)))) return type;
  }
  return null;
}

// A SMALL, specific "vague professional need" trigger list -- mirrors
// PROPERTY_NEED_PATTERNS above exactly in spirit: anything not matching
// falls straight through to the existing backend pipeline unchanged.
const PROFESSIONAL_NEED_PATTERNS = [
  /\bi need (a|an)\b/, /\bi'?m looking for (a|an)\b/, /\bfind me (a|an)\b/, /\bhelp me find (a|an)\b/,
  /پێویستم بە/, /دەمەوێت/, /محتاج/, /ابحث عن/
];

/**
 * Non-null only for a SHORT, genuinely underspecified professional need --
 * a real category keyword AND a real "I need" phrasing. Returns the
 * already-detected category and city (city may be null, meaning still
 * missing) so the caller decides whether to start the clarification flow
 * at all -- a city already present means nothing is missing to ask.
 */
export function isVagueProfessionalNeed(text) {
  const norm = normalize(text);
  if (!norm || norm.length > 80) return null;
  const category = detectProfessionCategory(text);
  if (!category) return null;
  if (!PROFESSIONAL_NEED_PATTERNS.some((re) => re.test(norm))) return null;
  return { category, city: detectCity(norm) };
}

// ---- voice/click/tap/keyboard SHARED matching -----------------------------
// The one function both the spatial-choice renderer's click/tap/keyboard
// handler AND js/mam-chat-panel.js's voice/typed-text path call to resolve
// a spoken or typed answer against the question currently on screen --
// never a second, separate "voice interpretation" implementation. Matches
// against the REAL domain each question draws from (full CITY_KEYWORDS/
// PROPERTY_TYPE_KEYWORDS, not just the subset of cards currently rendered
// on screen -- so saying "Zakho" while only the primary 4 city cards are
// shown still works, exactly as tapping "More cities" then "Zakho" would).
const INTENT_BUY_WORDS = ['buy', 'purchase', 'بکڕم', 'شراء'];
const INTENT_SELL_WORDS = ['sell', 'selling', 'بفرۆشم', 'فرۆشتن', 'بۆ فرۆشتن', 'بیع', 'للبيع'];

function choiceFor(choices, value) {
  return choices.find((c) => c.value === value) || { id: value, value };
}

export function matchChoiceForQuestion(questionId, choices, text) {
  const norm = normalize(text);
  if (!norm) return null;
  if (questionId === 'city') {
    const city = detectCity(norm);
    return city ? { id: city, label: cityLabel(city), value: city } : null;
  }
  if (questionId === 'type') {
    const type = detectPropertyType(norm);
    if (!type) return null;
    const entry = PROPERTY_TYPES.find((t) => t.word === type);
    return entry ? { id: entry.id, labelKey: entry.labelKey, labelFallback: entry.fallback, value: entry.word } : null;
  }
  if (questionId === 'intent') {
    if (DEAL_RENT_WORDS.some((w) => norm.includes(normalize(w)))) return choiceFor(choices, 'rent');
    if (INTENT_SELL_WORDS.some((w) => norm.includes(normalize(w)))) return choiceFor(choices, 'sell');
    if (INTENT_BUY_WORDS.some((w) => norm.includes(normalize(w)))) return choiceFor(choices, 'buy');
    return null;
  }
  // Fallback for any other question shape: literal label containment
  // against whatever is actually offered right now.
  for (const c of choices) {
    if (c.expandTo) continue;
    const label = c.label || tr(c.labelKey, c.labelFallback || '');
    if (label && norm.includes(normalize(label))) return c;
  }
  return null;
}

// ---- choice-model: ordered question definitions --------------------------
// Each question: `isAnswered(slots)` (already known -- SKIPPED, never
// re-asked), `isRelevant(slots)` (would even make sense to ask), and
// `build(lang)` returning the real card choices. `nextQuestion()` walks
// the list once and returns the first the visitor hasn't already
// answered -- or null once enough is known, which is where the search
// actually runs. Capped at 3 questions for property (intent, city, type)
// -- deliberately NOT also asking budget/rooms/verification by default;
// intent+city+type is already a specific, useful real search (matches
// backend/app/mam/intent_resolver.py's own "specific enough" bar with
// room to spare), and the brief is explicit that over-interrogating is a
// FAIL condition. Budget/rooms stay real, defined questions any future
// "Refine search" affordance can reach -- they are simply not part of
// this flow's default question order today.
export const PROPERTY_QUESTIONS = [
  {
    id: 'intent',
    isAnswered: (s) => !!s.intent,
    isRelevant: () => true,
    build: () => ({
      id: 'intent',
      textKey: 'mamai.spatial.qIntent', textFallback: 'What would you like to do?',
      choices: INTENT_CHOICES.map((c) => ({ id: c.id, labelKey: c.labelKey, labelFallback: c.fallback, value: c.id }))
    })
  },
  {
    id: 'city',
    isAnswered: (s) => !!s.city,
    isRelevant: (s) => s.intent !== 'sell', // Sell has its own single-question flow below
    build: () => ({
      id: 'city',
      textKey: 'mamai.spatial.qCity', textFallback: 'Where are you looking?',
      choices: CITY_PRIMARY.map((c) => ({ id: c, label: cityLabel(c), value: c })).concat([
        {
          id: '__more', labelKey: 'mamai.spatial.moreCities', labelFallback: 'More cities', value: '__more',
          expandTo: CITY_MORE.map((c) => ({ id: c, label: cityLabel(c), value: c }))
        }
      ])
    })
  },
  {
    id: 'type',
    isAnswered: (s) => !!s.propertyType,
    isRelevant: () => true,
    build: () => ({
      id: 'type',
      textKey: 'mamai.spatial.qType', textFallback: 'What kind of property?',
      choices: PROPERTY_TYPES.map((t) => ({ id: t.id, labelKey: t.labelKey, labelFallback: t.fallback, value: t.word }))
    })
  }
];

export const PROFESSIONAL_QUESTIONS = [
  {
    id: 'city',
    isAnswered: (s) => !!s.city,
    isRelevant: () => true,
    build: () => ({
      id: 'city',
      textKey: 'mamai.spatial.qCity', textFallback: 'Where should I look?',
      choices: CITY_PRIMARY.map((c) => ({ id: c, label: cityLabel(c), value: c })).concat([
        {
          id: '__more', labelKey: 'mamai.spatial.moreCities', labelFallback: 'More cities', value: '__more',
          expandTo: CITY_MORE.map((c) => ({ id: c, label: cityLabel(c), value: c }))
        }
      ])
    })
  }
];

export const SELL_QUESTIONS = [
  {
    id: 'city',
    isAnswered: (s) => !!s.city,
    isRelevant: () => true,
    build: () => ({
      id: 'city',
      textKey: 'mamai.spatial.qCity', textFallback: 'Where is it?',
      // Every real sell.html Location-step city, not just the primary 4 --
      // js/mam-command-registry.js's setSellField('city', ...) only
      // accepts one of these 8, so offering fewer here would let a
      // visitor pick a city that then fails to apply.
      choices: [...CITY_PRIMARY, ...CITY_MORE].map((c) => ({ id: c, label: cityLabel(c), value: c }))
    })
  }
];

export function nextQuestion(questions, slots) {
  for (const q of questions) {
    if (q.isRelevant(slots) && !q.isAnswered(slots)) return q;
  }
  return null;
}

// The room-relevance rule lives here (not a question in PROPERTY_QUESTIONS
// itself, since rooms is not part of the default question order -- see
// above) so a future caller can still ask it correctly if it ever does.
export function isRoomsRelevant(slots) {
  return !!slots.propertyType && ROOM_RELEVANT_TYPES.has(slots.propertyType);
}

// ---- sentence synthesis: the ONE place a filled-out slot set turns back
// into an ordinary sentence for the REAL backend to parse. Never a second
// filter implementation -- this hands the exact same kind of message a
// visitor could have typed, through the exact same pipeline. ------------
export function synthesizePropertyMessage(slots, lang) {
  const isRent = slots.intent === 'rent';
  const typeEntry = PROPERTY_TYPES.find((t) => t.word === slots.propertyType);
  const typeLabel = typeEntry ? tr(typeEntry.labelKey, typeEntry.fallback) : '';
  const cityText = slots.city ? cityLabel(slots.city) : '';
  if (lang === 'ku') {
    // Deliberately different verb forms per deal type, not a reused
    // "buy/rent" noun slotted into one template: intent_resolver.py's
    // DEAL_TYPE_SALE_KEYWORDS matches the first-person verb "بکڕم" ("I
    // will buy"), not the noun "کڕین" (nav.buy's own label) -- reusing
    // the label directly here would silently produce a sentence with NO
    // recognizable deal-type keyword at all. "کرێ" (nav.rent's label) IS
    // a real DEAL_TYPE_RENT_KEYWORDS entry, so the rent form can reuse it
    // as-is.
    return isRent
      ? [typeLabel, 'دەمەوێت بە کرێ', cityText ? 'لە ' + cityText : ''].filter(Boolean).join(' ')
      : [typeLabel, 'دەمەوێت بکڕم', cityText ? 'لە ' + cityText : ''].filter(Boolean).join(' ');
  }
  if (lang === 'ar') {
    // nav.buy="شراء" and nav.rent="إيجار" both already match
    // DEAL_TYPE_SALE_KEYWORDS/DEAL_TYPE_RENT_KEYWORDS verbatim (after the
    // resolver's own ي->ی normalization), so these reuse the label as-is.
    const dealWord = isRent ? tr('nav.rent', 'إيجار') : tr('nav.buy', 'شراء');
    return ['أريد', dealWord, typeLabel, cityText ? 'في ' + cityText : ''].filter(Boolean).join(' ');
  }
  const dealWord = isRent ? 'rent' : 'buy'; // both literal DEAL_TYPE_*_KEYWORDS entries
  return ['I want to', dealWord, typeLabel ? 'a ' + typeLabel.toLowerCase() : '', cityText ? 'in ' + cityText : ''].filter(Boolean).join(' ');
}

/**
 * Reuses the ORIGINAL utterance's own wording (it already named the
 * profession, e.g. "I need an interior designer") plus the newly-chosen
 * city, rather than re-deriving a category label from a code -- more
 * natural, and avoids needing a second category->word table.
 */
export function synthesizeProfessionalMessage(originalText, city, lang) {
  const cityText = cityLabel(city);
  const trimmed = (originalText || '').trim().replace(/[.!?]+$/, '');
  if (lang === 'ku') return trimmed + ' لە ' + cityText;
  if (lang === 'ar') return trimmed + ' في ' + cityText;
  return trimmed + ' in ' + cityText;
}
