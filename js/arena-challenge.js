// Darwesh Arena -- Mission-path controller (arena-challenge.html?id=...).
// A TryHackMe-room-style experience: one current mission in focus, a
// ✓/●/🔒 rail beside it. Every transition is a request to the backend
// (advanceArenaStep/attachArenaProperty/createArenaDeal/advanceArenaDealStage)
// -- this module never marks a step complete or awards a point itself.
import { auth } from './firebase-init.js';
import {
  getArenaChallenge, joinArenaChallenge, advanceArenaStep, attachArenaProperty,
  createArenaDeal, advanceArenaDealStage, getMyArenaState, isEndpointUnavailable,
  BackendResponseError,
} from './backend-api.js';
import {
  difficultyMeta, categoryMeta, totalChallengePoints, timeRemainingLabel,
  formatNumber, currentStepKey, stepProgressCounts,
} from './arena-model.js';
import { escapeHtml as esc } from './offer-banner.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

const params = new URLSearchParams(window.location.search);
const challengeId = params.get('id') || '';

const state = {
  user: null,
  challenge: null,
  myState: null,
  loading: true,
  loadError: null,
  focusedStepKey: null, // null = follow the server's currentStepKey
  hintOpen: {},
  busy: false,
  propertySource: 'my_property',
  deal: null, // best-effort local view once a deal is created
};

function root() { return document.getElementById('arMissionRoot'); }

function renderShell(html) {
  const el = root();
  if (el) el.innerHTML = html;
}

// ---------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------
async function load() {
  state.loading = true;
  state.loadError = null;
  render();
  if (!challengeId) {
    state.loading = false;
    state.loadError = tr('arena.challenge.missingId', 'No challenge specified.');
    render();
    return;
  }
  try {
    state.challenge = await getArenaChallenge(state.user, challengeId);
    if (state.user) state.myState = await getMyArenaState(state.user).catch(() => null);
  } catch (err) {
    state.challenge = null;
    if (err instanceof BackendResponseError && err.status === 404) {
      state.loadError = tr('arena.challenge.notFound', 'This challenge does not exist or was removed.');
    } else if (isEndpointUnavailable(err)) {
      state.loadError = tr('arena.errUnavailable', 'Darwesh Arena is not available right now. Please check back soon.');
    } else {
      state.loadError = tr('arena.errGeneric', 'Could not load this challenge right now.');
    }
  }
  state.loading = false;
  render();
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function render() {
  const el = root();
  if (!el) return;
  if (state.loading) { renderShell(`<div class="ar-empty">${esc(tr('arena.loading', 'Loading…'))}</div>`); return; }
  if (state.loadError) { renderShell(`<div class="ar-empty"><span class="material-symbols-outlined">error</span><p>${esc(state.loadError)}</p></div>`); return; }
  const c = state.challenge;
  document.title = `Darwesh Arena — ${c.name || ''}`;
  const sub = c.mySubmission;

  renderShell(`
    ${heroHtml(c, sub)}
    ${sub ? missionBodyHtml(c, sub) : joinScreenHtml(c)}
  `);
  wire();
}

function heroHtml(c, sub) {
  const diff = difficultyMeta(c.difficulty);
  const cat = categoryMeta(c.category);
  const points = totalChallengePoints(c);
  const timeLeft = timeRemainingLabel(c, tr);
  return `
    <div class="ar-mission-hero">
      <div class="ar-mission-hero-media">${c.artworkUrl ? `<img src="${esc(c.artworkUrl)}" alt="">` : ''}</div>
      <div class="ar-mission-hero-body">
        <p class="ar-hero-eyebrow">${esc(tr(cat.key, cat.fallback))} · ${esc(tr(diff.key, diff.fallback))}</p>
        <h1 class="ar-mission-hero-title">${esc(c.name || '')}</h1>
        <p class="ar-mission-detail-desc" style="max-width:70ch;">${esc(c.description || '')}</p>
        <div class="ar-mission-hero-meta">
          <span><strong>${formatNumber(points)}</strong> ${esc(tr('arena.card.pts', 'pts'))}</span>
          ${c.mainPrize ? `<span>🏆 ${esc(c.mainPrize)}</span>` : ''}
          <span>${formatNumber(c.participantCount || 0)} ${esc(tr('arena.card.participants', 'participants'))}</span>
          <span>${esc(timeLeft)}</span>
        </div>
        ${sub ? '' : `<div class="ar-mission-hero-cta"><button type="button" class="ar-btn ar-btn-primary" id="arJoinBtn" ${c.locked ? 'disabled' : ''}>${esc(tr('arena.join', 'Join Challenge'))}</button>${c.locked ? `<span class="ar-form-hint">${esc(tr('arena.locked.generic', 'Requirements not met'))}</span>` : ''}</div>`}
      </div>
    </div>`;
}

function joinScreenHtml(c) {
  if (!state.user) {
    return `
      <div class="ar-mission-detail">
        <p class="ar-mission-detail-eyebrow">${esc(tr('arena.rules.eyebrow', 'Before you join'))}</p>
        <h2 class="ar-mission-detail-title">${esc(tr('arena.signInToJoin', 'Sign in to join this Challenge'))}</h2>
        <a class="ar-btn ar-btn-primary" href="login.html">${esc(tr('arena.signIn', 'Sign In'))}</a>
      </div>`;
  }
  const steps = c.steps || [];
  return `
    <div class="ar-mission-detail">
      <p class="ar-mission-detail-eyebrow">${esc(tr('arena.rules.eyebrow', 'Challenge Rules'))}</p>
      <h2 class="ar-mission-detail-title">${esc(tr('arena.rules.title', 'What this Challenge involves'))}</h2>
      <ul class="ar-complete-checklist" style="margin-bottom:18px;">
        ${steps.map((s) => `<li><span class="material-symbols-outlined" style="font-size:16px;color:var(--ar-gold);">check</span>${esc(s.name)}</li>`).join('')}
      </ul>
      <div class="ar-mission-detail-action">
        <p>${esc(tr('arena.rules.propertyRights', 'Only submit a property you own, or have explicit permission to market on behalf of its owner.'))}</p>
        <p>${esc(tr('arena.rules.noJoinPoints', 'Joining alone does not award points — real value comes from verified properties and completed sales.'))}</p>
      </div>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:16px;font-size:13px;color:var(--ar-cream);">
        <input type="checkbox" id="arAcceptRules" style="margin-top:3px;">
        <span>${esc(tr('arena.rules.accept', 'I have read and accept these Challenge rules.'))}</span>
      </label>
      <button type="button" class="ar-btn ar-btn-primary" id="arJoinBtn2" disabled>${esc(tr('arena.join', 'Join Challenge'))}</button>
      <p class="ar-form-error" id="arJoinError" hidden></p>
    </div>`;
}

function missionBodyHtml(c, sub) {
  if (sub.overallStatus === 'completed' || sub.overallStatus === 'won') {
    return completeScreenHtml(c, sub);
  }
  const steps = c.steps || [];
  const focusKey = state.focusedStepKey || currentStepKey(c, sub);
  const progress = sub.stepProgress || {};
  const { done, total } = stepProgressCounts(c, sub);

  const railItems = steps.map((s) => {
    const status = (progress[s.key] || {}).status || 'locked';
    const isDone = status === 'completed' || status === 'skipped';
    const isCurrent = s.key === focusKey;
    const icon = isDone ? 'check' : (status === 'locked' ? 'lock' : '');
    return `
      <button type="button" class="ar-mission-step${isDone ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}${status === 'locked' ? ' is-locked' : ''}" data-step="${esc(s.key)}">
        <span class="ar-mission-step-icon">${icon ? `<span class="material-symbols-outlined" style="font-size:15px;">${icon}</span>` : ''}</span>
        <span class="ar-mission-step-name">${esc(s.name)}</span>
        ${s.points ? `<span class="ar-mission-step-points">+${s.points}</span>` : ''}
      </button>`;
  }).join('');

  const focusStep = steps.find((s) => s.key === focusKey) || steps[0];
  const focusStatus = (progress[(focusStep || {}).key] || {}).status || 'locked';

  return `
    <p class="ar-form-hint" style="margin-bottom:10px;">${esc(tr('arena.missionProgress', '{done} / {total} required missions complete').replace('{done}', done).replace('{total}', total))}</p>
    <div class="ar-mission-layout">
      <div class="ar-mission-rail">${railItems}</div>
      <div class="ar-mission-detail" id="arDetailPanel">${focusStep ? stepDetailHtml(focusStep, focusStatus, c, sub) : ''}</div>
    </div>
    <div class="ar-sticky-continue" id="arStickyContinue">
      <button type="button" class="ar-btn ar-btn-primary" id="arStickyBtn">${esc(tr('arena.continueMission', 'Continue Mission'))}</button>
    </div>`;
}

function stepDetailHtml(step, status, challenge, submission) {
  const isPropertyStep = !!step.requiredPropertyState;
  const isLocked = status === 'locked';
  const hintOpen = !!state.hintOpen[step.key];

  let actionHtml = '';
  if (isLocked) {
    actionHtml = `<p class="ar-form-hint">${esc(tr('arena.step.locked', 'Complete the previous mission to unlock this one.'))}</p>`;
  } else if (status === 'completed' || status === 'skipped') {
    actionHtml = `<p class="ar-form-hint">✓ ${esc(tr('arena.step.done', 'Completed'))}</p>`;
  } else if (status === 'verification_pending') {
    actionHtml = `<div class="ar-mission-pending"><span class="material-symbols-outlined">hourglass_top</span>${esc(tr('arena.step.pendingReview', 'Pending Admin Review'))}</div>`;
  } else if (isPropertyStep) {
    actionHtml = propertyFormHtml(step);
  } else {
    const label = step.requiredVerificationBy === 'admin'
      ? tr('arena.step.submitForReview', 'Submit for Review')
      : tr('arena.step.markDone', 'Mark as Done');
    actionHtml = `<button type="button" class="ar-btn ar-btn-primary" data-advance-step="${esc(step.key)}" data-target="${step.requiredVerificationBy === 'admin' ? 'verification_pending' : 'completed'}">${esc(label)}</button>
      <p class="ar-form-error" id="arStepError" hidden></p>`;
  }

  const dealPanel = (isPropertyStep === false && submission.listingRef) ? dealPanelHtml(submission) : '';

  return `
    <p class="ar-mission-detail-eyebrow">${esc(tr('arena.currentMission', 'Current Mission'))}</p>
    <h2 class="ar-mission-detail-title">${esc(step.name)}</h2>
    ${step.description ? `<p class="ar-mission-detail-desc">${esc(step.description)}</p>` : ''}
    ${step.requiredAction ? `<p class="ar-mission-detail-action">${esc(step.requiredAction)}</p>` : ''}
    ${actionHtml}
    ${step.hint && step.hint.enabled && step.hint.text ? `
      <div class="ar-hint-toggle">
        <button type="button" id="arHintToggle" data-step="${esc(step.key)}">
          <span class="material-symbols-outlined" style="font-size:15px;">lightbulb</span>
          ${esc(hintOpen ? tr('arena.hint.hide', 'Hide hint') : tr('arena.hint.show', 'Need a hint?'))}
        </button>
        ${hintOpen ? `<div class="ar-hint-body">${esc(step.hint.text)}</div>` : ''}
      </div>` : ''}
    ${dealPanel}
  `;
}

function propertyFormHtml(step) {
  const sources = [
    { v: 'my_property', key: 'arena.source.mine', fallback: 'My Property' },
    { v: 'owner_permission', key: 'arena.source.ownerPermission', fallback: 'Owner Gave Me Permission' },
    { v: 'agency_partner', key: 'arena.source.agencyPartner', fallback: 'Agency / Partner Property' },
  ];
  const needsOwnerInfo = state.propertySource !== 'my_property';
  return `
    <div class="ar-source-options">
      ${sources.map((s) => `
        <label class="ar-source-option${state.propertySource === s.v ? ' is-selected' : ''}">
          <input type="radio" name="arPropSource" value="${s.v}" ${state.propertySource === s.v ? 'checked' : ''}>
          <span>${esc(tr(s.key, s.fallback))}</span>
        </label>`).join('')}
    </div>
    <div class="ar-form-field">
      <label>${esc(tr('arena.form.listingId', 'Existing Darwesh listing ID'))}</label>
      <input type="text" id="arListingId" placeholder="${esc(tr('arena.form.listingIdPlaceholder', 'e.g. from your Sell dashboard'))}">
      <p class="ar-form-hint">${esc(tr('arena.form.listingIdHint', "Don't have one yet?"))} <a href="sell.html" style="color:var(--ar-gold-bright);">${esc(tr('arena.form.listPropertyLink', 'List a property first →'))}</a></p>
    </div>
    <div class="ar-form-field"><label>${esc(tr('arena.form.propertyType', 'Property type'))}</label><input type="text" id="arPropType"></div>
    <div class="ar-form-field"><label>${esc(tr('arena.form.city', 'City'))}</label><input type="text" id="arPropCity"></div>
    <div class="ar-form-field"><label>${esc(tr('arena.form.price', 'Price'))}</label><input type="text" id="arPropPrice"></div>
    <div class="ar-form-field"><label>${esc(tr('arena.form.area', 'Area (sqm)'))}</label><input type="number" id="arPropArea"></div>
    ${needsOwnerInfo ? `
      <div class="ar-form-field"><label>${esc(tr('arena.form.ownerName', "Owner's full name"))}</label><input type="text" id="arOwnerName"></div>
      <div class="ar-form-field"><label>${esc(tr('arena.form.ownerPhone', "Owner's phone"))}</label><input type="text" id="arOwnerPhone"></div>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px;font-size:12.5px;color:var(--ar-muted);">
        <input type="checkbox" id="arConsentGiven" style="margin-top:3px;">
        <span>${esc(tr('arena.form.consent', 'I confirm the owner has given explicit permission to market this property.'))}</span>
      </label>` : ''}
    <button type="button" class="ar-btn ar-btn-primary" id="arSubmitPropertyBtn" data-step="${esc(step.key)}">${esc(tr('arena.form.submitProperty', 'Submit Property'))}</button>
    <p class="ar-form-error" id="arStepError" hidden></p>`;
}

function dealPanelHtml(submission) {
  const buyerInfo = submission.buyerInfo || {};
  const status = buyerInfo.status || 'searching';
  return `
    <div style="margin-top:24px;padding-top:20px;border-top:1px solid var(--ar-outline);">
      <p class="ar-mission-detail-eyebrow">${esc(tr('arena.buyer.eyebrow', 'Buyer Acquisition'))}</p>
      <h3 style="font-size:15px;font-weight:700;margin:.3em 0 10px;">${esc(tr('arena.buyer.title', 'Find a Buyer'))}</h3>
      <p class="ar-form-hint" style="margin-bottom:12px;">${esc(tr('arena.buyer.note', 'Buyer details are private and reviewed by Darwesh Group. Qualification and closing are always admin-verified.'))}</p>
      ${status === 'searching'
        ? `<button type="button" class="ar-btn" id="arCreateDealBtn">${esc(tr('arena.buyer.iHaveBuyer', 'I Have a Buyer'))}</button>`
        : `<p class="ar-form-hint">${esc(tr('arena.buyer.status', 'Status'))}: <strong style="color:var(--ar-gold-bright);">${esc(status)}</strong></p>`}
    </div>`;
}

function completeScreenHtml(c, sub) {
  const bonus = (c.completionReward && c.completionReward.points) || 0;
  const stepPoints = (c.steps || []).reduce((sum, s) => {
    const p = (sub.stepProgress || {})[s.key];
    return sum + (p && p.pointsAwarded ? (s.points || 0) : 0);
  }, 0);
  const badge = c.completionReward && c.completionReward.badge;
  return `
    <div class="ar-complete">
      <p class="ar-complete-badge">${esc(tr('arena.complete.eyebrow', 'Mission Complete'))}</p>
      <h2 class="ar-complete-title">${esc(c.name || '')}</h2>
      <ul class="ar-complete-checklist">
        ${(c.steps || []).map((s) => `<li><span class="material-symbols-outlined" style="font-size:16px;color:var(--ar-ok);">check_circle</span>${esc(s.name)}</li>`).join('')}
      </ul>
      <div class="ar-complete-points">
        <div class="ar-complete-points-row"><span>${esc(tr('arena.complete.stepPoints', 'Mission Points'))}</span><span>+${formatNumber(stepPoints)}</span></div>
        ${bonus ? `<div class="ar-complete-points-row"><span>${esc(tr('arena.complete.bonus', 'Completion Bonus'))}</span><span>+${formatNumber(bonus)}</span></div>` : ''}
        <div class="ar-complete-points-row is-total"><span>${esc(tr('arena.complete.total', 'Total Earned'))}</span><span>+${formatNumber(stepPoints + bonus)}</span></div>
      </div>
      ${badge ? `<div class="ar-complete-badge-earned">🏅 ${esc(badge.name)}</div>` : ''}
      <div class="ar-complete-rank">
        ${state.myState ? `
          <p style="font-weight:700;">${esc(state.myState.currentRankName || '')}</p>
          ${state.myState.nextRankName ? `<p class="ar-form-hint">${esc(tr('arena.xpToNext', '{n} XP to {rank}').replace('{n}', formatNumber(state.myState.xpToNextRank || 0)).replace('{rank}', state.myState.nextRankName))}</p>` : ''}
        ` : ''}
      </div>
      <div style="margin-top:22px;"><a class="ar-btn ar-btn-primary" href="arena.html">${esc(tr('arena.complete.backToArena', 'Back to Arena'))}</a></div>
    </div>`;
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
function setError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}

function describeErr(err) {
  if (err instanceof BackendResponseError) return err.message;
  return tr('arena.errGeneric', 'Something went wrong. Please try again.');
}

async function withBusy(btn, fn) {
  if (state.busy) return;
  state.busy = true;
  if (btn) { btn.disabled = true; }
  try { await fn(); } finally { state.busy = false; if (btn) btn.disabled = false; }
}

function wire() {
  document.querySelectorAll('[data-step]').forEach((btn) => {
    if (btn.tagName === 'BUTTON' && btn.classList.contains('ar-mission-step')) {
      btn.addEventListener('click', () => { state.focusedStepKey = btn.dataset.step; render(); });
    }
  });

  const joinBtn = document.getElementById('arJoinBtn');
  if (joinBtn) joinBtn.addEventListener('click', () => doJoin());

  const acceptCb = document.getElementById('arAcceptRules');
  const joinBtn2 = document.getElementById('arJoinBtn2');
  if (acceptCb && joinBtn2) {
    acceptCb.addEventListener('change', () => { joinBtn2.disabled = !acceptCb.checked; });
    joinBtn2.addEventListener('click', () => doJoin(joinBtn2));
  }

  document.querySelectorAll('[data-advance-step]').forEach((btn) => {
    btn.addEventListener('click', () => withBusy(btn, async () => {
      setError('arStepError', '');
      try {
        await advanceArenaStep(state.user, state.challenge.mySubmission.id, btn.dataset.advanceStep, { targetStatus: btn.dataset.target });
        await load();
      } catch (err) { setError('arStepError', describeErr(err)); }
    }));
  });

  const submitPropBtn = document.getElementById('arSubmitPropertyBtn');
  if (submitPropBtn) submitPropBtn.addEventListener('click', () => withBusy(submitPropBtn, async () => {
    setError('arStepError', '');
    const listingId = (document.getElementById('arListingId')?.value || '').trim();
    if (!listingId) { setError('arStepError', tr('arena.form.listingIdRequired', 'Enter an existing listing ID.')); return; }
    const ownerInfo = state.propertySource !== 'my_property' ? {
      ownerFullName: document.getElementById('arOwnerName')?.value || '',
      ownerPhone: document.getElementById('arOwnerPhone')?.value || '',
    } : null;
    if (ownerInfo && !document.getElementById('arConsentGiven')?.checked) {
      setError('arStepError', tr('arena.form.consentRequired', 'Please confirm owner consent before submitting.'));
      return;
    }
    try {
      await attachArenaProperty(state.user, state.challenge.mySubmission.id, {
        stepKey: submitPropBtn.dataset.step,
        listingRef: { collection: 'listings', id: listingId },
        displayFields: {
          propertyType: document.getElementById('arPropType')?.value || '',
          city: document.getElementById('arPropCity')?.value || '',
          priceDisplay: document.getElementById('arPropPrice')?.value || '',
          areaSqm: Number(document.getElementById('arPropArea')?.value) || null,
        },
        propertySource: state.propertySource,
        ownerInfo,
      });
      await load();
    } catch (err) { setError('arStepError', describeErr(err)); }
  }));

  document.querySelectorAll('input[name="arPropSource"]').forEach((r) => {
    r.addEventListener('change', () => { state.propertySource = r.value; render(); });
  });

  const hintBtn = document.getElementById('arHintToggle');
  if (hintBtn) hintBtn.addEventListener('click', () => {
    const key = hintBtn.dataset.step;
    state.hintOpen[key] = !state.hintOpen[key];
    render();
  });

  const dealBtn = document.getElementById('arCreateDealBtn');
  if (dealBtn) dealBtn.addEventListener('click', () => withBusy(dealBtn, async () => {
    try {
      await createArenaDeal(state.user, state.challenge.mySubmission.id);
      await advanceArenaDealStage(state.user, state.challenge.mySubmission.id, {}).catch(() => {});
      await load();
    } catch (err) { window.alert(describeErr(err)); }
  }));

  const stickyBtn = document.getElementById('arStickyBtn');
  const sticky = document.getElementById('arStickyContinue');
  if (stickyBtn && sticky) {
    stickyBtn.addEventListener('click', () => {
      document.getElementById('arDetailPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // Sticky Continue only appears once the inline mission detail has
    // scrolled out of view on a phone -- desktop never needs it (the
    // detail panel is always on-screen beside the rail).
    const panel = document.getElementById('arDetailPanel');
    if (panel && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(([entry]) => {
        sticky.classList.toggle('is-visible', window.innerWidth <= 900 && !entry.isIntersecting);
      }, { threshold: 0.1 });
      io.observe(panel);
    }
  }
}

async function doJoin(btn) {
  await withBusy(btn, async () => {
    setError('arJoinError', '');
    try {
      await joinArenaChallenge(state.user, challengeId);
      await load();
    } catch (err) { setError('arJoinError', describeErr(err)); }
  });
}

// ---------------------------------------------------------------------
auth.onAuthStateChanged((user) => {
  state.user = user;
  load();
});

document.addEventListener('darwesh:langchange', render);
