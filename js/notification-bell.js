// ---------------------------------------------------------------------
// Notification bell — shared across every public page that has the
// standard `<button aria-label="Notifications">` in its header. Shows
// the signed-in user's own real activity: status updates on the sell
// submissions and viewing requests they made (the same "submissions"
// collection account.html's My Submissions tab reads, filtered to their
// own uid — nothing here is fabricated or estimated). A guest sees a
// sign-in prompt instead. A small dot appears on the bell only when at
// least one of the user's own submissions has moved past "pending" —
// never a fake unread count, since there's no read/unread tracking.
// ---------------------------------------------------------------------
import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

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
  return items.map(it => {
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
  }).join('');
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

async function loadMyActivity(uid) {
  const items = [];
  try {
    const snap = await getDocs(query(collection(db, 'submissions'), where('uid', '==', uid)));
    snap.forEach(d => {
      const s = d.data();
      items.push({
        title: s.address ? (s.address + (s.city ? ', ' + s.city : '')) : (s.title || null),
        type: s.type,
        status: s.status || 'pending',
        seconds: s.createdAt?.seconds || 0
      });
    });
  } catch (e) {
    // Leave items empty — an honest "no updates" beats a broken panel.
  }
  items.sort((a, b) => b.seconds - a.seconds);
  return items.slice(0, 8);
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
    currentItems = await loadMyActivity(user.uid);
    const hasUpdate = currentItems.some(it => it.status && it.status !== 'pending');
    bells.forEach(bell => setDot(bell, hasUpdate));
  });

  document.addEventListener('darwesh:langchange', () => {
    if (panelEl && panelBellEl) openPanel(panelBellEl, currentState, currentItems);
  });
}

init();
