// Final pass for components whose text is rendered by JS before the shared
// editorial wrappers are guaranteed to be installed. This never touches
// user/Firestore content; only known Darwesh UI nodes are rewritten.
const LANG_KEY = 'darwesh_lang';
const COPY = {
  en: {
    footer: 'Darwesh Group connects property seekers, owners, professionals and services across Kurdistan and Iraq in one platform.',
    rights: 'All rights reserved.',
    commercial: 'Commercial Property'
  },
  ku: {
    footer: 'دەروێش گروپ گەڕۆکانی موڵک، خاوەن موڵک، پسپۆڕان و خزمەتگوزارییەکان لە کوردستان و عێراق لە یەک پلاتفۆرمدا پێکەوە دەبەستێتەوە.',
    rights: 'هەموو مافەکان پارێزراون.',
    commercial: 'موڵکی بازرگانی'
  },
  ar: {
    footer: 'تربط مجموعة درويش الباحثين عن العقارات والمالكين والمهنيين والخدمات في كردستان والعراق ضمن منصة واحدة.',
    rights: 'جميع الحقوق محفوظة.',
    commercial: 'عقار تجاري'
  },
  tr: {
    footer: 'Darwesh Group, Kürdistan ve Irak genelinde emlak arayanları, mülk sahiplerini, profesyonelleri ve hizmetleri tek platformda buluşturur.',
    rights: 'Tüm hakları saklıdır.',
    commercial: 'Ticari Emlak'
  }
};
function lang() {
  const value = localStorage.getItem(LANG_KEY);
  return COPY[value] ? value : 'en';
}
function setText(el, value) {
  if (el && value && el.textContent !== value) el.textContent = value;
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
