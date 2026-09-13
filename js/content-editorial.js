// Darwesh Group editorial localization layer
// ------------------------------------------------------------
// Purpose: keep approved wording fixes and dynamic-content localization in
// one small layer without duplicating the main js/i18n.js dictionaries.
// Kurdish (Sorani) is the editorial priority, while Arabic, English and
// Turkish stay semantically aligned. This module is intentionally UI-only:
// it does not change auth, Firestore data, permissions or business logic.

const LANG_KEY = 'darwesh_lang';
const SUPPORTED = new Set(['en', 'ku', 'ar', 'tr']);

function currentLang() {
  const stored = localStorage.getItem(LANG_KEY);
  if (SUPPORTED.has(stored)) return stored;
  const htmlLang = (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
  return SUPPORTED.has(htmlLang) ? htmlLang : 'en';
}

// Editorial corrections that must override older wording in the large base
// dictionary. English lives in HTML in the base i18n system, so English
// overrides are included here only where the authored fallback itself needs
// correction (for example an unsupported marketing claim).
const OVERRIDES = {
  en: {
    'promo.subtitle': 'Use this Darwesh Group offer for 10% off our brokerage fee on your next eligible Buy or Sell.',
    'promo.subtitleTpl': 'Use this Darwesh Group offer for {percent}% off our brokerage fee on your next eligible Buy or Sell.',
    'promo.placeholderNote': 'Demo staff roster — replace it with your authorized staff list before using this check-in flow operationally.',
    'sell.benefit4': 'Professional photography support can be arranged.'
  },
  ku: {
    'office.tabListings': 'موڵکەکان',
    'rp.markVerified': 'وەک پشتڕاستکراو دیاری بکە',
    'rp.markUnverified': 'دۆخی پشتڕاستکردنەوە لاببە',
    'promo.subtitle': 'ئەم پێشکەشکردنەی دەروێش گروپ بەکاربهێنە بۆ ١٠٪ داشکاندن لە کرێی ناوبژیوانی، لە کڕین یان فرۆشتنێکی شایستەی داهاتووت.',
    'promo.subtitleTpl': 'ئەم پێشکەشکردنەی دەروێش گروپ بەکاربهێنە بۆ {percent}٪ داشکاندن لە کرێی ناوبژیوانی، لە کڕین یان فرۆشتنێکی شایستەی داهاتووت.',
    'promo.placeholderNote': 'ئەم لیستی ستافە تەنها بۆ تاقیکردنەوەیە — پێش بەکارهێنانی فەرمی، لیستی ستافی ڕێپێدراوی خۆتان جێگای بگرێتەوە.',
    'sell.benefit4': 'دەتوانرێت یارمەتی وێنەگرتنی پیشەیی ڕێکبخرێت.',
    'admin.minsAgo': ' خولەک لەمەوبەر',
    'admin.hoursAgo': ' کاتژمێر لەمەوبەر',
    'admin.daysAgo': ' ڕۆژ لەمەوبەر'
  },
  ar: {
    'office.tabListings': 'العقارات',
    'rp.markVerified': 'تمييز كموثّق',
    'rp.markUnverified': 'إزالة حالة التوثيق',
    'promo.subtitle': 'استخدم عرض مجموعة درويش للحصول على خصم 10٪ من رسوم الوساطة في عملية الشراء أو البيع المؤهلة التالية.',
    'promo.subtitleTpl': 'استخدم عرض مجموعة درويش للحصول على خصم {percent}٪ من رسوم الوساطة في عملية الشراء أو البيع المؤهلة التالية.',
    'promo.placeholderNote': 'قائمة الموظفين هذه تجريبية — استبدلها بقائمة الموظفين المخوّلين قبل استخدام مسار تسجيل الحضور فعليًا.',
    'sell.benefit4': 'يمكن ترتيب دعم للتصوير الاحترافي.',
    'admin.minsAgo': ' دقيقة مضت',
    'admin.hoursAgo': ' ساعة مضت',
    'admin.daysAgo': ' يومًا مضى'
  },
  tr: {
    'office.tabListings': 'İlanlar',
    'rp.markVerified': 'Doğrulanmış Olarak İşaretle',
    'rp.markUnverified': 'Doğrulama Durumunu Kaldır',
    'promo.subtitle': 'Bir sonraki uygun alım veya satım işleminizde aracılık ücretimizde %10 indirim için bu Darwesh Group teklifini kullanın.',
    'promo.subtitleTpl': 'Bir sonraki uygun alım veya satım işleminizde aracılık ücretimizde %{percent} indirim için bu Darwesh Group teklifini kullanın.',
    'promo.placeholderNote': 'Bu personel listesi demodur — bu giriş akışını gerçek kullanımda açmadan önce yetkili personel listenizle değiştirin.',
    'sell.benefit4': 'Profesyonel fotoğraf desteği ayarlanabilir.',
    'admin.minsAgo': ' dk önce',
    'admin.hoursAgo': ' sa önce',
    'admin.daysAgo': ' gün önce'
  }
};

let baseT = null;
let tWrapped = false;

function editorialValue(key, lang = currentLang()) {
  return OVERRIDES[lang]?.[key] || null;
}

function installTranslationOverride() {
  if (tWrapped) return true;
  if (typeof window.t !== 'function') return false;
  baseT = window.t.bind(window);
  window.t = function editorialT(key) {
    return editorialValue(key) || baseT(key);
  };
  tWrapped = true;
  return true;
}

function setText(el, value) {
  if (el && typeof value === 'string' && el.textContent !== value) el.textContent = value;
}

function setHtml(el, value) {
  if (el && typeof value === 'string' && el.innerHTML !== value) el.innerHTML = value;
}

function replaceVars(template, vars) {
  return Object.entries(vars || {}).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template
  );
}

function tr(key, fallback, vars) {
  const value = editorialValue(key) || (typeof window.t === 'function' ? window.t(key) : null) || fallback;
  return replaceVars(value, vars);
}

function applyStaticOverrides() {
  const dict = OVERRIDES[currentLang()] || {};
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = dict[el.getAttribute('data-i18n')];
    if (value) setText(el, value);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const value = dict[el.getAttribute('data-i18n-placeholder')];
    if (value && el.getAttribute('placeholder') !== value) el.setAttribute('placeholder', value);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const value = dict[el.getAttribute('data-i18n-title')];
    if (value && el.getAttribute('title') !== value) el.setAttribute('title', value);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const value = dict[el.getAttribute('data-i18n-aria')];
    if (value && el.getAttribute('aria-label') !== value) el.setAttribute('aria-label', value);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const value = dict[el.getAttribute('data-i18n-html')];
    if (value) setHtml(el, value);
  });
}

const ACCOUNT_COPY = {
  en: {
    title: 'Darwesh Group — My Account', welcome: 'Welcome, {name}', favorites: '{n} favorite{plural}', searches: '{n} saved search{plural}',
    uploading: 'Uploading photo…', uploadFailed: 'Photo upload failed. Please try again.', remove: 'Remove', open: 'Open',
    savedSearch: 'Saved search', submission: 'Submission', sellSubmission: 'Sell submission', pending: 'Pending',
    agent: 'Darwesh Group Agent', group: 'Darwesh Group', perMonth: '/mo', photoTitle: 'Change profile photo',
    favoritesEmpty: 'No favorites yet. Tap the heart icon on any listing in <a href="map.html" class="text-secondary hover:underline">Map</a> or <a href="buy.html" class="text-secondary hover:underline">Buy</a> to save it here.',
    submissionsEmpty: 'No submissions yet. Once you list a property via <a href="sell.html" class="text-secondary hover:underline">Sell</a> while logged in, it will show up here.',
    searchesEmpty: 'No saved searches yet. Set your filters on <a href="map.html" class="text-secondary hover:underline">Map</a> or <a href="buy.html" class="text-secondary hover:underline">Buy</a>, then save the search.',
    agentEmpty: 'You do not have an assigned agent yet. Contact Darwesh Group to get connected, or browse <a href="map.html" class="text-secondary hover:underline">Map</a> in the meantime.'
  },
  ku: {
    title: 'دەروێش گروپ — هەژماری من', welcome: 'بەخێربێیت، {name}', favorites: '{n} دڵخواز', searches: '{n} گەڕانی پاشەکەوتکراو',
    uploading: 'وێنەکە بار دەکرێت…', uploadFailed: 'بارکردنی وێنەکە سەرکەوتوو نەبوو. تکایە دووبارە هەوڵبدەوە.', remove: 'لابردن', open: 'کردنەوە',
    savedSearch: 'گەڕانی پاشەکەوتکراو', submission: 'داواکاری', sellSubmission: 'داواکاری فرۆشتن', pending: 'چاوەڕوانی پێداچوونەوە',
    agent: 'نوێنەری دەروێش گروپ', group: 'دەروێش گروپ', perMonth: '/ مانگ', photoTitle: 'گۆڕینی وێنەی پرۆفایل',
    favoritesEmpty: 'هێشتا هیچ موڵکێکت بە دڵخواز زیاد نەکردووە. لە <a href="map.html" class="text-secondary hover:underline">نەخشە</a> یان <a href="buy.html" class="text-secondary hover:underline">کڕین</a> نیشانی دڵ لەسەر هەر موڵکێک دابگرە تا لێرە پاشەکەوت بێت.',
    submissionsEmpty: 'هێشتا هیچ داواکارییەکت نەناردووە. کاتێک بە هەژمارەکەتەوە موڵکێک لە بەشی <a href="sell.html" class="text-secondary hover:underline">فرۆشتن</a> بنێریت، لێرە دەردەکەوێت.',
    searchesEmpty: 'هێشتا هیچ گەڕانێکت پاشەکەوت نەکردووە. فلتەرەکانت لە <a href="map.html" class="text-secondary hover:underline">نەخشە</a> یان <a href="buy.html" class="text-secondary hover:underline">کڕین</a> دیاری بکە و گەڕانەکە پاشەکەوت بکە.',
    agentEmpty: 'هێشتا هیچ نوێنەرێکت بۆ دیاری نەکراوە. بۆ پەیوەستبوون بە نوێنەرێک پەیوەندی بە دەروێش گروپ بکە، یان لە ئێستادا <a href="map.html" class="text-secondary hover:underline">نەخشە</a> ببینە.'
  },
  ar: {
    title: 'مجموعة درويش — حسابي', welcome: 'مرحبًا، {name}', favorites: '{n} مفضلة', searches: '{n} بحث محفوظ',
    uploading: 'جارٍ رفع الصورة…', uploadFailed: 'تعذر رفع الصورة. حاول مرة أخرى.', remove: 'إزالة', open: 'فتح',
    savedSearch: 'بحث محفوظ', submission: 'طلب', sellSubmission: 'طلب بيع', pending: 'قيد المراجعة',
    agent: 'وكيل مجموعة درويش', group: 'مجموعة درويش', perMonth: '/ شهر', photoTitle: 'تغيير صورة الملف الشخصي',
    favoritesEmpty: 'لا توجد عقارات مفضلة بعد. اضغط رمز القلب على أي عقار في <a href="map.html" class="text-secondary hover:underline">الخريطة</a> أو <a href="buy.html" class="text-secondary hover:underline">الشراء</a> لحفظه هنا.',
    submissionsEmpty: 'لا توجد طلبات بعد. عند إرسال عقار عبر <a href="sell.html" class="text-secondary hover:underline">البيع</a> أثناء تسجيل الدخول، سيظهر هنا.',
    searchesEmpty: 'لا توجد عمليات بحث محفوظة بعد. حدّد الفلاتر في <a href="map.html" class="text-secondary hover:underline">الخريطة</a> أو <a href="buy.html" class="text-secondary hover:underline">الشراء</a> ثم احفظ البحث.',
    agentEmpty: 'لم يتم تعيين وكيل لك بعد. تواصل مع مجموعة درويش لربطك بوكيل، أو تصفح <a href="map.html" class="text-secondary hover:underline">الخريطة</a> في الوقت الحالي.'
  },
  tr: {
    title: 'Darwesh Group — Hesabım', welcome: 'Hoş geldiniz, {name}', favorites: '{n} favori', searches: '{n} kayıtlı arama',
    uploading: 'Fotoğraf yükleniyor…', uploadFailed: 'Fotoğraf yüklenemedi. Lütfen tekrar deneyin.', remove: 'Kaldır', open: 'Aç',
    savedSearch: 'Kayıtlı arama', submission: 'Başvuru', sellSubmission: 'Satış başvurusu', pending: 'İnceleniyor',
    agent: 'Darwesh Group Danışmanı', group: 'Darwesh Group', perMonth: '/ay', photoTitle: 'Profil fotoğrafını değiştir',
    favoritesEmpty: 'Henüz favoriniz yok. Buraya kaydetmek için <a href="map.html" class="text-secondary hover:underline">Harita</a> veya <a href="buy.html" class="text-secondary hover:underline">Satın Al</a> bölümündeki bir ilanda kalp simgesine dokunun.',
    submissionsEmpty: 'Henüz başvurunuz yok. Giriş yapmışken <a href="sell.html" class="text-secondary hover:underline">Sat</a> üzerinden bir emlak gönderdiğinizde burada görünür.',
    searchesEmpty: 'Henüz kayıtlı aramanız yok. <a href="map.html" class="text-secondary hover:underline">Harita</a> veya <a href="buy.html" class="text-secondary hover:underline">Satın Al</a> bölümünde filtrelerinizi ayarlayın ve aramayı kaydedin.',
    agentEmpty: 'Henüz size atanmış bir danışman yok. Bir danışmanla eşleşmek için Darwesh Group ile iletişime geçin veya şimdilik <a href="map.html" class="text-secondary hover:underline">Harita</a> bölümüne göz atın.'
  }
};

const WELCOME_PREFIXES = ['Welcome, ', 'بەخێربێیت، ', 'مرحبًا، ', 'Hoş geldiniz, '];
const STATUS_WORDS = new Set(['Pending', 'چاوەڕوانی پێداچوونەوە', 'قيد المراجعة', 'İnceleniyor']);

function extractWelcomeName(el) {
  if (!el) return '';
  const text = (el.textContent || '').trim();
  for (const prefix of WELCOME_PREFIXES) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return el.dataset.editorialName || '';
}

function firstNumber(text) {
  const match = String(text || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function paintAccount() {
  const root = document.getElementById('accountContent');
  if (!root) return;
  const lang = currentLang();
  const c = ACCOUNT_COPY[lang] || ACCOUNT_COPY.en;
  document.title = c.title;

  const welcome = document.getElementById('welcomeName');
  const name = extractWelcomeName(welcome);
  if (name) {
    welcome.dataset.editorialName = name;
    setText(welcome, replaceVars(c.welcome, { name }));
  }

  const favStat = document.getElementById('statFavorites');
  const favN = firstNumber(favStat?.textContent);
  if (favN !== null) setText(favStat, replaceVars(c.favorites, { n: favN, plural: lang === 'en' && favN !== 1 ? 's' : '' }));

  const searchStat = document.getElementById('statSearches');
  const searchN = firstNumber(searchStat?.textContent);
  if (searchN !== null) setText(searchStat, replaceVars(c.searches, { n: searchN, plural: lang === 'en' && searchN !== 1 ? 'es' : '' }));

  setHtml(document.getElementById('favoritesEmpty'), c.favoritesEmpty);
  setHtml(document.getElementById('submissionsEmpty'), c.submissionsEmpty);
  setHtml(document.getElementById('searchesEmpty'), c.searchesEmpty);
  setHtml(document.getElementById('agentEmpty'), c.agentEmpty);

  const photoLabel = document.querySelector('label[title="Change profile photo"], label[data-editorial-photo-title]');
  if (photoLabel) {
    photoLabel.dataset.editorialPhotoTitle = '1';
    if (photoLabel.getAttribute('title') !== c.photoTitle) photoLabel.setAttribute('title', c.photoTitle);
  }

  const photoStatus = document.getElementById('acctPhotoStatus');
  if (photoStatus && !photoStatus.classList.contains('hidden')) {
    const raw = photoStatus.textContent || '';
    if (/^(Uploading\.\.\.|Uploading photo…|وێنەکە بار دەکرێت|جارٍ رفع|Fotoğraf yükleniyor)/.test(raw)) setText(photoStatus, c.uploading);
    if (/^(Upload failed:|Photo upload failed|بارکردنی وێنەکە سەرکەوتوو نەبوو|تعذر رفع الصورة|Fotoğraf yüklenemedi)/.test(raw)) setText(photoStatus, c.uploadFailed);
  }

  document.querySelectorAll('#favoritesGrid button').forEach((btn) => setText(btn, c.remove));
  document.querySelectorAll('#searchesList a').forEach((link) => setText(link, c.open));
  document.querySelectorAll('#searchesList button').forEach((btn) => setText(btn, c.remove));

  document.querySelectorAll('#searchesList p').forEach((p) => {
    const text = (p.textContent || '').trim();
    if (text === 'Saved search' || p.dataset.editorialGenericSearch === '1') {
      p.dataset.editorialGenericSearch = '1';
      setText(p, c.savedSearch);
    }
  });

  document.querySelectorAll('#submissionsList .status-badge').forEach((badge) => {
    const text = (badge.textContent || '').trim();
    if (STATUS_WORDS.has(text) || badge.dataset.editorialPending === '1') {
      badge.dataset.editorialPending = '1';
      setText(badge, c.pending);
    }
  });
  document.querySelectorAll('#submissionsList p').forEach((p) => {
    const text = (p.textContent || '').trim();
    if (text === 'Sell submission' || p.dataset.editorialSellSubmission === '1') {
      p.dataset.editorialSellSubmission = '1';
      setText(p, c.sellSubmission);
    } else if (text === 'Submission' || p.dataset.editorialSubmission === '1') {
      p.dataset.editorialSubmission = '1';
      setText(p, c.submission);
    }
  });

  const agentName = document.getElementById('agentName');
  if (agentName) {
    const text = (agentName.textContent || '').trim();
    if (text === 'Darwesh Group Agent' || agentName.dataset.editorialAgentFallback === '1') {
      agentName.dataset.editorialAgentFallback = '1';
      setText(agentName, c.agent);
    }
  }
  const officeLine = document.getElementById('agentEmail');
  if (officeLine) {
    const text = (officeLine.textContent || '').trim();
    if (['Darwesh Group', 'دەروێش گروپ', 'مجموعة درويش'].includes(text) || officeLine.dataset.editorialGroupFallback === '1') {
      officeLine.dataset.editorialGroupFallback = '1';
      setText(officeLine, c.group);
    }
  }

  document.querySelectorAll('#agentListingsGrid .font-headline-md').forEach((price) => {
    const raw = price.textContent || '';
    const normalized = raw.replace(/\s*\/\s*(mo|month|مانگ|شهر|ay)\s*$/i, '');
    if (normalized !== raw || price.dataset.editorialMonthly === '1') {
      price.dataset.editorialMonthly = '1';
      setText(price, normalized.trim() + c.perMonth);
    }
  });
}

const INSIGHTS_COPY = {
  en: { allCities: 'All cities', view: 'View as table', hide: 'Hide table', perMonth: '/mo' },
  ku: { allCities: 'هەموو شارەکان', view: 'پیشاندان وەک خشتە', hide: 'شاردنەوەی خشتە', perMonth: '/ مانگ' },
  ar: { allCities: 'كل المدن', view: 'عرض كجدول', hide: 'إخفاء الجدول', perMonth: '/ شهر' },
  tr: { allCities: 'Tüm şehirler', view: 'Tablo olarak göster', hide: 'Tabloyu gizle', perMonth: '/ay' }
};

function paintInsights() {
  const note = document.getElementById('kpiListingsNote');
  if (!note) return;
  const c = INSIGHTS_COPY[currentLang()] || INSIGHTS_COPY.en;
  const cityFilter = document.getElementById('cityFilter');
  if (!cityFilter || cityFilter.value === 'all') setText(note, c.allCities);

  document.querySelectorAll('.table-toggle').forEach((btn) => {
    const target = document.getElementById(btn.dataset.target);
    const label = btn.querySelector('[data-i18n="insights.viewTable"]') || btn.lastElementChild;
    if (label) setText(label, target?.classList.contains('open') ? c.hide : c.view);
  });

  const rent = document.getElementById('kpiRent');
  if (rent && rent.textContent !== '—') {
    const base = rent.textContent.replace(/\s*\/\s*(mo|month|مانگ|شهر|ay)\s*$/i, '');
    if (base !== rent.textContent || rent.dataset.editorialMonthly === '1') {
      rent.dataset.editorialMonthly = '1';
      setText(rent, base.trim() + c.perMonth);
    }
  }
}

const PAGE_TITLES = {
  ku: {
    'office.html': 'دەروێش گروپ — پرۆفایلی نووسینگە',
    'organization.html': 'دەروێش گروپ — پرۆفایلی ڕێکخراو',
    'designer.html': 'دەروێش گروپ — پرۆفایلی دیزاینەر',
    'insights.html': 'دەروێش گروپ — زانیاری بازاڕ',
    'promo.html': 'دەروێش گروپ — پێشکەشکردن'
  },
  ar: {
    'office.html': 'مجموعة درويش — ملف المكتب',
    'organization.html': 'مجموعة درويش — ملف المؤسسة',
    'designer.html': 'مجموعة درويش — ملف المصمم',
    'insights.html': 'مجموعة درويش — تحليلات السوق',
    'promo.html': 'مجموعة درويش — العرض'
  },
  tr: {
    'office.html': 'Darwesh Group — Ofis Profili',
    'organization.html': 'Darwesh Group — Kuruluş Profili',
    'designer.html': 'Darwesh Group — Tasarımcı Profili',
    'insights.html': 'Darwesh Group — Pazar Analizleri',
    'promo.html': 'Darwesh Group — Teklif'
  }
};

function paintPageTitle() {
  const lang = currentLang();
  if (lang === 'en') return;
  const page = location.pathname.split('/').pop() || 'index.html';
  const title = PAGE_TITLES[lang]?.[page];
  if (title && document.title !== title) document.title = title;
}

let paintQueued = false;
function paintAll() {
  installTranslationOverride();
  applyStaticOverrides();
  paintAccount();
  paintInsights();
  paintPageTitle();
}

function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paintAll();
  });
}

// Dynamic cards, account data and Insights toggles are rendered after the
// initial i18n pass. Observe only text/child changes and coalesce them into
// one paint per frame; setters above compare values first, preventing loops.
const observer = new MutationObserver(queuePaint);
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

document.addEventListener('darwesh:langchange', queuePaint);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintAll, { once: true });
else paintAll();

// If a page imported this module before the classic i18n script executed,
// one deferred retry is enough; later language-change events keep it synced.
if (!installTranslationOverride()) setTimeout(() => { installTranslationOverride(); paintAll(); }, 0);

window.DarweshContentEditorial = Object.freeze({
  currentLang,
  tr,
  repaint: queuePaint
});
