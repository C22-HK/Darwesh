// Admin Panel -- Darwesh Arena (Challenge Builder, review queues, ledger,
// rank/commission config, commercial dashboard). Same lazy-init-on-
// first-click pattern as js/admin-offers.js/js/admin-verification.js, but
// EVERY write here goes through js/backend-api.js -- firestore.rules make
// every Arena collection `allow write: if false` for every client SDK
// caller, admin sessions included, so there is no direct-Firestore path
// the way admin-offers.js has for `offers`.
import { auth } from './firebase-init.js';
import {
  listArenaChallenges, createArenaChallenge, updateArenaChallenge, setArenaChallengeStatus, deleteArenaChallenge,
  listArenaSubmissionsForReview, verifyArenaStep, disqualifyArenaParticipant, flagArenaSubmission,
  listArenaLedgerAdmin, adjustArenaPoints, listArenaRanks, createArenaRank, updateArenaRank,
  listArenaDealsAdmin, verifyArenaDealStage, setArenaDealPaymentState,
  listArenaCommissionRules, setArenaCommissionRule, getArenaCommercialSummary,
  BackendResponseError, isEndpointUnavailable,
} from './backend-api.js';
import { escapeHtml as esc } from './offer-banner.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function toast(msg, variant) { if (window.AdminShellToast) window.AdminShellToast(msg, variant || 'success'); }
function user() { return auth.currentUser; }

const SUB_TABS = [
  { key: 'challenges', label: () => tr('admin.arena.tabChallenges', 'Challenges') },
  { key: 'submissions', label: () => tr('admin.arena.tabSubmissions', 'Submission Review') },
  { key: 'deals', label: () => tr('admin.arena.tabDeals', 'Buyer / Deal CRM') },
  { key: 'ledger', label: () => tr('admin.arena.tabLedger', 'Ledger & Points') },
  { key: 'ranks', label: () => tr('admin.arena.tabRanks', 'Ranks') },
  { key: 'commission', label: () => tr('admin.arena.tabCommission', 'Commission Rules') },
  { key: 'dashboard', label: () => tr('admin.arena.tabDashboard', 'Commercial Dashboard') },
];

const state = {
  mounted: false,
  subTab: 'challenges',
  challenges: [],
  challengesLoaded: false,
  editingChallenge: null, // working copy, or null
  editingChallengeId: null,
  submissions: [],
  submissionFilter: '',
  deals: [],
  dealFilter: '',
  ledger: [],
  ranks: [],
  ranksLoaded: false,
  editingRank: null,
  editingRankId: null,
  commissionRules: [],
  dashboardChallengeId: '',
  dashboardSummary: null,
};

function panel() { return document.getElementById('tab-arena'); }

function ensureShell() {
  const root = panel();
  if (!root || state.mounted) return root;
  root.innerHTML = `
    <div class="ash-offers">
      <div class="ash-offers-head">
        <div>
          <p class="font-headline-md text-[22px] text-on-surface font-bold" data-i18n="admin.arena.title">Darwesh Arena</p>
          <p class="font-body-md text-[12.5px] text-on-surface-variant mt-1" data-i18n="admin.arena.subtitle">The Step Engine, buyer/deal CRM, points ledger, ranks, commission rules and commercial analytics -- every write here is server-authoritative and audited.</p>
        </div>
      </div>
      <div id="arenaSubTabs" style="display:flex;gap:8px;flex-wrap:wrap;margin:16px 0;"></div>
      <div id="arenaSubPanel"></div>
    </div>`;
  state.mounted = true;
  return root;
}

async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return fn();
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = tr('admin.arena.working', 'Working…');
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = prev; }
}

function describeError(err) {
  if (err instanceof BackendResponseError) return err.message;
  if (isEndpointUnavailable(err)) return tr('admin.arena.errUnavailable', 'The Arena backend is not deployed in this environment yet.');
  return tr('admin.arena.errGeneric', 'Something went wrong. Please try again.');
}

function renderSubTabs() {
  const el = document.getElementById('arenaSubTabs');
  if (!el) return;
  el.innerHTML = SUB_TABS.map((t) => `
    <button type="button" class="ash-detail-btn${state.subTab === t.key ? ' ash-detail-btn-primary' : ''}" data-arena-subtab="${t.key}">${esc(t.label())}</button>
  `).join('');
  el.querySelectorAll('[data-arena-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => { state.subTab = btn.dataset.arenaSubtab; renderSubTabs(); renderSubPanel(); });
  });
}

function renderSubPanel() {
  const el = document.getElementById('arenaSubPanel');
  if (!el) return;
  if (state.subTab === 'challenges') return renderChallengesTab(el);
  if (state.subTab === 'submissions') return renderSubmissionsTab(el);
  if (state.subTab === 'deals') return renderDealsTab(el);
  if (state.subTab === 'ledger') return renderLedgerTab(el);
  if (state.subTab === 'ranks') return renderRanksTab(el);
  if (state.subTab === 'commission') return renderCommissionTab(el);
  if (state.subTab === 'dashboard') return renderDashboardTab(el);
}

// =====================================================================
// Challenges + Step Builder
// =====================================================================
const VERIFICATION_OPTIONS = ['none', 'admin'];
const CATEGORY_OPTIONS = ['residential', 'commercial', 'land', 'projects', 'city', 'special', 'partner'];
const DIFFICULTY_OPTIONS = ['easy', 'medium', 'hard', 'elite', 'legendary'];
const STATUS_OPTIONS = ['draft', 'scheduled', 'live', 'paused', 'ended', 'archived'];

function newChallengeDraft() {
  return {
    name: '', description: '', artworkUrl: '', category: 'residential', difficulty: 'medium', status: 'draft',
    startDate: null, endDate: null, mainPrize: '', bonusReward: '', rewardsPreview: '',
    durationDays: 90, prizePool: null, revenueTarget: null, closedSalesTarget: null, closedVolumeTarget: null,
    maxParticipants: null,
    steps: [
      { key: 'join', name: 'Join', description: '', requiredAction: 'Accept the challenge rules', requiredVerificationBy: 'none', requiredPropertyState: null, points: 0, optional: false, unlockAfterStepKey: null, hint: { enabled: false, text: '' }, reward: '' },
    ],
    completionReward: { points: 0, badge: null, certificate: false, rankBonusXp: 0 },
    unlockRequirements: { minXp: null, minRankOrder: null, prerequisiteChallengeIds: [], verifiedAccountRequired: false, cities: [], accountTypes: [], minPreviousSales: null },
  };
}

async function loadChallenges() {
  try {
    const data = await listArenaChallenges(user());
    state.challenges = data.challenges || [];
  } catch (err) {
    state.challenges = [];
    toast(describeError(err), 'error');
  }
  state.challengesLoaded = true;
}

function challengeRowHtml(c) {
  return `
    <tr>
      <td>${esc(c.name || '')}</td>
      <td><span class="badge badge-pending">${esc(c.effectiveState || c.status)}</span></td>
      <td>${c.participantCount || 0}</td>
      <td>${c.completedCount || 0}</td>
      <td>
        <button type="button" class="ash-detail-btn" data-edit-challenge="${esc(c.id)}">${esc(tr('admin.arena.edit', 'Edit'))}</button>
        <button type="button" class="ash-detail-btn" data-status-challenge="${esc(c.id)}" data-status="${c.status === 'live' ? 'paused' : 'live'}">${esc(c.status === 'live' ? tr('admin.arena.pause', 'Pause') : tr('admin.arena.publish', 'Publish'))}</button>
        <button type="button" class="ash-detail-btn" data-status-challenge="${esc(c.id)}" data-status="archived">${esc(tr('admin.arena.archive', 'Archive'))}</button>
        <button type="button" class="ash-detail-btn ash-detail-btn-danger" data-delete-challenge="${esc(c.id)}">${esc(tr('admin.arena.delete', 'Delete'))}</button>
      </td>
    </tr>`;
}

async function renderChallengesTab(el) {
  if (!state.challengesLoaded) { el.innerHTML = `<p>${esc(tr('admin.arena.loading', 'Loading…'))}</p>`; await loadChallenges(); }
  if (state.editingChallenge) { renderChallengeEditor(el); return; }
  el.innerHTML = `
    <div style="margin-bottom:12px;"><button type="button" class="ash-detail-btn ash-detail-btn-primary" id="arenaNewChallengeBtn">+ ${esc(tr('admin.arena.newChallenge', 'New Challenge'))}</button></div>
    ${state.challenges.length ? `
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="admin-table">
          <thead><tr><th>${esc(tr('admin.arena.thName', 'Name'))}</th><th>${esc(tr('admin.arena.thStatus', 'Status'))}</th><th>${esc(tr('admin.arena.thParticipants', 'Participants'))}</th><th>${esc(tr('admin.arena.thCompleted', 'Completed'))}</th><th>${esc(tr('admin.arena.thActions', 'Actions'))}</th></tr></thead>
          <tbody>${state.challenges.map(challengeRowHtml).join('')}</tbody>
        </table></div>
      </div>` : `<div class="ash-empty-state"><p class="ash-empty-title">${esc(tr('admin.arena.noChallenges', 'No challenges yet'))}</p></div>`}
  `;
  document.getElementById('arenaNewChallengeBtn')?.addEventListener('click', () => {
    state.editingChallengeId = null;
    state.editingChallenge = newChallengeDraft();
    renderSubPanel();
  });
  el.querySelectorAll('[data-edit-challenge]').forEach((b) => b.addEventListener('click', () => {
    const c = state.challenges.find((x) => x.id === b.dataset.editChallenge);
    if (!c) return;
    state.editingChallengeId = c.id;
    state.editingChallenge = JSON.parse(JSON.stringify(c));
    renderSubPanel();
  }));
  el.querySelectorAll('[data-status-challenge]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
    try {
      await setArenaChallengeStatus(user(), b.dataset.statusChallenge, b.dataset.status);
      toast(tr('admin.arena.saved', 'Saved.'));
      state.challengesLoaded = false;
      await loadChallenges();
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  })));
  el.querySelectorAll('[data-delete-challenge]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
    if (!window.confirm(tr('admin.arena.confirmDelete', 'Delete this challenge? Only possible while it has zero participants.'))) return;
    try {
      await deleteArenaChallenge(user(), b.dataset.deleteChallenge);
      toast(tr('admin.arena.deleted', 'Deleted.'));
      state.challengesLoaded = false;
      await loadChallenges();
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  })));
}

function stepCardHtml(step, idx, total) {
  return `
    <div class="ar-admin-step-card" data-step-idx="${idx}">
      <div class="ar-admin-step-head">
        <strong>${esc(tr('admin.arena.stepN', 'Step {n}').replace('{n}', idx + 1))}</strong>
        <div>
          <button type="button" class="ash-detail-btn" data-step-move="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="ash-detail-btn" data-step-move="down" data-idx="${idx}" ${idx === total - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="ash-detail-btn ash-detail-btn-danger" data-step-remove="${idx}" ${total <= 1 ? 'disabled' : ''}>${esc(tr('admin.arena.remove', 'Remove'))}</button>
        </div>
      </div>
      <div class="ar-admin-step-grid">
        <label class="block"><span class="admin-label">${esc(tr('admin.arena.stepKey', 'Key (unique id)'))}</span><input class="admin-input" data-step-field="key" data-idx="${idx}" value="${esc(step.key || '')}"></label>
        <label class="block"><span class="admin-label">${esc(tr('admin.arena.stepName', 'Name'))}</span><input class="admin-input" data-step-field="name" data-idx="${idx}" value="${esc(step.name || '')}"></label>
        <label class="block"><span class="admin-label">${esc(tr('admin.arena.stepPoints', 'Points'))}</span><input class="admin-input" type="number" data-step-field="points" data-idx="${idx}" value="${esc(String(step.points ?? 0))}"></label>
        <label class="block"><span class="admin-label">${esc(tr('admin.arena.stepVerification', 'Verification'))}</span>
          <select class="admin-input" data-step-field="requiredVerificationBy" data-idx="${idx}">
            ${VERIFICATION_OPTIONS.map((v) => `<option value="${v}"${step.requiredVerificationBy === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </label>
        <label class="block"><span class="admin-label">${esc(tr('admin.arena.stepUnlockAfter', 'Unlocks after step key'))}</span><input class="admin-input" data-step-field="unlockAfterStepKey" data-idx="${idx}" value="${esc(step.unlockAfterStepKey || '')}" placeholder="${esc(tr('admin.arena.firstStepHint', 'blank = first step'))}"></label>
        <label class="block"><span class="admin-label">${esc(tr('admin.arena.stepPropertyState', 'Required property state (optional)'))}</span><input class="admin-input" data-step-field="requiredPropertyState" data-idx="${idx}" value="${esc(step.requiredPropertyState || '')}" placeholder="${esc(tr('admin.arena.propertyStateHint', 'set to render the property-submission form'))}"></label>
        <label class="block" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" data-step-field="optional" data-idx="${idx}" ${step.optional ? 'checked' : ''}><span class="admin-label">${esc(tr('admin.arena.stepOptional', 'Optional'))}</span></label>
        <label class="block" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" data-step-field="hintEnabled" data-idx="${idx}" ${step.hint && step.hint.enabled ? 'checked' : ''}><span class="admin-label">${esc(tr('admin.arena.stepHintEnabled', 'Hint enabled'))}</span></label>
      </div>
      <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.stepDescription', 'Description'))}</span><textarea class="ash-detail-textarea" rows="2" data-step-field="description" data-idx="${idx}">${esc(step.description || '')}</textarea></label>
      <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.stepRequiredAction', 'Required action (shown to participant)'))}</span><textarea class="ash-detail-textarea" rows="2" data-step-field="requiredAction" data-idx="${idx}">${esc(step.requiredAction || '')}</textarea></label>
      <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.stepHintText', 'Hint text'))}</span><textarea class="ash-detail-textarea" rows="2" data-step-field="hintText" data-idx="${idx}">${esc((step.hint && step.hint.text) || '')}</textarea></label>
    </div>`;
}

function renderChallengeEditor(el) {
  const c = state.editingChallenge;
  el.innerHTML = `
    <div class="ash-offers-head">
      <p class="font-headline-md text-[17px] text-on-surface font-bold">${esc(state.editingChallengeId ? tr('admin.arena.editChallenge', 'Edit Challenge') : tr('admin.arena.newChallenge', '+ New Challenge'))}</p>
      <button type="button" class="ash-detail-btn" id="arenaCancelEditBtn">${esc(tr('admin.arena.cancel', 'Cancel'))}</button>
    </div>

    <div class="ar-admin-step-grid" style="margin-bottom:12px;">
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fName', 'Name'))}</span><input class="admin-input" id="cfName" value="${esc(c.name)}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fCategory', 'Category'))}</span><select class="admin-input" id="cfCategory">${CATEGORY_OPTIONS.map((v) => `<option value="${v}"${c.category === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fDifficulty', 'Difficulty'))}</span><select class="admin-input" id="cfDifficulty">${DIFFICULTY_OPTIONS.map((v) => `<option value="${v}"${c.difficulty === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fStatus', 'Status'))}</span><select class="admin-input" id="cfStatus">${STATUS_OPTIONS.map((v) => `<option value="${v}"${c.status === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fArtwork', 'Artwork URL'))}</span><input class="admin-input" id="cfArtwork" value="${esc(c.artworkUrl || '')}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fMaxParticipants', 'Max participants (optional)'))}</span><input class="admin-input" type="number" id="cfMaxParticipants" value="${c.maxParticipants ?? ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fStartDate', 'Start date'))}</span><input class="admin-input" type="date" id="cfStart" value="${c.startDate ? String(c.startDate).slice(0, 10) : ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fEndDate', 'End date'))}</span><input class="admin-input" type="date" id="cfEnd" value="${c.endDate ? String(c.endDate).slice(0, 10) : ''}"></label>
    </div>
    <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fDescription', 'Description'))}</span><textarea class="ash-detail-textarea" rows="3" id="cfDescription">${esc(c.description || '')}</textarea></label>

    <p class="ash-detail-section-title" style="margin-top:20px;">${esc(tr('admin.arena.businessTargets', 'Business Targets (illustrative -- shown on the commercial dashboard)'))}</p>
    <div class="ar-admin-dashboard-grid">
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fDuration', 'Duration (days)'))}</span><input class="admin-input" type="number" id="cfDuration" value="${c.durationDays ?? ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fPrizePool', 'Prize pool ($)'))}</span><input class="admin-input" type="number" id="cfPrizePool" value="${c.prizePool ?? ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fRevenueTarget', 'Revenue target ($)'))}</span><input class="admin-input" type="number" id="cfRevenueTarget" value="${c.revenueTarget ?? ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fClosedSalesTarget', 'Closed sales target'))}</span><input class="admin-input" type="number" id="cfClosedSalesTarget" value="${c.closedSalesTarget ?? ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fClosedVolumeTarget', 'Closed volume target ($)'))}</span><input class="admin-input" type="number" id="cfClosedVolumeTarget" value="${c.closedVolumeTarget ?? ''}"></label>
    </div>

    <p class="ash-detail-section-title" style="margin-top:20px;">${esc(tr('admin.arena.rewards', 'Rewards'))}</p>
    <div class="ar-admin-dashboard-grid">
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fMainPrize', 'Main prize'))}</span><input class="admin-input" id="cfMainPrize" value="${esc(c.mainPrize || '')}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fBonusReward', 'Bonus reward'))}</span><input class="admin-input" id="cfBonusReward" value="${esc(c.bonusReward || '')}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fCompletionPoints', 'Completion bonus points'))}</span><input class="admin-input" type="number" id="cfCompletionPoints" value="${(c.completionReward && c.completionReward.points) ?? 0}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fBadgeId', 'Badge id'))}</span><input class="admin-input" id="cfBadgeId" value="${esc((c.completionReward && c.completionReward.badge && c.completionReward.badge.id) || '')}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fBadgeName', 'Badge name'))}</span><input class="admin-input" id="cfBadgeName" value="${esc((c.completionReward && c.completionReward.badge && c.completionReward.badge.name) || '')}"></label>
    </div>

    <p class="ash-detail-section-title" style="margin-top:20px;">${esc(tr('admin.arena.unlockRequirements', 'Unlock Requirements (leave blank for none)'))}</p>
    <div class="ar-admin-dashboard-grid">
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fMinXp', 'Minimum XP'))}</span><input class="admin-input" type="number" id="cfMinXp" value="${(c.unlockRequirements && c.unlockRequirements.minXp) ?? ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fMinRankOrder', 'Minimum rank order'))}</span><input class="admin-input" type="number" id="cfMinRankOrder" value="${(c.unlockRequirements && c.unlockRequirements.minRankOrder) ?? ''}"></label>
      <label class="block"><span class="admin-label">${esc(tr('admin.arena.fMinPreviousSales', 'Minimum previous sales'))}</span><input class="admin-input" type="number" id="cfMinPreviousSales" value="${(c.unlockRequirements && c.unlockRequirements.minPreviousSales) ?? ''}"></label>
      <label class="block" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="cfVerifiedRequired" ${c.unlockRequirements && c.unlockRequirements.verifiedAccountRequired ? 'checked' : ''}><span class="admin-label">${esc(tr('admin.arena.fVerifiedRequired', 'Verified account required'))}</span></label>
    </div>

    <p class="ash-detail-section-title" style="margin-top:20px;">${esc(tr('admin.arena.stepEngine', 'Step Engine -- the Challenge\'s mission path'))}</p>
    <div class="ar-admin-steps" id="cfSteps">${c.steps.map((s, i) => stepCardHtml(s, i, c.steps.length)).join('')}</div>
    <button type="button" class="ash-detail-btn" id="arenaAddStepBtn">+ ${esc(tr('admin.arena.addStep', 'Add Step'))}</button>

    <div style="margin-top:22px;display:flex;gap:10px;align-items:center;">
      <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="arenaSaveChallengeBtn">${esc(tr('admin.arena.save', 'Save'))}</button>
      <span id="arenaChallengeSaveHint" class="ash-offer-hint"></span>
    </div>
  `;
  wireChallengeEditor(el);
}

function readStepFieldsFromDom() {
  const cards = document.querySelectorAll('#cfSteps [data-step-idx]');
  const c = state.editingChallenge;
  cards.forEach((card) => {
    const idx = Number(card.dataset.stepIdx);
    const step = c.steps[idx];
    if (!step) return;
    card.querySelectorAll('[data-step-field]').forEach((f) => {
      const field = f.dataset.stepField;
      if (field === 'points') step.points = Number(f.value) || 0;
      else if (field === 'optional') step.optional = f.checked;
      else if (field === 'hintEnabled') { step.hint = step.hint || { enabled: false, text: '' }; step.hint.enabled = f.checked; }
      else if (field === 'hintText') { step.hint = step.hint || { enabled: false, text: '' }; step.hint.text = f.value; }
      else if (field === 'unlockAfterStepKey') step.unlockAfterStepKey = f.value.trim() || null;
      else if (field === 'requiredPropertyState') step.requiredPropertyState = f.value.trim() || null;
      else step[field] = f.value;
    });
  });
}

function wireChallengeEditor(el) {
  document.getElementById('arenaCancelEditBtn')?.addEventListener('click', () => {
    state.editingChallenge = null; state.editingChallengeId = null; renderSubPanel();
  });
  document.getElementById('arenaAddStepBtn')?.addEventListener('click', () => {
    readStepFieldsFromDom();
    state.editingChallenge.steps.push({
      key: '', name: '', description: '', requiredAction: '', requiredVerificationBy: 'none',
      requiredPropertyState: null, points: 0, optional: false, unlockAfterStepKey: null,
      hint: { enabled: false, text: '' }, reward: '',
    });
    renderChallengeEditor(el);
  });
  el.querySelectorAll('[data-step-remove]').forEach((b) => b.addEventListener('click', () => {
    readStepFieldsFromDom();
    const idx = Number(b.dataset.stepRemove);
    state.editingChallenge.steps.splice(idx, 1);
    renderChallengeEditor(el);
  }));
  el.querySelectorAll('[data-step-move]').forEach((b) => b.addEventListener('click', () => {
    readStepFieldsFromDom();
    const idx = Number(b.dataset.idx);
    const dir = b.dataset.stepMove === 'up' ? -1 : 1;
    const steps = state.editingChallenge.steps;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= steps.length) return;
    [steps[idx], steps[swapIdx]] = [steps[swapIdx], steps[idx]];
    renderChallengeEditor(el);
  }));

  document.getElementById('arenaSaveChallengeBtn')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    readStepFieldsFromDom();
    const c = state.editingChallenge;
    const v = (id) => document.getElementById(id)?.value ?? '';
    const payload = {
      name: v('cfName'), description: v('cfDescription'), artworkUrl: v('cfArtwork'),
      category: v('cfCategory'), difficulty: v('cfDifficulty'), status: v('cfStatus'),
      startDate: v('cfStart') ? new Date(v('cfStart')).toISOString() : null,
      endDate: v('cfEnd') ? new Date(v('cfEnd')).toISOString() : null,
      maxParticipants: v('cfMaxParticipants') ? Number(v('cfMaxParticipants')) : null,
      durationDays: v('cfDuration') ? Number(v('cfDuration')) : null,
      prizePool: v('cfPrizePool') ? Number(v('cfPrizePool')) : null,
      revenueTarget: v('cfRevenueTarget') ? Number(v('cfRevenueTarget')) : null,
      closedSalesTarget: v('cfClosedSalesTarget') ? Number(v('cfClosedSalesTarget')) : null,
      closedVolumeTarget: v('cfClosedVolumeTarget') ? Number(v('cfClosedVolumeTarget')) : null,
      mainPrize: v('cfMainPrize'), bonusReward: v('cfBonusReward'), rewardsPreview: c.rewardsPreview || '',
      steps: c.steps,
      completionReward: {
        points: Number(v('cfCompletionPoints')) || 0,
        badge: v('cfBadgeId') ? { id: v('cfBadgeId'), name: v('cfBadgeName') } : null,
        certificate: !!(c.completionReward && c.completionReward.certificate),
        rankBonusXp: (c.completionReward && c.completionReward.rankBonusXp) || 0,
      },
      unlockRequirements: {
        minXp: v('cfMinXp') ? Number(v('cfMinXp')) : null,
        minRankOrder: v('cfMinRankOrder') ? Number(v('cfMinRankOrder')) : null,
        minPreviousSales: v('cfMinPreviousSales') ? Number(v('cfMinPreviousSales')) : null,
        verifiedAccountRequired: !!document.getElementById('cfVerifiedRequired')?.checked,
        prerequisiteChallengeIds: (c.unlockRequirements && c.unlockRequirements.prerequisiteChallengeIds) || [],
        cities: (c.unlockRequirements && c.unlockRequirements.cities) || [],
        accountTypes: (c.unlockRequirements && c.unlockRequirements.accountTypes) || [],
      },
    };
    const hint = document.getElementById('arenaChallengeSaveHint');
    try {
      if (state.editingChallengeId) {
        await updateArenaChallenge(user(), state.editingChallengeId, payload);
      } else {
        await createArenaChallenge(user(), payload);
      }
      toast(tr('admin.arena.saved', 'Saved.'));
      state.editingChallenge = null; state.editingChallengeId = null;
      state.challengesLoaded = false;
      await loadChallenges();
      renderSubPanel();
    } catch (err) {
      if (hint) hint.textContent = describeError(err);
      toast(describeError(err), 'error');
    }
  }));
}

// =====================================================================
// Submission review
// =====================================================================
async function renderSubmissionsTab(el) {
  el.innerHTML = `<p>${esc(tr('admin.arena.loading', 'Loading…'))}</p>`;
  try {
    const data = await listArenaSubmissionsForReview(user(), { status: state.submissionFilter || undefined });
    state.submissions = data.submissions || [];
  } catch (err) {
    state.submissions = [];
    toast(describeError(err), 'error');
  }
  const filters = ['', 'joined', 'in_progress', 'verification_pending', 'completed', 'rejected'];
  el.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      ${filters.map((f) => `<button type="button" class="ash-detail-btn${state.submissionFilter === f ? ' ash-detail-btn-primary' : ''}" data-sub-filter="${f}">${esc(f || tr('admin.arena.all', 'All'))}</button>`).join('')}
    </div>
    ${state.submissions.length ? `
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="admin-table">
          <thead><tr><th>${esc(tr('admin.arena.thParticipant', 'Participant'))}</th><th>${esc(tr('admin.arena.thChallenge', 'Challenge'))}</th><th>${esc(tr('admin.arena.thCurrentStep', 'Current Step'))}</th><th>${esc(tr('admin.arena.thStatus', 'Status'))}</th><th>${esc(tr('admin.arena.thFraud', 'Fraud'))}</th><th>${esc(tr('admin.arena.thActions', 'Actions'))}</th></tr></thead>
          <tbody>${state.submissions.map((s) => `
            <tr>
              <td>${esc(s.participantUid || '')}</td>
              <td>${esc(s.challengeId || '')}</td>
              <td>${esc(s.currentStepKey || '')}</td>
              <td><span class="badge badge-pending">${esc(s.overallStatus || '')}</span></td>
              <td>${(s.fraudFlags || []).length ? `<span class="badge badge-rejected">${(s.fraudFlags || []).length}</span>` : '—'}</td>
              <td>
                <button type="button" class="ash-detail-btn ash-detail-btn-primary" data-verify-step="${esc(s.id)}" data-step="${esc(s.currentStepKey || '')}">${esc(tr('admin.arena.verifyStep', 'Verify Step'))}</button>
                <button type="button" class="ash-detail-btn ash-detail-btn-danger" data-disqualify="${esc(s.id)}">${esc(tr('admin.arena.disqualify', 'Disqualify'))}</button>
              </td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<div class="ash-empty-state"><p class="ash-empty-title">${esc(tr('admin.arena.noSubmissions', 'No submissions'))}</p></div>`}
  `;
  el.querySelectorAll('[data-sub-filter]').forEach((b) => b.addEventListener('click', () => { state.submissionFilter = b.dataset.subFilter; renderSubPanel(); }));
  el.querySelectorAll('[data-verify-step]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
    if (!b.dataset.step) { toast(tr('admin.arena.noCurrentStep', 'No current step to verify.'), 'error'); return; }
    try {
      await verifyArenaStep(user(), b.dataset.verifyStep, b.dataset.step, { targetStatus: 'completed' });
      toast(tr('admin.arena.verified', 'Step verified.'));
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  })));
  el.querySelectorAll('[data-disqualify]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
    const reason = window.prompt(tr('admin.arena.disqualifyReason', 'Reason for disqualification:'));
    if (!reason) return;
    try {
      await disqualifyArenaParticipant(user(), b.dataset.disqualify, reason);
      toast(tr('admin.arena.disqualified', 'Participant disqualified.'));
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  })));
}

// =====================================================================
// Deals / CRM
// =====================================================================
async function renderDealsTab(el) {
  el.innerHTML = `<p>${esc(tr('admin.arena.loading', 'Loading…'))}</p>`;
  try {
    const data = await listArenaDealsAdmin(user(), { stage: state.dealFilter || undefined });
    state.deals = data.deals || [];
  } catch (err) {
    state.deals = [];
    toast(describeError(err), 'error');
  }
  const stages = ['', 'lead', 'contacted', 'qualified', 'matched', 'viewing_scheduled', 'viewing_completed', 'negotiating', 'deal_pending', 'closed', 'lost'];
  const nextStageOf = {
    lead: 'contacted', contacted: 'qualified', qualified: 'matched', matched: 'viewing_scheduled',
    viewing_scheduled: 'viewing_completed', viewing_completed: 'negotiating', negotiating: 'deal_pending', deal_pending: 'closed',
  };
  el.innerHTML = `
    <p class="ash-offer-hint" style="margin-bottom:10px;">${esc(tr('admin.arena.dealsNote', 'Qualification and closing are admin-only by design -- a participant can never self-advance past "contacted."'))}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      ${stages.map((f) => `<button type="button" class="ash-detail-btn${state.dealFilter === f ? ' ash-detail-btn-primary' : ''}" data-deal-filter="${f}">${esc(f || tr('admin.arena.all', 'All'))}</button>`).join('')}
    </div>
    ${state.deals.length ? `
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="admin-table">
          <thead><tr><th>${esc(tr('admin.arena.thParticipant', 'Participant'))}</th><th>${esc(tr('admin.arena.thCity', 'City'))}</th><th>${esc(tr('admin.arena.thStage', 'Stage'))}</th><th>${esc(tr('admin.arena.thSaleValue', 'Sale Value'))}</th><th>${esc(tr('admin.arena.thPayment', 'Payment'))}</th><th>${esc(tr('admin.arena.thActions', 'Actions'))}</th></tr></thead>
          <tbody>${state.deals.map((d) => `
            <tr>
              <td>${esc(d.participantUid || '')}</td>
              <td>${esc(d.city || '')}</td>
              <td><span class="badge badge-pending">${esc(d.stage || '')}</span></td>
              <td>${d.saleValue ? '$' + Number(d.saleValue).toLocaleString() : '—'}</td>
              <td>${esc(d.paymentState || '—')}</td>
              <td>
                ${nextStageOf[d.stage] ? `<button type="button" class="ash-detail-btn ash-detail-btn-primary" data-advance-deal="${esc(d.id)}" data-next="${nextStageOf[d.stage]}">${esc(tr('admin.arena.advanceTo', 'Advance to')) + ' ' + esc(nextStageOf[d.stage])}</button>` : ''}
                ${d.stage === 'closed' && d.paymentState !== 'received' ? `<button type="button" class="ash-detail-btn" data-mark-paid="${esc(d.id)}">${esc(tr('admin.arena.markPaid', 'Mark Paid'))}</button>` : ''}
                <button type="button" class="ash-detail-btn ash-detail-btn-danger" data-advance-deal="${esc(d.id)}" data-next="lost">${esc(tr('admin.arena.markLost', 'Mark Lost'))}</button>
              </td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<div class="ash-empty-state"><p class="ash-empty-title">${esc(tr('admin.arena.noDeals', 'No deals'))}</p></div>`}
  `;
  el.querySelectorAll('[data-deal-filter]').forEach((b) => b.addEventListener('click', () => { state.dealFilter = b.dataset.dealFilter; renderSubPanel(); }));
  el.querySelectorAll('[data-advance-deal]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
    const targetStage = b.dataset.next;
    let saleValue, city;
    if (targetStage === 'closed') {
      saleValue = Number(window.prompt(tr('admin.arena.enterSaleValue', 'Final sale value ($):')) || '');
      city = window.prompt(tr('admin.arena.enterCity', 'City (must match a configured commission rule):')) || '';
      if (!saleValue || !city) { toast(tr('admin.arena.saleValueRequired', 'Sale value and city are required to close a deal.'), 'error'); return; }
    }
    try {
      await verifyArenaDealStage(user(), b.dataset.advanceDeal, { targetStage, saleValue, city });
      toast(tr('admin.arena.saved', 'Saved.'));
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  })));
  el.querySelectorAll('[data-mark-paid]').forEach((b) => b.addEventListener('click', () => withBusy(b, async () => {
    const actual = Number(window.prompt(tr('admin.arena.enterActualCommission', 'Actual commission received ($):')) || '');
    if (!actual) return;
    try {
      await setArenaDealPaymentState(user(), b.dataset.markPaid, { paymentState: 'received', actualCommission: actual });
      toast(tr('admin.arena.saved', 'Saved.'));
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  })));
}

// =====================================================================
// Ledger
// =====================================================================
async function renderLedgerTab(el) {
  el.innerHTML = `<p>${esc(tr('admin.arena.loading', 'Loading…'))}</p>`;
  try {
    const data = await listArenaLedgerAdmin(user(), {});
    state.ledger = data.ledger || [];
  } catch (err) {
    state.ledger = [];
    toast(describeError(err), 'error');
  }
  el.innerHTML = `
    <div class="ash-offer-editor" style="margin-bottom:20px;">
      <div class="ash-offer-form" style="max-width:520px;">
        <p class="ash-detail-section-title">${esc(tr('admin.arena.manualAdjustment', 'Manual Point Adjustment'))}</p>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fUid', 'User ID (uid)'))}</span><input class="admin-input" id="arLedgerUid" style="width:100%;"></label>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fPointsDelta', 'Points delta (+/-)'))}</span><input class="admin-input" type="number" id="arLedgerDelta" style="width:100%;"></label>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fNote', 'Note (required)'))}</span><textarea class="ash-detail-textarea" rows="2" id="arLedgerNote"></textarea></label>
        <label class="block mt-2" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="arLedgerReversal"><span class="admin-label">${esc(tr('admin.arena.fIsReversal', 'This is a fraud reversal'))}</span></label>
        <button type="button" class="ash-detail-btn ash-detail-btn-primary mt-3" id="arLedgerSubmit">${esc(tr('admin.arena.applyAdjustment', 'Apply Adjustment'))}</button>
      </div>
    </div>
    ${state.ledger.length ? `
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="admin-table">
          <thead><tr><th>${esc(tr('admin.arena.thUser', 'User'))}</th><th>${esc(tr('admin.arena.thDelta', 'Delta'))}</th><th>${esc(tr('admin.arena.thReason', 'Reason'))}</th><th>${esc(tr('admin.arena.thNote', 'Note'))}</th></tr></thead>
          <tbody>${state.ledger.map((l) => `<tr><td>${esc(l.uid || '')}</td><td>${l.pointsDelta > 0 ? '+' : ''}${l.pointsDelta}</td><td>${esc(l.reason || '')}</td><td>${esc(l.note || '')}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<div class="ash-empty-state"><p class="ash-empty-title">${esc(tr('admin.arena.noLedgerEntries', 'No ledger entries yet'))}</p></div>`}
  `;
  document.getElementById('arLedgerSubmit')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const uid = document.getElementById('arLedgerUid')?.value.trim();
    const pointsDelta = Number(document.getElementById('arLedgerDelta')?.value);
    const note = document.getElementById('arLedgerNote')?.value.trim();
    const isReversal = !!document.getElementById('arLedgerReversal')?.checked;
    if (!uid || !pointsDelta || !note) { toast(tr('admin.arena.adjustmentFieldsRequired', 'User, points delta and note are all required.'), 'error'); return; }
    try {
      await adjustArenaPoints(user(), { uid, pointsDelta, note, isReversal });
      toast(tr('admin.arena.saved', 'Saved.'));
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  }));
}

// =====================================================================
// Ranks
// =====================================================================
async function loadRanks() {
  try {
    const data = await listArenaRanks();
    state.ranks = (data.ranks || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (err) {
    state.ranks = [];
    toast(describeError(err), 'error');
  }
  state.ranksLoaded = true;
}

function newRankDraft() {
  return { name: '', iconUrl: '', badgeUrl: '', minXp: 0, maxXp: null, order: (state.ranks.length ? state.ranks[state.ranks.length - 1].order + 1 : 1), description: '', enabled: true };
}

async function renderRanksTab(el) {
  if (!state.ranksLoaded) { el.innerHTML = `<p>${esc(tr('admin.arena.loading', 'Loading…'))}</p>`; await loadRanks(); }
  if (state.editingRank) {
    const r = state.editingRank;
    el.innerHTML = `
      <div class="ash-offer-form" style="max-width:520px;">
        <p class="ash-detail-section-title">${esc(state.editingRankId ? tr('admin.arena.editRank', 'Edit Rank') : tr('admin.arena.newRank', '+ New Rank'))}</p>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fName', 'Name'))}</span><input class="admin-input" id="rfName" style="width:100%;" value="${esc(r.name)}"></label>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fOrder', 'Order'))}</span><input class="admin-input" type="number" id="rfOrder" style="width:100%;" value="${r.order}"></label>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fMinXp', 'Minimum XP'))}</span><input class="admin-input" type="number" id="rfMinXp" style="width:100%;" value="${r.minXp}"></label>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fMaxXp', 'Maximum XP (blank = top rank)'))}</span><input class="admin-input" type="number" id="rfMaxXp" style="width:100%;" value="${r.maxXp ?? ''}"></label>
        <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fDescription', 'Description'))}</span><textarea class="ash-detail-textarea" rows="2" id="rfDescription">${esc(r.description || '')}</textarea></label>
        <label class="block mt-2" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="rfEnabled" ${r.enabled ? 'checked' : ''}><span class="admin-label">${esc(tr('admin.arena.fEnabled', 'Enabled'))}</span></label>
        <div style="margin-top:14px;display:flex;gap:8px;">
          <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="rfSave">${esc(tr('admin.arena.save', 'Save'))}</button>
          <button type="button" class="ash-detail-btn" id="rfCancel">${esc(tr('admin.arena.cancel', 'Cancel'))}</button>
        </div>
      </div>`;
    document.getElementById('rfCancel')?.addEventListener('click', () => { state.editingRank = null; renderSubPanel(); });
    document.getElementById('rfSave')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      const payload = {
        name: document.getElementById('rfName')?.value.trim(),
        order: Number(document.getElementById('rfOrder')?.value) || 0,
        minXp: Number(document.getElementById('rfMinXp')?.value) || 0,
        maxXp: document.getElementById('rfMaxXp')?.value ? Number(document.getElementById('rfMaxXp').value) : null,
        description: document.getElementById('rfDescription')?.value || '',
        enabled: !!document.getElementById('rfEnabled')?.checked,
        iconUrl: r.iconUrl || '', badgeUrl: r.badgeUrl || '', privileges: [], visualTreatment: {},
      };
      if (!payload.name) { toast(tr('admin.arena.rankNameRequired', 'Give the rank a name.'), 'error'); return; }
      try {
        if (state.editingRankId) await updateArenaRank(user(), state.editingRankId, payload);
        else await createArenaRank(user(), payload);
        toast(tr('admin.arena.saved', 'Saved.'));
        state.editingRank = null; state.editingRankId = null;
        state.ranksLoaded = false;
        await loadRanks();
        renderSubPanel();
      } catch (err) { toast(describeError(err), 'error'); }
    }));
    return;
  }
  el.innerHTML = `
    <div style="margin-bottom:12px;"><button type="button" class="ash-detail-btn ash-detail-btn-primary" id="arenaNewRankBtn">+ ${esc(tr('admin.arena.newRank', 'New Rank'))}</button></div>
    ${state.ranks.length ? `
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="admin-table">
          <thead><tr><th>${esc(tr('admin.arena.thOrder', 'Order'))}</th><th>${esc(tr('admin.arena.thName', 'Name'))}</th><th>${esc(tr('admin.arena.thMinXp', 'Min XP'))}</th><th>${esc(tr('admin.arena.thMaxXp', 'Max XP'))}</th><th>${esc(tr('admin.arena.thActions', 'Actions'))}</th></tr></thead>
          <tbody>${state.ranks.map((r) => `<tr><td>${r.order}</td><td>${esc(r.name)}</td><td>${r.minXp}</td><td>${r.maxXp ?? '∞'}</td><td><button type="button" class="ash-detail-btn" data-edit-rank="${esc(r.id)}">${esc(tr('admin.arena.edit', 'Edit'))}</button></td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<div class="ash-empty-state"><p class="ash-empty-title">${esc(tr('admin.arena.noRanks', 'No ranks configured yet'))}</p></div>`}
  `;
  document.getElementById('arenaNewRankBtn')?.addEventListener('click', () => { state.editingRankId = null; state.editingRank = newRankDraft(); renderSubPanel(); });
  el.querySelectorAll('[data-edit-rank]').forEach((b) => b.addEventListener('click', () => {
    const r = state.ranks.find((x) => x.id === b.dataset.editRank);
    if (!r) return;
    state.editingRankId = r.id;
    state.editingRank = JSON.parse(JSON.stringify(r));
    renderSubPanel();
  }));
}

// =====================================================================
// Commission rules
// =====================================================================
async function renderCommissionTab(el) {
  el.innerHTML = `<p>${esc(tr('admin.arena.loading', 'Loading…'))}</p>`;
  try {
    const data = await listArenaCommissionRules(user());
    state.commissionRules = data.commissionRules || [];
  } catch (err) {
    state.commissionRules = [];
    toast(describeError(err), 'error');
  }
  el.innerHTML = `
    <p class="ash-offer-hint" style="margin-bottom:12px;">${esc(tr('admin.arena.commissionNote', 'Illustrative example: Erbil ~3%, Sulaymaniyah ~2-3%, Kirkuk ~1-2% -- set your own real figures per city.'))}</p>
    <div class="ash-offer-form" style="max-width:520px;margin-bottom:20px;">
      <p class="ash-detail-section-title">${esc(tr('admin.arena.setCommissionRule', 'Set Commission Rule'))}</p>
      <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fCity', 'City'))}</span><input class="admin-input" id="crCity" style="width:100%;"></label>
      <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fMinPercent', 'Min %'))}</span><input class="admin-input" type="number" id="crMin" style="width:100%;"></label>
      <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fDefaultPercent', 'Default %'))}</span><input class="admin-input" type="number" id="crDefault" style="width:100%;"></label>
      <label class="block mt-2"><span class="admin-label">${esc(tr('admin.arena.fMaxPercent', 'Max %'))}</span><input class="admin-input" type="number" id="crMax" style="width:100%;"></label>
      <button type="button" class="ash-detail-btn ash-detail-btn-primary mt-3" id="crSave">${esc(tr('admin.arena.save', 'Save'))}</button>
    </div>
    ${state.commissionRules.length ? `
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="admin-table">
          <thead><tr><th>${esc(tr('admin.arena.thCity', 'City'))}</th><th>${esc(tr('admin.arena.fMinPercent', 'Min %'))}</th><th>${esc(tr('admin.arena.fDefaultPercent', 'Default %'))}</th><th>${esc(tr('admin.arena.fMaxPercent', 'Max %'))}</th></tr></thead>
          <tbody>${state.commissionRules.map((r) => `<tr><td>${esc(r.city || r.id)}</td><td>${r.minPercent}%</td><td>${r.defaultPercent}%</td><td>${r.maxPercent}%</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<div class="ash-empty-state"><p class="ash-empty-title">${esc(tr('admin.arena.noCommissionRules', 'No commission rules configured yet'))}</p></div>`}
  `;
  document.getElementById('crSave')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const city = document.getElementById('crCity')?.value.trim();
    const minPercent = Number(document.getElementById('crMin')?.value);
    const defaultPercent = Number(document.getElementById('crDefault')?.value);
    const maxPercent = Number(document.getElementById('crMax')?.value);
    if (!city) { toast(tr('admin.arena.cityRequired', 'City is required.'), 'error'); return; }
    try {
      await setArenaCommissionRule(user(), { city, minPercent, maxPercent, defaultPercent });
      toast(tr('admin.arena.saved', 'Saved.'));
      renderSubPanel();
    } catch (err) { toast(describeError(err), 'error'); }
  }));
}

// =====================================================================
// Commercial dashboard
// =====================================================================
async function renderDashboardTab(el) {
  if (!state.challengesLoaded) await loadChallenges();
  el.innerHTML = `
    <label class="block" style="max-width:420px;margin-bottom:16px;">
      <span class="admin-label">${esc(tr('admin.arena.selectChallenge', 'Select Challenge'))}</span>
      <select class="admin-input" id="arDashSelect" style="width:100%;">
        <option value="">${esc(tr('admin.arena.chooseOne', '— choose —'))}</option>
        ${state.challenges.map((c) => `<option value="${esc(c.id)}"${state.dashboardChallengeId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
    </label>
    <div id="arDashMetrics"></div>
  `;
  document.getElementById('arDashSelect')?.addEventListener('change', async (e) => {
    state.dashboardChallengeId = e.target.value;
    await loadDashboardSummary();
    renderDashboardMetrics();
  });
  if (state.dashboardChallengeId) { await loadDashboardSummary(); renderDashboardMetrics(); }
}

async function loadDashboardSummary() {
  if (!state.dashboardChallengeId) { state.dashboardSummary = null; return; }
  try {
    state.dashboardSummary = await getArenaCommercialSummary(user(), state.dashboardChallengeId);
  } catch (err) {
    state.dashboardSummary = null;
    toast(describeError(err), 'error');
  }
}

function metricTile(label, value, target) {
  const pct = target ? Math.min(100, Math.round((Number(value) / Number(target)) * 100)) : null;
  return `
    <div class="ar-admin-metric">
      <div class="ar-admin-metric-label">${esc(label)}</div>
      <div class="ar-admin-metric-value">${value}</div>
      ${target ? `<div class="ar-admin-metric-target">${esc(tr('admin.arena.ofTarget', 'of {target}').replace('{target}', target))}</div><div class="ar-admin-metric-bar"><div class="ar-admin-metric-bar-fill" style="width:${pct}%"></div></div>` : ''}
    </div>`;
}

function renderDashboardMetrics() {
  const el = document.getElementById('arDashMetrics');
  if (!el) return;
  const s = state.dashboardSummary;
  if (!s) { el.innerHTML = `<div class="ash-empty-state"><p class="ash-empty-title">${esc(tr('admin.arena.selectToView', 'Select a challenge to view its commercial dashboard.'))}</p></div>`; return; }
  el.innerHTML = `
    <div class="ar-admin-dashboard-grid">
      ${metricTile(tr('admin.arena.mParticipants', 'Participants'), s.participantCount || 0)}
      ${metricTile(tr('admin.arena.mSubmissions', 'Submissions'), s.totalSubmissions || 0)}
      ${metricTile(tr('admin.arena.mVerified', 'Verified Properties'), s.verifiedProperties || 0)}
      ${metricTile(tr('admin.arena.mRejected', 'Rejected'), s.rejectedProperties || 0)}
      ${metricTile(tr('admin.arena.mFraud', 'Fraud-Flagged'), s.fraudFlaggedSubmissions || 0)}
      ${metricTile(tr('admin.arena.mClosedDeals', 'Closed Deals'), s.closedDeals || 0, s.closedSalesTarget)}
      ${metricTile(tr('admin.arena.mClosedVolume', 'Closed Volume'), '$' + Number(s.closedVolume || 0).toLocaleString(), s.closedVolumeTarget ? '$' + Number(s.closedVolumeTarget).toLocaleString() : null)}
      ${metricTile(tr('admin.arena.mExpectedCommission', 'Expected Commission'), '$' + Number(s.expectedCommission || 0).toLocaleString(), s.revenueTarget ? '$' + Number(s.revenueTarget).toLocaleString() : null)}
      ${metricTile(tr('admin.arena.mActualCommission', 'Actual Commission Received'), '$' + Number(s.actualCommission || 0).toLocaleString())}
      ${metricTile(tr('admin.arena.mPrizePool', 'Prize Pool'), s.prizePool ? '$' + Number(s.prizePool).toLocaleString() : '—')}
      ${s.durationDays ? metricTile(tr('admin.arena.mDuration', 'Duration'), s.durationDays + ' ' + tr('admin.arena.days', 'days')) : ''}
    </div>
    <p class="ash-detail-section-title" style="margin-top:20px;">${esc(tr('admin.arena.topParticipants', 'Top Participants'))}</p>
    ${(s.topParticipants || []).length ? `
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="admin-table">
          <thead><tr><th>${esc(tr('admin.arena.thUser', 'User'))}</th><th>${esc(tr('admin.arena.thSubmissions', 'Submissions'))}</th><th>${esc(tr('admin.arena.thClosedDeals', 'Closed Deals'))}</th></tr></thead>
          <tbody>${s.topParticipants.map((p) => `<tr><td>${esc(p.uid)}</td><td>${p.submissions}</td><td>${p.closedDeals}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<p class="ash-offer-hint">${esc(tr('admin.arena.noData', 'No data yet.'))}</p>`}
  `;
}

// =====================================================================
export function renderArenaTab() {
  ensureShell();
  renderSubTabs();
  renderSubPanel();
}

document.addEventListener('darwesh:langchange', () => {
  if (!state.mounted) return;
  renderSubTabs();
});
