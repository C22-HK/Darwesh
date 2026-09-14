// Darwesh Group — final editorial/accessibility cleanup
// ------------------------------------------------------------
// This layer closes the remaining user-facing content gaps found by the
// full-site audit without changing data models, auth, permissions, layout or
// business logic. It is deliberately exact-key / exact-string based: no
// fuzzy rewriting of user content or Firestore data.

const LANG_KEY = 'darwesh_lang';
const LANGS = new Set(['en', 'ku', 'ar', 'tr']);
function lang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (LANGS.has(saved)) return saved;
  const html = (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
  return LANGS.has(html) ? html : 'en';
}

const OVERRIDES = {
  en: {
    'footer.tagline': 'Darwesh Group connects property seekers, owners, professionals and services across Kurdistan and Iraq in one platform.',
    'buy.subtitle': 'Browse homes and properties for sale across the Kurdistan Region with support from the Darwesh Group team.',
    'buy.cityHeadingSubtitle': 'Properties for sale in',
    'rent.subtitle': 'Browse available rental properties across Kurdistan.',
    'sell.subtitle': 'List your property with Darwesh Group and manage it through our review process.',
    'sell.benefit4': 'Professional photography support can be arranged.'
  },
  ku: {
    'footer.tagline': 'دەروێش گروپ گەڕۆکانی موڵک، خاوەن موڵک، پسپۆڕان و خزمەتگوزارییەکان لە کوردستان و عێراق لە یەک پلاتفۆرمدا پێکەوە دەبەستێتەوە.',
    'index.featuredSubtitle': 'هەڵبژێردراو و پێداچوونەوەیان بۆ کراوە لەلایەن دەروێش گروپەوە.',
    'index.cityApartments': 'ئاپارتمان',
    'index.browseByCitySubtitle': 'پرۆژەکانی ئاپارتمان و کۆمەڵگە نیشتەجێبوونەکان لە شاری دڵخوازت بدۆزەرەوە.',
    'index.viewOfferOnline': 'بینینی پێشکەشکردنەکە سەرهێڵ',
    'map.titleTypeForRent': '{type} بۆ کرێ',
    'map.titleInCityForRent': 'خانووبەرە بۆ کرێ لە {city}',
    'map.bedrooms': 'ژووری نوستن',
    'buy.apartmentsSuffix': 'ئاپارتمانەکان',
    'buy.subtitle': 'موڵک و خانووی بەردەست بۆ فرۆشتن لە هەرێمی کوردستان ببینە، لەگەڵ یارمەتی تیمی دەروێش گروپ.',
    'buy.cityHeadingSubtitle': 'موڵکەکانی بۆ فرۆشتن لە',
    'rent.subtitle': 'موڵکە بەردەستەکان بۆ کرێ لە کوردستان ببینە.',
    'proj.categoryApartment': 'ئاپارتمانەکان',
    'sell.subtitle': 'موڵکەکەت لەگەڵ دەروێش گروپ تۆمار بکە و لە ڕێگەی پڕۆسەی پێداچوونەوەکەمان بەڕێوەی ببە.',
    'sell.benefit4': 'دەتوانرێت یارمەتی وێنەگرتنی پیشەیی ڕێکبخرێت.'
  },
  ar: {
    'footer.tagline': 'تربط مجموعة درويش الباحثين عن العقارات والمالكين والمهنيين والخدمات في كردستان والعراق ضمن منصة واحدة.',
    'cities.koya': 'كويه',
    'buy.subtitle': 'تصفح المنازل والعقارات المتاحة للبيع في إقليم كردستان مع دعم فريق مجموعة درويش.',
    'buy.cityHeadingSubtitle': 'عقارات للبيع في',
    'rent.subtitle': 'تصفح العقارات المتاحة للإيجار في كردستان.',
    'sell.subtitle': 'أدرج عقارك مع مجموعة درويش وتابع الطلب عبر عملية المراجعة لدينا.',
    'sell.benefit4': 'يمكن ترتيب دعم للتصوير الاحترافي.'
  },
  tr: {
    'footer.tagline': 'Darwesh Group, Kürdistan ve Irak genelinde emlak arayanları, mülk sahiplerini, profesyonelleri ve hizmetleri tek platformda buluşturur.',
    'buy.subtitle': 'Kürdistan Bölgesi genelindeki satılık ev ve emlakları Darwesh Group ekibinin desteğiyle inceleyin.',
    'buy.cityHeadingSubtitle': 'Satılık emlaklar:',
    'rent.subtitle': 'Kürdistan genelindeki kiralık emlakları inceleyin.',
    'sell.subtitle': 'Emlakınızı Darwesh Group ile listeleyin ve inceleme sürecimiz üzerinden yönetin.',
    'sell.benefit4': 'Profesyonel fotoğraf desteği ayarlanabilir.'
  }
};

let baseT = null;
let wrappedT = false;
function overrideValue(key) { return OVERRIDES[lang()]?.[key] || null; }
function installTranslationOverrides() {
  if (wrappedT) return true;
  if (typeof window.t !== 'function') return false;
  baseT = window.t.bind(window);
  window.t = (key) => overrideValue(key) || baseT(key);
  wrappedT = true;
  return true;
}

function setText(el, value) {
  if (el && typeof value === 'string' && el.textContent !== value) el.textContent = value;
}
function setAttr(el, name, value) {
  if (el && value && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function paintStaticOverrides() {
  const dict = OVERRIDES[lang()] || {};
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) setText(el, dict[key]);
  });
}

const ARIA = {
  en: {
    'Language': 'Language', 'Notifications': 'Notifications', 'Darwesh Group — Home': 'Darwesh Group — Home',
    'Buy or rent': 'Buy or rent', 'Profile': 'Profile', 'Primary mobile': 'Primary mobile navigation',
    'Enter Darwesh Group': 'Enter Darwesh Group', 'Darwesh social channels': 'Darwesh social channels',
    'Close': 'Close', 'Save to favorites': 'Save to favorites', 'Remove photo': 'Remove photo',
    'Search for area, street or landmark': 'Search for area, street or landmark', 'Installment filters': 'Installment filters',
    'Voice replies': 'Voice replies', 'Ask MAM': 'Ask MAM', 'Speak your question': 'Speak your question', 'Send message': 'Send message',
    'Keyword search': 'Keyword search', 'Property type': 'Property type', 'City': 'City', 'Bedrooms': 'Bedrooms',
    'Minimum price': 'Minimum price', 'Maximum price': 'Maximum price', 'Sort': 'Sort', 'Filters': 'Filters',
    'Close filters': 'Close filters', 'City suggestions': 'City suggestions'
  },
  ku: {
    'Language': 'زمان', 'Notifications': 'ئاگادارکردنەوەکان', 'Darwesh Group — Home': 'دەروێش گروپ — سەرەکی',
    'Buy or rent': 'کڕین یان کرێ', 'Profile': 'پرۆفایل', 'Primary mobile': 'ڕێنیشاندەری سەرەکیی مۆبایل',
    'Enter Darwesh Group': 'بچۆ ناو دەروێش گروپ', 'Darwesh social channels': 'کەناڵە کۆمەڵایەتییەکانی دەروێش',
    'Close': 'داخستن', 'Save to favorites': 'پاشەکەوتکردن بۆ دڵخوازەکان', 'Remove photo': 'لابردنی وێنە',
    'Search for area, street or landmark': 'گەڕان بۆ ناوچە، شەقام یان نیشانەی ناسراو', 'Installment filters': 'پاڵاوتنی قیست',
    'Voice replies': 'وەڵامی دەنگی', 'Ask MAM': 'پرسیار لە MAM بکە', 'Speak your question': 'پرسیارەکەت بە دەنگ بڵێ', 'Send message': 'ناردنی پەیام',
    'Keyword search': 'گەڕان بە وشە', 'Property type': 'جۆری موڵک', 'City': 'شار', 'Bedrooms': 'ژووری نوستن',
    'Minimum price': 'کەمترین نرخ', 'Maximum price': 'زۆرترین نرخ', 'Sort': 'ڕیزکردن', 'Filters': 'پاڵاوتن',
    'Close filters': 'داخستنی پاڵاوتنەکان', 'City suggestions': 'پێشنیارەکانی شار'
  },
  ar: {
    'Language': 'اللغة', 'Notifications': 'الإشعارات', 'Darwesh Group — Home': 'مجموعة درويش — الرئيسية',
    'Buy or rent': 'شراء أو إيجار', 'Profile': 'الملف الشخصي', 'Primary mobile': 'التنقل الرئيسي على الهاتف',
    'Enter Darwesh Group': 'الدخول إلى مجموعة درويش', 'Darwesh social channels': 'قنوات مجموعة درويش الاجتماعية',
    'Close': 'إغلاق', 'Save to favorites': 'حفظ في المفضلة', 'Remove photo': 'إزالة الصورة',
    'Search for area, street or landmark': 'ابحث عن منطقة أو شارع أو معلم', 'Installment filters': 'فلاتر التقسيط',
    'Voice replies': 'الردود الصوتية', 'Ask MAM': 'اسأل MAM', 'Speak your question': 'انطق سؤالك', 'Send message': 'إرسال الرسالة',
    'Keyword search': 'بحث بالكلمات', 'Property type': 'نوع العقار', 'City': 'المدينة', 'Bedrooms': 'غرف النوم',
    'Minimum price': 'الحد الأدنى للسعر', 'Maximum price': 'الحد الأقصى للسعر', 'Sort': 'الترتيب', 'Filters': 'الفلاتر',
    'Close filters': 'إغلاق الفلاتر', 'City suggestions': 'اقتراحات المدن'
  },
  tr: {
    'Language': 'Dil', 'Notifications': 'Bildirimler', 'Darwesh Group — Home': 'Darwesh Group — Ana Sayfa',
    'Buy or rent': 'Satın al veya kirala', 'Profile': 'Profil', 'Primary mobile': 'Ana mobil gezinme',
    'Enter Darwesh Group': 'Darwesh Group’a gir', 'Darwesh social channels': 'Darwesh sosyal kanalları',
    'Close': 'Kapat', 'Save to favorites': 'Favorilere kaydet', 'Remove photo': 'Fotoğrafı kaldır',
    'Search for area, street or landmark': 'Bölge, sokak veya önemli yer ara', 'Installment filters': 'Taksit filtreleri',
    'Voice replies': 'Sesli yanıtlar', 'Ask MAM': 'MAM’a sor', 'Speak your question': 'Sorunuzu söyleyin', 'Send message': 'Mesaj gönder',
    'Keyword search': 'Anahtar kelime arama', 'Property type': 'Emlak türü', 'City': 'Şehir', 'Bedrooms': 'Yatak odaları',
    'Minimum price': 'Minimum fiyat', 'Maximum price': 'Maksimum fiyat', 'Sort': 'Sırala', 'Filters': 'Filtreler',
    'Close filters': 'Filtreleri kapat', 'City suggestions': 'Şehir önerileri'
  }
};

function paintAria() {
  const copy = ARIA[lang()] || ARIA.en;
  document.querySelectorAll('[aria-label]').forEach((el) => {
    if (el.hasAttribute('data-i18n-aria')) return;
    const original = el.dataset.editorialAriaOriginal || el.getAttribute('aria-label');
    if (!el.dataset.editorialAriaOriginal) el.dataset.editorialAriaOriginal = original;
    if (copy[original]) setAttr(el, 'aria-label', copy[original]);
  });
}

const META = {
  en: {
    'index.html': ['Darwesh Group — Real Estate & Services', 'Explore properties, projects, professionals and real estate services across Kurdistan and Iraq with Darwesh Group.'],
    'buy.html': ['Darwesh Group — Buy Property', 'Browse homes, land and other properties for sale across Kurdistan with Darwesh Group.'],
    'rent.html': ['Darwesh Group — Rent Property', 'Browse available rental properties across Kurdistan with Darwesh Group.'],
    'map.html': ['Darwesh Group — Property Map', 'Explore properties for sale and rent on an interactive map with filters and saved searches.'],
    'listing.html': ['Darwesh Group — Property Details', 'View property details, location information and available contact options.'],
    'sell.html': ['Darwesh Group — Sell Property', 'Submit your property to Darwesh Group and follow it through the review process.'],
    'installments.html': ['Darwesh Group — Installment Properties', 'Browse properties whose published project information includes installment options.'],
    'about.html': ['Darwesh Group — About Us', 'Learn about Darwesh Group, our platform, services and professional network.'],
    'mam-ai.html': ['Darwesh Group — MAM AI', 'Use MAM AI to explore Darwesh Group properties, projects and services.'],
    'projects.html': ['Darwesh Group — Projects', 'Explore residential and commercial projects available through Darwesh Group.']
  },
  ku: {
    'index.html': ['دەروێش گروپ — موڵک و خزمەتگوزاری', 'موڵک، پڕۆژە، پسپۆڕ و خزمەتگوزارییەکانی خانووبەرە لە کوردستان و عێراق لە دەروێش گروپ ببینە.'],
    'buy.html': ['دەروێش گروپ — کڕینی موڵک', 'خانوو، زەوی و موڵکەکانی تر بۆ فرۆشتن لە کوردستان ببینە.'],
    'rent.html': ['دەروێش گروپ — کرێی موڵک', 'موڵکە بەردەستەکان بۆ کرێ لە کوردستان ببینە.'],
    'map.html': ['دەروێش گروپ — نەخشەی موڵک', 'موڵکەکانی فرۆشتن و کرێ لەسەر نەخشە ببینە و بە پاڵاوتن بگەڕێ.'],
    'listing.html': ['دەروێش گروپ — وردەکاریی موڵک', 'وردەکاریی موڵک، زانیاریی شوێن و هەڵبژاردەکانی پەیوەندی ببینە.'],
    'sell.html': ['دەروێش گروپ — فرۆشتنی موڵک', 'موڵکەکەت بۆ دەروێش گروپ بنێرە و پڕۆسەی پێداچوونەوەکەی بەدواداچوون بکە.'],
    'installments.html': ['دەروێش گروپ — موڵکی قیستی', 'ئەو موڵکانە ببینە کە زانیاریی بڵاوکراوەی پڕۆژەکانیان هەڵبژاردەی قیست لەخۆدەگرێت.'],
    'about.html': ['دەروێش گروپ — دەربارەمان', 'دەربارەی دەروێش گروپ، پلاتفۆرمەکە، خزمەتگوزارییەکان و تۆڕی پسپۆڕان بزانە.'],
    'mam-ai.html': ['دەروێش گروپ — MAM AI', 'بە MAM AI موڵک، پڕۆژە و خزمەتگوزارییەکانی دەروێش گروپ بگەڕێ.'],
    'projects.html': ['دەروێش گروپ — پڕۆژەکان', 'پڕۆژە نیشتەجێبوون و بازرگانییە بەردەستەکان لە دەروێش گروپ ببینە.']
  },
  ar: {
    'index.html': ['مجموعة درويش — العقارات والخدمات', 'استكشف العقارات والمشاريع والمهنيين والخدمات العقارية في كردستان والعراق مع مجموعة درويش.'],
    'buy.html': ['مجموعة درويش — شراء عقار', 'تصفح المنازل والأراضي والعقارات الأخرى المعروضة للبيع في كردستان.'],
    'rent.html': ['مجموعة درويش — إيجار عقار', 'تصفح العقارات المتاحة للإيجار في كردستان.'],
    'map.html': ['مجموعة درويش — خريطة العقارات', 'استكشف عقارات البيع والإيجار على الخريطة واستخدم الفلاتر للبحث.'],
    'listing.html': ['مجموعة درويش — تفاصيل العقار', 'اطلع على تفاصيل العقار ومعلومات الموقع وخيارات التواصل المتاحة.'],
    'sell.html': ['مجموعة درويش — بيع عقار', 'أرسل عقارك إلى مجموعة درويش وتابع عملية المراجعة.'],
    'installments.html': ['مجموعة درويش — عقارات بالتقسيط', 'تصفح العقارات التي تتضمن معلومات مشاريعها المنشورة خيارات للتقسيط.'],
    'about.html': ['مجموعة درويش — من نحن', 'تعرف على مجموعة درويش والمنصة والخدمات وشبكة المهنيين.'],
    'mam-ai.html': ['مجموعة درويش — MAM AI', 'استخدم MAM AI لاستكشاف عقارات ومشاريع وخدمات مجموعة درويش.'],
    'projects.html': ['مجموعة درويش — المشاريع', 'استكشف المشاريع السكنية والتجارية المتاحة عبر مجموعة درويش.']
  },
  tr: {
    'index.html': ['Darwesh Group — Emlak ve Hizmetler', 'Darwesh Group ile Kürdistan ve Irak genelindeki emlakları, projeleri, profesyonelleri ve hizmetleri keşfedin.'],
    'buy.html': ['Darwesh Group — Emlak Satın Al', 'Kürdistan genelindeki satılık ev, arsa ve diğer emlakları inceleyin.'],
    'rent.html': ['Darwesh Group — Emlak Kirala', 'Kürdistan genelindeki kiralık emlakları inceleyin.'],
    'map.html': ['Darwesh Group — Emlak Haritası', 'Satılık ve kiralık emlakları haritada keşfedin ve filtrelerle arayın.'],
    'listing.html': ['Darwesh Group — Emlak Detayları', 'Emlak detaylarını, konum bilgisini ve mevcut iletişim seçeneklerini görüntüleyin.'],
    'sell.html': ['Darwesh Group — Emlak Sat', 'Emlakınızı Darwesh Group’a gönderin ve inceleme sürecini takip edin.'],
    'installments.html': ['Darwesh Group — Taksitli Emlaklar', 'Yayınlanmış proje bilgilerinde taksit seçeneği bulunan emlakları inceleyin.'],
    'about.html': ['Darwesh Group — Hakkımızda', 'Darwesh Group, platform, hizmetler ve profesyonel ağ hakkında bilgi alın.'],
    'mam-ai.html': ['Darwesh Group — MAM AI', 'MAM AI ile Darwesh Group emlaklarını, projelerini ve hizmetlerini keşfedin.'],
    'projects.html': ['Darwesh Group — Projeler', 'Darwesh Group üzerinden sunulan konut ve ticari projeleri keşfedin.']
  }
};

function pageName() { return location.pathname.split('/').pop() || 'index.html'; }
function paintMeta() {
  const entry = META[lang()]?.[pageName()];
  if (!entry) return;
  const [title, description] = entry;
  document.title = title;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', description);
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogDesc = document.querySelector('meta[property="og:description"]');
  const twTitle = document.querySelector('meta[name="twitter:title"]');
  const twDesc = document.querySelector('meta[name="twitter:description"]');
  if (ogTitle) ogTitle.setAttribute('content', title);
  if (ogDesc) ogDesc.setAttribute('content', description);
  if (twTitle) twTitle.setAttribute('content', title);
  if (twDesc) twDesc.setAttribute('content', description);
}

const TOASTS = {
  ku: {
    'Log in to save favorites': 'بچۆ ژوورەوە بۆ پاشەکەوتکردن لە دڵخوازەکان',
    'Removed from favorites': 'لە دڵخوازەکان لابرا',
    'Saved to favorites': 'لە دڵخوازەکان پاشەکەوت کرا',
    'Log in to save searches': 'بچۆ ژوورەوە بۆ پاشەکەوتکردنی گەڕان',
    'Search saved to your account': 'گەڕانەکە لە هەژمارەکەت پاشەکەوت کرا'
  },
  ar: {
    'Log in to save favorites': 'سجّل الدخول لحفظ المفضلة',
    'Removed from favorites': 'تمت الإزالة من المفضلة',
    'Saved to favorites': 'تم الحفظ في المفضلة',
    'Log in to save searches': 'سجّل الدخول لحفظ عمليات البحث',
    'Search saved to your account': 'تم حفظ البحث في حسابك'
  },
  tr: {
    'Log in to save favorites': 'Favorileri kaydetmek için giriş yapın',
    'Removed from favorites': 'Favorilerden kaldırıldı',
    'Saved to favorites': 'Favorilere kaydedildi',
    'Log in to save searches': 'Aramaları kaydetmek için giriş yapın',
    'Search saved to your account': 'Arama hesabınıza kaydedildi'
  }
};

let toastWrapped = false;
function installBuyToastLocalization() {
  if (pageName() !== 'buy.html' || toastWrapped || typeof window.showToast !== 'function') return;
  const original = window.showToast;
  window.showToast = function (message, icon) {
    const translated = TOASTS[lang()]?.[message] || message;
    return original.call(this, translated, icon);
  };
  toastWrapped = true;
}

const CITY = {
  ku: { Erbil: 'هەولێر', Sulaymaniyah: 'سلێمانی', Duhok: 'دهۆک', Kirkuk: 'کەرکووک', Halabja: 'هەڵەبجە', Zakho: 'زاخۆ', Koya: 'کۆیە', Soran: 'سۆران' },
  ar: { Erbil: 'أربيل', Sulaymaniyah: 'السليمانية', Duhok: 'دهوك', Kirkuk: 'كركوك', Halabja: 'حلبجة', Zakho: 'زاخو', Koya: 'كويه', Soran: 'سوران' },
  tr: { Erbil: 'Erbil', Sulaymaniyah: 'Süleymaniye', Duhok: 'Duhok', Kirkuk: 'Kerkük', Halabja: 'Halepçe', Zakho: 'Zaho', Koya: 'Koya', Soran: 'Soran' }
};

const RAW = {
  ku: { commercialProperty: 'موڵکی بازرگانی', 'Price on request': 'نرخ بە داواکردن' },
  ar: { commercialProperty: 'عقار تجاري', 'Price on request': 'السعر عند الطلب' },
  tr: { commercialProperty: 'Ticari Emlak', 'Price on request': 'Fiyat için iletişime geçin' }
};

function paintBuyDynamic() {
  if (pageName() !== 'buy.html') return;
  const count = document.getElementById('resultCount');
  const m = (count?.textContent || '').trim().match(/^(\d+) properties for sale$/);
  if (m && lang() !== 'en') {
    const n = m[1];
    setText(count, lang() === 'ku' ? `${n} موڵک بۆ فرۆشتن` : lang() === 'ar' ? `${n} عقار للبيع` : `Satılık ${n} emlak`);
  }
}

function paintMapDynamic() {
  if (pageName() !== 'map.html') return;
  const cities = CITY[lang()];
  if (cities) {
    document.querySelectorAll('#citySuggestList *').forEach((el) => {
      const original = el.dataset.editorialCityOriginal || (el.textContent || '').trim();
      if (!el.dataset.editorialCityOriginal && cities[original]) el.dataset.editorialCityOriginal = original;
      if (cities[original] && el.children.length === 0) setText(el, cities[original]);
    });
  }
  const raw = RAW[lang()];
  if (raw) {
    document.querySelectorAll('#cardList *, .leaflet-popup-content *').forEach((el) => {
      if (el.children.length) return;
      const text = (el.textContent || '').trim();
      if (raw[text]) setText(el, raw[text]);
    });
  }
}

function paintSavedSearchLabels() {
  const root = document.getElementById('searchesList');
  if (!root || lang() === 'en') return;
  root.querySelectorAll('p').forEach((el) => {
    const text = (el.textContent || '').trim();
    if (!text || el.dataset.editorialSavedSearch === '1') return;
    if (/ on Buy$/.test(text)) {
      let next = text.replace(/ on Buy$/, lang() === 'ku' ? ' · گەڕانی کڕین' : lang() === 'ar' ? ' · بحث الشراء' : ' · Satın alma araması');
      next = next.replace(/^All types/, lang() === 'ku' ? 'هەموو جۆرەکان' : lang() === 'ar' ? 'كل الأنواع' : 'Tüm türler');
      el.dataset.editorialSavedSearch = '1';
      setText(el, next);
    }
  });
}

const ADMIN_CONFIRM = {
  ku: {
    clear: 'تۆماری سکان کە لەم ئامێرە پاشەکەوت کراوە پاک بکرێتەوە؟ ئەم کردارە ناگەڕێتەوە.',
    adminTail: ' ئەمە دەسەڵاتی تەواوی بەڕێوەبەر دەدات.'
  },
  ar: {
    clear: 'هل تريد مسح سجل المسح المحفوظ على هذا الجهاز؟ لا يمكن التراجع عن ذلك.',
    adminTail: ' سيمنح هذا صلاحية الإدارة الكاملة.'
  },
  tr: {
    clear: 'Bu cihazda kayıtlı tarama günlüğü temizlensin mi? Bu işlem geri alınamaz.',
    adminTail: ' Bu işlem tam yönetici erişimi verir.'
  }
};

let confirmWrapped = false;
function installConfirmLocalization() {
  if (pageName() !== 'admin.html' || confirmWrapped || lang() === 'en') return;
  const original = window.confirm.bind(window);
  window.confirm = function (message) {
    let text = String(message);
    const c = ADMIN_CONFIRM[lang()];
    if (text === 'Clear the scan log saved on this device? This cannot be undone.') text = c.clear;
    else {
      const m = text.match(/^Change (.+)'s role to "(.+)"\?( This grants full admin access\.)?$/);
      if (m) {
        text = lang() === 'ku'
          ? `ڕۆڵی ${m[1]} بگۆڕدرێت بۆ «${m[2]}»؟${m[3] ? c.adminTail : ''}`
          : lang() === 'ar'
            ? `هل تريد تغيير دور ${m[1]} إلى «${m[2]}»؟${m[3] ? c.adminTail : ''}`
            : `${m[1]} kullanıcısının rolü “${m[2]}” olarak değiştirilsin mi?${m[3] ? c.adminTail : ''}`;
      }
    }
    return original(text);
  };
  confirmWrapped = true;
}

let queued = false;
function paintAll() {
  installTranslationOverrides();
  paintStaticOverrides();
  paintAria();
  paintMeta();
  installBuyToastLocalization();
  installConfirmLocalization();
  paintBuyDynamic();
  paintMapDynamic();
  paintSavedSearchLabels();
}
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; paintAll(); });
}

const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
document.addEventListener('darwesh:langchange', schedule);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintAll, { once: true });
else paintAll();
if (!installTranslationOverrides()) setTimeout(() => { installTranslationOverrides(); paintAll(); }, 0);
