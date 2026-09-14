// Darwesh Group editorial localization layer
// ------------------------------------------------------------
// Sorani-first editorial corrections and dynamic UI localization.
// UI text only: no auth, Firestore, permission or business-logic changes.

const LANG_KEY = 'darwesh_lang';
const LANGS = new Set(['en', 'ku', 'ar', 'tr']);

function lang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (LANGS.has(saved)) return saved;
  const html = (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
  return LANGS.has(html) ? html : 'en';
}

// Keys whose approved wording should supersede the older base dictionary.
// promo.subtitle is intentionally handled separately: a live Admin offer can
// replace 10% with another percentage, so a static DOM override must never
// overwrite that live value.
const OVERRIDES = {
  en: {
    'promo.subtitleTpl': 'Use this Darwesh Group offer for {percent}% off our brokerage fee on your next eligible Buy or Sell.',
    'promo.placeholderNote': 'Demo staff roster — replace it with your authorized staff list before using this check-in flow operationally.',
    'sell.benefit4': 'Professional photography support can be arranged.'
  },
  ku: {
    'office.tabListings': 'موڵکەکان',
    'rp.markVerified': 'وەک پشتڕاستکراو دیاری بکە',
    'rp.markUnverified': 'دۆخی پشتڕاستکردنەوە لاببە',
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
    'promo.subtitleTpl': 'Bir sonraki uygun alım veya satım işleminizde aracılık ücretimizde %{percent} indirim için bu Darwesh Group teklifini kullanın.',
    'promo.placeholderNote': 'Bu personel listesi demodur — bu giriş akışını gerçek kullanımda açmadan önce yetkili personel listenizle değiştirin.',
    'sell.benefit4': 'Profesyonel fotoğraf desteği ayarlanabilir.',
    'admin.minsAgo': ' dk önce',
    'admin.hoursAgo': ' sa önce',
    'admin.daysAgo': ' gün önce'
  }
};

const PROMO_STATIC = {
  en: 'Use this Darwesh Group offer for 10% off our brokerage fee on your next eligible Buy or Sell.',
  ku: 'ئەم پێشکەشکردنەی دەروێش گروپ بەکاربهێنە بۆ ١٠٪ داشکاندن لە کرێی ناوبژیوانی، لە کڕین یان فرۆشتنێکی شایستەی داهاتووت.',
  ar: 'استخدم عرض مجموعة درويش للحصول على خصم 10٪ من رسوم الوساطة في عملية الشراء أو البيع المؤهلة التالية.',
  tr: 'Bir sonraki uygun alım veya satım işleminizde aracılık ücretimizde %10 indirim için bu Darwesh Group teklifini kullanın.'
};

let baseT = null;
let wrapped = false;
function overrideValue(key) { return OVERRIDES[lang()]?.[key] || null; }
function installT() {
  if (wrapped) return true;
  if (typeof window.t !== 'function') return false;
  baseT = window.t.bind(window);
  window.t = (key) => overrideValue(key) || baseT(key);
  wrapped = true;
  return true;
}

function setText(el, value) {
  if (el && typeof value === 'string' && el.textContent !== value) el.textContent = value;
}
function setHtml(el, value) {
  if (el && typeof value === 'string' && el.innerHTML !== value) el.innerHTML = value;
}
function fill(text, vars = {}) {
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

function applyStaticOverrides() {
  const dict = OVERRIDES[lang()] || {};
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const value = dict[key];
    // Template-only values are consumed through window.t(), not written
    // directly into DOM elements that expect a concrete percentage.
    if (value && !key.endsWith('Tpl')) setText(el, value);
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
}

// The legacy subtitle claimed an in-person verification while the same page
// labels its staff roster as placeholder data. Replace only that legacy
// claim. A live offer subtitle generated from promo.subtitleTpl contains no
// verification claim, so this function deliberately leaves it untouched.
function paintPromoClaim() {
  const el = document.querySelector('[data-i18n="promo.subtitle"]');
  if (!el) return;
  const text = el.textContent || '';
  const isLegacyClaim = /Verified in person|پشتڕاست|تحق|doğrulan/i.test(text);
  if (isLegacyClaim) setText(el, PROMO_STATIC[lang()] || PROMO_STATIC.en);
}

const ACCOUNT = {
  en: {
    title: 'Darwesh Group — My Account', welcome: 'Welcome, {name}', fav: '{n} favorite{p}', searches: '{n} saved search{p}',
    uploading: 'Uploading photo…', failed: 'Photo upload failed. Please try again.', remove: 'Remove', open: 'Open', search: 'Saved search',
    submission: 'Submission', sellSubmission: 'Sell submission', pending: 'Pending', agent: 'Darwesh Group Agent', group: 'Darwesh Group', month: '/mo', photo: 'Change profile photo',
    favEmpty: 'No favorites yet. Tap the heart icon on any listing in <a href="map.html" class="text-secondary hover:underline">Map</a> or <a href="buy.html" class="text-secondary hover:underline">Buy</a> to save it here.',
    subEmpty: 'No submissions yet. Once you list a property via <a href="sell.html" class="text-secondary hover:underline">Sell</a> while logged in, it will show up here.',
    searchEmpty: 'No saved searches yet. Set your filters on <a href="map.html" class="text-secondary hover:underline">Map</a> or <a href="buy.html" class="text-secondary hover:underline">Buy</a>, then save the search.',
    agentEmpty: 'You do not have an assigned agent yet. Contact Darwesh Group to get connected, or browse <a href="map.html" class="text-secondary hover:underline">Map</a> in the meantime.'
  },
  ku: {
    title: 'دەروێش گروپ — هەژماری من', welcome: 'بەخێربێیت، {name}', fav: '{n} دڵخواز', searches: '{n} گەڕانی پاشەکەوتکراو',
    uploading: 'وێنەکە بار دەکرێت…', failed: 'بارکردنی وێنەکە سەرکەوتوو نەبوو. تکایە دووبارە هەوڵبدەوە.', remove: 'لابردن', open: 'کردنەوە', search: 'گەڕانی پاشەکەوتکراو',
    submission: 'داواکاری', sellSubmission: 'داواکاری فرۆشتن', pending: 'چاوەڕوانی پێداچوونەوە', agent: 'نوێنەری دەروێش گروپ', group: 'دەروێش گروپ', month: '/ مانگ', photo: 'گۆڕینی وێنەی پرۆفایل',
    favEmpty: 'هێشتا هیچ موڵکێکت بە دڵخواز زیاد نەکردووە. لە <a href="map.html" class="text-secondary hover:underline">نەخشە</a> یان <a href="buy.html" class="text-secondary hover:underline">کڕین</a> نیشانی دڵ لەسەر هەر موڵکێک دابگرە تا لێرە پاشەکەوت بێت.',
    subEmpty: 'هێشتا هیچ داواکارییەکت نەناردووە. کاتێک بە هەژمارەکەتەوە موڵکێک لە بەشی <a href="sell.html" class="text-secondary hover:underline">فرۆشتن</a> بنێریت، لێرە دەردەکەوێت.',
    searchEmpty: 'هێشتا هیچ گەڕانێکت پاشەکەوت نەکردووە. فلتەرەکانت لە <a href="map.html" class="text-secondary hover:underline">نەخشە</a> یان <a href="buy.html" class="text-secondary hover:underline">کڕین</a> دیاری بکە و گەڕانەکە پاشەکەوت بکە.',
    agentEmpty: 'هێشتا هیچ نوێنەرێکت بۆ دیاری نەکراوە. بۆ پەیوەستبوون بە نوێنەرێک پەیوەندی بە دەروێش گروپ بکە، یان لە ئێستادا <a href="map.html" class="text-secondary hover:underline">نەخشە</a> ببینە.'
  },
  ar: {
    title: 'مجموعة درويش — حسابي', welcome: 'مرحبًا، {name}', fav: '{n} مفضلة', searches: '{n} بحث محفوظ',
    uploading: 'جارٍ رفع الصورة…', failed: 'تعذر رفع الصورة. حاول مرة أخرى.', remove: 'إزالة', open: 'فتح', search: 'بحث محفوظ',
    submission: 'طلب', sellSubmission: 'طلب بيع', pending: 'قيد المراجعة', agent: 'وكيل مجموعة درويش', group: 'مجموعة درويش', month: '/ شهر', photo: 'تغيير صورة الملف الشخصي',
    favEmpty: 'لا توجد عقارات مفضلة بعد. اضغط رمز القلب على أي عقار في <a href="map.html" class="text-secondary hover:underline">الخريطة</a> أو <a href="buy.html" class="text-secondary hover:underline">الشراء</a> لحفظه هنا.',
    subEmpty: 'لا توجد طلبات بعد. عند إرسال عقار عبر <a href="sell.html" class="text-secondary hover:underline">البيع</a> أثناء تسجيل الدخول، سيظهر هنا.',
    searchEmpty: 'لا توجد عمليات بحث محفوظة بعد. حدّد الفلاتر في <a href="map.html" class="text-secondary hover:underline">الخريطة</a> أو <a href="buy.html" class="text-secondary hover:underline">الشراء</a> ثم احفظ البحث.',
    agentEmpty: 'لم يتم تعيين وكيل لك بعد. تواصل مع مجموعة درويش لربطك بوكيل، أو تصفح <a href="map.html" class="text-secondary hover:underline">الخريطة</a> في الوقت الحالي.'
  },
  tr: {
    title: 'Darwesh Group — Hesabım', welcome: 'Hoş geldiniz, {name}', fav: '{n} favori', searches: '{n} kayıtlı arama',
    uploading: 'Fotoğraf yükleniyor…', failed: 'Fotoğraf yüklenemedi. Lütfen tekrar deneyin.', remove: 'Kaldır', open: 'Aç', search: 'Kayıtlı arama',
    submission: 'Başvuru', sellSubmission: 'Satış başvurusu', pending: 'İnceleniyor', agent: 'Darwesh Group Danışmanı', group: 'Darwesh Group', month: '/ay', photo: 'Profil fotoğrafını değiştir',
    favEmpty: 'Henüz favoriniz yok. Buraya kaydetmek için <a href="map.html" class="text-secondary hover:underline">Harita</a> veya <a href="buy.html" class="text-secondary hover:underline">Satın Al</a> bölümündeki bir ilanda kalp simgesine dokunun.',
    subEmpty: 'Henüz başvurunuz yok. Giriş yapmışken <a href="sell.html" class="text-secondary hover:underline">Sat</a> üzerinden bir emlak gönderdiğinizde burada görünür.',
    searchEmpty: 'Henüz kayıtlı aramanız yok. <a href="map.html" class="text-secondary hover:underline">Harita</a> veya <a href="buy.html" class="text-secondary hover:underline">Satın Al</a> bölümünde filtrelerinizi ayarlayın ve aramayı kaydedin.',
    agentEmpty: 'Henüz size atanmış bir danışman yok. Bir danışmanla eşleşmek için Darwesh Group ile iletişime geçin veya şimdilik <a href="map.html" class="text-secondary hover:underline">Harita</a> bölümüne göz atın.'
  }
};

const WELCOME_PREFIXES = ['Welcome, ', 'بەخێربێیت، ', 'مرحبًا، ', 'Hoş geldiniz, '];
const PENDING_WORDS = new Set(['Pending', 'چاوەڕوانی پێداچوونەوە', 'قيد المراجعة', 'İnceleniyor']);
function numberFrom(text) { const m = String(text || '').match(/\d+/); return m ? Number(m[0]) : null; }
function welcomeName(el) {
  const text = (el?.textContent || '').trim();
  for (const prefix of WELCOME_PREFIXES) if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  return el?.dataset.editorialName || '';
}

function paintAccount() {
  if (!document.getElementById('accountContent')) return;
  const c = ACCOUNT[lang()] || ACCOUNT.en;
  document.title = c.title;

  const welcome = document.getElementById('welcomeName');
  const name = welcomeName(welcome);
  if (name) { welcome.dataset.editorialName = name; setText(welcome, fill(c.welcome, { name })); }

  const fav = document.getElementById('statFavorites');
  const favN = numberFrom(fav?.textContent);
  if (favN !== null) setText(fav, fill(c.fav, { n: favN, p: lang() === 'en' && favN !== 1 ? 's' : '' }));

  const searches = document.getElementById('statSearches');
  const searchN = numberFrom(searches?.textContent);
  if (searchN !== null) setText(searches, fill(c.searches, { n: searchN, p: lang() === 'en' && searchN !== 1 ? 'es' : '' }));

  setHtml(document.getElementById('favoritesEmpty'), c.favEmpty);
  setHtml(document.getElementById('submissionsEmpty'), c.subEmpty);
  setHtml(document.getElementById('searchesEmpty'), c.searchEmpty);
  setHtml(document.getElementById('agentEmpty'), c.agentEmpty);

  const photoLabel = document.querySelector('label[title="Change profile photo"], label[data-editorial-photo]');
  if (photoLabel) { photoLabel.dataset.editorialPhoto = '1'; if (photoLabel.title !== c.photo) photoLabel.title = c.photo; }

  const status = document.getElementById('acctPhotoStatus');
  if (status && !status.classList.contains('hidden')) {
    const raw = status.textContent || '';
    if (/^(Uploading\.\.\.|Uploading photo…|وێنەکە بار دەکرێت|جارٍ رفع|Fotoğraf yükleniyor)/.test(raw)) setText(status, c.uploading);
    if (/^(Upload failed:|Photo upload failed|بارکردنی وێنەکە سەرکەوتوو نەبوو|تعذر رفع الصورة|Fotoğraf yüklenemedi)/.test(raw)) setText(status, c.failed);
  }

  document.querySelectorAll('#favoritesGrid button').forEach((x) => setText(x, c.remove));
  document.querySelectorAll('#searchesList a').forEach((x) => setText(x, c.open));
  document.querySelectorAll('#searchesList button').forEach((x) => setText(x, c.remove));
  document.querySelectorAll('#searchesList p').forEach((x) => {
    if ((x.textContent || '').trim() === 'Saved search' || x.dataset.editorialGenericSearch) {
      x.dataset.editorialGenericSearch = '1'; setText(x, c.search);
    }
  });
  document.querySelectorAll('#submissionsList .status-badge').forEach((x) => {
    if (PENDING_WORDS.has((x.textContent || '').trim()) || x.dataset.editorialPending) {
      x.dataset.editorialPending = '1'; setText(x, c.pending);
    }
  });
  document.querySelectorAll('#submissionsList p').forEach((x) => {
    const text = (x.textContent || '').trim();
    if (text === 'Sell submission' || x.dataset.editorialSell) { x.dataset.editorialSell = '1'; setText(x, c.sellSubmission); }
    else if (text === 'Submission' || x.dataset.editorialSubmission) { x.dataset.editorialSubmission = '1'; setText(x, c.submission); }
  });

  const agent = document.getElementById('agentName');
  if (agent && ((agent.textContent || '').trim() === 'Darwesh Group Agent' || agent.dataset.editorialAgent)) {
    agent.dataset.editorialAgent = '1'; setText(agent, c.agent);
  }
  const office = document.getElementById('agentEmail');
  if (office && (['Darwesh Group', 'دەروێش گروپ', 'مجموعة درويش'].includes((office.textContent || '').trim()) || office.dataset.editorialGroup)) {
    office.dataset.editorialGroup = '1'; setText(office, c.group);
  }

  document.querySelectorAll('#agentListingsGrid .font-headline-md').forEach((x) => {
    const raw = x.textContent || '';
    const base = raw.replace(/\s*\/\s*(mo|month|مانگ|شهر|ay)\s*$/i, '');
    if (base !== raw || x.dataset.editorialMonthly) { x.dataset.editorialMonthly = '1'; setText(x, base.trim() + c.month); }
  });
}

const INSIGHTS = {
  en: { all: 'All cities', view: 'View as table', hide: 'Hide table', month: '/mo' },
  ku: { all: 'هەموو شارەکان', view: 'پیشاندان وەک خشتە', hide: 'شاردنەوەی خشتە', month: '/ مانگ' },
  ar: { all: 'كل المدن', view: 'عرض كجدول', hide: 'إخفاء الجدول', month: '/ شهر' },
  tr: { all: 'Tüm şehirler', view: 'Tablo olarak göster', hide: 'Tabloyu gizle', month: '/ay' }
};
function paintInsights() {
  const note = document.getElementById('kpiListingsNote');
  if (!note) return;
  const c = INSIGHTS[lang()] || INSIGHTS.en;
  const filter = document.getElementById('cityFilter');
  if (!filter || filter.value === 'all') setText(note, c.all);
  document.querySelectorAll('.table-toggle').forEach((btn) => {
    const target = document.getElementById(btn.dataset.target);
    const label = btn.querySelector('[data-i18n="insights.viewTable"]') || btn.lastElementChild;
    if (label) setText(label, target?.classList.contains('open') ? c.hide : c.view);
  });
  const rent = document.getElementById('kpiRent');
  if (rent && rent.textContent !== '—') {
    const raw = rent.textContent || '';
    const base = raw.replace(/\s*\/\s*(mo|month|مانگ|شهر|ay)\s*$/i, '');
    if (base !== raw || rent.dataset.editorialMonthly) { rent.dataset.editorialMonthly = '1'; setText(rent, base.trim() + c.month); }
  }
}

const TITLES = {
  ku: { 'office.html': 'دەروێش گروپ — پرۆفایلی نووسینگە', 'organization.html': 'دەروێش گروپ — پرۆفایلی ڕێکخراو', 'designer.html': 'دەروێش گروپ — پرۆفایلی دیزاینەر', 'insights.html': 'دەروێش گروپ — زانیاری بازاڕ', 'promo.html': 'دەروێش گروپ — پێشکەشکردن' },
  ar: { 'office.html': 'مجموعة درويش — ملف المكتب', 'organization.html': 'مجموعة درويش — ملف المؤسسة', 'designer.html': 'مجموعة درويش — ملف المصمم', 'insights.html': 'مجموعة درويش — تحليلات السوق', 'promo.html': 'مجموعة درويش — العرض' },
  tr: { 'office.html': 'Darwesh Group — Ofis Profili', 'organization.html': 'Darwesh Group — Kuruluş Profili', 'designer.html': 'Darwesh Group — Tasarımcı Profili', 'insights.html': 'Darwesh Group — Pazar Analizleri', 'promo.html': 'Darwesh Group — Teklif' }
};
function paintTitle() {
  if (lang() === 'en') return;
  const page = location.pathname.split('/').pop() || 'index.html';
  const title = TITLES[lang()]?.[page];
  if (title && document.title !== title) document.title = title;
}

let queued = false;
function paint() {
  installT();
  applyStaticOverrides();
  paintPromoClaim();
  paintAccount();
  paintInsights();
  paintTitle();
}
function queuePaint() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; paint(); });
}

const observer = new MutationObserver(queuePaint);
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
document.addEventListener('darwesh:langchange', queuePaint);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint, { once: true });
else paint();
if (!installT()) setTimeout(() => { installT(); paint(); }, 0);

window.DarweshContentEditorial = Object.freeze({ currentLang: lang, repaint: queuePaint });
