// Admin Panel -- Offers & Discounts.
//
// Lets an admin run public promotions (first type: brokerage fee
// discount) without anyone touching code. Same separate-module,
// lazy-init-on-first-tab-click pattern as js/admin-orgs-pros.js and
// js/admin-map.js.
//
// TWO THINGS THIS MODULE DELIBERATELY DOES NOT DO:
//
// 1. It does not re-implement the offer design for the preview. The
//    preview calls renderOfferBanner() -- the same function the public
//    site calls, against the same css/offer-banner.css -- so "what I
//    saw in Admin" and "what the visitor got" are the same rendering
//    path, not two that have to be kept in step.
//
// 2. It does not store the percentage anywhere except discountPercent.
//    Titles and descriptions hold a {percent} placeholder; the number is
//    substituted at render time by js/offers.js. Change 10 to 15 and
//    every string follows, because no string owns its own copy.

import { db, auth } from './firebase-init.js';
import {
  collection, doc, getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import {
  OFFER_STATUSES, PERCENT_MIN, PERCENT_MAX, PERCENT_STEP, LIMITS,
  clampPercent, isValidPercent, parsePercent, normalizeOffer, effectiveState,
  newOfferDraft, offerPageUrl, qrTargetUrl, isSafeHttpUrl, toMillis,
} from './offers.js';
import { renderOfferBanner, escapeHtml as esc } from './offer-banner.js';
import { qrToPngDataUrl } from './offer-qr.js';

function tr(key, fallback) {
  return (window.t && window.t(key)) || fallback;
}
function toast(msg, variant) {
  if (window.AdminShellToast) window.AdminShellToast(msg, variant || 'success');
}

const state = {
  mounted: false,
  offers: [],
  editing: null,     // working copy, never a live Firestore object
  editingId: null,   // null => unsaved new offer
  adminNote: '',
  loading: false,
  loadError: null,
};

// ---------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------
function panel() { return document.getElementById('tab-offers'); }

function ensureShell() {
  const root = panel();
  if (!root || state.mounted) return root;
  root.innerHTML = `
    <div class="ash-offers">
      <div class="ash-offers-head">
        <div>
          <p class="font-headline-md text-[22px] text-on-surface font-bold" data-i18n="admin.offers.title">Offers &amp; Discounts</p>
          <p class="font-body-md text-[12.5px] text-on-surface-variant mt-1" data-i18n="admin.offers.subtitle">Promotional discounts shown on the public site. Only an Active offer inside its date window is visible to visitors.</p>
        </div>
        <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="offerNewBtn">
          <span data-i18n="admin.offers.newOffer">+ New Offer</span>
        </button>
      </div>
      <div id="offerListWrap"></div>
      <div id="offerEditorWrap" class="hidden"></div>
    </div>`;
  root.querySelector('#offerNewBtn').addEventListener('click', () => openEditor(null));
  state.mounted = true;
  return root;
}

// ---------------------------------------------------------------------
// List
// ---------------------------------------------------------------------
const STATE_BADGE = {
  active: 'badge-active',
  scheduled: 'badge-pending',
  draft: 'badge-private',
  paused: 'badge-suspended',
  expired: 'badge-rejected',
  archived: 'badge-rejected',
};

function stateLabel(s) {
  return {
    active: tr('admin.offers.state.active', 'Active'),
    scheduled: tr('admin.offers.state.scheduled', 'Scheduled'),
    draft: tr('admin.offers.state.draft', 'Draft'),
    paused: tr('admin.offers.state.paused', 'Paused'),
    expired: tr('admin.offers.state.expired', 'Expired'),
    archived: tr('admin.offers.state.archived', 'Archived'),
  }[s] || s;
}

function fmtDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (_) { return '—'; }
}

function renderList() {
  const wrap = document.getElementById('offerListWrap');
  if (!wrap) return;
  if (state.loading) {
    wrap.innerHTML = `<p class="font-body-md text-[13px] text-on-surface-variant">${esc(tr('admin.offers.loading', 'Loading offers…'))}</p>`;
    return;
  }
  if (state.loadError) {
    // A failed read is not "no offers". Saying so would invite an admin
    // to create a duplicate of an offer that is already live.
    wrap.innerHTML = `
      <div class="ash-empty-state">
        <span class="material-symbols-outlined ash-empty-icon">error</span>
        <p class="ash-empty-title">${esc(tr('admin.offers.loadFailedTitle', 'Could not load offers'))}</p>
        <p class="ash-empty-desc">${esc(state.loadError)}</p>
        <button type="button" class="ash-detail-btn" id="offerRetryBtn">${esc(tr('admin.offers.retry', 'Try again'))}</button>
      </div>`;
    wrap.querySelector('#offerRetryBtn').addEventListener('click', () => loadOffers());
    return;
  }
  if (!state.offers.length) {
    wrap.innerHTML = `
      <div class="ash-empty-state">
        <span class="material-symbols-outlined ash-empty-icon">sell</span>
        <p class="ash-empty-title">${esc(tr('admin.offers.emptyTitle', 'No offers yet'))}</p>
        <p class="ash-empty-desc">${esc(tr('admin.offers.emptyDesc', 'Create an offer to show a promotional discount on the public site.'))}</p>
      </div>`;
    return;
  }
  const now = Date.now();
  const rows = state.offers.map((o) => {
    const st = effectiveState(o, now);
    return `
      <tr>
        <td>
          <p class="font-body-md text-[13.5px] text-on-surface font-medium">${esc(o.title || tr('admin.offers.untitled', '(untitled offer)'))}</p>
          <p class="font-body-md text-[12px] text-on-surface-variant">${esc(tr('admin.offers.type.brokerage_fee', 'Brokerage Fee Discount'))}</p>
        </td>
        <td><span class="font-body-md text-[15px] text-on-surface font-bold">${esc(String(o.discountPercent))}%</span></td>
        <td><span class="badge ${STATE_BADGE[st] || 'badge-private'}">${esc(stateLabel(st))}</span></td>
        <td><span class="font-body-md text-[12.5px] text-on-surface-variant">${esc(fmtDate(o.startAt))}</span></td>
        <td><span class="font-body-md text-[12.5px] text-on-surface-variant">${esc(fmtDate(o.endAt))}</span></td>
        <td><span class="font-body-md text-[12.5px] text-on-surface-variant">${esc(fmtDate(o.updatedAt))}</span></td>
        <td>
          <div class="ash-offer-actions">
            <button type="button" class="ash-detail-btn" data-offer-edit="${esc(o.id)}">${esc(tr('admin.offers.edit', 'Edit'))}</button>
            <a class="ash-detail-btn" href="${esc(offerPageUrl(o.id))}" target="_blank" rel="noopener">${esc(tr('admin.offers.preview', 'Preview'))}</a>
            ${o.status === 'active'
              ? `<button type="button" class="ash-detail-btn" data-offer-pause="${esc(o.id)}">${esc(tr('admin.offers.pause', 'Pause'))}</button>`
              : `<button type="button" class="ash-detail-btn ash-detail-btn-primary" data-offer-publish="${esc(o.id)}">${esc(tr('admin.offers.publish', 'Publish'))}</button>`}
            <button type="button" class="ash-detail-btn" data-offer-duplicate="${esc(o.id)}">${esc(tr('admin.offers.duplicate', 'Duplicate'))}</button>
            ${o.status === 'archived'
              ? `<button type="button" class="ash-detail-btn ash-detail-btn-danger" data-offer-delete="${esc(o.id)}">${esc(tr('admin.offers.delete', 'Delete'))}</button>`
              : `<button type="button" class="ash-detail-btn ash-detail-btn-danger" data-offer-archive="${esc(o.id)}">${esc(tr('admin.offers.archive', 'Archive'))}</button>`}
          </div>
        </td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead><tr>
            <th>${esc(tr('admin.offers.thOffer', 'Offer'))}</th>
            <th>${esc(tr('admin.offers.thDiscount', 'Discount'))}</th>
            <th>${esc(tr('admin.offers.thStatus', 'Status'))}</th>
            <th>${esc(tr('admin.offers.thStart', 'Start'))}</th>
            <th>${esc(tr('admin.offers.thEnd', 'End'))}</th>
            <th>${esc(tr('admin.offers.thUpdated', 'Last Updated'))}</th>
            <th>${esc(tr('admin.offers.thActions', 'Actions'))}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  wrap.querySelectorAll('[data-offer-edit]').forEach((b) =>
    b.addEventListener('click', () => openEditor(b.dataset.offerEdit)));
  wrap.querySelectorAll('[data-offer-publish]').forEach((b) =>
    b.addEventListener('click', () => quickStatus(b, b.dataset.offerPublish, 'active')));
  wrap.querySelectorAll('[data-offer-pause]').forEach((b) =>
    b.addEventListener('click', () => quickStatus(b, b.dataset.offerPause, 'paused')));
  wrap.querySelectorAll('[data-offer-archive]').forEach((b) =>
    b.addEventListener('click', () => quickStatus(b, b.dataset.offerArchive, 'archived')));
  wrap.querySelectorAll('[data-offer-duplicate]').forEach((b) =>
    b.addEventListener('click', () => duplicateOffer(b, b.dataset.offerDuplicate)));
  wrap.querySelectorAll('[data-offer-delete]').forEach((b) =>
    b.addEventListener('click', () => deleteOffer(b, b.dataset.offerDelete)));
}

/** Disables a button for the duration of an async action so a
 *  double-click cannot fire the same write twice, and always restores
 *  it -- including on failure. */
async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return fn();
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = tr('admin.offers.working', 'Working…');
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = prev; }
}

async function quickStatus(btn, id, status) {
  const offer = state.offers.find((o) => o.id === id);
  if (!offer) return;
  try {
    await withBusy(btn, () => updateDoc(doc(db, 'offers', id), {
      status,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser ? auth.currentUser.uid : '',
    }));
    toast(tr('admin.offers.saved', 'Offer updated.'), 'success');
    await loadOffers();
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

async function duplicateOffer(btn, id) {
  const offer = state.offers.find((o) => o.id === id);
  if (!offer) return;
  const copy = { ...offer };
  delete copy.id;
  copy.status = 'draft';
  copy.title = `${offer.title} (${tr('admin.offers.copySuffix', 'copy')})`;
  try {
    await withBusy(btn, () => createOffer(copy));
    toast(tr('admin.offers.duplicated', 'Offer duplicated as a draft.'), 'success');
    await loadOffers();
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

async function deleteOffer(btn, id) {
  if (!window.confirm(tr('admin.offers.confirmDelete',
    'Delete this archived offer permanently? This cannot be undone.'))) return;
  try {
    await withBusy(btn, () => deleteDoc(doc(db, 'offers', id)));
    toast(tr('admin.offers.deleted', 'Offer deleted.'), 'success');
    await loadOffers();
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

function describeError(err) {
  if (err && err.code === 'permission-denied') {
    return tr('admin.offers.errPermission',
      'You do not have permission to change offers, or a value failed validation.');
  }
  return tr('admin.offers.errGeneric', 'Could not save the offer right now.');
}

// ---------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------
function dtLocal(ms) {
  if (!ms) return '';
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function openEditor(id) {
  state.editingId = id;
  state.adminNote = '';
  state.editing = id
    ? { ...state.offers.find((o) => o.id === id) }
    : newOfferDraft(tr);
  renderEditor();
  if (id) loadAdminNote(id);
  document.getElementById('offerListWrap')?.classList.add('hidden');
  document.getElementById('offerEditorWrap')?.classList.remove('hidden');
}

function closeEditor() {
  state.editing = null;
  state.editingId = null;
  document.getElementById('offerEditorWrap')?.classList.add('hidden');
  document.getElementById('offerListWrap')?.classList.remove('hidden');
}

function renderEditor() {
  const wrap = document.getElementById('offerEditorWrap');
  const o = state.editing;
  if (!wrap || !o) return;

  wrap.innerHTML = `
    <div class="ash-offer-editor">
      <div class="ash-offer-form">
        <div class="ash-offers-head">
          <p class="font-headline-md text-[17px] text-on-surface font-bold">
            ${esc(state.editingId ? tr('admin.offers.editOffer', 'Edit offer') : tr('admin.offers.newOffer', '+ New Offer'))}
          </p>
          <button type="button" class="ash-detail-btn" id="offerCancelBtn">${esc(tr('admin.offers.cancel', 'Cancel'))}</button>
        </div>

        <label class="block mt-4">
          <span class="admin-label">${esc(tr('admin.offers.fType', 'Offer type'))}</span>
          <select class="admin-input" id="offerType" style="width:100%;">
            <option value="brokerage_fee">${esc(tr('admin.offers.type.brokerage_fee', 'Brokerage Fee Discount'))}</option>
          </select>
        </label>

        <div class="ash-offer-percent-row">
          <span class="admin-label">${esc(tr('admin.offers.fPercent', 'Discount percentage'))}</span>
          <div class="ash-percent-stepper">
            <button type="button" id="offerPctDown" aria-label="${esc(tr('admin.offers.decrease', 'Decrease'))}">−</button>
            <div class="ash-percent-input">
              <input type="number" id="offerPct" inputmode="numeric"
                     min="${PERCENT_MIN}" max="${PERCENT_MAX}" step="${PERCENT_STEP}"
                     value="${esc(String(o.discountPercent))}"
                     aria-label="${esc(tr('admin.offers.fPercent', 'Discount percentage'))}"/>
              <span aria-hidden="true">%</span>
            </div>
            <button type="button" id="offerPctUp" aria-label="${esc(tr('admin.offers.increase', 'Increase'))}">+</button>
          </div>
          <p class="ash-offer-hint" id="offerPctHint">${esc(tr('admin.offers.percentHint', 'Between 0 and 100. This single value drives every “% off” shown to visitors.'))}</p>
        </div>

        <label class="block mt-4">
          <span class="admin-label">${esc(tr('admin.offers.fTitle', 'Offer title'))}</span>
          <input class="admin-input" id="offerTitle" style="width:100%;" maxlength="${LIMITS.title}" value="${esc(o.title)}"/>
          <span class="ash-offer-hint">${esc(tr('admin.offers.templateHint', 'Use {percent} where the number should appear — it is filled in automatically.'))}</span>
        </label>

        <label class="block mt-3">
          <span class="admin-label">${esc(tr('admin.offers.fDescription', 'Short description'))}</span>
          <textarea class="ash-detail-textarea" id="offerDesc" rows="3" maxlength="${LIMITS.description}">${esc(o.description)}</textarea>
        </label>

        <div class="ash-offer-grid">
          <label class="block">
            <span class="admin-label">${esc(tr('admin.offers.fStatus', 'Status'))}</span>
            <select class="admin-input" id="offerStatus" style="width:100%;">
              ${OFFER_STATUSES.map((s) => `<option value="${s}"${o.status === s ? ' selected' : ''}>${esc(stateLabel(s))}</option>`).join('')}
            </select>
          </label>
          <label class="block">
            <span class="admin-label">${esc(tr('admin.offers.fPromo', 'Promo code (optional)'))}</span>
            <div class="ash-offer-inline">
              <input class="admin-input" id="offerPromo" maxlength="${LIMITS.promoCode}" value="${esc(o.promoCode)}" style="flex:1 1 auto;min-width:0;"/>
              <button type="button" class="ash-detail-btn" id="offerGenCode">${esc(tr('admin.offers.generate', 'Generate'))}</button>
            </div>
          </label>
          <label class="block">
            <span class="admin-label">${esc(tr('admin.offers.fStart', 'Start date'))}</span>
            <input class="admin-input" type="datetime-local" id="offerStart" style="width:100%;" value="${esc(dtLocal(o.startAt))}"/>
          </label>
          <label class="block">
            <span class="admin-label">${esc(tr('admin.offers.fEnd', 'End date'))}</span>
            <input class="admin-input" type="datetime-local" id="offerEnd" style="width:100%;" value="${esc(dtLocal(o.endAt))}"/>
          </label>
          <label class="block">
            <span class="admin-label">${esc(tr('admin.offers.fCtaLabel', 'CTA label'))}</span>
            <input class="admin-input" id="offerCtaLabel" maxlength="${LIMITS.ctaLabel}" value="${esc(o.ctaLabel)}" style="width:100%;"/>
          </label>
          <label class="block">
            <span class="admin-label">${esc(tr('admin.offers.fCtaUrl', 'CTA URL'))}</span>
            <input class="admin-input" id="offerCtaUrl" maxlength="${LIMITS.url}" value="${esc(o.ctaUrl)}" placeholder="https://…" style="width:100%;"/>
          </label>
        </div>

        <label class="block mt-3">
          <span class="admin-label">${esc(tr('admin.offers.fQrUrl', 'QR destination URL'))}</span>
          <input class="admin-input" id="offerQrUrl" maxlength="${LIMITS.url}" value="${esc(o.qrUrl)}" placeholder="${esc(tr('admin.offers.qrPlaceholder', 'Leave empty to use this offer’s own page'))}" style="width:100%;"/>
          <span class="ash-offer-hint">${esc(tr('admin.offers.qrHint', 'The QR is generated from this URL. Never put private information in it — anyone can scan it.'))}</span>
        </label>

        <label class="block mt-3">
          <span class="admin-label">${esc(tr('admin.offers.fTerms', 'Terms & conditions (optional)'))}</span>
          <textarea class="ash-detail-textarea" id="offerTerms" rows="3" maxlength="${LIMITS.terms}">${esc(o.terms)}</textarea>
        </label>

        <label class="block mt-3">
          <span class="admin-label">${esc(tr('admin.offers.fNote', 'Internal admin note (never public)'))}</span>
          <textarea class="ash-detail-textarea" id="offerNote" rows="2" maxlength="${LIMITS.adminNote}">${esc(state.adminNote)}</textarea>
        </label>

        <div class="ash-offer-save-row">
          <button type="button" class="ash-detail-btn" id="offerSaveDraftBtn">${esc(tr('admin.offers.saveDraft', 'Save Draft'))}</button>
          <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="offerPublishBtn">${esc(tr('admin.offers.publish', 'Publish'))}</button>
          <span class="ash-offer-hint" id="offerSaveHint"></span>
        </div>
      </div>

      <div class="ash-offer-preview">
        <p class="ash-detail-section-title">${esc(tr('admin.offers.livePreview', 'Live preview'))}</p>
        <div id="offerPreview"></div>
        <div class="ash-offer-qr-tools">
          <button type="button" class="ash-detail-btn" id="offerCopyLink">${esc(tr('admin.offers.copyLink', 'Copy offer link'))}</button>
          <button type="button" class="ash-detail-btn" id="offerDownloadQr">${esc(tr('admin.offers.downloadQr', 'Download QR'))}</button>
        </div>
        <p class="ash-offer-hint" id="offerPreviewState"></p>
      </div>
    </div>`;

  wireEditor();
  updatePreview();
}

function readForm() {
  const o = state.editing;
  const v = (id) => document.getElementById(id)?.value ?? '';
  o.type = v('offerType') || 'brokerage_fee';
  o.title = v('offerTitle');
  o.description = v('offerDesc');
  o.status = v('offerStatus');
  o.promoCode = v('offerPromo').trim();
  o.ctaLabel = v('offerCtaLabel');
  o.ctaUrl = v('offerCtaUrl').trim();
  o.qrUrl = v('offerQrUrl').trim();
  o.terms = v('offerTerms');
  const s = v('offerStart');
  const e = v('offerEnd');
  o.startAt = s ? new Date(s).getTime() : null;
  o.endAt = e ? new Date(e).getTime() : null;
  state.adminNote = v('offerNote');
  const pct = parsePercent(v('offerPct'));
  if (pct !== null) o.discountPercent = pct;
  return o;
}

function wireEditor() {
  const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);

  on('offerCancelBtn', 'click', closeEditor);

  // --- percentage control -------------------------------------------
  const pctInput = document.getElementById('offerPct');
  const step = (delta) => {
    // Steps from the CLAMPED current value, so pressing + at 100 or −
    // at 0 is simply a no-op rather than walking out of range and
    // relying on validation to catch it later.
    const current = clampPercent(pctInput.value);
    const next = clampPercent((current === null ? 0 : current) + delta);
    pctInput.value = String(next);
    pctInput.dispatchEvent(new Event('input', { bubbles: true }));
  };
  on('offerPctDown', 'click', () => step(-PERCENT_STEP));
  on('offerPctUp', 'click', () => step(PERCENT_STEP));
  pctInput?.addEventListener('input', () => {
    const hint = document.getElementById('offerPctHint');
    const raw = pctInput.value;
    if (raw !== '' && !isValidPercent(raw)) {
      // Do NOT silently rewrite what the admin typed -- say what is
      // wrong and block saving instead, so a typo can't become a
      // published discount nobody intended.
      hint.textContent = tr('admin.offers.percentInvalid',
        'Enter a whole number between 0 and 100.');
      hint.classList.add('is-error');
    } else {
      hint.textContent = tr('admin.offers.percentHint',
        'Between 0 and 100. This single value drives every “% off” shown to visitors.');
      hint.classList.remove('is-error');
    }
    updatePreview();
  });

  ['offerTitle', 'offerDesc', 'offerCtaLabel', 'offerCtaUrl', 'offerQrUrl', 'offerTerms', 'offerPromo']
    .forEach((id) => on(id, 'input', updatePreview));
  ['offerStatus', 'offerStart', 'offerEnd', 'offerType']
    .forEach((id) => on(id, 'change', updatePreview));

  on('offerGenCode', 'click', () => {
    // Generated only on explicit request. The brief is clear that
    // changing the percentage must never silently rewrite a code an
    // admin chose by hand -- so nothing but this button touches it.
    const el = document.getElementById('offerPromo');
    el.value = generatePromoCode();
    updatePreview();
  });

  on('offerSaveDraftBtn', 'click', (e) => save(e.currentTarget, 'draft'));
  on('offerPublishBtn', 'click', (e) => save(e.currentTarget, 'active'));

  on('offerCopyLink', 'click', async (e) => {
    const url = state.editingId ? offerPageUrl(state.editingId) : qrTargetUrl(readForm());
    try {
      await navigator.clipboard.writeText(url);
      toast(tr('admin.offers.linkCopied', 'Offer link copied.'), 'success');
    } catch (_) {
      window.prompt(tr('admin.offers.copyManually', 'Copy this link:'), url);
    }
  });

  on('offerDownloadQr', 'click', async (e) => {
    const url = qrTargetUrl({ ...readForm(), id: state.editingId || 'preview' });
    await withBusy(e.currentTarget, async () => {
      const dataUrl = await qrToPngDataUrl(url, { scale: 10 });
      if (!dataUrl) { toast(tr('admin.offers.qrFailed', 'Could not generate the QR image.'), 'error'); return; }
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `darwesh-offer-${state.editingId || 'draft'}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });
}

function generatePromoCode() {
  // Unambiguous alphabet: no O/0 or I/1, because these get read off a
  // phone screen and typed by hand.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const buf = new Uint32Array(4);
  (window.crypto || {}).getRandomValues?.(buf);
  for (let i = 0; i < 4; i += 1) {
    suffix += alphabet[(buf[i] || Math.floor(Math.random() * 1e9)) % alphabet.length];
  }
  return `DARWESH${suffix}`;
}

function updatePreview() {
  const o = readForm();
  const host = document.getElementById('offerPreview');
  // The preview always renders the offer as a visitor would see it,
  // regardless of status -- that is the point of a preview. The state
  // line below says plainly whether the public can currently see it.
  renderOfferBanner(host, { ...o, id: state.editingId || 'preview' }, {
    variant: 'page',
    ctaHref: isSafeHttpUrl(o.ctaUrl) ? o.ctaUrl : undefined,
  });
  const st = effectiveState(o);
  const line = document.getElementById('offerPreviewState');
  if (line) {
    line.textContent = st === 'active'
      ? tr('admin.offers.previewLive', 'Visitors can see this offer now.')
      : tr('admin.offers.previewHidden', 'Not visible to visitors right now — current state: {state}')
        .replace('{state}', stateLabel(st));
    line.classList.toggle('is-error', st !== 'active');
  }
}

// ---------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------
function validate(o) {
  if (!isValidPercent(o.discountPercent)) {
    return tr('admin.offers.percentInvalid', 'Enter a whole number between 0 and 100.');
  }
  if (!o.title || !o.title.trim()) {
    return tr('admin.offers.titleRequired', 'Give the offer a title.');
  }
  if (o.title.length > LIMITS.title) return tr('admin.offers.tooLong', 'One of the fields is too long.');
  if (o.ctaUrl && !isSafeHttpUrl(o.ctaUrl)) {
    return tr('admin.offers.urlInvalid', 'URLs must start with http:// or https://');
  }
  if (o.qrUrl && !isSafeHttpUrl(o.qrUrl)) {
    return tr('admin.offers.urlInvalid', 'URLs must start with http:// or https://');
  }
  if (o.startAt && o.endAt && o.startAt >= o.endAt) {
    return tr('admin.offers.datesInvalid', 'The end date must be after the start date.');
  }
  return null;
}

/** Shapes the working copy into exactly the fields firestore.rules
 *  allows -- nothing more, nothing less. */
function toDocFields(o, uid, isCreate) {
  const fields = {
    type: o.type || 'brokerage_fee',
    title: o.title || '',
    description: o.description || '',
    discountPercent: clampPercent(o.discountPercent) ?? 0,
    status: OFFER_STATUSES.includes(o.status) ? o.status : 'draft',
    startAt: o.startAt ? new Date(o.startAt) : null,
    endAt: o.endAt ? new Date(o.endAt) : null,
    ctaLabel: o.ctaLabel || '',
    ctaUrl: o.ctaUrl || '',
    qrUrl: o.qrUrl || '',
    promoCode: o.promoCode || '',
    terms: o.terms || '',
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  };
  if (isCreate) {
    fields.createdAt = serverTimestamp();
    fields.createdBy = uid;
  }
  return fields;
}

async function createOffer(o) {
  const uid = auth.currentUser ? auth.currentUser.uid : '';
  const ref = doc(collection(db, 'offers'));
  await setDoc(ref, toDocFields(o, uid, true));
  return ref.id;
}

async function save(btn, statusOverride) {
  const o = readForm();
  if (statusOverride) o.status = statusOverride;
  const problem = validate(o);
  const hint = document.getElementById('offerSaveHint');
  if (problem) {
    if (hint) { hint.textContent = problem; hint.classList.add('is-error'); }
    toast(problem, 'error');
    return;
  }
  if (hint) { hint.textContent = ''; hint.classList.remove('is-error'); }

  try {
    await withBusy(btn, async () => {
      const uid = auth.currentUser ? auth.currentUser.uid : '';
      let id = state.editingId;
      if (id) {
        await updateDoc(doc(db, 'offers', id), toDocFields(o, uid, false));
      } else {
        id = await createOffer(o);
        state.editingId = id;
      }
      await saveAdminNote(id);
    });
    // The status <select> must reflect what was actually written --
    // Publish changes it behind the admin's back, and leaving the old
    // value on screen would be the UI lying about stored state.
    const sel = document.getElementById('offerStatus');
    if (sel) sel.value = o.status;
    state.editing.status = o.status;
    toast(tr('admin.offers.saved', 'Offer updated.'), 'success');
    await loadOffers();
    updatePreview();
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

// Internal note lives in an admin-only subcollection, never on the
// publicly readable offer document.
async function loadAdminNote(id) {
  try {
    const snap = await getDoc(doc(db, 'offers', id, 'private', 'admin'));
    state.adminNote = snap.exists() ? (snap.data().note || '') : '';
  } catch (_) {
    state.adminNote = '';
  }
  const el = document.getElementById('offerNote');
  if (el) el.value = state.adminNote;
}

async function saveAdminNote(id) {
  const note = document.getElementById('offerNote')?.value ?? '';
  if (!id) return;
  try {
    await setDoc(doc(db, 'offers', id, 'private', 'admin'), {
      note,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser ? auth.currentUser.uid : '',
    }, { merge: true });
  } catch (_) {
    // Non-fatal: the offer itself saved. Surfaced rather than silent.
    toast(tr('admin.offers.noteFailed', 'The offer saved, but the internal note did not.'), 'error');
  }
}

async function loadOffers() {
  state.loading = true;
  state.loadError = null;
  renderList();
  try {
    const snap = await getDocs(query(collection(db, 'offers'), orderBy('updatedAt', 'desc')));
    const list = [];
    snap.forEach((d) => list.push(normalizeOffer(d.id, d.data())));
    state.offers = list;
  } catch (err) {
    state.offers = [];
    state.loadError = err && err.code === 'permission-denied'
      ? tr('admin.offers.errPermissionRead', 'Your account is not allowed to read offers.')
      : tr('admin.offers.errGenericRead', 'The offers could not be loaded. Check your connection and try again.');
  }
  state.loading = false;
  renderList();
}

// ---------------------------------------------------------------------
export function renderOffersTab() {
  ensureShell();
  loadOffers();
}

document.addEventListener('darwesh:langchange', () => {
  if (!state.mounted) return;
  renderList();
  if (state.editing) renderEditor();
});
