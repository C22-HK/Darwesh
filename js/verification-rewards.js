// "Verification & Rewards" -- the ONE shared settings component (§C).
//
// Mounted identically by every non-admin profile: customer, agent,
// office, company, professional. Account type changes which EVIDENCE a
// case may need, never the architecture -- so there is one component
// here, not five.
//
// WHAT THIS COMPONENT IS ALLOWED TO DO
// ------------------------------------
// Read server state and render it. That is all. It never writes
// verified, referralUnlocked, a referral status or a discount: those
// collections are write-closed to every browser session by
// firestore.rules, so an attempt would fail anyway -- but the code does
// not even contain the attempt.
//
// When a protected endpoint is not deployed, the UI says so plainly
// (§BI). It never renders a success state for a request that did not
// actually succeed.

import { escapeHtml as esc } from './offer-banner.js';
import {
  computePersonalDiscount,
  formatPercent,
  formatPercentLabel,
  normalizeRewardConfig,
} from './rewards.js';
import {
  isFullyIdentityVerified,
  isReferralUnlocked,
  normalizeReferralCode,
  referralSignupUrl,
} from './verification-model.js';

function tr(key, fallback) {
  return (window.t && window.t(key)) || fallback;
}

const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LOCK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" stroke-width="2"/>'
  + '<path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const STATUS_LABELS = {
  unverified: ['vr.status.unverified', 'Not started'],
  pending: ['vr.status.pending', 'In review'],
  verified: ['vr.status.verified', 'Verified'],
  needs_review: ['vr.status.needsReview', 'In review'],
  needs_resubmission: ['vr.status.needsResubmission', 'Action needed'],
  rejected: ['vr.status.rejected', 'Not approved'],
};

function statusLabel(status) {
  const entry = STATUS_LABELS[status] || STATUS_LABELS.unverified;
  return tr(entry[0], entry[1]);
}

/**
 * Renders the whole section from already-loaded state.
 *
 * `state` is what the server says:
 *   { case, rewardState, config, referralCode }
 * Nothing in it is trusted to be well-formed; every field is normalized
 * before use so a partially-written document cannot break the page.
 */
export function renderVerificationRewards(el, state) {
  if (!el) return;
  const s = state || {};
  // Kept so a language switch can re-render from the same data instead
  // of re-reading Firestore.
  el.__vrState = s;
  const config = normalizeRewardConfig(s.config);
  const kase = s.case || {};
  const verified = isFullyIdentityVerified(kase);
  const unlocked = isReferralUnlocked(kase);

  // Recomputed here purely for DISPLAY. The authoritative number is
  // rewardState.personalDiscountPercent, written by the backend; if the
  // two ever disagree the stored one wins and is shown.
  const computed = computePersonalDiscount(
    {
      identityVerified: kase.verificationStatus === 'verified' && kase.idVerified === true,
      faceVerified: kase.faceResult === 'passed',
      qualifiedReferralCount: Number(s.rewardState?.qualifiedReferralCount) || 0,
    },
    config,
  );
  const stored = s.rewardState?.personalDiscountPercent;
  const discount = Number.isFinite(stored) ? stored : computed.personalDiscountPercent;

  const qualified = computed.qualifiedReferralCount;
  const required = computed.requiredQualifiedReferrals;
  const progressPct = required === 0 ? 100 : Math.min(100, (qualified / required) * 100);
  const complete = verified && qualified >= required;

  el.innerHTML = `
    <div class="vr-card">
      <div class="vr-hero">
        <p class="vr-hero-label">${esc(tr('vr.currentDiscount', 'Your discount'))}</p>
        <p class="vr-hero-figure">${esc(formatPercentLabel(discount))}</p>
        ${complete
          ? `<p class="vr-hero-note vr-complete">${esc(tr('vr.rewardComplete', 'Reward complete'))}</p>`
          : `<p class="vr-hero-note">${esc(
              verified
                ? tr('vr.nextRewardHint', 'Next reward +{n}').replace('{n}', formatPercentLabel(computed.nextRewardPercent))
                : tr('vr.unlockHint', 'Complete verification to unlock your {n} reward and referral network.')
                    .replace('{n}', formatPercentLabel(config.verificationReward)),
            )}</p>`}
      </div>

      <ul class="vr-steps">
        <li class="vr-step ${verified ? 'is-done' : ''}">
          <span class="vr-step-icon">${verified ? CHECK : ''}</span>
          <span class="vr-step-body">
            <span class="vr-step-title">${esc(tr('vr.identityVerification', 'Identity Verification'))}</span>
            <span class="vr-step-meta">${esc(statusLabel(kase.verificationStatus || 'unverified'))}</span>
          </span>
          <span class="vr-step-value">${verified ? esc('+' + formatPercentLabel(config.verificationReward)) : ''}</span>
        </li>
        <li class="vr-step ${complete ? 'is-done' : ''} ${unlocked ? '' : 'is-locked'}">
          <span class="vr-step-icon">${complete ? CHECK : (unlocked ? '' : LOCK)}</span>
          <span class="vr-step-body">
            <span class="vr-step-title">${esc(tr('vr.qualifiedReferral', 'Qualified Referral'))}</span>
            <span class="vr-step-meta">${esc(
              unlocked
                ? `${qualified} / ${required}`
                : tr('vr.referralLocked', 'Locked')
            )}</span>
          </span>
          <span class="vr-step-value">${complete
            ? esc('+' + formatPercentLabel(config.qualifiedReferralReward))
            : esc(formatPercentLabel(computed.referralReward))}</span>
        </li>
      </ul>

      ${unlocked ? `
      <div class="vr-progress" role="group" aria-label="${esc(tr('vr.referralProgress', 'Referral progress'))}">
        <div class="vr-progress-head">
          <span>${esc(tr('vr.referralProgress', 'Referral progress'))}</span>
          <span class="vr-progress-count">${qualified} / ${required}</span>
        </div>
        <div class="vr-progress-track">
          <div class="vr-progress-fill" style="width:${progressPct}%"></div>
        </div>
      </div>` : ''}

      ${renderReferralBlock(s, unlocked)}
      ${renderActionBlock(kase, verified)}
      <p class="vr-terms">${esc(tr(
        'vr.terms',
        'Rewards apply to eligible Darwesh brokerage and service fees during the reward period. They do not change a property’s listed price.',
      ))}</p>
    </div>`;

  wire(el, s);
}

function renderReferralBlock(s, unlocked) {
  if (!unlocked) {
    return `
      <div class="vr-referral is-locked">
        <span class="vr-referral-lock">${LOCK}</span>
        <div>
          <p class="vr-referral-title">${esc(tr('vr.referralNetwork', 'Referral Network'))}</p>
          <p class="vr-referral-note">${esc(tr(
            'vr.referralLockedNote',
            'Verify your account to unlock the Darwesh Referral Network.',
          ))}</p>
        </div>
      </div>`;
  }

  const code = normalizeReferralCode(s.referralCode);
  if (!code) {
    // Honest: the code is issued by the backend, and if it has not been
    // issued yet we say so rather than inventing one client-side.
    return `
      <div class="vr-referral">
        <div>
          <p class="vr-referral-title">${esc(tr('vr.referralNetwork', 'Referral Network'))}</p>
          <p class="vr-referral-note">${esc(tr(
            'vr.referralCodePending',
            'Your referral code is being prepared. Refresh in a moment.',
          ))}</p>
        </div>
      </div>`;
  }

  const link = referralSignupUrl(code);
  return `
    <div class="vr-referral">
      <div class="vr-referral-main">
        <p class="vr-referral-title">${esc(tr('vr.yourReferralCode', 'Your referral code'))}</p>
        <p class="vr-code" data-vr-code>${esc(code)}</p>
        <p class="vr-referral-note">${esc(tr(
          'vr.referralCodeHint',
          'Share this code. Anyone can enter it when they create their Darwesh account.',
        ))}</p>
      </div>
      <div class="vr-referral-actions">
        <button type="button" class="vr-btn vr-btn-primary" data-vr-copy-code>${esc(tr('vr.copyCode', 'Copy Code'))}</button>
        ${link ? `<button type="button" class="vr-btn" data-vr-copy-link data-link="${esc(link)}">${esc(tr('vr.copyLink', 'Copy Link'))}</button>` : ''}
      </div>
    </div>`;
}

function renderActionBlock(kase, verified) {
  if (verified) return '';
  const status = kase.verificationStatus || 'unverified';
  const label = status === 'needs_resubmission' || status === 'rejected'
    ? tr('vr.resubmit', 'Update my documents')
    : status === 'pending' || status === 'needs_review'
      ? tr('vr.inReview', 'In review')
      : tr('vr.startVerification', 'Start Verification');
  const busy = status === 'pending' || status === 'needs_review';

  return `
    <div class="vr-actions">
      <a class="vr-btn vr-btn-primary vr-btn-lg${busy ? ' is-disabled' : ''}"
         href="verify.html"${busy ? ' aria-disabled="true" tabindex="-1"' : ''}>${esc(label)}</a>
      ${kase.reviewReason ? `<p class="vr-reason">${esc(kase.reviewReason)}</p>` : ''}
    </div>`;
}

function wire(el, s) {
  const copy = async (text, btn) => {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = tr('vr.copied', 'Copied');
    } catch (_) {
      // Clipboard can be refused (permissions, insecure context). Say so
      // rather than claiming a copy that did not happen.
      btn.textContent = tr('vr.copyFailed', 'Press to select');
      const node = el.querySelector('[data-vr-code]');
      if (node && window.getSelection) {
        const r = document.createRange();
        r.selectNodeContents(node);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setTimeout(() => { btn.textContent = original; }, 1800);
  };

  const codeBtn = el.querySelector('[data-vr-copy-code]');
  if (codeBtn) codeBtn.addEventListener('click', () => copy(normalizeReferralCode(s.referralCode) || '', codeBtn));
  const linkBtn = el.querySelector('[data-vr-copy-link]');
  if (linkBtn) linkBtn.addEventListener('click', () => copy(linkBtn.dataset.link || '', linkBtn));
}

/**
 * Loads the state this component needs and renders it.
 *
 * Reads only what firestore.rules already allow the signed-in user to
 * read about THEMSELVES: their own case, their own reward state, their
 * own code, and the public reward config.
 */
export async function mountVerificationRewards(el, uid) {
  if (!el || !uid) return;
  el.innerHTML = `<div class="vr-card vr-skeleton" aria-busy="true"></div>`;
  try {
    const [{ db }, store] = await Promise.all([
      import('./firebase-init.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js'),
    ]);
    const { doc, getDoc, collection, query, where, limit, getDocs } = store;

    // A document that DOESN'T EXIST and a read that FAILED are not the
    // same thing, and the difference decides what this component claims.
    // Swallowing both as null renders a brand-new-user card -- "Start
    // Verification", no reward -- to someone who may well be verified
    // and holding a reward. The case and reward state are load-bearing,
    // so a failure on either becomes the honest "couldn't load" card
    // below; the config and the referral code already have truthful
    // absent-states of their own, so those stay best-effort.
    const FAILED = Symbol('read-failed');
    const [caseSnap, rewardSnap, configSnap, codeSnap] = await Promise.all([
      getDoc(doc(db, 'verificationCases', uid)).catch(() => FAILED),
      getDoc(doc(db, 'users', uid, 'private', 'rewardState')).catch(() => FAILED),
      getDoc(doc(db, 'rewardConfig', 'current')).catch(() => null),
      getDocs(query(
        collection(db, 'referralCodes'),
        where('ownerUid', '==', uid),
        where('active', '==', true),
        limit(1),
      )).catch(() => null),
    ]);

    if (caseSnap === FAILED || rewardSnap === FAILED) {
      throw new Error('verification state unreadable');
    }

    let referralCode = '';
    if (codeSnap && !codeSnap.empty) {
      referralCode = (codeSnap.docs[0].data() || {}).code || codeSnap.docs[0].id;
    }

    renderVerificationRewards(el, {
      case: caseSnap?.exists() ? caseSnap.data() : {},
      rewardState: rewardSnap?.exists() ? rewardSnap.data() : {},
      config: configSnap?.exists() ? configSnap.data() : null,
      referralCode,
    });
  } catch (_) {
    el.innerHTML = `<div class="vr-card"><p class="vr-referral-note">${
      esc(tr('vr.loadFailed', 'We could not load your verification status right now.'))
    }</p></div>`;
  }
}

// Auto-mount: a page only needs <div data-verification-rewards></div>.
if (typeof document !== 'undefined') {
  const boot = async () => {
    const hosts = [...document.querySelectorAll('[data-verification-rewards]')];
    if (!hosts.length) return;
    const { auth } = await import('./firebase-init.js');
    const apply = (user) => hosts.forEach((h) => {
      if (user) mountVerificationRewards(h, user.uid);
      else h.innerHTML = '';
    });
    if (auth.onAuthStateChanged) auth.onAuthStateChanged(apply);
    else apply(auth.currentUser);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  document.addEventListener('darwesh:langchange', () => {
    // Re-render in place from the same data rather than re-reading.
    document.querySelectorAll('[data-verification-rewards]').forEach((h) => {
      if (h.__vrState) renderVerificationRewards(h, h.__vrState);
    });
  });
}
