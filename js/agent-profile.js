// Darwesh Group -- public real-estate agent profile (agent.html).
//
// WHY THIS IS NOT A serviceProviders PAGE. An agent is not a
// serviceProviders document: their identity already lives on users/{uid}
// with role == 'agent', and their body of work already lives in
// listings/{id} keyed by agentId. Creating a serviceProviders record for
// them, or copying their listings into professionalPosts to manufacture a
// portfolio, would be exactly the duplicate-profile / duplicate-content
// architecture docs/PROFESSIONAL_CONTENT_ARCHITECTURE.md §9 rules out --
// two identities for one person, drifting apart from the moment they are
// created. So this page reads the two collections that are already the
// truth and adds no third one.
//
// AN AGENT'S LISTINGS ARE THEIR PORTFOLIO. There is no visual gallery
// here, no professionalPosts, and no `portfolio` array -- the Properties
// tab queries the real listing documents and links to the real
// listing.html for each, so a listing appears in exactly one place and is
// edited in exactly one place (agent-dashboard.html).
//
// NO RULES CHANGE WAS NEEDED. firestore.rules already allows
// `read: if ... || resource.data.role == 'agent'` on users/{uid}, and
// listings are already publicly readable when active and not private. This
// page therefore adds no permission surface whatsoever.
//
// CONTACT DISCIPLINE. The users/{uid} document an agent carries can hold a
// phone number and an email, and the rule above technically lets any
// visitor read them. This page deliberately renders NEITHER. A public
// profile is not a place to publish someone's direct line; a visitor who
// wants to reach this agent does it through the Request Viewing flow that
// already exists on each listing, which is logged and rate-limited like
// every other lead. Display discipline on top of an existing rule -- the
// rule itself is left exactly as it is.
//
// LOC-01. Listing cards render title, price and city only. No lat/lng is
// read, and private/location is never touched -- the query itself cannot
// return it, since it is a subcollection.
import { auth, db, getDoc, getDocs } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc, collection, query, where, limit } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { mountTabs, renderEmptyState, renderErrorState } from './profile-shell.js';

// Same guard office.html applies to the same listing/avatar fields, kept
// local for the same reason it is local there: js/escape-html.js exposes no
// module bindings, so importing from it would fail at load time. An image
// src is only ever emitted for a real http(s) URL -- never a javascript:
// or data: value that reached Firestore.
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
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Bounded, like every other listing surface in this project -- a profile
// is a showcase, not a paginated search. Discovery lives on map.html.
const LISTINGS_LIMIT = 24;

const params = new URLSearchParams(window.location.search);
let agentId = params.get('id');
let currentUser = null;
let agentData = null;
let isOwnerView = false;
let listingsLoaded = false;

function hideStates() {
  ['loadingState', 'notFoundState', 'errorState', 'providerContent'].forEach(hide);
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  // With no ?id=, an agent viewing this page sees their own public profile
  // -- the same "how do I look to a client" preview the role pages give.
  if (!agentId && user) agentId = user.uid;
  if (!agentId) { hideStates(); show('notFoundState'); return; }
  loadAgent();
});

async function loadAgent() {
  try {
    const snap = await getDoc(doc(db, 'users', agentId));
    // Not found, or found but not an agent. Both resolve to the same
    // neutral state: this page presents agents, and saying "that person
    // exists but is not an agent" would leak more than it helps.
    if (!snap.exists() || snap.data().role !== 'agent') {
      hideStates();
      show('notFoundState');
      return;
    }
    agentData = snap.data();
    isOwnerView = !!(currentUser && currentUser.uid === agentId);
    render();
    hideStates();
    show('providerContent');
    setupTabs();
  } catch {
    hideStates();
    renderErrorState(el('errorState'), {
      message: tr('rp.errorGeneric', 'Something went wrong. Please try again.'),
      onRetry: loadAgent
    });
    show('errorState');
  }
}

function render() {
  el('agentName').textContent = agentData.displayName || tr('agent.unnamed', 'Darwesh agent');

  // Avatar: only ever an allowlisted http(s) URL, never raw markup.
  const media = el('heroMedia');
  const photo = agentData.photoURL;
  media.innerHTML = isSafeHttpUrl(photo)
    ? `<img src="${esc(photo)}" alt="" class="rp-hero-photo" loading="lazy" decoding="async"/>`
    : `<span class="material-symbols-outlined rp-hero-fallback" aria-hidden="true">real_estate_agent</span>`;

  // Meta line is built from whatever is genuinely present -- an agent with
  // no city simply gets a shorter line, never an em dash placeholder or an
  // invented "5 years experience". No ratings, no jobs-completed, no
  // response time: none of those exist on users/{uid}, so none are shown.
  const bits = [];
  if (agentData.city) bits.push(agentData.city);
  if (agentData.companyName) bits.push(agentData.companyName);
  el('heroMeta').textContent = bits.join(' · ');

  el('ovCity').textContent = agentData.city || tr('agent.notProvided', 'Not provided');
  el('ovOffice').textContent = agentData.companyName || tr('agent.independent', 'Independent agent');

  if (isOwnerView) show('manageListingsBtn');
}

function setupTabs() {
  mountTabs({
    tabs: [
      { key: 'listings', button: el('tabBtnListings'), panel: el('panelListings') },
      { key: 'about', button: el('tabBtnAbout'), panel: el('panelAbout') }
    ],
    onChange: (key) => { if (key === 'listings') loadListings(); }
  });
  loadListings();
}

async function loadListings() {
  // Guarded so switching tabs back and forth never re-queries -- the
  // listings do not change while the page is open.
  if (listingsLoaded) return;
  listingsLoaded = true;

  const grid = el('listingsGrid');
  const emptyEl = el('listingsEmpty');
  try {
    // Equality-only filters plus a limit: Firestore serves this by merging
    // single-field indexes, so no composite index is required (the same
    // shape office.html already uses for companyId).
    const q = query(
      collection(db, 'listings'),
      where('agentId', '==', agentId),
      where('private', '==', false),
      where('status', '==', 'active'),
      limit(LISTINGS_LIMIT)
    );
    const snap = await getDocs(q);
    if (snap.empty) {
      grid.innerHTML = '';
      renderEmptyState(emptyEl, {
        icon: 'home_work',
        // The owner gets a next step; a visitor gets a plain statement of
        // fact and none of the internal setup language.
        title: isOwnerView
          ? tr('agent.listingsEmptyOwner', 'You have no active properties yet.')
          : tr('agent.listingsEmpty', 'No active properties yet.'),
        hint: isOwnerView
          ? tr('agent.listingsEmptyOwnerHint', 'Add a property from your dashboard and it will appear here.')
          : undefined
      });
      show('listingsEmpty');
      return;
    }
    hide('listingsEmpty');
    grid.innerHTML = '';
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const card = document.createElement('a');
      card.href = `listing.html?id=${encodeURIComponent(docSnap.id)}`;
      card.className = 'ps-card overflow-hidden hover:shadow-lg transition-shadow';
      const price = typeof d.price === 'number' ? d.price.toLocaleString() : d.price;
      // Below-the-fold imagery is lazy + async-decoded, so a profile with
      // 24 properties does not block first paint on 24 downloads.
      card.innerHTML = `
        <div style="aspect-ratio:4/3;background:#221E15;overflow:hidden;">
          ${isSafeHttpUrl(d.img) ? `<img src="${esc(d.img)}" alt="" style="width:100%;height:100%;object-fit:cover;" loading="lazy" decoding="async"/>` : ''}
        </div>
        <div class="p-3">
          <p class="font-body-md text-[13.5px] text-on-surface font-medium truncate">${esc(d.title || '')}</p>
          <p class="font-data-mono text-[13px] text-secondary mt-1">${price ? '$' + esc(String(price)) : ''}</p>
          ${d.city ? `<p class="font-body-md text-[12px] text-on-surface-variant mt-0.5 truncate">${esc(d.city)}</p>` : ''}
        </div>
      `;
      grid.appendChild(card);
    });
  } catch {
    listingsLoaded = false;   // a failure must stay retryable
    grid.innerHTML = '';
    renderErrorState(emptyEl, {
      message: tr('rp.errorGeneric', 'Something went wrong. Please try again.'),
      onRetry: loadListings
    });
    show('listingsEmpty');
  }
}
