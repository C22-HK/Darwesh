// Property Watch / Area Alerts -- profile panel. Auto-mounts on
// `[data-alerts-panel]` (account.html), exactly like js/arena-panel.js's
// own auto-mount. Alerts are never a public-profile surface (a saved
// search is private), so this only ever mounts for the signed-in owner,
// never a visitor.
import {
  listMyAreaAlerts, updateAreaAlert, deleteAreaAlert, localizeBackendError,
} from './backend-api.js';
import { escapeHtml as esc } from './offer-banner.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  let s = tr(key, fallback);
  for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, v);
  return s;
}

function fmtRadius(metres) {
  if (metres >= 1000) return trf('alerts.radiusKm', '{n} km', { n: (metres / 1000).toFixed(1) });
  return trf('alerts.radiusM', '{n} m', { n: Math.round(metres) });
}

function describeArea(area) {
  if (!area) return '';
  if (area.type === 'circle') return trf('alerts.area.circle', '{radius} radius area', { radius: fmtRadius(area.radiusM) });
  if (area.type === 'neighborhood') return [area.city, area.district].filter(Boolean).join(', ');
  return area.city || '';
}

function describeFilters(filters) {
  const f = filters || {};
  const parts = [];
  if (f.dealType) parts.push(f.dealType === 'rent' ? tr('common.forRent', 'For Rent') : tr('common.forSale', 'For Sale'));
  if (f.propertyType) parts.push(f.propertyType);
  if (f.minPrice != null || f.maxPrice != null) {
    const min = f.minPrice != null ? '$' + f.minPrice.toLocaleString() : '';
    const max = f.maxPrice != null ? '$' + f.maxPrice.toLocaleString() : '';
    parts.push(min && max ? `${min}–${max}` : (min ? min + '+' : 'up to ' + max));
  }
  if (f.minBeds != null) parts.push(trf('alerts.minBeds', '{n}+ bd', { n: f.minBeds }));
  return parts.length ? parts.join(' · ') : tr('alerts.filters.any', 'Any property');
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch { return ''; }
}

function notifyModeLabel(mode) {
  if (mode === 'daily_digest') return tr('alerts.notifyMode.dailyDigestSoon', 'Daily digest (coming soon)');
  return tr('alerts.notifyMode.instant', 'Instantly');
}

function alertCardHtml(alert) {
  const newBadge = alert.newMatchCount > 0
    ? `<span class="inline-flex items-center rounded-full bg-primary text-on-primary px-2 py-0.5 font-label-caps text-[10px] ml-2">${esc(trf('alerts.newMatches', '{n} new', { n: alert.newMatchCount }))}</span>`
    : '';
  const pauseLabel = alert.status === 'paused'
    ? tr('alerts.action.resume', 'Resume')
    : tr('alerts.action.pause', 'Pause');
  return `
    <div class="fav-card p-4 mb-3" data-alert-id="${esc(alert.id)}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-headline-md text-[16px] text-primary truncate">${esc(alert.name || '')}${newBadge}</p>
          <p class="font-body-md text-[13px] text-on-surface-variant mt-0.5">${esc(describeArea(alert.area))}</p>
          <p class="font-body-md text-[12.5px] text-on-surface-variant">${esc(describeFilters(alert.filters))}</p>
          <p class="font-body-md text-[12px] text-on-surface-variant mt-1">
            ${esc(notifyModeLabel(alert.notifyMode))}
            ${alert.status === 'paused' ? ' · ' + esc(tr('alerts.status.paused', 'Paused')) : ''}
            ${alert.lastMatchedAt ? ' · ' + esc(trf('alerts.lastMatched', 'Last match {date}', { date: fmtDate(alert.lastMatchedAt) })) : ''}
          </p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 mt-3">
        <a href="map.html?alertId=${encodeURIComponent(alert.id)}" class="border border-outline-variant rounded-full px-3 py-1.5 font-label-caps text-label-caps text-[11px] text-secondary hover:bg-surface-container transition-colors">${esc(tr('alerts.action.viewMatches', 'View Matches'))}</a>
        <button type="button" data-action="rename" class="border border-outline-variant rounded-full px-3 py-1.5 font-label-caps text-label-caps text-[11px] text-on-surface hover:bg-surface-container transition-colors">${esc(tr('alerts.action.edit', 'Edit'))}</button>
        <button type="button" data-action="toggle-status" class="border border-outline-variant rounded-full px-3 py-1.5 font-label-caps text-label-caps text-[11px] text-on-surface hover:bg-surface-container transition-colors">${esc(pauseLabel)}</button>
        <button type="button" data-action="delete" class="border border-error text-error rounded-full px-3 py-1.5 font-label-caps text-label-caps text-[11px] hover:bg-error-container transition-colors">${esc(tr('alerts.action.delete', 'Delete'))}</button>
      </div>
    </div>`;
}

export function renderAlertsPanel(el, alerts) {
  if (!el) return;
  el.__alertsData = alerts;
  if (!alerts.length) {
    el.innerHTML = `<p class="font-body-md text-[14px] text-on-surface-variant py-8 text-center">${esc(tr('alerts.empty', 'No property alerts yet. Draw an area or enter a city on'))} <a href="map.html" class="text-secondary hover:underline">${esc(tr('nav.map', 'Map'))}</a> ${esc(tr('alerts.emptySuffix', 'and save it as an alert.'))}</p>`;
    return;
  }
  el.innerHTML = alerts.map(alertCardHtml).join('');
}

export async function mountAreaAlertsPanel(el, user) {
  if (!el || !user) return;
  el.innerHTML = `<div class="vr-skeleton" style="min-height:140px;border-radius:14px;"></div>`;
  let alerts;
  try {
    const res = await listMyAreaAlerts(user);
    alerts = res.alerts || [];
  } catch (_) {
    el.innerHTML = `<p class="font-body-md text-[14px] text-on-surface-variant py-8 text-center">${esc(tr('alerts.loadFailed', 'We could not load your property alerts right now.'))}</p>`;
    return;
  }
  renderAlertsPanel(el, alerts);

  el.addEventListener('click', async (event) => {
    const card = event.target.closest('[data-alert-id]');
    if (!card) return;
    const alertId = card.dataset.alertId;
    const current = (el.__alertsData || []).find((a) => a.id === alertId);
    if (!current) return;

    if (event.target.matches('[data-action="rename"]')) {
      const name = window.prompt(tr('alerts.saveModal.nameLabel', 'Alert name'), current.name || '');
      if (!name || !name.trim() || name.trim() === current.name) return;
      try {
        await updateAreaAlert(user, alertId, { name: name.trim() });
        current.name = name.trim();
        renderAlertsPanel(el, el.__alertsData);
      } catch (err) {
        window.alert(localizeBackendError(err, tr, 'alerts.saveModal.error', 'Could not update this alert.'));
      }
      return;
    }

    if (event.target.matches('[data-action="toggle-status"]')) {
      const nextStatus = current.status === 'paused' ? 'active' : 'paused';
      try {
        await updateAreaAlert(user, alertId, { status: nextStatus });
        current.status = nextStatus;
        renderAlertsPanel(el, el.__alertsData);
      } catch (err) {
        window.alert(localizeBackendError(err, tr, 'alerts.saveModal.error', 'Could not update this alert.'));
      }
      return;
    }

    if (event.target.matches('[data-action="delete"]')) {
      if (!window.confirm(tr('alerts.confirmDelete', 'Delete this alert? This cannot be undone.'))) return;
      try {
        await deleteAreaAlert(user, alertId);
        el.__alertsData = (el.__alertsData || []).filter((a) => a.id !== alertId);
        renderAlertsPanel(el, el.__alertsData);
      } catch (err) {
        window.alert(localizeBackendError(err, tr, 'alerts.saveModal.error', 'Could not delete this alert.'));
      }
    }
  });
}

if (typeof document !== 'undefined') {
  const boot = async () => {
    const hosts = [...document.querySelectorAll('[data-alerts-panel]')];
    if (!hosts.length) return;
    const { auth } = await import('./firebase-init.js');
    const apply = (user) => hosts.forEach((h) => {
      if (user) mountAreaAlertsPanel(h, user);
      else h.innerHTML = '';
    });
    if (auth.onAuthStateChanged) auth.onAuthStateChanged(apply);
    else apply(auth.currentUser);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  document.addEventListener('darwesh:langchange', () => {
    document.querySelectorAll('[data-alerts-panel]').forEach((h) => {
      if (h.__alertsData) renderAlertsPanel(h, h.__alertsData);
    });
  });
}
