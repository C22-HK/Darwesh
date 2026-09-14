// Darwesh Group -- public customer profile (customer.html).
//
// WHY THIS PAGE NEVER READS users/{uid} FOR A VISITOR. firestore.rules
// only makes users/{uid} publicly readable for `role == 'agent'`
// (see agent-profile.js's own header comment) -- a customer document is
// owner/admin-only, full stop. Widening that rule to cover customers too
// would repeat exactly the mistake the U1 privacy pass spent an entire
// remediation fixing for agents (email/phone/verification flags/
// commissionRate had to be moved OUT of users/{uid} once it became public).
// So this page takes the opposite approach: a visitor's ENTIRE view of a
// customer is built from the one document that was already designed to be
// public -- arenaLeaderboardEntries/{uid} (rank, XP, verified/sold counts,
// badges by name, plus the denormalized displayName/avatarUrl/city already
// mirrored onto it for exactly this kind of surface). No account, buyer,
// deal, ledger, document or verification data ever appears here, because
// none of it is ever read here.
//
// The owner is the one exception, and only for their own uid: isOwner(uid)
// reads are allowed on users/{uid} regardless of role, so the signed-in
// customer viewing their own page gets their real displayName/photoURL/city
// plus the full private js/arena-panel.js (current missions, point ledger --
// everything account.html's own Arena tab already shows them).
import { auth, db, getDoc } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { renderErrorState } from './profile-shell.js';

// Same local guard used by agent-profile.js/office.html for the same
// reason: an avatar <img> src is only ever a real http(s) URL that reached
// Firestore, never a javascript:/data: value.
function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
const el = (id) => document.getElementById(id);
function show(id) { const n = el(id); if (n) n.classList.remove('hidden'); }
function hide(id) { const n = el(id); if (n) n.classList.add('hidden'); }

const params = new URLSearchParams(window.location.search);
let profileId = params.get('id');
let currentUser = null;

function hideStates() {
  ['loadingState', 'noProfileState', 'noActivityState', 'errorState', 'customerContent'].forEach(hide);
}

function renderHero({ displayName, avatarUrl, city }) {
  el('customerName').textContent = displayName || tr('customer.unnamed', 'Darwesh member');
  el('heroMeta').textContent = city || '';
  const icon = el('avatarIcon');
  const img = el('avatarImg');
  if (isSafeHttpUrl(avatarUrl)) {
    img.src = avatarUrl;
    img.classList.remove('hidden');
    icon.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    img.removeAttribute('src');
    icon.classList.remove('hidden');
  }
}

async function loadOwner(uid) {
  let userData = {};
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) userData = snap.data();
  } catch (_) {
    // Keep going with Auth-only identity -- a transient read failure on
    // the owner's own doc shouldn't block them from seeing their page.
  }
  renderHero({
    displayName: userData.displayName || currentUser.displayName,
    avatarUrl: userData.photoURL || currentUser.photoURL,
    city: userData.city
  });
  show('manageAccountBtn');
  hideStates();
  show('customerContent');
  const host = el('arenaPanel');
  if (host) {
    host.hidden = false;
    import('./arena-panel.js')
      .then((m) => m.mountArenaPanel(host, currentUser))
      .catch(() => { host.hidden = true; });
  }
}

async function loadVisitor(uid) {
  try {
    const snap = await getDoc(doc(db, 'arenaLeaderboardEntries', uid));
    const entry = snap.exists() ? snap.data() : null;
    // Mirrors arena-summary.js's own activity gate -- a member who exists
    // but has done nothing yet renders exactly like one this page can't
    // find at all, which is the point: this page never confirms whether a
    // uid is a real account, only whether it has public activity to show.
    const hasActivity = !!entry && (
      (entry.lifetimeXp || 0) > 0 ||
      (Array.isArray(entry.badges) && entry.badges.length > 0) ||
      (entry.verifiedPropertiesCount || 0) > 0 ||
      (entry.soldPropertiesCount || 0) > 0
    );
    if (!hasActivity) {
      hideStates();
      show('noActivityState');
      return;
    }
    renderHero({ displayName: entry.displayName, avatarUrl: entry.avatarUrl, city: entry.city });
    hideStates();
    show('customerContent');
    const host = el('arenaPanel');
    if (host) {
      host.hidden = false;
      import('./arena-summary.js')
        .then((m) => m.renderArenaSummary(host, entry))
        .catch(() => { host.hidden = true; host.innerHTML = ''; });
    }
  } catch (_) {
    hideStates();
    renderErrorState(el('errorState'), {
      message: tr('rp.errorGeneric', 'Something went wrong. Please try again.'),
      onRetry: () => loadVisitor(uid)
    });
    show('errorState');
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  // With no ?id=, a signed-in member sees their own public profile -- the
  // same "how do I look to others" preview every other role page gives.
  if (!profileId && user) profileId = user.uid;
  if (!profileId) { hideStates(); show('noProfileState'); return; }

  const isOwnerView = !!(user && user.uid === profileId);
  if (isOwnerView) {
    loadOwner(profileId);
  } else {
    loadVisitor(profileId);
  }
});
