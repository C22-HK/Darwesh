// Admin Estate Data semantic label repair
// ------------------------------------------------------------
// admin.html's Estate Data renderer historically reused translation keys
// whose original meanings differ from the fields being rendered (for
// example Office for District/Organization and Current Asking for Project
// ID). English fallbacks masked that bug; KU/AR exposed it. This module
// scopes the repair to #edRecord's fixed semantic card layout so legitimate
// uses of Office, Status, Agent, etc. elsewhere in Admin stay untouched.

const LANG_KEY = 'darwesh_lang';
const COPY = {
  en: {
    listingId: 'Listing ID', currentAsking: 'Current asking price', status: 'Status', agent: 'Agent', office: 'Office',
    price: 'Price', type: 'Type', date: 'Date', verifiedBy: 'Verified by',
    city: 'City', district: 'District', address: 'Address', latLng: 'Lat/Lng',
    projectId: 'Project ID', buildingId: 'Building ID', unitId: 'Unit ID',
    created: 'Created', updated: 'Updated', organization: 'Organization', protectedNotes: 'Protected admin notes'
  },
  ku: {
    listingId: 'ناسنامەی لیستکردن', currentAsking: 'نرخی داواکراوی ئێستا', status: 'دۆخ', agent: 'نوێنەر', office: 'نووسینگە',
    price: 'نرخ', type: 'جۆر', date: 'بەروار', verifiedBy: 'پشتڕاستکراوەتەوە لەلایەن',
    city: 'شار', district: 'ناوچە', address: 'ناونیشان', latLng: 'Lat/Lng',
    projectId: 'ناسنامەی پڕۆژە', buildingId: 'ناسنامەی بینا', unitId: 'ناسنامەی یەکە',
    created: 'دروستکراوە لە', updated: 'نوێکراوەتەوە لە', organization: 'ڕێکخراو', protectedNotes: 'تێبینییە پارێزراوەکانی بەڕێوەبەر'
  },
  ar: {
    listingId: 'معرّف الإعلان', currentAsking: 'السعر المطلوب حاليًا', status: 'الحالة', agent: 'الوكيل', office: 'المكتب',
    price: 'السعر', type: 'النوع', date: 'التاريخ', verifiedBy: 'تم التحقق بواسطة',
    city: 'المدينة', district: 'المنطقة', address: 'العنوان', latLng: 'خط العرض/الطول',
    projectId: 'معرّف المشروع', buildingId: 'معرّف المبنى', unitId: 'معرّف الوحدة',
    created: 'تاريخ الإنشاء', updated: 'آخر تحديث', organization: 'المؤسسة', protectedNotes: 'ملاحظات الإدارة المحمية'
  },
  tr: {
    listingId: 'İlan Kimliği', currentAsking: 'Güncel istenen fiyat', status: 'Durum', agent: 'Danışman', office: 'Ofis',
    price: 'Fiyat', type: 'Tür', date: 'Tarih', verifiedBy: 'Doğrulayan',
    city: 'Şehir', district: 'Bölge', address: 'Adres', latLng: 'Enlem/Boylam',
    projectId: 'Proje Kimliği', buildingId: 'Bina Kimliği', unitId: 'Birim Kimliği',
    created: 'Oluşturulma', updated: 'Güncellenme', organization: 'Kuruluş', protectedNotes: 'Korumalı yönetici notları'
  }
};

function language() {
  const value = localStorage.getItem(LANG_KEY);
  return COPY[value] ? value : 'en';
}

function setLabels(nodes, keys, copy) {
  keys.forEach((key, index) => {
    const node = nodes[index];
    if (node && node.textContent !== copy[key]) node.textContent = copy[key];
  });
}

function kvLabelNodes(card) {
  if (!card) return [];
  return [...card.querySelectorAll('.space-y-1\.5 > .flex > .text-on-surface-variant:first-child')];
}

function tableHeaders(card) {
  if (!card) return [];
  return [...card.querySelectorAll('table.admin-table thead th')];
}

function paintEstateLabels() {
  const record = document.getElementById('edRecord');
  if (!record || record.classList.contains('hidden')) return;

  // section() in admin.html renders exactly these nine semantic cards in
  // this order, separated by spacer divs. Querying only the section-card
  // class keeps the index stable even with those spacers present.
  const cards = [...record.querySelectorAll(':scope > .bg-surface-container-lowest')];
  if (cards.length < 9) return;
  const c = COPY[language()] || COPY.en;

  // 1 — Current Listing. These were partly backed by Scan Log keys.
  setLabels(kvLabelNodes(cards[1]), ['listingId', 'currentAsking', 'status', 'agent', 'office'], c);

  // 2 — Listing History. Listing ID and Price previously reused unrelated
  // Agent ID / Current Asking translation keys.
  setLabels(tableHeaders(cards[2]), ['listingId', 'status', 'price'], c);

  // 3 — Verified Transaction History. Date and Verified By previously used
  // Scanned At and Agent keys.
  setLabels(tableHeaders(cards[3]), ['type', 'price', 'date', 'verifiedBy'], c);

  // 5 — Location. District previously rendered as Office in KU/AR.
  setLabels(kvLabelNodes(cards[5]), ['city', 'district', 'address', 'latLng'], c);

  // 6 — Project / Building / Unit. Project ID previously reused Current
  // Asking, while Building/Unit IDs were unlocalized English.
  setLabels(kvLabelNodes(cards[6]), ['projectId', 'buildingId', 'unitId'], c);

  // 8 — Audit Information. Created/Updated/Organization were backed by
  // Scanned At/Status/Office keys; the protected-notes label was hardcoded.
  setLabels(kvLabelNodes(cards[8]), ['created', 'updated', 'organization', 'protectedNotes'], c);
}

let queued = false;
function schedulePaint() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    paintEstateLabels();
  });
}

// Estate records are rendered asynchronously after a search, so listen only
// to the record subtree. If it is not present yet, DOMContentLoaded retries.
function install() {
  const record = document.getElementById('edRecord');
  if (!record || record.dataset.semanticLabelsWired === '1') return;
  record.dataset.semanticLabelsWired = '1';
  new MutationObserver(schedulePaint).observe(record, { childList: true, subtree: true });
  schedulePaint();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
document.addEventListener('darwesh:langchange', schedulePaint);
