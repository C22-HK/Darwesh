// Admin Panel -- Network Verification Center (§U-§AI, §T).
//
// One place for identity review, the referral graph and the reward
// policy. Same separate-module, lazy-init-on-first-tab-click pattern as
// js/admin-orgs-pros.js / js/admin-map.js, and it reuses that phase's
// .ash-entity-* / .ash-detail-* component family rather than inventing a
// third table and a third overlay.
//
// WHAT THIS MODULE CANNOT DO, BY CONSTRUCTION
// -------------------------------------------
//  * It cannot change a verification outcome from the browser.
//    firestore.rules makes verificationCases, referrals, referralCodes,
//    rewardLedger and rewardConfig unwritable by EVERY client session --
//    admins included -- so every decision here is a request to the
//    audited backend ops layer, never a direct write (§AK).
//  * It cannot bulk-load identity documents. Opening one is its own
//    click, its own audited call, and yields a URL that expires in
//    minutes (§Z). There is deliberately no "show all evidence".
//  * It cannot show a confidence score. Risk is Low/Medium/High for
//    queue ordering only, derived from facts a human can check (§AA).
//
// WHEN THE BACKEND IS NOT DEPLOYED
// --------------------------------
// Every call goes through isEndpointUnavailable() and reports "not live
// in production yet" rather than a validation error or a fake success
// (§BI). That message is self-correcting: it stops appearing the moment
// the route is deployed, with no code change here.

import { auth } from './firebase-init.js';
import {
  getVerificationMetrics, listVerificationCases, getVerificationCase,
  reviewVerificationCase, setVerificationFaceResult, revealVerificationEvidence,
  archiveVerificationCase, listReferrals, setReferralStatus, correctReferrer,
  getRewardConfig, saveRewardConfig, isEndpointUnavailable, BackendResponseError,
} from './backend-api.js';
import {
  normalizeRewardConfig, computePersonalDiscount, formatPercent,
  isValidRewardPercent, STACKING_POLICIES,
} from './rewards.js';
import { escapeHtml as esc } from './offer-banner.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function toast(msg, variant) {
  if (window.AdminShellToast) window.AdminShellToast(msg, variant || 'success');
}

/** One translation of a failure, used everywhere in this module. An
 *  undeployed route and a refused action must never read the same. */
function describeError(err) {
  if (isEndpointUnavailable(err)) {
    return tr('admin.nv.unavailable', "This feature isn't live in production yet.");
  }
  if (err instanceof BackendResponseError) return err.message;
  return tr('admin.nv.actionFailed', 'Could not complete this action right now.');
}

const state = {
  mounted: false,
  filter: '',
  cases: [],
  metrics: null,
  referrals: [],
  config: null,
  loading: false,
  error: null,
  openCase: null,
};

const STATUS_LABELS = {
  unverified: ['vr.status.unverified', 'Not started'],
  pending: ['vr.status.pending', 'In review'],
  needs_review: ['vr.status.needsReview', 'Needs manual review'],
  needs_resubmission: ['vr.status.needsResubmission', 'Needs resubmission'],
  verified: ['vr.status.verified', 'Verified'],
  rejected: ['vr.status.rejected', 'Not approved'],
};
const STATUS_BADGE = {
  unverified: 'badge-private',
  pending: 'badge-pending',
  needs_review: 'badge-pending',
  needs_resubmission: 'badge-suspended',
  verified: 'badge-active',
  rejected: 'badge-rejected',
};
const RISK_LABELS = {
  low: ['admin.nv.riskLow', 'Low'],
  medium: ['admin.nv.riskMedium', 'Medium'],
  high: ['admin.nv.riskHigh', 'High'],
};
const RISK_BADGE = { low: 'badge-active', medium: 'badge-pending', high: 'badge-rejected' };

// English fallbacks for the internal vocabulary. Without these an English
// reviewer sees the raw enum -- "highest_benefit", "strong_mismatch" --
// because English has no dictionary in js/i18n.js by design (the inline
// fallback IS the English string), so a fallback of the key's own value
// leaks the enum straight to the screen.
const STACK_LABELS = {
  personal_only: 'Personal discount only',
  campaign_only: 'Public campaign only',
  highest_benefit: 'Best for the user',
  stack: 'Combine both',
};
const REFERRAL_STATUS_LABELS = {
  pending: ['vr.status.pending', 'Awaiting qualification'],
  qualified: ['admin.nv.referralQualify', 'Qualified'],
  rejected: ['vr.status.rejected', 'Rejected'],
  suspicious: ['admin.nv.referralSuspicious', 'Suspicious'],
  revoked: ['admin.nv.referralRevoke', 'Revoked'],
};
const FACE_LABELS = {
  pending: 'Not captured yet',
  passed: 'Passed',
  failed: 'Did not match',
  needs_review: 'Needs a human look',
  unavailable: 'Not available',
};
const NAME_MATCH_LABELS = {
  exact: 'Exact',
  likely: 'Likely the same name',
  needs_review: 'Needs a human look',
  strong_mismatch: 'Does not match',
};

/** Turns an internal flag like `rapid_signup_burst` into something a
 *  person can read. Deliberately generic rather than a per-flag
 *  dictionary: a new flag added in model.py then renders sensibly here
 *  instead of appearing as a raw identifier until someone notices. */
function humanize(value) {
  if (!value) return '—';
  const s = String(value).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function referralStatusLabel(status) {
  const e = REFERRAL_STATUS_LABELS[status];
  return e ? tr(e[0], e[1]) : humanize(status);
}

function statusLabel(s) {
  const e = STATUS_LABELS[s] || STATUS_LABELS.unverified;
  return tr(e[0], e[1]);
}
function riskLabel(r) {
  const e = RISK_LABELS[r] || RISK_LABELS.low;
  return tr(e[0], e[1]);
}
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}
/** A uid is an internal identifier, never a public one (§AK's companion
 *  rule). Shown truncated here only so a reviewer can tell two rows
 *  apart when neither account has filled in a name yet. */
function shortUid(uid) {
  return uid ? `${String(uid).slice(0, 6)}…` : '—';
}

// ---------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------
function panel() { return document.getElementById('tab-verification'); }

function ensureShell() {
  const root = panel();
  if (!root || state.mounted) return root;
  root.innerHTML = `
    <div class="ash-nv">
      <div class="ash-offers-head">
        <div>
          <p class="font-headline-md text-[22px] text-on-surface font-bold" data-i18n="admin.nv.title">Network Verification Center</p>
          <p class="font-body-md text-[12.5px] text-on-surface-variant mt-1" data-i18n="admin.nv.subtitle">Identity review, referrals and rewards — all in one place.</p>
        </div>
        <button type="button" class="ash-detail-btn" id="nvRefreshBtn">
          <span class="material-symbols-outlined" style="font-size:17px;" aria-hidden="true">refresh</span>
          <span data-i18n="common.refresh">Refresh</span>
        </button>
      </div>

      <div id="nvMetrics" class="ash-nv-metrics"></div>

      <div class="ash-nv-columns">
        <section class="ash-nv-col">
          <p class="ash-detail-section-title" data-i18n="admin.nv.queueTitle">Review queue</p>
          <div class="ash-entity-toolbar">
            <select class="ash-entity-select" id="nvStatusFilter">
              <option value="" data-i18n="admin.nv.filterAll">All</option>
            </select>
            <span class="ash-entity-count" id="nvCount"></span>
          </div>
          <div id="nvQueue"></div>
        </section>

        <section class="ash-nv-col">
          <p class="ash-detail-section-title" data-i18n="admin.nv.rewardConfigTitle">Reward settings</p>
          <div id="nvRewardConfig"></div>
        </section>
      </div>

      <section class="ash-nv-col" style="margin-top:22px;">
        <p class="ash-detail-section-title" data-i18n="admin.nv.referralsTitle">Referrals</p>
        <div id="nvReferrals"></div>
      </section>
    </div>`;

  // Status filter options are built from the vocabulary, not typed
  // twice -- a new status appears here automatically.
  const sel = root.querySelector('#nvStatusFilter');
  Object.keys(STATUS_LABELS).forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = statusLabel(s);
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => { state.filter = sel.value; loadQueue(); });
  root.querySelector('#nvRefreshBtn').addEventListener('click', () => loadAll());

  state.mounted = true;
  return root;
}

// ---------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------
function skeleton(host, rows) {
  host.innerHTML = `<div class="ash-entity-loading">${
    Array.from({ length: rows || 3 }, () => '<div class="ash-entity-skel" style="margin:8px 0;"></div>').join('')
  }</div>`;
}

function errorState(host, err) {
  host.innerHTML = `<div class="ash-entity-error">${esc(describeError(err))}</div>`;
}

async function loadAll() {
  await Promise.all([loadMetrics(), loadQueue(), loadReferrals(), loadRewardConfig()]);
}

async function loadMetrics() {
  const host = document.getElementById('nvMetrics');
  if (!host) return;
  skeleton(host, 1);
  try {
    const data = await getVerificationMetrics(auth.currentUser);
    state.metrics = data;
    renderMetrics(host, data);
  } catch (err) {
    errorState(host, err);
  }
}

function renderMetrics(host, data) {
  const cases = (data && data.cases) || {};
  const refs = (data && data.referrals) || {};
  // Real counts only (§U). A collection with nothing in it reports zero
  // -- there are no modelled, projected or placeholder figures here.
  const tiles = [
    ['pending', cases.pending || 0, statusLabel('pending')],
    ['needs_review', cases.needs_review || 0, statusLabel('needs_review')],
    ['verified', cases.verified || 0, statusLabel('verified')],
    ['qualified', refs.qualified || 0, tr('vr.qualifiedReferral', 'Qualified referral')],
  ];
  host.innerHTML = tiles.map(([key, value, label]) => `
    <div class="ash-nv-metric" data-metric="${esc(key)}">
      <span class="ash-nv-metric-value">${esc(String(value))}</span>
      <span class="ash-nv-metric-label">${esc(label)}</span>
    </div>`).join('');
}

async function loadQueue() {
  const host = document.getElementById('nvQueue');
  if (!host) return;
  skeleton(host, 4);
  try {
    const data = await listVerificationCases(auth.currentUser, state.filter || undefined);
    state.cases = (data && data.cases) || [];
    renderQueue(host);
  } catch (err) {
    errorState(host, err);
  }
}

function renderQueue(host) {
  const count = document.getElementById('nvCount');
  if (count) count.textContent = String(state.cases.length);
  if (!state.cases.length) {
    host.innerHTML = `<div class="ash-entity-empty">${esc(tr('admin.nv.empty', 'No cases in this state.'))}</div>`;
    return;
  }
  host.innerHTML = `
    <div class="ash-entity-table-wrap">
      <table class="admin-table">
        <thead><tr>
          <th data-i18n="admin.nv.colUser">User</th>
          <th data-i18n="admin.nv.colStatus">Status</th>
          <th data-i18n="admin.nv.colRisk">Risk</th>
          <th data-i18n="admin.nv.colSubmitted">Submitted</th>
        </tr></thead>
        <tbody>${state.cases.map((c) => `
          <tr class="ash-entity-row" data-uid="${esc(c.uid)}">
            <td>${esc(shortUid(c.uid))}</td>
            <td><span class="badge ${STATUS_BADGE[c.verificationStatus] || 'badge-private'}">${esc(statusLabel(c.verificationStatus))}</span></td>
            <td><span class="badge ${RISK_BADGE[c.risk] || 'badge-active'}">${esc(riskLabel(c.risk))}</span></td>
            <td>${esc(shortDate(c.submittedAt))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="ash-entity-cards">${state.cases.map((c) => `
      <div class="ash-entity-card" data-uid="${esc(c.uid)}">
        <div class="ash-entity-card-head">
          <span class="ash-entity-card-title">${esc(shortUid(c.uid))}</span>
          <span class="badge ${STATUS_BADGE[c.verificationStatus] || 'badge-private'}">${esc(statusLabel(c.verificationStatus))}</span>
        </div>
        <span class="ash-entity-card-sub">${esc(shortDate(c.submittedAt))}</span>
        <div class="ash-entity-card-meta">
          <span class="badge ${RISK_BADGE[c.risk] || 'badge-active'}">${esc(riskLabel(c.risk))}</span>
        </div>
      </div>`).join('')}</div>`;

  host.querySelectorAll('[data-uid]').forEach((el) => {
    el.addEventListener('click', () => openCase(el.dataset.uid));
  });
}

// ---------------------------------------------------------------------
// Case detail + decisions
// ---------------------------------------------------------------------
async function openCase(uid) {
  const backdrop = document.createElement('div');
  backdrop.className = 'ash-detail-backdrop';
  backdrop.innerHTML = `<div class="ash-detail-panel"><div class="ash-detail-body"><div class="ash-entity-loading"><div class="ash-entity-skel"></div></div></div></div>`;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);

  let detail;
  try {
    detail = await getVerificationCase(auth.currentUser, uid);
  } catch (err) {
    backdrop.querySelector('.ash-detail-body').innerHTML =
      `<div class="ash-entity-error">${esc(describeError(err))}</div>`;
    return;
  }
  state.openCase = detail;
  renderCaseDetail(backdrop, detail);
}

function renderCaseDetail(backdrop, c) {
  const panelEl = backdrop.querySelector('.ash-detail-panel');
  const flags = (c.riskFlags || []);
  panelEl.innerHTML = `
    <div class="ash-detail-head">
      <div>
        <p class="ash-detail-title">${esc(c.displayName || shortUid(c.uid))}</p>
        <p class="ash-detail-sub" data-i18n="admin.nv.caseTitle">Verification file</p>
      </div>
      <button type="button" class="ash-detail-close" data-nv-close aria-label="Close">
        <span class="material-symbols-outlined" style="font-size:19px;" aria-hidden="true">close</span>
      </button>
    </div>
    <div class="ash-detail-body">
      <section>
        <dl class="ash-detail-kv">
          <dt data-i18n="admin.nv.fieldIdentity">Identity</dt>
          <dd><span class="badge ${STATUS_BADGE[c.verificationStatus] || 'badge-private'}">${esc(statusLabel(c.verificationStatus))}</span></dd>
          <dt data-i18n="admin.nv.fieldFace">Face result</dt>
          <dd>${esc(FACE_LABELS[c.faceResult] || humanize(c.faceResult))}</dd>
          <dt data-i18n="admin.nv.fieldNameMatch">Name match</dt>
          <dd>${esc(NAME_MATCH_LABELS[c.nameMatch] || humanize(c.nameMatch))}</dd>
          <dt data-i18n="admin.nv.fieldRiskFlags">Risk flags</dt>
          <dd>${flags.length
            ? flags.map((f) => `<span class="badge badge-pending">${esc(humanize(f))}</span>`).join(' ')
            : esc(tr('admin.nv.noRiskFlags', 'No flags'))}</dd>
          <dt data-i18n="admin.nv.fieldConsent">Consent</dt>
          <dd>${esc(c.consentVersion || '—')}</dd>
          <dt data-i18n="admin.nv.fieldAccount">Account status</dt>
          <dd>${esc(humanize(c.accountStatus || 'active'))}</dd>
        </dl>
      </section>

      <section>
        <p class="ash-detail-section-title" data-i18n="admin.nv.evidenceTitle">Documents</p>
        ${renderEvidence(c)}
      </section>

      <section>
        <p class="ash-detail-section-title" data-i18n="admin.nv.decisionTitle">Decision</p>
        <textarea class="ash-detail-textarea" id="nvReason"
          placeholder="${esc(tr('admin.nv.reasonPlaceholder', 'Write the reason — this is sent to the user.'))}"></textarea>
        <p id="nvDecisionMsg" class="ash-nv-msg"></p>
        <div class="ash-detail-actions" style="margin-top:10px;">
          <button type="button" class="ash-detail-btn ash-detail-btn-primary" data-nv-decide="verified" data-i18n="admin.nv.approve">Approve</button>
          <button type="button" class="ash-detail-btn" data-nv-decide="needs_review" data-i18n="admin.nv.needsReview">Send to manual review</button>
          <button type="button" class="ash-detail-btn" data-nv-decide="needs_resubmission" data-i18n="admin.nv.needsResubmission">Ask for new documents</button>
          <button type="button" class="ash-detail-btn ash-detail-btn-danger" data-nv-decide="rejected" data-i18n="admin.nv.reject">Reject</button>
        </div>
      </section>

      <section>
        <p class="ash-detail-section-title" data-i18n="admin.nv.accountTitle">Account actions</p>
        <p class="ash-nv-hint" data-i18n="admin.nv.accountNote">Account status is independent of the verification outcome.</p>
        <div class="ash-detail-actions" style="margin-top:10px;">
          <button type="button" class="ash-detail-btn" data-nv-account="active" data-i18n="admin.nv.accountActive">Active</button>
          <button type="button" class="ash-detail-btn" data-nv-account="restricted" data-i18n="admin.nv.accountRestrict">Restrict</button>
          <button type="button" class="ash-detail-btn" data-nv-account="suspended" data-i18n="admin.nv.accountSuspend">Suspend</button>
          <button type="button" class="ash-detail-btn ash-detail-btn-danger" data-nv-account="closed" data-i18n="admin.nv.accountClose">Close permanently</button>
        </div>
      </section>

      <section>
        <p class="ash-detail-section-title" data-i18n="admin.nv.archiveTitle">Archiving</p>
        <p class="ash-nv-hint" data-i18n="admin.nv.archiveWarning">Live documents are deleted only after the archive is created, encrypted, uploaded and verified. If any check fails, nothing is deleted.</p>
        <div class="ash-detail-actions" style="margin-top:10px;">
          <button type="button" class="ash-detail-btn" data-nv-archive data-i18n="admin.nv.archiveRun">Archive and delete live documents</button>
        </div>
      </section>
    </div>`;

  panelEl.querySelector('[data-nv-close]').addEventListener('click', () => backdrop.remove());

  const msg = panelEl.querySelector('#nvDecisionMsg');
  const reason = () => panelEl.querySelector('#nvReason').value.trim();
  const say = (text, bad) => {
    msg.textContent = text;
    msg.className = `ash-nv-msg${bad ? ' ash-nv-msg-bad' : ''}`;
  };

  panelEl.querySelectorAll('[data-nv-decide]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const status = btn.dataset.nvDecide;
      // The backend enforces this too; checking here saves a round trip
      // and puts the message next to the field it is about.
      if ((status === 'rejected' || status === 'needs_resubmission') && !reason()) {
        say(tr('admin.nv.reasonRequired', 'This decision requires a reason.'), true);
        return;
      }
      btn.disabled = true;
      try {
        await reviewVerificationCase(auth.currentUser, c.uid, { status, reason: reason() });
        toast(tr('admin.nv.saved', 'Saved.'), 'success');
        backdrop.remove();
        loadAll();
      } catch (err) {
        say(describeError(err), true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  panelEl.querySelectorAll('[data-nv-account]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const accountStatus = btn.dataset.nvAccount;
      if (accountStatus === 'closed' && !reason()) {
        // §AB: permanent closure always needs a stated reason.
        say(tr('admin.nv.reasonRequired', 'This decision requires a reason.'), true);
        return;
      }
      btn.disabled = true;
      try {
        // Account status travels with the CURRENT verification status,
        // so restricting someone does not silently also change their
        // verification outcome (§H).
        await reviewVerificationCase(auth.currentUser, c.uid, {
          status: c.verificationStatus,
          accountStatus,
          reason: reason(),
        });
        toast(tr('admin.nv.saved', 'Saved.'), 'success');
        backdrop.remove();
        loadAll();
      } catch (err) {
        say(describeError(err), true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  panelEl.querySelector('[data-nv-archive]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const result = await archiveVerificationCase(auth.currentUser, c.uid);
      // archive_case returns {ok, deleted, error} rather than throwing
      // for an expected refusal -- report what actually happened, never
      // "done" for a run that deleted nothing.
      if (result && result.ok && result.deleted) {
        toast(tr('admin.nv.saved', 'Saved.'), 'success');
      } else {
        say(String((result && result.error) || tr('admin.nv.actionFailed', 'Could not complete this action right now.')), true);
      }
    } catch (err) {
      say(describeError(err), true);
    } finally {
      btn.disabled = false;
    }
  });

  panelEl.querySelectorAll('[data-nv-reveal]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const result = await revealVerificationEvidence(auth.currentUser, c.uid, btn.dataset.nvReveal);
        // A new tab, not an <img> in the panel: the URL is short-lived
        // and single-purpose, and nothing caches it into this page.
        if (result && result.url) window.open(result.url, '_blank', 'noopener');
        const minutes = Math.round((result.expiresInSeconds || 600) / 60);
        toast(tr('admin.nv.evidenceExpires', 'This link expires in {n} minutes.').replace('{n}', String(minutes)), 'success');
      } catch (err) {
        toast(describeError(err), 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function renderEvidence(c) {
  if (!c.evidenceVisible) {
    return `<p class="ash-nv-hint">${esc(tr('admin.nv.evidenceHidden', 'You do not have permission to view documents.'))}</p>`;
  }
  const items = c.evidence || [];
  if (!items.length) {
    return `<p class="ash-nv-hint">${esc(tr('admin.nv.evidenceNone', 'No documents.'))}</p>`;
  }
  return `
    <p class="ash-nv-hint">${esc(tr('admin.nv.evidenceAudited', 'Every document opening is recorded.'))}</p>
    <div class="ash-nv-evidence">${items.map((e) => `
      <div class="ash-nv-evidence-row">
        <div>
          <span class="ash-nv-evidence-kind">${esc(humanize(e.kind || 'other'))}</span>
          ${(e.qualityIssues || []).length
            ? `<span class="ash-nv-hint">${esc((e.qualityIssues || []).map((q) => tr(`verify.quality.${q}`, humanize(q))).join(', '))}</span>`
            : ''}
        </div>
        ${e.liveEvidenceDeleted
          ? `<span class="badge badge-private">${esc(tr('admin.nv.evidenceArchived', 'Archived and deleted from live storage.'))}</span>`
          : `<button type="button" class="ash-detail-btn" data-nv-reveal="${esc(e.evidenceId)}">${esc(tr('admin.nv.evidenceReveal', 'Open document'))}</button>`}
      </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------
// Referrals (§AI)
// ---------------------------------------------------------------------
async function loadReferrals() {
  const host = document.getElementById('nvReferrals');
  if (!host) return;
  skeleton(host, 3);
  try {
    const data = await listReferrals(auth.currentUser);
    state.referrals = (data && data.referrals) || [];
    renderReferrals(host);
  } catch (err) {
    errorState(host, err);
  }
}

const REFERRAL_ACTIONS = [
  ['qualified', 'admin.nv.referralQualify', 'Approve'],
  ['suspicious', 'admin.nv.referralSuspicious', 'Suspicious'],
  ['rejected', 'admin.nv.referralReject', 'Reject'],
  ['revoked', 'admin.nv.referralRevoke', 'Revoke'],
];

function renderReferrals(host) {
  if (!state.referrals.length) {
    host.innerHTML = `<div class="ash-entity-empty">${esc(tr('admin.nv.empty', 'No cases in this state.'))}</div>`;
    return;
  }
  host.innerHTML = `<div class="ash-nv-referrals">${state.referrals.map((r) => `
    <div class="ash-nv-referral" data-referral="${esc(r.referralId)}">
      <div class="ash-nv-referral-main">
        <span class="ash-entity-card-title">${esc(shortUid(r.referrerUid))} → ${esc(shortUid(r.referredUid))}</span>
        <span class="ash-entity-card-sub">${esc(referralStatusLabel(r.status))}</span>
        ${(r.riskFlags || []).length
          ? `<div class="ash-entity-card-meta">${r.riskFlags.map((f) => `<span class="badge badge-pending">${esc(humanize(f))}</span>`).join('')}</div>`
          : ''}
      </div>
      <div class="ash-detail-actions">${REFERRAL_ACTIONS.map(([status, key, fallback]) =>
        `<button type="button" class="ash-detail-btn" data-ref-status="${esc(status)}">${esc(tr(key, fallback))}</button>`).join('')}</div>
      <p class="ash-nv-msg" data-ref-msg></p>
    </div>`).join('')}</div>`;

  host.querySelectorAll('[data-referral]').forEach((row) => {
    const id = row.dataset.referral;
    const msg = row.querySelector('[data-ref-msg]');
    row.querySelectorAll('[data-ref-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const status = btn.dataset.refStatus;
        let reason = '';
        if (status === 'rejected' || status === 'revoked') {
          // The backend requires a reason for these two; asking here
          // means the request is not sent just to be refused.
          reason = (window.prompt(tr('admin.nv.reason', 'Reason')) || '').trim();
          if (!reason) return;
        }
        btn.disabled = true;
        try {
          await setReferralStatus(auth.currentUser, id, status, reason);
          toast(tr('admin.nv.saved', 'Saved.'), 'success');
          loadReferrals();
          loadMetrics();
        } catch (err) {
          msg.textContent = describeError(err);
          msg.className = 'ash-nv-msg ash-nv-msg-bad';
        } finally {
          btn.disabled = false;
        }
      });
    });
  });
}

// ---------------------------------------------------------------------
// Reward configuration (§T)
// ---------------------------------------------------------------------
const CONFIG_FIELDS = [
  ['verificationReward', 'admin.nv.rcVerification', 'Verification reward (%)', 'number', '0.5'],
  ['qualifiedReferralReward', 'admin.nv.rcReferral', 'Reward per qualified referral (%)', 'number', '0.5'],
  ['requiredQualifiedReferrals', 'admin.nv.rcRequired', 'Qualified referrals required', 'number', '1'],
  ['maximumPersonalDiscount', 'admin.nv.rcMaximum', 'Maximum personal discount (%)', 'number', '0.5'],
];

async function loadRewardConfig() {
  const host = document.getElementById('nvRewardConfig');
  if (!host) return;
  skeleton(host, 3);
  try {
    const data = await getRewardConfig(auth.currentUser);
    state.config = normalizeRewardConfig(data);
    renderRewardConfig(host);
  } catch (err) {
    errorState(host, err);
  }
}

function renderRewardConfig(host) {
  const c = state.config;
  host.innerHTML = `
    <div class="ash-nv-config">
      ${CONFIG_FIELDS.map(([key, i18n, fallback, type, step]) => `
        <label class="ash-nv-field">
          <span data-i18n="${esc(i18n)}">${esc(fallback)}</span>
          <input class="ash-entity-select" type="${esc(type)}" step="${esc(step)}" min="0"
                 data-rc="${esc(key)}" value="${esc(String(c[key]))}"/>
        </label>`).join('')}
      <label class="ash-nv-field">
        <span data-i18n="admin.nv.rcStacking">Stacking policy</span>
        <select class="ash-entity-select" data-rc="stackingPolicy">
          ${STACKING_POLICIES.map((p) => `
            <option value="${esc(p)}"${p === c.stackingPolicy ? ' selected' : ''}>${
              esc(tr(`admin.nv.stack.${p}`, STACK_LABELS[p] || humanize(p)))
            }</option>`).join('')}
        </select>
      </label>
      <p class="ash-nv-hint" data-i18n="admin.nv.rcStackingHint">Personal discount and the public campaign are two separate systems.</p>

      <p class="ash-detail-section-title" style="margin-top:16px;" data-i18n="admin.nv.rcPreview">Calculation preview</p>
      <p class="ash-nv-preview" id="nvPreview"></p>
      <p class="ash-nv-msg" id="nvConfigMsg"></p>
      <div class="ash-detail-actions" style="margin-top:12px;">
        <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="nvSaveConfig" data-i18n="common.save">Save</button>
      </div>
    </div>`;

  const inputs = [...host.querySelectorAll('[data-rc]')];
  const msg = host.querySelector('#nvConfigMsg');

  /** Reads the form into a config object. Never parseInt: 3.5 must
   *  survive as 3.5, and an integer parse is exactly how it would
   *  silently become 3. */
  function read() {
    const out = {};
    inputs.forEach((el) => {
      const key = el.dataset.rc;
      if (key === 'stackingPolicy') out[key] = el.value;
      else if (key === 'requiredQualifiedReferrals') out[key] = Math.max(0, Math.trunc(Number(el.value) || 0));
      else out[key] = Number(el.value);
    });
    return out;
  }

  function preview() {
    const draft = normalizeRewardConfig(read());
    // The SAME formula the backend runs, so what an admin sees here is
    // what a user's discount will actually become.
    const full = computePersonalDiscount(
      { identityVerified: true, faceVerified: true, qualifiedReferralCount: draft.requiredQualifiedReferrals },
      draft,
    );
    host.querySelector('#nvPreview').textContent =
      tr('admin.nv.rcPreviewNote', 'Verification {a}% + referral {b}% = {t}%')
        .replace('{a}', formatPercent(full.verificationReward))
        .replace('{b}', formatPercent(full.referralReward))
        .replace('{t}', formatPercent(full.personalDiscountPercent));
  }

  inputs.forEach((el) => el.addEventListener('input', preview));
  preview();

  host.querySelector('#nvSaveConfig').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const draft = read();
    const bad = ['verificationReward', 'qualifiedReferralReward', 'maximumPersonalDiscount']
      .find((k) => !isValidRewardPercent(draft[k]));
    if (bad) {
      msg.textContent = tr('admin.nv.actionFailed', 'Could not complete this action right now.');
      msg.className = 'ash-nv-msg ash-nv-msg-bad';
      return;
    }
    btn.disabled = true;
    try {
      const saved = await saveRewardConfig(auth.currentUser, draft);
      state.config = normalizeRewardConfig(saved);
      msg.textContent = tr('admin.nv.saved', 'Saved.');
      msg.className = 'ash-nv-msg';
      toast(tr('admin.nv.saved', 'Saved.'), 'success');
    } catch (err) {
      msg.textContent = describeError(err);
      msg.className = 'ash-nv-msg ash-nv-msg-bad';
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Entry point (called from admin.html's tab dispatch)
// ---------------------------------------------------------------------
export function renderVerificationTab() {
  const root = ensureShell();
  if (!root) return;
  loadAll();
}

// A language change re-renders from state already in memory -- no
// refetch, and no lost queue position.
if (typeof document !== 'undefined') {
  document.addEventListener('darwesh:langchange', () => {
    if (!state.mounted) return;
    const queue = document.getElementById('nvQueue');
    const refs = document.getElementById('nvReferrals');
    const cfg = document.getElementById('nvRewardConfig');
    const metrics = document.getElementById('nvMetrics');
    if (metrics && state.metrics) renderMetrics(metrics, state.metrics);
    if (queue && state.cases.length) renderQueue(queue);
    if (refs && state.referrals.length) renderReferrals(refs);
    if (cfg && state.config) renderRewardConfig(cfg);
  });
}
