// Offers & Discounts -- the ONE public offer component.
//
// The brief: "Create/reuse one public offer component... Do not duplicate
// the design across multiple pages." This module owns the markup; Home,
// offer.html and the Admin live preview all call renderOfferBanner() with
// a plain offer object, so there is exactly one implementation of the
// design and one place a change to it lands.
//
// Every string that reaches HTML here comes from Firestore, i.e. it is
// admin-authored but still untrusted at render time, so all of it goes
// through esc(). URLs additionally pass isSafeHttpUrl() before becoming
// an href -- escaping alone would not stop a `javascript:` target.

import { offerStrings, qrTargetUrl, isSafeHttpUrl, offerPageUrl } from './offers.js';
import { renderQrInto } from './offer-qr.js';

// js/escape-html.js is a classic script that defines a global, so it
// cannot be imported here. Same five-character escape, exported so the
// Admin module shares this one implementation rather than keeping a
// second copy that could drift.
export function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
const esc = escapeHtml;

function tr(key, fallback) {
  return (window.t && window.t(key)) || fallback;
}

const ARROW_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.2" '
  + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

function formatDate(ms, locale) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(locale || undefined,
      { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Renders `offer` into `el`.
 *
 * opts.variant   'banner' (default) | 'page'  -- 'page' additionally
 *                shows promo code, validity dates and terms, which are
 *                detail-page concerns rather than teaser concerns.
 * opts.ctaHref   overrides where the CTA points (the banner on Home
 *                sends people to the offer page; the offer page itself
 *                sends them to the configured ctaUrl).
 */
export function renderOfferBanner(el, offer, opts = {}) {
  if (!el) return;
  if (!offer) { el.innerHTML = ''; return; }

  const variant = opts.variant || 'banner';
  const s = offerStrings(offer, tr);
  const qrUrl = qrTargetUrl(offer);

  // On Home the CTA should open the offer's own page; on the offer page
  // it should follow the admin-configured destination. Either way an
  // unsafe or empty URL falls back to the offer page rather than
  // rendering a dead or dangerous link.
  let href = opts.ctaHref;
  if (!href) {
    href = variant === 'page'
      ? (isSafeHttpUrl(offer.ctaUrl) ? offer.ctaUrl : qrUrl)
      : offerPageUrl(offer.id);
  }
  if (!isSafeHttpUrl(href)) href = offerPageUrl(offer.id);

  const showDetail = variant === 'page';
  const locale = (document.documentElement.lang || 'en');

  const codeHtml = (showDetail && offer.promoCode)
    ? `<div class="dwo-code">
         <span class="dwo-code-label">${esc(tr('offers.yourCode', 'Your code'))}</span>
         <span class="dwo-code-value" data-dwo-code>${esc(offer.promoCode)}</span>
         <button type="button" class="dwo-copy" data-dwo-copy>${esc(tr('offers.copyCode', 'Copy Code'))}</button>
       </div>`
    : '';

  let datesHtml = '';
  if (showDetail && (offer.startAt || offer.endAt)) {
    const from = formatDate(offer.startAt, locale);
    const to = formatDate(offer.endAt, locale);
    let text;
    if (from && to) text = tr('offers.validBetween', 'Valid {from} – {to}').replace('{from}', from).replace('{to}', to);
    else if (to) text = tr('offers.validUntil', 'Valid until {to}').replace('{to}', to);
    else text = tr('offers.validFrom', 'Valid from {from}').replace('{from}', from);
    datesHtml = `<p class="dwo-dates">${esc(text)}</p>`;
  }

  const termsHtml = (showDetail && s.terms)
    ? `<p class="dwo-terms">${esc(s.terms)}</p>`
    : '';

  el.innerHTML = `
    <div class="dwo-banner" data-dwo-variant="${esc(variant)}">
      <div class="dwo-figure">
        <p class="dwo-percent">${esc(s.percentLabel)}</p>
        <p class="dwo-eyebrow">${esc(s.eyebrow)}</p>
      </div>
      <div class="dwo-body">
        <h2 class="dwo-title">${esc(s.title)}</h2>
        <p class="dwo-desc">${esc(s.description)}</p>
        <div class="dwo-actions">
          <div class="dwo-qr" data-dwo-qr></div>
          <a class="dwo-cta" href="${esc(href)}"${opts.ctaTarget ? ` target="${esc(opts.ctaTarget)}" rel="noopener"` : ''}>
            <span>${esc(s.ctaLabel)}</span>${ARROW_SVG}
          </a>
        </div>
        ${codeHtml}
        ${datesHtml}
        ${termsHtml}
      </div>
    </div>`;

  const qrBox = el.querySelector('[data-dwo-qr]');
  renderQrInto(qrBox, qrUrl, { label: s.title });

  const copyBtn = el.querySelector('[data-dwo-copy]');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const original = copyBtn.textContent;
      try {
        await navigator.clipboard.writeText(offer.promoCode);
        copyBtn.textContent = tr('offers.copied', 'Copied');
      } catch (_) {
        // Clipboard can be refused (permissions, insecure context).
        // Say so rather than claiming a copy that did not happen; the
        // code itself is select-all styled so it stays usable.
        copyBtn.textContent = tr('offers.copyFailed', 'Press to select');
        const v = el.querySelector('[data-dwo-code]');
        if (v && window.getSelection) {
          const r = document.createRange();
          r.selectNodeContents(v);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      setTimeout(() => { copyBtn.textContent = original; }, 1800);
    });
  }
}

/** The "nothing to show" state for the offer page. */
export function renderOfferUnavailable(el, reasonKey) {
  if (!el) return;
  const messages = {
    expired: tr('offers.unavailableExpired', 'This offer has ended.'),
    scheduled: tr('offers.unavailableScheduled', 'This offer has not started yet.'),
    paused: tr('offers.unavailablePaused', 'This offer is not available right now.'),
    missing: tr('offers.unavailableMissing', 'We could not find this offer.'),
  };
  el.innerHTML = `
    <div class="dwo-banner dwo-unavailable">
      <h2>${esc(tr('offers.unavailableTitle', 'Offer unavailable'))}</h2>
      <p>${esc(messages[reasonKey] || messages.missing)}</p>
      <a class="dwo-cta" href="index.html"><span>${esc(tr('offers.backHome', 'Back to Darwesh'))}</span>${ARROW_SVG}</a>
    </div>`;
}

/**
 * A host that has nothing to show hides the section it sits in, so a page
 * whose only offer is paused or expired closes the gap instead of leaving
 * an empty stage. The section is opted in with [data-offer-section] on an
 * ancestor -- without it only the host itself empties.
 */
function paintHost(host, offer) {
  const type = host.getAttribute('data-darwesh-offer');
  const matches = offer && (!type || type === 'any' || offer.type === type);
  if (matches) {
    renderOfferBanner(host, offer, { variant: 'banner' });
  } else {
    host.innerHTML = '';
  }
  const section = host.closest('[data-offer-section]');
  if (section) section.hidden = !matches;
}

let liveUnsub = null;
let liveOffer = null;
let liveHosts = [];

/**
 * Auto-mount for ordinary pages: any element with [data-darwesh-offer]
 * gets the current live offer, kept in sync by a Firestore listener.
 * The element stays empty when no offer qualifies, so a page never
 * shows a hole or a stale promotion.
 *
 * Calling this again (a language switch, a dynamically added host) reuses
 * the existing listener rather than opening a second one -- one collection
 * listener per page, no polling.
 */
export async function mountLiveOfferBanners(root = document) {
  const hosts = [...root.querySelectorAll('[data-darwesh-offer]')];
  if (!hosts.length) return;
  liveHosts = [...new Set([...liveHosts, ...hosts])];

  if (liveUnsub) {
    liveHosts.forEach((h) => paintHost(h, liveOffer));
    return;
  }

  try {
    const [{ db }, store, offersMod] = await Promise.all([
      import('./firebase-init.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js'),
      import('./offers.js'),
    ]);
    const { collection, query, where, orderBy, limit, onSnapshot } = store;
    liveUnsub = offersMod.watchPublicOffer(
      { collection, query, where, orderBy, limit, onSnapshot },
      db,
      (offer) => {
        liveOffer = offer;
        liveHosts.forEach((h) => paintHost(h, offer));
      },
    );
  } catch (_) {
    liveHosts.forEach((h) => paintHost(h, null));
  }
}

// Self-mount so a page only needs the markup plus this one script tag.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountLiveOfferBanners());
  } else {
    mountLiveOfferBanners();
  }
  // Re-render on language change so the eyebrow/CTA fallbacks localize
  // without a reload (the site switches language in place).
  document.addEventListener('darwesh:langchange', () => mountLiveOfferBanners());
}
