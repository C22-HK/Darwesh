// Final pass for components whose text is rendered by JS before the shared
// editorial wrappers are guaranteed to be installed. This never touches
// user/Firestore content; only known Darwesh UI nodes are rewritten.
const LANG_KEY = 'darwesh_lang';
const COPY = {
  en: {
    footer: 'Darwesh Group connects property seekers, owners, professionals and services across Kurdistan and Iraq in one platform.',
    rights: 'All rights reserved.', commercial: 'Commercial Property', searchSuffix: ' on Buy', allTypes: 'All types',
    types: { house: 'House', villa: 'Villa', apartment: 'Apartment', land: 'Land', building: 'Building', office: 'Office', shop: 'Shop', commercialProperty: 'Commercial Property' }
  },
  ku: {
    footer: 'دەروێش گروپ گەڕۆکانی موڵک، خاوەن موڵک، پسپۆڕان و خزمەتگوزارییەکان لە کوردستان و عێراق لە یەک پلاتفۆرمدا پێکەوە دەبەستێتەوە.',
    rights: 'هەموو مافەکان پارێزراون.', commercial: 'موڵکی بازرگانی', searchSuffix: ' · گەڕانی کڕین', allTypes: 'هەموو جۆرەکان',
    types: { house: 'خانوو', villa: 'ڤیلا', apartment: 'ئاپارتمان', land: 'زەوی', building: 'بینا', office: 'نووسینگە', shop: 'دوکان', commercialProperty: 'موڵکی بازرگانی' }
  },
  ar: {
    footer: 'تربط مجموعة درويش الباحثين عن العقارات والمالكين والمهنيين والخدمات في كردستان والعراق ضمن منصة واحدة.',
    rights: 'جميع الحقوق محفوظة.', commercial: 'عقار تجاري', searchSuffix: ' · بحث الشراء', allTypes: 'كل الأنواع',
    types: { house: 'منزل', villa: 'فيلا', apartment: 'شقة', land: 'أرض', building: 'مبنى', office: 'مكتب', shop: 'محل', commercialProperty: 'عقار تجاري' }
  },
  tr: {
    footer: 'Darwesh Group, Kürdistan ve Irak genelinde emlak arayanları, mülk sahiplerini, profesyonelleri ve hizmetleri tek platformda buluşturur.',
    rights: 'Tüm hakları saklıdır.', commercial: 'Ticari Emlak', searchSuffix: ' · Satın alma araması', allTypes: 'Tüm türler',
    types: { house: 'Ev', villa: 'Villa', apartment: 'Daire', land: 'Arsa', building: 'Bina', office: 'Ofis', shop: 'Dükkan', commercialProperty: 'Ticari Emlak' }
  }
};
function lang() {
  const value = localStorage.getItem(LANG_KEY);
  return COPY[value] ? value : 'en';
}
function setText(el, value) {
  if (el && value && el.textContent !== value) el.textContent = value;
}

const SEARCH_SUFFIX_RE = /(?: on Buy| · گەڕانی کڕین| · بحث الشراء| · Satın alma araması)$/;
const ALL_TYPES = ['All types', 'هەموو جۆرەکان', 'كل الأنواع', 'Tüm türler'];
const TYPE_ALIASES = {
  house: ['house', 'House', 'خانوو', 'منزل', 'Ev'],
  villa: ['villa', 'Villa', 'ڤیلا', 'فيلا'],
  apartment: ['apartment', 'Apartment', 'ئاپارتمان', 'شقة', 'Daire'],
  land: ['land', 'Land', 'زەوی', 'أرض', 'Arsa'],
  building: ['building', 'Building', 'بینا', 'مبنى', 'Bina'],
  office: ['office', 'Office', 'نووسینگە', 'مكتب', 'Ofis'],
  shop: ['shop', 'Shop', 'دوکان', 'محل', 'Dükkan'],
  commercialProperty: ['commercialProperty', 'Commercial Property', 'موڵکی بازرگانی', 'عقار تجاري', 'Ticari Emlak']
};
function translateSavedSearchLabel(text, c) {
  if (!SEARCH_SUFFIX_RE.test(text)) return null;
  let base = text.replace(SEARCH_SUFFIX_RE, '');
  for (const value of ALL_TYPES) {
    if (base === value || base.startsWith(value + ' — ')) {
      base = c.allTypes + base.slice(value.length);
      return base + c.searchSuffix;
    }
  }
  for (const [key, aliases] of Object.entries(TYPE_ALIASES)) {
    for (const value of aliases) {
      if (base === value || base.startsWith(value + ' — ')) {
        base = c.types[key] + base.slice(value.length);
        return base + c.searchSuffix;
      }
    }
  }
  return base + c.searchSuffix;
}

function paint() {
  const c = COPY[lang()] || COPY.en;
  setText(document.querySelector('.sf-tagline'), c.footer);

  const copyright = document.querySelector('.sf-copyright');
  if (copyright) {
    const year = copyright.querySelector('.sf-year')?.textContent || String(new Date().getFullYear());
    const value = lang() === 'ku'
      ? `${year} دەروێش گروپ. ${c.rights}`
      : lang() === 'ar'
        ? `${year} مجموعة درويش. ${c.rights}`
        : `${year} Darwesh Group. ${c.rights}`;
    setText(copyright, value);
  }

  if ((location.pathname.split('/').pop() || '') === 'map.html') {
    document.querySelectorAll('#cardList *, .leaflet-popup-content *').forEach((el) => {
      if (el.children.length) return;
      const text = (el.textContent || '').trim();
      if (text === 'commercialProperty' || el.dataset.editorialCommercial === '1') {
        el.dataset.editorialCommercial = '1';
        setText(el, c.commercial);
      }
    });
  }

  document.querySelectorAll('#searchesList p').forEach((el) => {
    const next = translateSavedSearchLabel((el.textContent || '').trim(), c);
    if (next) setText(el, next);
  });
}
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; paint(); });
}
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
document.addEventListener('darwesh:langchange', schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint, { once: true });
else paint();
