import { auth, db, getDoc } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
// accountType/role -> destination page lives in ONE shared module now
// (launch-readiness fix B3): the same resolver drives this header chip,
// login.html's post-login redirect and account.html's management card, so
// an office owner or a developer is routed to office.html/org-projects.html
// everywhere instead of only knowing the professional roles here.
import { resolveProfileDestination } from './profile-destination.js';


// Header light-luxury rebuild: guest visitors see Login/Sign Up buttons
// (#navAuthGuest), signed-in visitors see a single Profile chip
// (#navProfileLink) -- both markups exist from first paint (see
// js/site-header.js), this is the one place that decides which shows,
// using the SAME real auth resolution the rest of this file already does.
// Neither element exists on every page (js/site-header.js only renders
// them in the desktop split layout), so both lookups are optional.
function setAuthUiState(signedIn) {
  const guest = document.getElementById('navAuthGuest');
  const chip = document.getElementById('navProfileLink');
  if (guest) {
    guest.classList.toggle('hidden', signedIn);
    guest.classList.toggle('flex', !signedIn);
  }
  if (chip) {
    chip.classList.toggle('hidden', !signedIn);
    chip.classList.toggle('inline-flex', signedIn);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    setAuthUiState(false);
    return;
  }
  setAuthUiState(true);

  let dest = 'account.html';
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    // PHASE 3B routed professionals from the capability map; fix B3 moved
    // that table (plus offices, organizations, agents and admins) into
    // js/profile-destination.js so every surface agrees. A missing profile
    // document still resolves to the generic account page.
    dest = resolveProfileDestination(snap.exists() ? snap.data() : null);
  } catch (e) {}

  const firstName = (user.displayName || user.email || 'Profile').split(' ')[0];

  const plainLink = document.getElementById('navProfileLink');
  if (plainLink) {
    plainLink.href = dest;
    plainLink.textContent = firstName;
  }

  const iconLink = document.getElementById('navProfileIconLink');
  if (iconLink) iconLink.href = dest;
  const iconLabel = document.getElementById('navProfileIconLabel');
  if (iconLabel) iconLabel.textContent = firstName;

  const mobileLink = document.getElementById('navProfileLinkMobile');
  if (mobileLink) mobileLink.href = dest;
  const mobileLabel = document.getElementById('navProfileLabelMobile');
  if (mobileLabel) mobileLabel.textContent = firstName;
});
