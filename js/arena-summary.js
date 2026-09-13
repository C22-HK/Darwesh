// Darwesh Arena -- PUBLIC summary component (arena-summary.js).
//
// Visitor-safe mirror of a player's Arena standing for PUBLIC profile
// pages (agent.html, the 6 professional role pages). Reads exactly ONE
// document -- arenaLeaderboardEntries/{uid}, the single Arena collection
// firestore.rules marks `allow read: if true` -- and nothing else. There
// is no code path here that touches arenaState, arenaSubmissions, or
// arenaLedger, so this module cannot leak the point ledger, active
// missions, buyer/deal data, or internal verification notes even if a
// caller wired it up wrong. Compare js/arena-panel.js (the OWNER-only
// component): that one calls the authenticated /me/state and /me/
// submissions endpoints; this one never does.
//
// Shown fields are exactly what arenaLeaderboardEntries carries: current
// Rank, Featured Badges (id+name only -- see arena_ops.py's
// recompute_state, which projects badgesEarned down to that before
// writing this doc), Verified Properties, Successful Sales. "Top 3
// finishes" and "Champion" badges are NOT rendered here: Darwesh Arena's
// Phase 1 data model has no winner-approval ceremony or historical
// leaderboard-position tracking yet (see the Arena plan's Phase 2
// roadmap) -- there is no real field to show, so none is invented.
//
// Hidden entirely when the visited profile has no meaningful Arena
// activity yet (no XP, no badges, nothing verified or sold): an empty
// summary card on every profile that has never touched Arena is noise,
// not information.
import { db, getDoc } from './firebase-init.js';
import { doc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { formatNumber } from './arena-model.js';
import { escapeHtml as esc } from './offer-banner.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

export function renderArenaSummary(el, entry) {
  if (!el) return;
  el.__arSummaryData = entry;
  el.dataset.arenaSummary = '1';

  if (!entry) { el.hidden = true; el.innerHTML = ''; return; }

  const badges = Array.isArray(entry.badges) ? entry.badges : [];
  const hasActivity = (entry.lifetimeXp || 0) > 0 || badges.length > 0
    || (entry.verifiedPropertiesCount || 0) > 0 || (entry.soldPropertiesCount || 0) > 0;
  if (!hasActivity) { el.hidden = true; el.innerHTML = ''; return; }

  el.hidden = false;
  el.innerHTML = `
    <div class="arena-scope">
      <div class="ar-panel">
        <div class="ar-panel-hero">
          <div class="ar-panel-rank-badge">${esc((entry.rankName || '—')[0] || '—')}</div>
          <div style="flex:1;min-width:160px;">
            <p class="ar-panel-xp">${formatNumber(entry.lifetimeXp || 0)} XP</p>
            <p class="ar-panel-rank-name">${esc(entry.rankName || tr('arena.unranked', 'Unranked'))}</p>
          </div>
        </div>
        <div class="ar-panel-stats">
          <div><div class="ar-panel-stat-value">${formatNumber(entry.verifiedPropertiesCount || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.verified', 'Verified'))}</div></div>
          <div><div class="ar-panel-stat-value">${formatNumber(entry.soldPropertiesCount || 0)}</div><div class="ar-panel-stat-label">${esc(tr('arena.stat.sold', 'Sold'))}</div></div>
        </div>
        ${badges.length ? `
          <p class="ar-section-title" style="margin-top:20px;font-size:14px;">${esc(tr('arena.featuredBadges', 'Featured Badges'))}</p>
          <div class="ar-panel-badges">
            ${badges.slice(0, 6).map((b) => `<div class="ar-panel-badge-chip"><div class="ar-panel-badge-icon">🏅</div><span class="ar-panel-badge-name">${esc(b.name || '')}</span></div>`).join('')}
          </div>` : ''}
        <div class="ar-panel-cta">
          <a class="ar-btn ar-btn-primary" href="arena.html">${esc(tr('arena.viewArena', 'View Darwesh Arena'))}</a>
        </div>
      </div>
    </div>`;
}

/**
 * Mounts the public Arena summary for `uid` into `el`. Safe to call for
 * any uid, signed in or not -- arenaLeaderboardEntries is a public-read
 * collection, so this never needs (and never sends) an auth token.
 */
export async function mountArenaSummary(el, uid) {
  if (!el) return;
  if (!uid) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<div class="arena-scope"><div class="ar-panel" aria-busy="true"><div class="vr-skeleton" style="min-height:140px;border-radius:14px;"></div></div></div>`;
  try {
    const snap = await getDoc(doc(db, 'arenaLeaderboardEntries', uid));
    renderArenaSummary(el, snap.exists() ? snap.data() : null);
  } catch (_) {
    el.hidden = true;
    el.innerHTML = '';
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('darwesh:langchange', () => {
    document.querySelectorAll('[data-arena-summary]').forEach((h) => {
      if (h.__arSummaryData !== undefined) renderArenaSummary(h, h.__arSummaryData);
    });
  });
}
