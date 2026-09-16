// ---------------------------------------------------------------------
// Darwesh Group i18n -- core runtime (English / Kurdish (Sorani) / Arabic / Turkish)
//
// PERFORMANCE FOUNDATION PASS (P0-4/P0-5): this file used to contain the
// full text of all three non-English dictionaries inline (~683 KB, shipped
// to every visitor regardless of language). It now contains only the
// runtime -- getLang/setLanguage/t/cityLabel/applyTranslations and the
// generic lang-menu wiring -- and loads exactly one dictionary file
// (js/i18n/{ku,ar,tr}.js) for whichever language is active, or none at all
// for English (see below). Dictionary content itself is unchanged,
// verbatim, byte-for-byte moved into js/i18n/{ku,ar,tr}.js -- this is a
// loading-strategy change, not a translation edit.
//
// English text lives directly in the HTML and is never stored here --
// it's cached from the DOM the first time a page translates away from
// it, then restored when the visitor switches back to English. Only
// Kurdish, Arabic, and Turkish strings live in dictionary files, keyed
// by the same data-i18n value used in the markup. This is also why an
// English visitor -- the common case -- downloads zero dictionary bytes
// for this system at all.
//
// AI-translated (Sorani Kurdish + Modern Standard Arabic + Turkish) --
// good enough to ship, but worth a native-speaker pass before a big
// public push.
// ---------------------------------------------------------------------

const I18N_KEY = 'darwesh_lang';
const RTL_LANGS = ['ku', 'ar'];
const DICT_LANGS = ['ku', 'ar', 'tr'];

// Populated as each language's dictionary file loads. English never gets
// an entry here -- applyTranslations() already falls back to the cached
// original DOM text whenever a key/dict is missing, which is exactly
// correct for English.
const translations = {};
const loadedLangs = new Set();
const pendingLoads = {};

function dictUrl(lang) {
  // Every production page that loads this file lives flat at the repo
  // root (verified: every `src="./js/i18n.js"` reference site-wide uses
  // this exact relative form, no nested pages) -- so the same
  // page-relative path used for this script itself works identically for
  // its per-language dictionary files.
  return './js/i18n/' + lang + '.js';
}

// Loads one dictionary on demand and caches the in-flight/resolved result
// so a second call for the same language -- e.g. switching KU -> EN -> KU
// in one session -- never re-fetches (P0-5). The browser's own HTTP cache
// is a second safety net across page navigations within a session even
// after this in-memory Set resets.
function loadLangDict(lang) {
  if (lang === 'en' || !DICT_LANGS.includes(lang)) return Promise.resolve();
  if (loadedLangs.has(lang)) return Promise.resolve();
  if (pendingLoads[lang]) return pendingLoads[lang];
  pendingLoads[lang] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = dictUrl(lang);
    s.onload = () => {
      const dict = (window.__DARWESH_I18N__ && window.__DARWESH_I18N__[lang]) || {};
      translations[lang] = dict;
      loadedLangs.add(lang);
      delete pendingLoads[lang];
      resolve();
    };
    s.onerror = () => {
      delete pendingLoads[lang];
      console.error('[i18n] failed to load dictionary for "' + lang + '"');
      reject(new Error('i18n dictionary load failed: ' + lang));
    };
    document.head.appendChild(s);
  });
  return pendingLoads[lang];
}

// Kick the CURRENT language's dictionary off as early as physically
// possible -- synchronously, during initial parse, via the same
// document.write pattern this codebase already uses for the lang/dir
// bootstrap in every page's <head>. document.write from a script that is
// itself being parsed inserts its content immediately after that script
// in the token stream, and the browser blocks on it exactly like a
// normal parser-inserted <script src>, which is what guarantees the
// dictionary has finished loading before DOMContentLoaded fires below --
// no fetch()/Promise race, no flash of untranslated content, identical
// blocking guarantee to the old single-file version, just conditional on
// which (much smaller, or zero-byte for English) file is requested.
(function bootstrapCurrentLangDict() {
  let lang;
  try { lang = localStorage.getItem(I18N_KEY) || 'en'; } catch (_err) { lang = 'en'; }
  if (DICT_LANGS.includes(lang)) {
    loadedLangs.add(lang); // claimed synchronously; the write below fulfills it before DOMContentLoaded
    document.write('<script src="' + dictUrl(lang) + '"><\/script>');
  }
})();

function getLang() {
  return localStorage.getItem(I18N_KEY) || 'en';
}

function applyTranslations(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL_LANGS.includes(lang) ? 'rtl' : 'ltr';

  const dict = translations[lang];

  document.querySelectorAll('[data-i18n]').forEach(el => {
    if (el.dataset.i18nOrig === undefined) el.dataset.i18nOrig = el.textContent;
    const key = el.getAttribute('data-i18n');
    el.textContent = (dict && dict[key]) ? dict[key] : el.dataset.i18nOrig;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    if (el.dataset.i18nOrigPh === undefined) el.dataset.i18nOrigPh = el.getAttribute('placeholder') || '';
    const key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', (dict && dict[key]) ? dict[key] : el.dataset.i18nOrigPh);
  });

  // data-i18n-title / data-i18n-aria were USED across the site and
  // validated by scripts/ci-checks.js, but never actually applied here --
  // so every tooltip and every translated aria-label silently stayed
  // English in Kurdish and Arabic. Added alongside the existing
  // placeholder/html handlers, with the same original-value stashing so
  // switching back to English restores the authored text rather than a
  // key.
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    if (el.dataset.i18nOrigTitle === undefined) el.dataset.i18nOrigTitle = el.getAttribute('title') || '';
    const key = el.getAttribute('data-i18n-title');
    el.setAttribute('title', (dict && dict[key]) ? dict[key] : el.dataset.i18nOrigTitle);
  });

  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    if (el.dataset.i18nOrigAria === undefined) el.dataset.i18nOrigAria = el.getAttribute('aria-label') || '';
    const key = el.getAttribute('data-i18n-aria');
    el.setAttribute('aria-label', (dict && dict[key]) ? dict[key] : el.dataset.i18nOrigAria);
  });

  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    if (el.dataset.i18nOrigHtml === undefined) el.dataset.i18nOrigHtml = el.innerHTML;
    const key = el.getAttribute('data-i18n-html');
    el.innerHTML = (dict && dict[key]) ? dict[key] : el.dataset.i18nOrigHtml;
  });

  document.querySelectorAll('.lang-option').forEach(opt => {
    const active = opt.dataset.lang === lang;
    // aria-current is the correct a11y signal for "current item in a set"
    // on a role=menuitem (aria-selected isn't valid there) -- added for
    // every language option site-wide, harmless where nothing reads it.
    opt.setAttribute('aria-current', active ? 'true' : 'false');
    // Elements opting into the premium flag-based selector (data-lsel)
    // own their own selected-state color via CSS (html[lang=...]
    // selectors in cinematic.css); every other, pre-existing .lang-option
    // keeps its original inline-style-driven look, unchanged.
    if (opt.hasAttribute('data-lsel')) return;
    opt.style.color = active ? '#775a19' : '';
    opt.style.fontWeight = active ? '700' : '';
  });
}

// Still a plain global function called from inline onclick="setLanguage(...)"
// attributes across every page -- signature and name are unchanged.
// Internally it now awaits the target dictionary (a no-op await if it's
// already loaded/being loaded/English) before applying, so a language
// switch to a not-yet-loaded dictionary still ends in the exact same
// visible state as before, just after one lazy-load instead of reading
// data that was already sitting in memory unused.
window.setLanguage = async function (lang) {
  localStorage.setItem(I18N_KEY, lang);
  try {
    await loadLangDict(lang);
  } catch (_err) {
    // Loading failed (offline, blocked request, etc.) -- fall back to
    // whatever's cached/English rather than leaving the UI stuck waiting;
    // applyTranslations() already degrades gracefully when a dict is
    // missing (falls back to the original English DOM text per key).
  }
  applyTranslations(lang);
  document.querySelectorAll('.lang-menu').forEach(m => m.classList.add('hidden'));
  document.querySelectorAll('.lang-toggle-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
  document.dispatchEvent(new CustomEvent('darwesh:langchange', { detail: { lang } }));
};

window.t = function (key) {
  const dict = translations[getLang()];
  return (dict && dict[key]) || null;
};

const CITY_KEYS = {
  Erbil: 'cities.erbil', Sulaymaniyah: 'cities.sulaymaniyah', Duhok: 'cities.duhok',
  Zakho: 'cities.zakho', Soran: 'cities.soran', Koya: 'cities.koya', Halabja: 'cities.halabja',
  Kirkuk: 'cities.kirkuk'
};
window.cityLabel = function (englishName) {
  const key = CITY_KEYS[englishName];
  return (key && window.t(key)) || englishName;
};

document.addEventListener('DOMContentLoaded', () => {
  const lang = getLang();
  // The document.write bootstrap above has, by this point, already run
  // and finished loading js/i18n/{lang}.js synchronously if lang needed
  // one -- DOMContentLoaded cannot fire until every parser-inserted
  // script (including one inserted via document.write) has executed. So
  // window.__DARWESH_I18N__[lang] is guaranteed populated here already.
  if (DICT_LANGS.includes(lang) && window.__DARWESH_I18N__ && window.__DARWESH_I18N__[lang]) {
    translations[lang] = window.__DARWESH_I18N__[lang];
    loadedLangs.add(lang);
  }
  applyTranslations(lang);

  // Generic language-toggle wiring: applies to every .lang-toggle-btn /
  // .lang-menu pair on any page (open/close, ARIA state, keyboard nav).
  // Adding role/aria attributes here -- rather than hand-editing every
  // page's markup -- keeps this a single implementation shared site-wide.
  document.querySelectorAll('.lang-toggle-btn').forEach(btn => {
    const menu = btn.parentElement.querySelector('.lang-menu');
    if (!menu) return;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    menu.setAttribute('role', 'menu');
    menu.querySelectorAll('.lang-option').forEach(opt => opt.setAttribute('role', 'menuitem'));

    const closeMenu = (focusTrigger) => {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
      if (focusTrigger) btn.focus();
    };
    const openMenu = () => {
      document.querySelectorAll('.lang-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
      document.querySelectorAll('.lang-toggle-btn').forEach(b => { if (b !== btn) b.setAttribute('aria-expanded', 'false'); });
      menu.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      const options = Array.from(menu.querySelectorAll('.lang-option'));
      const current = options.find(o => o.getAttribute('aria-current') === 'true');
      (current || options[0] || btn).focus();
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.classList.contains('hidden')) openMenu(); else closeMenu(false);
    });

    menu.addEventListener('keydown', (e) => {
      const options = Array.from(menu.querySelectorAll('.lang-option'));
      const i = options.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); options[(i + 1 + options.length) % options.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); options[(i - 1 + options.length) % options.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); options[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); options[options.length - 1]?.focus(); }
    });
    menu.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!menu.contains(document.activeElement) && document.activeElement !== btn) closeMenu(false);
      });
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.lang-menu').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.lang-toggle-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.lang-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
      document.querySelectorAll('.lang-toggle-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
    }
  });
});
