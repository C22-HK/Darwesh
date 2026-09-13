// Darwesh Arena -- profile panel. Auto-mounts on `[data-arena-panel]`
// (account.html) for the signed-in owner, exactly like
// js/verification-rewards.js's own auto-mount. Read-only: shows what the
// backend already computed (rank/XP/current missions/badges) and links out
// to arena.html/arena-challenge.html for any actual mutation.
import {
  getMyArenaState, getMyArenaSubmissions, listArenaRanks,
} from './backend-api.js';
import { formatNumber } from './arena-model.js';
import { escapeHtml as esc } from './offer-banner.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

export function renderArenaPanel(el, data) {
  if (!el) return;
  el.__arData = data;
  const s = data.myState || {};
  const current = (data.mySubmissions || []).filter((m) => m.overallStatus !== 'completed' && m.overallStatus !== 'rejected');
  const completed = (data.mySubmissions || []).filter((m) => m.overallStatus === 'completed');
  const badges = s.badgesEarned || [];
  const ranks = data.ranks || [];
  const myOrder = (ranks.find((r) => r.id === s.currentRankId) || {}).order;
  const nextRank = ranks.find((r) => (myOrder === undefined ? false : r.order > myOrder));
  const progressPct = (nextRank && s.xpToNextRank !== undefined && s.xpToNextRank !== null)
    ? Math.max(4, 100 - Math.min(100, (s.xpToNextRank / Math.max(1, (nextRank.minXp || 1))) * 100))
    : 100;

  el.innerHTML = `
    <div class="arena-scope">
      <div class="ar-panel">
        <div class="ar-panel-hero">
          <div class="ar-panel-rank-badge">${esc((s.currentRankName || '—')[0] || '—')}</div>
          <div style="flex:1;min-width:160px;">
            <p class="ar-panel-xp">${formatNumber(s.lifetimeXp || 0)} XP</p>
            <p class="ar-panel-rank-name">${esc(s.currentRankName || tr('arena.unranked', 'Unranked'))}</p>
            ${s.nextRankName ? `<p class="ar-panel-next">${esc(tr('arena.xpToNext', '{n} XP to {rank}').replace('{n}', formatNumber(s.xpToNextRank || 0)).replace('{rank}', s.nextRankName))}</p>` : ''}
            <div class="ar-panel-progress"><div class="ar-panel-progress-fill" style="width:${progressPct}%"></div></div>
          </div>
        </div>
        <div class="ar-panel-stats">
          <div><div class="ar-panel-stat-value">${formatNumber(s.verifiedPropertiesCount || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.verified', 'Verified'))}</div></div>
          <div><div class="ar-panel-stat-value">${formatNumber(s.soldPropertiesCount || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.sold', 'Sold'))}</div></div>
          <div><div class="ar-panel-stat-value">${formatNumber(s.challengesJoined || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.joined', 'Joined'))}</div></div>
          <div><div class="ar-panel-stat-value">${formatNumber(s.challengesCompleted || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.completed', 'Completed'))}</div></div>
        </div>
        <p class="ar-section-title" style="margin-top:20px;font-size:14px;">${esc(tr('arena.currentMissions', 'Current Missions'))}</p>
        <div class="ar-panel-missions">
          ${current.length ? current.map((m) => `
            <a class="ar-panel-mission-row" href="arena-challenge.html?id=${encodeURIComponent(m.challengeId)}">
              <span class="ar-panel-mission-name">${esc(m.propertyType || m.city || m.challengeId)}</span>
              <span class="ar-panel-mission-step">${esc(m.currentStepKey || '')}</span>
            </a>`).join('') : `<p class="ar-panel-empty">${esc(tr('arena.noCurrentMissions', 'No active missions yet — join a challenge to get started.'))}</p>`}
        </div>
        ${badges.length ? `
          <p class="ar-section-title" style="margin-top:20px;font-size:14px;">${esc(tr('arena.featuredBadges', 'Featured Badges'))}</p>
          <div class="ar-panel-badges">
            ${badges.slice(0, 6).map((b) => `<div class="ar-panel-badge-chip"><div class="ar-panel-badge-icon">🏅</div><span class="ar-panel-badge-name">${esc(b.name || '')}</span></div>`).join('')}
          </div>` : ''}
        <div class="ar-panel-cta">
          <a class="ar-btn ar-btn-primary" href="arena.html">${esc(tr('arena.viewArena', 'View Darwesh Arena'))}</a>
          ${completed.length ? `<span class="ar-form-hint" style="margin-inline-start:10px;">${esc(tr('arena.completedCount', '{n} challenges completed').replace('{n}', completed.length))}</span>` : ''}
        </div>
      </div>
    </div>`;
}

export async function mountArenaPanel(el, user) {
  if (!el || !user) return;
  el.innerHTML = `<div class="arena-scope"><div class="ar-panel" aria-busy="true"><div class="vr-skeleton" style="min-height:180px;border-radius:14px;"></div></div></div>`;
  try {
    const [myState, subsRes, ranksRes] = await Promise.all([
      getMyArenaState(user),
      getMyArenaSubmissions(user).catch(() => ({ submissions: [] })),
      listArenaRanks().catch(() => ({ ranks: [] })),
    ]);
    renderArenaPanel(el, { myState, mySubmissions: subsRes.submissions || [], ranks: ranksRes.ranks || [] });
  } catch (_) {
    el.innerHTML = `<div class="arena-scope"><div class="ar-panel"><p class="ar-panel-empty">${esc(tr('arena.panelLoadFailed', 'We could not load your Arena progress right now.'))}</p></div></div>`;
  }
}

if (typeof document !== 'undefined') {
  const boot = async () => {
    const hosts = [...document.querySelectorAll('[data-arena-panel]')];
    if (!hosts.length) return;
    const { auth } = await import('./firebase-init.js');
    const apply = (user) => hosts.forEach((h) => {
      if (user) mountArenaPanel(h, user);
      else h.innerHTML = '';
    });
    if (auth.onAuthStateChanged) auth.onAuthStateChanged(apply);
    else apply(auth.currentUser);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  document.addEventListener('darwesh:langchange', () => {
    document.querySelectorAll('[data-arena-panel]').forEach((h) => {
      if (h.__arData) renderArenaPanel(h, h.__arData);
    });
  });
}
