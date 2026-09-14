// Admin Panel -- Property Watch / Area Alerts.
//
// Phase 1 is deliberately small: one read-only aggregate summary (active
// alerts, matches this week, alerts by city), reusing admin.html's own
// .kpi-card/.city-bar-* markup conventions for visual consistency. This
// is a placeholder for Phase 2's full Demand Intelligence dashboard, not
// a scaled-down version of it -- there is no per-user alert browsing and
// no buyer-identifying data anywhere in this view, by construction: the
// backend's admin_summary() never returns a per-user or per-alert row.
//
// Admin redesign Phase 3: this is still the ONE real Demand destination
// today (confirmed via repo-wide grep -- listAreaAlertMatches() in
// backend-api.js has zero callers anywhere, admin or customer-facing).
// A "Matches" or "Map" sub-tab is deliberately NOT built here: it would
// either be fake (no such UI exists) or violate the privacy boundary
// above by exposing per-alert match rows. Only an AdminPageHeader was
// added -- no AdminTabs, same single-item-hub treatment as Overview.
import { auth } from './firebase-init.js';
import { getAreaAlertsAdminSummary, localizeBackendError } from './backend-api.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

const state = { mounted: false };

function panel() { return document.getElementById('tab-alerts'); }

function mountHeader() {
  window.AdminPageHeader.mount(document.getElementById('aaHeaderMount'), {
    icon: 'notifications_active',
    title: () => tr('admin.nav.groupDemand', 'Demand'),
    description: () => tr('admin.demand.desc', 'Aggregate demand insight from saved Area Alerts, city by city.'),
  });
}

function ensureShell() {
  const root = panel();
  if (!root || state.mounted) return root;
  root.innerHTML = `
    <div class="ash-alerts">
      <div id="aaHeaderMount"></div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div class="kpi-card">
          <p class="kpi-label" data-i18n="admin.alerts.kpiActive">Active Alerts</p>
          <p class="kpi-value" id="aaKpiActive">—</p>
        </div>
        <div class="kpi-card">
          <p class="kpi-label" data-i18n="admin.alerts.kpiMatchesWeek">Matches This Week</p>
          <p class="kpi-value" id="aaKpiMatches">—</p>
        </div>
      </div>
      <p class="font-headline-md text-[16px] text-primary mb-3" data-i18n="admin.alerts.byCity">Active alerts by city</p>
      <div id="aaCityBars" class="space-y-2"></div>
      <p id="aaEmpty" class="hidden font-body-md text-[13px] text-on-surface-variant py-6 text-center" data-i18n="admin.alerts.noCityAlerts">No city or neighborhood alerts saved yet.</p>
      <p id="aaError" class="hidden font-body-md text-[13px] text-error py-4"></p>
    </div>`;
  mountHeader();
  state.mounted = true;
  return root;
}
document.addEventListener('darwesh:langchange', () => { if (state.mounted) mountHeader(); });

function renderCityBars(rows) {
  const container = document.getElementById('aaCityBars');
  const empty = document.getElementById('aaEmpty');
  if (!rows.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const max = Math.max(...rows.map((r) => r.count), 1);
  container.innerHTML = rows.map((r) => `
    <div class="city-bar-row">
      <div class="city-bar-label"><span class="material-symbols-outlined">location_on</span>${String(r.city)}</div>
      <div class="city-bar-track"><div class="city-bar-fill" style="width:${Math.round((r.count / max) * 100)}%"></div></div>
      <div class="city-bar-count">${r.count}</div>
    </div>`).join('');
}

export async function renderAlertsTab() {
  const root = ensureShell();
  if (!root) return;
  const errEl = document.getElementById('aaError');
  errEl.classList.add('hidden');
  if (!auth.currentUser) return;
  try {
    const summary = await getAreaAlertsAdminSummary(auth.currentUser);
    document.getElementById('aaKpiActive').textContent = summary.activeAlerts;
    document.getElementById('aaKpiMatches').textContent = summary.matchesThisWeek;
    renderCityBars(summary.alertsByCity || []);
  } catch (err) {
    errEl.textContent = localizeBackendError(err, tr, 'admin.alerts.loadFailed', 'Could not load the Area Alerts summary.');
    errEl.classList.remove('hidden');
  }
}
