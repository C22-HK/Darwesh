// Darwesh Group -- shared Professional Content primitives (Phase P2 UI
// prototype). Two reusable pieces, per PROFESSIONAL_CONTENT_ARCHITECTURE.md:
//
//   ProfessionalWorkCard   -- image-first editorial card for one published
//                             work item, used on a profile's Work tab, the
//                             Design Discovery grid, and "More work by
//                             this Designer."
//   ProfessionalCreatorCard -- the CONTENT -> PROFESSIONAL identity block
//                             ("[avatar] Name, verified, View Profile"),
//                             used inline on a work card and full-size on
//                             the work detail page.
//
// `professionalPosts` has no firestore.rules match block yet (see the
// architecture doc's §14) -- every query/read here treats a thrown
// permission-denied (or any other read failure) the same as a genuine
// empty result. This is NOT a fake/placeholder result: it is the correct,
// honest rendering of "this collection has nothing to show yet," whether
// that's because the rule doesn't exist yet or because it exists and is
// simply empty. Nothing in this file ever invents a post, a creator, or a
// count.
//
// Verification is NEVER read from a post document (none of the query
// helpers below select it, because professionalPosts carries no
// `verified` field at all) -- resolveCreator() is the only source of
// truth a caller may render a verified badge from.

import { db, storage, getDoc, getDocs } from './firebase-init.js';
import { collection, query, where, orderBy, limit as fsLimit, doc, startAfter } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';
import { withUploadTimeout } from './profile-shell.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
// Exported so every page that string-builds HTML from Firestore-sourced
// text or URLs (including media[].url, which -- unlike coverImageUrl --
// firestore.rules does not deep-validate per-item) uses this SAME
// escaping function rather than each page growing its own copy that can
// drift out of sync or simply be forgotten on one interpolation site.
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Single source of truth for the Designer category enum -- consumed by
// design.html (discovery filters), add-work.html (publish/edit form),
// and designer.html/work.html (card + detail labels). MUST mirror
// firestore.rules' professionalPosts isValidCategory() byte-for-byte;
// that function's own comment points back here. Do not hardcode a
// second copy of this list anywhere else.
export const DESIGNER_CATEGORIES = ['residential', 'apartment', 'villa', 'office', 'cafe', 'commercial', 'interior', 'exterior'];

export function categoryLabel(category) {
  return category ? tr(`pwork.category.${category}`, category) : '';
}

// ---- Media upload/delete (Designer publishing) ----------------------------
//
// storage.rules' professional-work/{profileId}/{fileName} match block is
// the real, server-enforced gate (owner + serviceType=='designer' cross-
// check, image/jpeg|png|webp only, 10MB cap) -- these client-side
// constants exist purely for immediate UX (reject an obviously-bad file
// before spending an upload round-trip), never as the actual security
// boundary.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_GALLERY_IMAGES = 10;

export function isAllowedImageFile(file) {
  return !!file && ALLOWED_IMAGE_TYPES.includes(file.type) && file.size > 0 && file.size < MAX_IMAGE_BYTES;
}

// Uploads one file under the caller's own profileId and resolves to its
// real Storage download URL. Never trust a filename -- the path segment
// is a random-suffixed, character-allowlisted copy of it, purely for
// human-readability in the Storage console; storage.rules validates the
// actual uploaded bytes' contentType, not this string.
export async function uploadProfessionalWorkImage(profileId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const path = `professional-work/${profileId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const fileRef = storageRef(storage, path);
  await withUploadTimeout(uploadBytes(fileRef, file));
  return withUploadTimeout(getDownloadURL(fileRef));
}

// Best-effort cleanup only (orphaned-upload rollback, or a genuine
// owner-initiated image removal) -- never blocks or fails the caller's
// user-facing flow on a cleanup failure (already deleted, network hiccup,
// etc.). storage.rules independently re-enforces that only the owning
// Designer (or admin) can actually delete a given path, regardless of
// what this helper is asked to do.
export async function deleteProfessionalWorkImage(url) {
  try {
    await deleteObject(storageRef(storage, url));
  } catch {
    /* best-effort only -- see doc comment above */
  }
}

// ---- Reads ---------------------------------------------------------------

// Published work, optionally scoped to one profile and/or one profileType/
// category. Always status=='published' -- draft/hidden work is never
// fetched through this helper (a profile's own owner-view "my drafts"
// listing, if ever built, is a deliberately separate, auth-gated path).
export async function fetchPublishedWork({ profileType, profileId, category, pageSize = 24, cursor = null } = {}) {
  try {
    const clauses = [where('status', '==', 'published')];
    if (profileType) clauses.push(where('profileType', '==', profileType));
    if (profileId) clauses.push(where('profileId', '==', profileId));
    if (category) clauses.push(where('category', '==', category));
    clauses.push(orderBy('createdAt', 'desc'));
    if (cursor) clauses.push(startAfter(cursor));
    clauses.push(fsLimit(pageSize));
    const snap = await getDocs(query(collection(db, 'professionalPosts'), ...clauses));
    return { items: snap.docs.map((d) => ({ id: d.id, ...d.data() })), lastDoc: snap.docs.length ? snap.docs[snap.docs.length - 1] : null };
  } catch (err) {
    // permission-denied (no rule published yet) and any other read
    // failure both resolve to "nothing to show" -- see module header.
    return { items: [], lastDoc: null };
  }
}

export async function fetchPost(postId) {
  try {
    const snap = await getDoc(doc(db, 'professionalPosts', postId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch {
    return null;
  }
}

// The single trusted source for a creator's display identity + verified
// state -- always a live read of the real serviceProviders profile, never
// anything carried on a post document.
export async function resolveCreator(profileId) {
  try {
    const snap = await getDoc(doc(db, 'serviceProviders', profileId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch {
    return null;
  }
}

// ---- ProfessionalCreatorCard ----------------------------------------------

// variant: 'inline' (small, embedded in a work card footer) | 'full'
// (standalone block on the work detail page).
export function renderCreatorCard(creator, { variant = 'inline', profileHref } = {}) {
  if (!creator) return '';
  const href = profileHref || `designer.html?id=${encodeURIComponent(creator.id)}`;
  const name = esc(creator.displayName || '—');
  const verified = creator.verified
    ? `<span class="pcc-verified material-symbols-outlined" aria-hidden="true" title="${esc(tr('rp.verified', 'Verified'))}">verified</span>`
    : '';
  if (variant === 'full') {
    const roleLabel = esc(tr(`rp.role.${creator.serviceType}`, creator.serviceType || ''));
    const locationParts = [creator.city, creator.district].filter(Boolean).map(esc);
    return `
      <a class="pcc-card pcc-full" href="${href}">
        <span class="pcc-avatar" aria-hidden="true">${creator.photoOrLogoUrl ? `<img src="${esc(creator.photoOrLogoUrl)}" alt="" loading="lazy"/>` : `<span class="material-symbols-outlined">person</span>`}</span>
        <span class="pcc-identity">
          <span class="pcc-name-row"><span class="pcc-name">${name}</span>${verified}</span>
          <span class="pcc-meta">${roleLabel}${locationParts.length ? ' · ' + locationParts.join(' · ') : ''}</span>
          <span class="pcc-viewprofile">${esc(tr('pwork.viewProfile', 'View Profile'))}</span>
        </span>
      </a>
    `;
  }
  return `
    <a class="pcc-card pcc-inline" href="${href}">
      <span class="pcc-avatar" aria-hidden="true">${creator.photoOrLogoUrl ? `<img src="${esc(creator.photoOrLogoUrl)}" alt="" loading="lazy"/>` : `<span class="material-symbols-outlined">person</span>`}</span>
      <span class="pcc-name-row"><span class="pcc-name">${name}</span>${verified}</span>
    </a>
  `;
}

// ---- ProfessionalWorkCard --------------------------------------------------

// `creator` is optional -- when supplied (Discovery / "more work by"
// contexts, where a caller already resolved it) the card embeds a
// compact ProfessionalCreatorCard; a profile's own Work tab omits it
// (the page's own hero already establishes who the creator is).
//
// `clickable` defaults to true (real professionalPosts item -> links to
// work.html?id=). A profile's read-only fallback to the legacy
// `serviceProviders.portfolio` array (PROFESSIONAL_CONTENT_ARCHITECTURE.md
// §13) has no post document and therefore no detail page to link to --
// callers pass `clickable: false` for those, which renders the same
// visual card with no <a> wrapper rather than a dead link.
export function renderWorkCard(post, { creator, categoryLabel, detailHref, clickable = true } = {}) {
  const href = detailHref || `work.html?id=${encodeURIComponent(post.id)}`;
  const cover = post.coverImageUrl || (Array.isArray(post.media) && post.media[0] && post.media[0].url) || '';
  const locationParts = [post.city, post.district].filter(Boolean).map(esc);
  const mediaInner = cover
    ? `<img class="pwc-media" src="${esc(cover)}" alt="" loading="lazy" decoding="async"/>`
    : `<span class="pwc-media pwc-media-fallback"><span class="material-symbols-outlined" aria-hidden="true">palette</span></span>`;
  const media = clickable
    ? `<a class="pwc-media-link" href="${href}" aria-label="${esc(post.title || '')}">${mediaInner}</a>`
    : `<span class="pwc-media-link">${mediaInner}</span>`;
  const titleInner = `<p class="pwc-title">${esc(post.title || '')}</p>`;
  const title = clickable ? `<a class="pwc-title-link" href="${href}">${titleInner}</a>` : titleInner;
  return `
    <div class="pwc-card">
      ${media}
      <div class="pwc-body">
        ${title}
        <p class="pwc-meta">${categoryLabel ? esc(categoryLabel) : ''}${locationParts.length ? (categoryLabel ? ' · ' : '') + locationParts.join(' · ') : ''}</p>
        ${creator ? renderCreatorCard(creator, { variant: 'inline' }) : ''}
      </div>
    </div>
  `;
}
