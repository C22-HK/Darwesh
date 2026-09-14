// Admin Panel -- Property Watch / Area Alerts.
//
// Phase 1 is deliberately small: one read-only aggregate summary (active
// alerts, matches this week, alerts by city), reusing admin.html's own
// .kpi-card/.city-bar-* markup conventions for visual consistency. This
// is a placeholder for Phase 2's full Demand Intelligence dashboard, not
// a scaled-down version of it -- there is no per-user alert browsing and
// no buyer-identifying data anywhere in this view, by construction: the
// backend's admin_summary() never returns a per-user or per-alert row.
import { auth } from './firebase-init.js';
import { getAreaAlertsAdminSummary, localizeBackendError } from './backend-api.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

const state = { mounted: false };

function panel() { return document.getElementById('tab-alerts'); }

function ensureShell() {
  const root = panel();
  if (!root || state.mounted) return root;
  root.innerHTML = `
    <div class="ash-alerts">
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
  state.mounted = true;
  return root;
}

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
