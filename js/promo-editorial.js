// Promo-only editorial bridge. Loaded through nav-auth.js and no-ops on
// every page except promo.html. It keeps the existing WhatsApp destination
// and device-local scan log, but removes the unsupported "verified customer"
// claim and writes the office message in the visitor's selected language.

const LANG_KEY = 'darwesh_lang';
const COPY = {
  en: ({ name, id, code, time }) => `Darwesh Group offer check-in: Agent ${name} (${id}) recorded a customer check-in for offer ${code} at ${time}.`,
  ku: ({ name, id, code, time }) => `تۆماری پێشکەشکردنی دەروێش گروپ: نوێنەر ${name} (${id}) تۆماری هاتنی کڕیارێکی بۆ پێشکەشکردنی ${code} لە ${time} کرد.`,
  ar: ({ name, id, code, time }) => `تسجيل عرض مجموعة درويش: سجّل الوكيل ${name} (${id}) حضور عميل لعرض ${code} في ${time}.`,
  tr: ({ name, id, code, time }) => `Darwesh Group teklif kaydı: Danışman ${name} (${id}), ${time} tarihinde ${code} teklifi için bir müşteri girişini kaydetti.`
};

function selectedLang() {
  const value = localStorage.getItem(LANG_KEY);
  return COPY[value] ? value : 'en';
}

function readLegacyConfig() {
  // Keep the existing promo page as the source of truth for these values so
  // this wording layer never duplicates operational contact configuration.
  for (const script of document.scripts) {
    const source = script.textContent || '';
    if (!source.includes('OWNER_WHATSAPP') || !source.includes('SCAN_LOG_KEY')) continue;
    const number = source.match(/OWNER_WHATSAPP\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    const key = source.match(/SCAN_LOG_KEY\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (number && key) return { number, key };
  }
  return null;
}

function wire() {
  const button = document.getElementById('notifyOfficeBtn');
  if (!button || button.dataset.editorialNotifyWired === '1') return;
  const config = readLegacyConfig();
  // If the existing config cannot be discovered, leave the original handler
  // completely untouched rather than risking a broken office notification.
  if (!config) return;

  button.dataset.editorialNotifyWired = '1';
  button.addEventListener('click', (event) => {
    let log;
    try { log = JSON.parse(localStorage.getItem(config.key) || '[]'); }
    catch (_) { return; }
    const last = Array.isArray(log) ? log[log.length - 1] : null;
    if (!last) return;

    const code = document.getElementById('couponCode')?.textContent?.trim();
    if (!code) return;

    // Replace only the original wording handler. Everything else about the
    // flow (same button, scan log, WhatsApp number and offer code) is kept.
    event.preventDefault();
    event.stopImmediatePropagation();
    const makeMessage = COPY[selectedLang()] || COPY.en;
    const message = makeMessage({ name: last.name, id: last.id, code, time: last.time });
    window.open(`https://wa.me/${config.number}?text=${encodeURIComponent(message)}`, '_blank');
  }, true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
else wire();
