// Final pass for components whose text is rendered by JS before the shared
// editorial wrappers are guaranteed to be installed. This never touches
// user/Firestore content; only known Darwesh UI nodes are rewritten.
const LANG_KEY = 'darwesh_lang';
const COPY = {
  en: {
    footer: 'Darwesh Group connects property seekers, owners, professionals and services across Kurdistan and Iraq in one platform.',
    rights: 'All rights reserved.', commercial: 'Commercial Property', searchSuffix: ' on Buy', allTypes: 'All types',
    roleError: 'Could not update the role. Please try again.', deleteError: 'Could not delete the listing. Please try again.', statusError: 'Could not update the listing status. Please try again.',
    breadcrumb: 'Breadcrumb', coverImage: 'Cover image',
    intents: { buy: 'Buy — homes, apartments and land', rent: 'Rent — available homes and properties', build: 'Build — work with property professionals', renovate: 'Renovate — improve your property', sell: 'Sell — list your property' },
    types: { house: 'House', villa: 'Villa', apartment: 'Apartment', land: 'Land', building: 'Building', office: 'Office', shop: 'Shop', commercialProperty: 'Commercial Property' }
  },
  ku: {
    footer: 'دەروێش گروپ گەڕۆکانی موڵک، خاوەن موڵک، پسپۆڕان و خزمەتگوزارییەکان لە کوردستان و عێراق لە یەک پلاتفۆرمدا پێکەوە دەبەستێتەوە.',
    rights: 'هەموو مافەکان پارێزراون.', commercial: 'موڵکی بازرگانی', searchSuffix: ' · گەڕانی کڕین', allTypes: 'هەموو جۆرەکان',
    roleError: 'نەتوانرا ڕۆڵەکە نوێ بکرێتەوە. تکایە دووبارە هەوڵبدەوە.', deleteError: 'نەتوانرا موڵکەکە بسڕدرێتەوە. تکایە دووبارە هەوڵبدەوە.', statusError: 'نەتوانرا دۆخی موڵکەکە نوێ بکرێتەوە. تکایە دووبارە هەوڵبدەوە.',
    breadcrumb: 'ڕێڕەوی پەڕە', coverImage: 'وێنەی سەرەکی',
    intents: { buy: 'کڕین — خانوو، ئاپارتمان و زەوی', rent: 'کرێ — خانوو و موڵکی بەردەست', build: 'دروستکردن — کارکردن لەگەڵ پسپۆڕانی خانووبەرە', renovate: 'نوێکردنەوە — باشترکردنی موڵکەکەت', sell: 'فرۆشتن — تۆمارکردنی موڵکەکەت' },
    types: { house: 'خانوو', villa: 'ڤیلا', apartment: 'ئاپارتمان', land: 'زەوی', building: 'بینا', office: 'نووسینگە', shop: 'دوکان', commercialProperty: 'موڵکی بازرگانی' }
  },
  ar: {
    footer: 'تربط مجموعة درويش الباحثين عن العقارات والمالكين والمهنيين والخدمات في كردستان والعراق ضمن منصة واحدة.',
    rights: 'جميع الحقوق محفوظة.', commercial: 'عقار تجاري', searchSuffix: ' · بحث الشراء', allTypes: 'كل الأنواع',
    roleError: 'تعذر تحديث الدور. حاول مرة أخرى.', deleteError: 'تعذر حذف العقار. حاول مرة أخرى.', statusError: 'تعذر تحديث حالة العقار. حاول مرة أخرى.',
    breadcrumb: 'مسار التنقل', coverImage: 'صورة الغلاف',
    intents: { buy: 'شراء — منازل وشقق وأراضٍ', rent: 'إيجار — منازل وعقارات متاحة', build: 'بناء — العمل مع مختصي العقارات', renovate: 'تجديد — تحسين عقارك', sell: 'بيع — إدراج عقارك' },
    types: { house: 'منزل', villa: 'فيلا', apartment: 'شقة', land: 'أرض', building: 'مبنى', office: 'مكتب', shop: 'محل', commercialProperty: 'عقار تجاري' }
  },
  tr: {
    footer: 'Darwesh Group, Kürdistan ve Irak genelinde emlak arayanları, mülk sahiplerini, profesyonelleri ve hizmetleri tek platformda buluşturur.',
    rights: 'Tüm hakları saklıdır.', commercial: 'Ticari Emlak', searchSuffix: ' · Satın alma araması', allTypes: 'Tüm türler',
    roleError: 'Rol güncellenemedi. Lütfen tekrar deneyin.', deleteError: 'Emlak silinemedi. Lütfen tekrar deneyin.', statusError: 'Emlak durumu güncellenemedi. Lütfen tekrar deneyin.',
    breadcrumb: 'Gezinme yolu', coverImage: 'Kapak görseli',
    intents: { buy: 'Satın al — evler, daireler ve arsalar', rent: 'Kirala — mevcut evler ve emlaklar', build: 'İnşa et — emlak profesyonelleriyle çalış', renovate: 'Yenile — emlakınızı geliştirin', sell: 'Sat — emlakınızı listeleyin' },
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
function setAria(el, value) {
  if (el && value && el.getAttribute('aria-label') !== value) el.setAttribute('aria-label', value);
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

let alertWrapped = false;
function installAlertLocalization() {
  if (alertWrapped) return;
  const original = window.alert.bind(window);
  window.alert = function (message) {
    const text = String(message || '');
    const c = COPY[lang()] || COPY.en;
    if (text.startsWith('Could not update role:')) return original(c.roleError);
    if (text.startsWith('Could not delete listing:')) return original(c.deleteError);
    if (text.startsWith('Could not update listing status:')) return original(c.statusError);
    return original(message);
  };
  alertWrapped = true;
}

function paintAccessibleNames(c) {
  document.querySelectorAll('[aria-label="Breadcrumb"], [data-editorial-breadcrumb="1"]').forEach((el) => {
    el.dataset.editorialBreadcrumb = '1';
    setAria(el, c.breadcrumb);
  });
  document.querySelectorAll('[aria-label="Cover image"], [data-editorial-cover-image="1"]').forEach((el) => {
    el.dataset.editorialCoverImage = '1';
    setAria(el, c.coverImage);
  });

  if ((location.pathname.split('/').pop() || 'index.html') === 'index.html') {
    document.querySelectorAll('.w-panel[data-i18n-aria]').forEach((el) => {
      const href = (el.getAttribute('href') || '').split('?')[0];
      const key = href === 'buy.html' ? 'buy'
        : href === 'rent.html' ? 'rent'
          : href === 'build.html' ? 'build'
            : href === 'renovate.html' ? 'renovate'
              : href === 'sell.html' ? 'sell' : null;
      if (key) setAria(el, c.intents[key]);
    });
  }
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
  paintAccessibleNames(c);
}
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; paint(); });
}
installAlertLocalization();
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
document.addEventListener('darwesh:langchange', schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint, { once: true });
else paint();
