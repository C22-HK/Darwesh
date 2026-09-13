// Darwesh Arena -- Hub controller (arena.html): HTB-style challenge card
// grid + filters, a Global leaderboard with a Top-3 podium, the rank
// ladder, and a signed-in-only "My Progress" tab. Every number here comes
// from the backend's own computed views (GET /api/v1/arena/*) -- this
// module never re-derives locked/unlocked, points totals or rank from
// raw Firestore documents.
import { auth } from './firebase-init.js';
import {
  listArenaChallenges, getArenaLeaderboard, listArenaRanks,
  getMyArenaState, getMyArenaSubmissions, joinArenaChallenge,
  isEndpointUnavailable,
} from './backend-api.js';
import {
  challengeStatusMeta, participationMeta, difficultyMeta, categoryMeta,
  totalChallengePoints, completionRatePct, timeRemainingLabel, formatNumber,
} from './arena-model.js';
import { escapeHtml as esc } from './offer-banner.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

const state = {
  tab: 'challenges',
  statusFilter: 'live', // live | scheduled | ended | '' (all)
  category: '',
  difficulty: '',
  challenges: [],
  loading: true,
  loadError: null,
  leaderboard: [],
  ranks: [],
  myState: null,
  mySubmissions: [],
  user: null,
};

const CATEGORY_CHIPS = ['', ...['residential', 'commercial', 'land', 'projects', 'city', 'special', 'partner']];
const STATUS_CHIPS = [
  { value: 'live', key: 'arena.filter.live', fallback: 'Live' },
  { value: 'scheduled', key: 'arena.filter.upcoming', fallback: 'Upcoming' },
  { value: 'ended', key: 'arena.filter.completed', fallback: 'Completed' },
  { value: '', key: 'arena.filter.all', fallback: 'All' },
];

function initials(name) {
  const s = (name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase();
}

// ---------------------------------------------------------------------
// Tablist
// ---------------------------------------------------------------------
function renderTablist() {
  const el = document.getElementById('arTablist');
  if (!el) return;
  const tabs = [
    { key: 'challenges', label: tr('arena.tab.challenges', 'Challenges') },
    { key: 'leaderboard', label: tr('arena.tab.leaderboard', 'Leaderboard') },
    { key: 'progress', label: tr('arena.tab.myProgress', 'My Progress') },
  ];
  el.innerHTML = tabs.map((t) => `
    <button type="button" class="ar-tab${state.tab === t.key ? ' is-active' : ''}" data-arena-tab="${t.key}">${esc(t.label)}</button>
  `).join('');
  el.querySelectorAll('[data-arena-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { state.tab = btn.dataset.arenaTab; renderAll(); });
  });
}

// ---------------------------------------------------------------------
// Challenges grid + filters
// ---------------------------------------------------------------------
function renderFilters() {
  const el = document.getElementById('arFilters');
  if (!el) return;
  const statusChips = STATUS_CHIPS.map((c) => `
    <button type="button" class="ar-chip${state.statusFilter === c.value ? ' is-active' : ''}" data-status="${esc(c.value)}">${esc(tr(c.key, c.fallback))}</button>
  `).join('');
  const categoryChips = CATEGORY_CHIPS.map((c) => {
    const label = c ? tr(categoryMeta(c).key, categoryMeta(c).fallback) : tr('arena.filter.allCategories', 'All Categories');
    return `<button type="button" class="ar-chip${state.category === c ? ' is-active' : ''}" data-category="${esc(c)}">${esc(label)}</button>`;
  }).join('');
  el.innerHTML = `<div class="ar-filters">${statusChips}</div><div class="ar-filters">${categoryChips}</div>`;
  el.querySelectorAll('[data-status]').forEach((btn) => btn.addEventListener('click', () => { state.statusFilter = btn.dataset.status; renderFilters(); renderGrid(); }));
  el.querySelectorAll('[data-category]').forEach((btn) => btn.addEventListener('click', () => { state.category = btn.dataset.category; renderGrid(); }));
}

function cardStatusBadge(challenge) {
  const mine = participationMeta(challenge.mySubmission);
  if (mine) return { tone: mine.key === 'arena.mystatus.completed' || mine.key === 'arena.mystatus.won' ? 'live' : 'info', label: tr(mine.key, mine.fallback) };
  if (challenge.locked) return { tone: 'muted', label: tr('arena.status.locked', 'Locked') };
  const meta = challengeStatusMeta(challenge);
  return { tone: meta.tone, label: tr(meta.key, meta.fallback) };
}

function challengeCardHtml(c) {
  const badge = cardStatusBadge(c);
  const diff = difficultyMeta(c.difficulty);
  const cat = categoryMeta(c.category);
  const points = totalChallengePoints(c);
  const rate = completionRatePct(c);
  const timeLeft = timeRemainingLabel(c, tr);
  const locked = !!c.locked;
  const myBadge = c.mySubmission
    ? `<span class="ar-card-my-badge">${esc(tr('arena.card.joined', 'Joined'))}</span>` : '';
  const lockedOverlay = locked
    ? `<div class="ar-card-locked-overlay">
        <span class="material-symbols-outlined" style="font-size:26px;">lock</span>
        <span style="font-size:11.5px;max-width:22ch;">${esc(lockedReasonLabel(c.lockedReason))}</span>
      </div>` : '';
  return `
    <a class="ar-card${locked ? ' is-locked' : ''}" href="arena-challenge.html?id=${encodeURIComponent(c.id)}">
      <div class="ar-card-media">
        ${c.artworkUrl ? `<img src="${esc(c.artworkUrl)}" alt="" loading="lazy">` : ''}
        <span class="ar-card-status tone-${badge.tone}">${esc(badge.label)}</span>
        <span class="ar-card-diff">${esc(tr(diff.key, diff.fallback))}</span>
        ${lockedOverlay}
      </div>
      <div class="ar-card-body">
        ${myBadge}
        <p class="ar-card-category">${esc(tr(cat.key, cat.fallback))}</p>
        <h3 class="ar-card-title">${esc(c.name || '')}</h3>
        <div class="ar-card-reward-row">
          <span><strong>${formatNumber(points)}</strong> ${esc(tr('arena.card.pts', 'pts'))}</span>
          ${c.mainPrize ? `<span>🏆 ${esc(c.mainPrize)}</span>` : ''}
        </div>
        <div class="ar-card-meta-row">
          <span>${formatNumber(c.participantCount || 0)} ${esc(tr('arena.card.participants', 'participants'))}</span>
          <span>${esc(timeLeft)}</span>
        </div>
        <div class="ar-card-progress"><div class="ar-card-progress-fill" style="width:${rate}%"></div></div>
        <div class="ar-card-meta-row"><span>${esc(tr('arena.card.completionRate', 'Completion'))}</span><span>${rate}%</span></div>
      </div>
    </a>`;
}

function lockedReasonLabel(reason) {
  const map = {
    min_xp_not_met: tr('arena.locked.minXp', 'Requires more XP'),
    min_rank_not_met: tr('arena.locked.minRank', 'Requires a higher rank'),
    prerequisite_challenge_incomplete: tr('arena.locked.prereq', 'Complete a prior challenge first'),
    verified_account_required: tr('arena.locked.verified', 'Requires a verified account'),
    city_not_eligible: tr('arena.locked.city', 'Not available in your city'),
    account_type_not_eligible: tr('arena.locked.accountType', 'Not open to your account type'),
    min_previous_sales_not_met: tr('arena.locked.previousSales', 'Requires previous completed sales'),
  };
  return map[reason] || tr('arena.locked.generic', 'Requirements not met');
}

function renderGrid() {
  const el = document.getElementById('arGrid');
  if (!el) return;
  if (state.loading) {
    el.innerHTML = `<div class="ar-empty">${esc(tr('arena.loading', 'Loading challenges…'))}</div>`;
    return;
  }
  if (state.loadError) {
    el.innerHTML = `<div class="ar-empty"><span class="material-symbols-outlined">error</span><p>${esc(state.loadError)}</p></div>`;
    return;
  }
  const filtered = state.challenges.filter((c) => {
    if (state.category && c.category !== state.category) return false;
    if (!state.statusFilter) return true;
    const eff = c.effectiveState;
    if (state.statusFilter === 'live') return eff === 'live' || eff === 'ending_soon';
    if (state.statusFilter === 'ended') return eff === 'ended' || eff === 'archived';
    return eff === state.statusFilter;
  });
  if (!filtered.length) {
    el.innerHTML = `<div class="ar-empty"><span class="material-symbols-outlined">flag</span><p>${esc(tr('arena.emptyChallenges', 'No challenges match right now — check back soon.'))}</p></div>`;
    return;
  }
  el.innerHTML = filtered.map(challengeCardHtml).join('');
}

async function loadChallenges() {
  state.loading = true;
  state.loadError = null;
  renderFilters();
  renderGrid();
  try {
    const data = await listArenaChallenges(state.user);
    state.challenges = data.challenges || [];
  } catch (err) {
    state.challenges = [];
    state.loadError = isEndpointUnavailable(err)
      ? tr('arena.errUnavailable', 'Darwesh Arena is not available right now. Please check back soon.')
      : tr('arena.errGeneric', 'Could not load challenges right now.');
  }
  state.loading = false;
  renderGrid();
}

// ---------------------------------------------------------------------
// Leaderboard + podium + rank ladder
// ---------------------------------------------------------------------
function podiumHtml(top3) {
  if (!top3.length) return '';
  const slot = (row, place) => row ? `
    <div class="ar-podium-slot rank-${place}">
      <div class="ar-podium-avatar">${row.avatarUrl ? `<img src="${esc(row.avatarUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : esc(initials(row.displayName))}</div>
      <p class="ar-podium-name">${esc(row.displayName || tr('arena.anonymous', 'Darwesh Contributor'))}</p>
      <p class="ar-podium-xp">${formatNumber(row.lifetimeXp || 0)} XP</p>
      <p class="ar-podium-rank-num">#${place}</p>
    </div>` : '<div></div>';
  return `<div class="ar-podium">${slot(top3[1], 2)}${slot(top3[0], 1)}${slot(top3[2], 3)}</div>`;
}

function leaderboardTableHtml(rows) {
  if (!rows.length) return `<div class="ar-empty">${esc(tr('arena.emptyLeaderboard', 'No one has scored yet — be the first.'))}</div>`;
  const myUid = state.user && state.user.uid;
  const body = rows.map((r, i) => `
    <tr class="ar-lb-row${r.uid === myUid ? ' is-me' : ''}">
      <td class="ar-lb-rank">${i + 1}</td>
      <td><div class="ar-lb-user">
        <div class="ar-lb-avatar">${r.avatarUrl ? `<img src="${esc(r.avatarUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : esc(initials(r.displayName))}</div>
        <span>${esc(r.displayName || tr('arena.anonymous', 'Darwesh Contributor'))}</span>
      </div></td>
      <td>${esc(r.rankName || '—')}</td>
      <td>${formatNumber(r.verifiedPropertiesCount || 0)}</td>
      <td>${formatNumber(r.soldPropertiesCount || 0)}</td>
      <td class="ar-lb-xp">${formatNumber(r.lifetimeXp || 0)}</td>
    </tr>`).join('');
  return `
    <table class="ar-lb-table">
      <thead><tr>
        <th>#</th><th>${esc(tr('arena.lb.user', 'User'))}</th><th>${esc(tr('arena.lb.rank', 'Rank'))}</th>
        <th>${esc(tr('arena.lb.verified', 'Verified'))}</th><th>${esc(tr('arena.lb.sold', 'Sold'))}</th>
        <th>${esc(tr('arena.lb.xp', 'XP'))}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function rankLadderHtml() {
  if (!state.ranks.length) return '';
  const myRankId = state.myState && state.myState.currentRankId;
  const myOrder = state.ranks.find((r) => r.id === myRankId);
  const myOrderVal = myOrder ? myOrder.order : -1;
  return `<div class="ar-rank-ladder">${state.ranks.map((r) => {
    const cls = r.id === myRankId ? 'is-current' : (r.order < myOrderVal ? 'is-passed' : '');
    return `<span class="ar-rank-pip ${cls}">${esc(r.name)}</span>`;
  }).join('<span style="color:var(--ar-outline);">→</span>')}</div>`;
}

function renderLeaderboardTab() {
  const el = document.getElementById('arLeaderboardWrap');
  if (!el) return;
  const rows = state.leaderboard;
  el.innerHTML = `
    <p class="ar-section-title">${esc(tr('arena.rankProgression', 'Rank Progression'))}</p>
    <p class="ar-section-sub">${esc(tr('arena.rankProgressionSub', 'Admin-configurable ladder — shown here as it currently stands.'))}</p>
    ${rankLadderHtml()}
    <p class="ar-section-title" style="margin-top:24px;">${esc(tr('arena.globalLeaderboard', 'Global Leaderboard'))}</p>
    ${podiumHtml(rows.slice(0, 3))}
    ${leaderboardTableHtml(rows)}
  `;
}

// ---------------------------------------------------------------------
// My Progress
// ---------------------------------------------------------------------
function renderProgressTab() {
  const el = document.getElementById('arProgressWrap');
  if (!el) return;
  if (!state.user) {
    el.innerHTML = `
      <div class="ar-empty">
        <span class="material-symbols-outlined">login</span>
        <p>${esc(tr('arena.signInToTrack', 'Sign in to track your missions, points and rank.'))}</p>
        <a class="ar-btn ar-btn-primary" style="margin-top:14px;" href="login.html">${esc(tr('arena.signIn', 'Sign In'))}</a>
      </div>`;
    return;
  }
  const s = state.myState || {};
  const current = state.mySubmissions.filter((m) => m.overallStatus !== 'completed' && m.overallStatus !== 'rejected');
  const completed = state.mySubmissions.filter((m) => m.overallStatus === 'completed');
  const currentHtml = current.length
    ? current.map((m) => `
      <a class="ar-panel-mission-row" href="arena-challenge.html?id=${encodeURIComponent(m.challengeId)}">
        <span class="ar-panel-mission-name">${esc(m.propertyType || m.city || m.challengeId)}</span>
        <span class="ar-panel-mission-step">${esc(m.currentStepKey || '')}</span>
      </a>`).join('')
    : `<p class="ar-panel-empty">${esc(tr('arena.noCurrentMissions', 'No active missions yet — join a challenge above.'))}</p>`;

  el.innerHTML = `
    <div class="ar-panel">
      <div class="ar-panel-hero">
        <div class="ar-panel-rank-badge">${esc((s.currentRankName || '—')[0] || '—')}</div>
        <div>
          <p class="ar-panel-xp">${formatNumber(s.lifetimeXp || 0)} XP</p>
          <p class="ar-panel-rank-name">${esc(s.currentRankName || tr('arena.unranked', 'Unranked'))}</p>
          ${s.nextRankName ? `<p class="ar-panel-next">${esc(tr('arena.xpToNext', '{n} XP to {rank}').replace('{n}', formatNumber(s.xpToNextRank || 0)).replace('{rank}', s.nextRankName))}</p>` : ''}
        </div>
      </div>
      <div class="ar-panel-stats">
        <div><div class="ar-panel-stat-value">${formatNumber(s.verifiedPropertiesCount || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.verified', 'Verified'))}</div></div>
        <div><div class="ar-panel-stat-value">${formatNumber(s.soldPropertiesCount || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.sold', 'Sold'))}</div></div>
        <div><div class="ar-panel-stat-value">${formatNumber(s.challengesJoined || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.joined', 'Joined'))}</div></div>
        <div><div class="ar-panel-stat-value">${formatNumber(s.challengesCompleted || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.completed', 'Completed'))}</div></div>
      </div>
      <p class="ar-section-title" style="margin-top:22px;font-size:15px;">${esc(tr('arena.currentMissions', 'Current Missions'))}</p>
      <div class="ar-panel-missions">${currentHtml}</div>
      ${completed.length ? `<p class="ar-section-title" style="margin-top:20px;font-size:15px;">${esc(tr('arena.completedChallenges', 'Completed Challenges'))}</p><div class="ar-panel-missions">${completed.map((m) => `
        <div class="ar-panel-mission-row"><span class="ar-panel-mission-name">${esc(m.propertyType || m.city || m.challengeId)}</span><span class="ar-panel-mission-step">✓</span></div>
      `).join('')}</div>` : ''}
    </div>`;
}

async function loadMyProgress() {
  if (!state.user) { renderProgressTab(); return; }
  try {
    const [stateRes, subsRes] = await Promise.all([
      getMyArenaState(state.user),
      getMyArenaSubmissions(state.user),
    ]);
    state.myState = stateRes;
    state.mySubmissions = subsRes.submissions || [];
  } catch (_) {
    state.myState = null;
    state.mySubmissions = [];
  }
  renderProgressTab();
}

// ---------------------------------------------------------------------
function renderAll() {
  renderTablist();
  document.getElementById('arChallengesTab')?.classList.toggle('hidden', state.tab !== 'challenges');
  document.getElementById('arLeaderboardTab')?.classList.toggle('hidden', state.tab !== 'leaderboard');
  document.getElementById('arProgressTab')?.classList.toggle('hidden', state.tab !== 'progress');
  if (state.tab === 'challenges') { renderFilters(); renderGrid(); }
  if (state.tab === 'leaderboard') renderLeaderboardTab();
  if (state.tab === 'progress') renderProgressTab();
}

async function boot() {
  const [lbData, ranksData] = await Promise.all([
    getArenaLeaderboard(50).catch(() => ({ leaderboard: [] })),
    listArenaRanks().catch(() => ({ ranks: [] })),
  ]);
  state.leaderboard = lbData.leaderboard || [];
  state.ranks = (ranksData.ranks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  await loadChallenges();
  renderAll();

  auth.onAuthStateChanged((user) => {
    state.user = user;
    loadChallenges();
    loadMyProgress();
  });
}

boot();

document.addEventListener('darwesh:langchange', renderAll);
