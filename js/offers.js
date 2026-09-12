// Offers & Discounts -- the ONE source of truth for what a promotional
// offer means, shared by the Admin editor, the Admin live preview, the
// public banner component and the public offer page. Nothing here renders
// HTML; it only decides what an offer *is* right now.
//
// WHY THIS MODULE EXISTS (the brief's "one source of truth" rule):
// the discount percentage must never be written down twice. It lives in
// exactly one field, `discountPercent`, and every human-readable string
// that mentions it -- "10% OFF", "Scan for 10% Off Brokerage Fees" --
// is produced by substituting {percent} into a template at render time
// (see fillTemplate/offerStrings). Change the number in Admin and every
// surface follows, because no surface stores its own copy.
//
// STORED STATUS vs EFFECTIVE STATE. Admin sets an *intent*
// (draft/active/paused/archived). "Scheduled" and "Expired" are NOT
// stored -- they are derived from startAt/endAt whenever the offer is
// looked at (see effectiveState). That is deliberate: a stored
// "scheduled" or "expired" would need a scheduler to flip it at the
// right moment, and this is a static site with no cron. Deriving means
// an offer starts and ends exactly on time with no moving parts, and
// can never be left publicly visible because a job failed to run.

// Offer categories. `brokerage_fee` is the first and currently only
// type; the shape is deliberately open so a second type needs a new
// entry here plus its label keys, not a new system.
export const OFFER_TYPES = ['brokerage_fee'];

// What Admin can store. Note the absence of 'scheduled'/'expired' --
// see the header.
export const OFFER_STATUSES = ['draft', 'active', 'paused', 'archived'];

// What a human is shown / what the public gate tests against.
export const EFFECTIVE_STATES = ['draft', 'scheduled', 'active', 'paused', 'expired', 'archived'];

export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;
export const PERCENT_STEP = 1;

// Field length caps, mirrored by firestore.rules. Kept here so the
// editor can refuse oversized input with a clear message instead of
// letting the write fail with a bare permission-denied.
export const LIMITS = {
  title: 160,
  description: 480,
  ctaLabel: 60,
  terms: 2000,
  promoCode: 40,
  url: 500,
  adminNote: 2000,
};

/** Integer percent inside [0,100]; anything unparseable becomes null so
 *  callers can tell "not a number" from a legitimate 0. */
export function parsePercent(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Clamp to the allowed range. Used by the -/+ stepper so holding a
 *  button can never walk past the bounds. */
export function clampPercent(value) {
  const n = parsePercent(value);
  if (n === null) return null;
  return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, n));
}

export function isValidPercent(value) {
  const n = parsePercent(value);
  return n !== null && n >= PERCENT_MIN && n <= PERCENT_MAX;
}

/** Firestore Timestamp | Date | millis | ISO string -> millis | null. */
export function toMillis(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * The offer's real state right now. `now` is injectable so the Admin
 * preview and the tests can ask "what will this look like on Friday?"
 * without touching the clock.
 */
export function effectiveState(offer, now = Date.now()) {
  if (!offer) return 'archived';
  const stored = OFFER_STATUSES.includes(offer.status) ? offer.status : 'draft';
  if (stored !== 'active') return stored;
  const start = toMillis(offer.startAt);
  const end = toMillis(offer.endAt);
  if (start !== null && now < start) return 'scheduled';
  // endAt is treated as exclusive: an offer ending "at 18:00" is over
  // the instant the clock reads 18:00, not a millisecond later.
  if (end !== null && now >= end) return 'expired';
  return 'active';
}

/** The single gate every public surface must ask before rendering. */
export function isPubliclyVisible(offer, now = Date.now()) {
  return effectiveState(offer, now) === 'active';
}

/**
 * Substitutes {percent} (and the tolerated {discount} alias) in a
 * template. The percentage is injected as a bare number so a template
 * can decide whether it wants "10%" or "10 percent" -- the "%" belongs
 * to the copy, not to the data.
 */
export function fillTemplate(template, percent) {
  if (typeof template !== 'string' || !template) return '';
  const value = String(percent ?? '');
  return template.replace(/\{(percent|discount)\}/gi, value);
}

/**
 * Everything a renderer needs, with {percent} already resolved. Callers
 * pass their own `tr(key, fallback)` so this module never depends on
 * how a given page loaded i18n.
 */
export function offerStrings(offer, tr) {
  const t = typeof tr === 'function' ? tr : (_k, f) => f;
  const percent = isValidPercent(offer?.discountPercent) ? parsePercent(offer.discountPercent) : 0;
  const titleTpl = offer?.title || t('offers.defaultTitle', 'Scan for {percent}% Off Brokerage Fees');
  const descTpl = offer?.description || t(
    'offers.defaultDescription',
    'Scan the QR code with your phone camera to reveal your discount code, or view it online.');
  return {
    percent,
    // "10%" -- the big number on the left of the reference design.
    percentLabel: `${percent}%`,
    title: fillTemplate(titleTpl, percent),
    description: fillTemplate(descTpl, percent),
    ctaLabel: fillTemplate(offer?.ctaLabel || t('offers.defaultCta', 'View Offer Online'), percent),
    terms: fillTemplate(offer?.terms || '', percent),
    eyebrow: t('offers.exclusiveOffer', 'Exclusive Offer'),
  };
}

/** A brand-new brokerage offer, pre-filled with the reference copy. */
export function newOfferDraft(tr) {
  const t = typeof tr === 'function' ? tr : (_k, f) => f;
  return {
    type: 'brokerage_fee',
    title: t('offers.defaultTitle', 'Scan for {percent}% Off Brokerage Fees'),
    description: t('offers.defaultDescription',
      'Scan the QR code with your phone camera to reveal your discount code, or view it online.'),
    discountPercent: 10,
    status: 'draft',
    startAt: null,
    endAt: null,
    ctaLabel: t('offers.defaultCta', 'View Offer Online'),
    ctaUrl: '',
    qrUrl: '',
    promoCode: '',
    terms: t('offers.defaultTerms',
      'Valid only on eligible Darwesh brokerage transactions during the offer period.'),
  };
}

/**
 * Normalizes a Firestore document into the shape every renderer expects,
 * so a legacy or partially-written document can never crash a page with
 * an undefined field. Unknown status falls back to 'draft' (invisible),
 * never to 'active' -- an offer must be deliberately published, never
 * published by accident of bad data.
 */
export function normalizeOffer(id, data) {
  const d = data || {};
  const percent = clampPercent(d.discountPercent);
  return {
    id,
    type: OFFER_TYPES.includes(d.type) ? d.type : 'brokerage_fee',
    title: typeof d.title === 'string' ? d.title : '',
    description: typeof d.description === 'string' ? d.description : '',
    discountPercent: percent === null ? 0 : percent,
    status: OFFER_STATUSES.includes(d.status) ? d.status : 'draft',
    startAt: toMillis(d.startAt),
    endAt: toMillis(d.endAt),
    ctaLabel: typeof d.ctaLabel === 'string' ? d.ctaLabel : '',
    ctaUrl: typeof d.ctaUrl === 'string' ? d.ctaUrl : '',
    qrUrl: typeof d.qrUrl === 'string' ? d.qrUrl : '',
    promoCode: typeof d.promoCode === 'string' ? d.promoCode : '',
    terms: typeof d.terms === 'string' ? d.terms : '',
    createdAt: toMillis(d.createdAt),
    updatedAt: toMillis(d.updatedAt),
    createdBy: typeof d.createdBy === 'string' ? d.createdBy : '',
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : '',
  };
}

/** Absolute URL for an offer's own public page. */
export function offerPageUrl(offerId) {
  try {
    return new URL('offer.html?id=' + encodeURIComponent(offerId), window.location.href).href;
  } catch (_) {
    return 'offer.html?id=' + encodeURIComponent(offerId);
  }
}

/**
 * What the QR should actually encode. Falls back through the explicitly
 * configured QR destination, then the CTA, then the offer's own public
 * page -- so a QR is never blank just because Admin left a field empty.
 *
 * PRIVACY (brief §6): this is always a plain public URL. Nothing
 * sensitive is ever encoded into the QR itself; a scanner that resolves
 * it lands on the same page any visitor could open.
 */
export function qrTargetUrl(offer) {
  const candidate = (offer?.qrUrl || '').trim() || (offer?.ctaUrl || '').trim();
  if (candidate && isSafeHttpUrl(candidate)) return candidate;
  return offerPageUrl(offer?.id || '');
}

/** http(s) only -- keeps `javascript:`/`data:` out of hrefs and QRs. */
export function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value, window.location.href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Watches the single offer that should be on public display and calls
 * back with it (or null). onSnapshot rather than a one-shot read on
 * purpose: firebase-init.js enables persistent local cache, so a plain
 * read can be served from disk, and the brief is explicit that a stale
 * percentage must never be shown after Admin changes it. A listener
 * always converges on server state -- and makes a published change
 * appear on open pages without a reload.
 *
 * The `status == 'active'` filter is also what firestore.rules requires
 * for an unauthenticated reader: drafts and paused offers are not
 * merely hidden by this code, they are unreadable.
 */
export function watchPublicOffer(fns, db, callback, opts = {}) {
  const { collection, query, where, limit, onSnapshot } = fns;
  const type = opts.type || null;
  const constraints = [where('status', '==', 'active')];
  if (type) constraints.push(where('type', '==', type));
  // Equality filters only, and the ordering is done below in JS. That is
  // deliberate: an `orderBy('updatedAt')` alongside an equality filter
  // would need a composite index deployed to production before the
  // banner could load at all, and no Firebase deployment happens as part
  // of this change. Equality-only queries are served by the automatic
  // single-field indexes, so this works against production as-is.
  constraints.push(limit(20));
  const q = query(collection(db, 'offers'), ...constraints);
  return onSnapshot(q, (snap) => {
    const now = Date.now();
    const live = [];
    snap.forEach((doc) => {
      const offer = normalizeOffer(doc.id, doc.data());
      if (isPubliclyVisible(offer, now)) live.push(offer);
    });
    // If more than one offer is live, the most recently published one
    // wins -- the least surprising rule for an admin who just hit
    // Publish.
    live.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    callback(live[0] || null);
  }, () => callback(null));
}
