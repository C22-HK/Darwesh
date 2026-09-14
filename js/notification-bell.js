// ---------------------------------------------------------------------
// Notification bell — shared across every public page that has the
// standard `<button aria-label="Notifications">` in its header. Shows
// two kinds of real activity, merged into one list, newest first:
//   1. Status updates on the user's own sell submissions/viewing requests
//      (the "submissions" collection, filtered to their own uid) — always
//      informational, never carries an unread state (there's no read/
//      unread tracking on that collection, same as before this file
//      grew a second source).
//   2. Property Watch / Area Alerts match notifications (the
//      `notifications` collection — the first real notification inbox in
//      this codebase) — these DO carry a real `read` flag, and the bell's
//      dot reflects an actual unread count from that field, not a guess.
// A guest sees a sign-in prompt instead.
// ---------------------------------------------------------------------
import { auth, db, getDocs } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { collection, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  let s = tr(key, fallback);
  for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, v);
  return s;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relTime(seconds) {
  if (!seconds) return '';
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return tr('notif.justNow', 'just now');
  if (diff < 3600) return Math.floor(diff / 60) + tr('notif.minAgo', 'm ago');
  if (diff < 86400) return Math.floor(diff / 3600) + tr('notif.hrAgo', 'h ago');
  return Math.floor(diff / 86400) + tr('notif.dayAgo', 'd ago');
}

function statusLabel(status) {
  if (status === 'in-progress') return tr('notif.statusInProgress', 'In Progress');
  if (status === 'resolved') return tr('notif.statusResolved', 'Resolved');
  return tr('notif.statusPending', 'Pending');
}
function statusColor(status) {
  if (status === 'in-progress') return { bg: '#d2e4fb', fg: '#0b1d2d' };
  if (status === 'resolved') return { bg: '#003115', fg: '#4ae183' };
  return { bg: '#fed488', fg: '#5d4201' };
}

let panelEl = null;
let outsideClickHandler = null;
let panelBellEl = null;

function closePanel() {
  if (panelEl) { panelEl.remove(); panelEl = null; }
  if (outsideClickHandler) { document.removeEventListener('click', outsideClickHandler); outsideClickHandler = null; }
  panelBellEl = null;
}

function renderSubmissionRow(it) {
  const c = statusColor(it.status);
  const sub = it.type === 'sell' ? tr('notif.sellSubmission', 'Sell submission') : tr('notif.viewingRequest', 'Viewing request');
  return `
    <div style="padding:12px 16px; border-bottom:1px solid #e5e8ee;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <p style="font-family:'Inter',sans-serif; font-size:13px; color:#181c20; font-weight:500; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(it.title || tr('notif.submission', 'Submission'))}</p>
        <span style="flex:none; font-size:10.5px; font-weight:600; padding:2px 8px; border-radius:999px; background:${c.bg}; color:${c.fg};">${statusLabel(it.status)}</span>
      </div>
      <p style="font-family:'Inter',sans-serif; font-size:11.5px; color:#9aa1ab; margin:3px 0 0;">${escapeHtml(sub)} · ${relTime(it.seconds)}</p>
    </div>`;
}

function renderAlertMatchRow(it) {
  const names = (it.payload.matches || []).map((m) => m.alertName).filter(Boolean);
  const title = names.length
    ? trf('notif.alertMatchTitle', 'New match for "{name}"', { name: names[0] })
    : tr('notif.alertMatchTitleGeneric', 'New property match');
  const countLabel = it.payload.matchCount > 1
    ? trf('notif.alertMatchCount', '{n} new matches', { n: it.payload.matchCount })
    : tr('notif.alertMatchCountOne', '1 new match');
  return `
    <a href="#" data-notif-id="${escapeHtml(it.id)}" data-notif-href="map.html?alertId=${encodeURIComponent((it.payload.matches || [])[0]?.alertId || '')}"
       style="display:block; padding:12px 16px; border-bottom:1px solid #e5e8ee; text-decoration:none; ${it.read ? '' : 'background:#fbf6ea;'}">
      <div style="display:flex; align-items:center; gap:8px;">
        ${it.read ? '' : '<span style="flex:none; width:7px; height:7px; border-radius:50%; background:#B89A63;"></span>'}
        <p style="font-family:'Inter',sans-serif; font-size:13px; color:#181c20; font-weight:500; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(title)}</p>
      </div>
      <p style="font-family:'Inter',sans-serif; font-size:11.5px; color:#9aa1ab; margin:3px 0 0;">${escapeHtml(countLabel)} · ${relTime(it.seconds)}</p>
    </a>`;
}

function renderPanelBody(state, items) {
  if (state === 'guest') {
    return `
      <div style="padding:20px 16px; text-align:center;">
        <p style="font-family:'Inter',sans-serif; font-size:13px; color:#44474c; margin-bottom:12px;">${tr('notif.signInPrompt', 'Sign in to see updates on your requests.')}</p>
        <a href="login.html" style="display:inline-block; background:#041627; color:#fff; padding:8px 18px; border-radius:999px; font-family:'IBM Plex Sans',sans-serif; font-size:12px; font-weight:600; text-decoration:none;">${tr('notif.signIn', 'Sign In')}</a>
      </div>`;
  }
  if (items.length === 0) {
    return `
      <div style="padding:20px 16px; text-align:center;">
        <p style="font-family:'Inter',sans-serif; font-size:13px; color:#44474c; margin-bottom:4px;">${tr('notif.empty', 'No updates yet.')}</p>
        <p style="font-family:'Inter',sans-serif; font-size:11.5px; color:#9aa1ab;">${tr('notif.emptyHint', 'Submit a property or request a viewing, and updates will show up here.')}</p>
      </div>`;
  }
  return items.map((it) => (it.kind === 'alert_match' ? renderAlertMatchRow(it) : renderSubmissionRow(it))).join('');
}

async function handleAlertMatchClick(link) {
  const notificationId = link.dataset.notifId;
  const href = link.dataset.notifHref;
  try {
    const { markNotificationRead } = await import('./backend-api.js');
    if (auth.currentUser) await markNotificationRead(auth.currentUser, notificationId);
  } catch (_) {
    // Best-effort -- never block navigation on the read-receipt write.
  }
  if (href) window.location.href = href;
}

function openPanel(bellEl, state, items) {
  closePanel();
  const rect = bellEl.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed; z-index:200; width:300px; max-width:calc(100vw - 24px); max-height:60vh; overflow-y:auto; background:#ffffff; border:1px solid #e0e3e8; border-radius:14px; box-shadow:0 12px 32px rgba(4,22,39,0.2);';
  panel.innerHTML = `
    <div style="padding:12px 16px; border-bottom:1px solid #e5e8ee;">
      <p style="font-family:'Plus Jakarta Sans',sans-serif; font-size:14px; font-weight:700; color:#041627; margin:0;">${tr('notif.title', 'Notifications')}</p>
    </div>
    <div>${renderPanelBody(state, items)}</div>
  `;
  document.body.appendChild(panel);
  panel.querySelectorAll('[data-notif-id]').forEach((link) => {
    link.addEventListener('click', (e) => { e.preventDefault(); handleAlertMatchClick(link); });
  });

  const top = rect.bottom + 8;
  let left = rect.right - 300;
  left = Math.min(Math.max(12, left), document.documentElement.clientWidth - 300 - 12);
  panel.style.top = top + 'px';
  panel.style.left = left + 'px';

  panelEl = panel;
  panelBellEl = bellEl;
  setTimeout(() => {
    outsideClickHandler = (e) => { if (!panel.contains(e.target) && e.target !== bellEl && !bellEl.contains(e.target)) closePanel(); };
    document.addEventListener('click', outsideClickHandler);
  }, 0);
}

function toSeconds(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms / 1000;
}

async function loadSubmissionItems(uid) {
  const items = [];
  try {
    const snap = await getDocs(query(collection(db, 'submissions'), where('uid', '==', uid)));
    snap.forEach((d) => {
      const s = d.data();
      items.push({
        kind: 'submission',
        title: s.address ? (s.address + (s.city ? ', ' + s.city : '')) : (s.title || null),
        type: s.type,
        status: s.status || 'pending',
        seconds: s.createdAt?.seconds || 0
      });
    });
  } catch (e) {
    // Leave items empty — an honest "no updates" beats a broken panel.
  }
  return items;
}

// Owner-scoped direct read -- firestore.rules already restrict
// `notifications` to `resource.data.uid == request.auth.uid`, so this
// needs no backend round-trip; only the mark-read mutation does.
async function loadNotificationItems(uid) {
  const items = [];
  let unreadCount = 0;
  try {
    const snap = await getDocs(query(
      collection(db, 'notifications'), where('uid', '==', uid), orderBy('createdAt', 'desc'), limit(20)
    ));
    snap.forEach((d) => {
      const n = d.data();
      if (n.type !== 'area_alert_match') return; // forward-compatible: ignore unknown future types here
      if (!n.read) unreadCount++;
      items.push({
        kind: 'alert_match',
        id: d.id,
        payload: n.payload || {},
        read: !!n.read,
        seconds: n.createdAt?.seconds || toSeconds(n.createdAt)
      });
    });
  } catch (e) {
    // Same honest-empty fallback as submissions.
  }
  return { items, unreadCount };
}

async function loadMyActivity(uid) {
  const [submissionItems, { items: notificationItems, unreadCount }] = await Promise.all([
    loadSubmissionItems(uid),
    loadNotificationItems(uid)
  ]);
  const items = [...submissionItems, ...notificationItems].sort((a, b) => b.seconds - a.seconds).slice(0, 10);
  return { items, unreadCount };
}

function setDot(bellEl, show) {
  let dot = bellEl.querySelector('.notif-bell-dot');
  if (show && !dot) {
    dot = document.createElement('span');
    dot.className = 'notif-bell-dot';
    dot.style.cssText = 'position:absolute; top:4px; right:4px; width:8px; height:8px; border-radius:50%; background:#ba1a1a; border:1.5px solid var(--notif-dot-ring, #ffffff);';
    bellEl.style.position = 'relative';
    bellEl.appendChild(dot);
  } else if (!show && dot) {
    dot.remove();
  }
}

function init() {
  const bells = document.querySelectorAll('button[aria-label="Notifications"]');
  if (!bells.length) return;

  let currentState = 'guest';
  let currentItems = [];

  bells.forEach(bell => {
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panelEl) { closePanel(); return; }
      openPanel(bell, currentState, currentItems);
    });
  });

  onAuthStateChanged(auth, async (user) => {
    closePanel();
    if (!user) {
      currentState = 'guest';
      currentItems = [];
      bells.forEach(bell => setDot(bell, false));
      return;
    }
    currentState = 'signed-in';
    const { items, unreadCount } = await loadMyActivity(user.uid);
    currentItems = items;
    // Real unread notifications take priority; submission status changes
    // remain the fallback signal for a visitor with no alerts yet, same
    // as before this file grew a second source.
    const hasSubmissionUpdate = items.some((it) => it.kind === 'submission' && it.status && it.status !== 'pending');
    bells.forEach(bell => setDot(bell, unreadCount > 0 || hasSubmissionUpdate));
  });

  document.addEventListener('darwesh:langchange', () => {
    if (panelEl && panelBellEl) openPanel(panelBellEl, currentState, currentItems);
  });
}

init();
