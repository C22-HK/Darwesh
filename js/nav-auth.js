import { auth, db, getDoc } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { PROFESSIONAL_ROLES } from './professional-roles.js';

// accountType -> profile page, built from the one capability map.
//
// Cleaning is the only role with two accountTypes (an individual and a
// team/company owner both land on cleaning.html), so the extra alias is
// declared here rather than distorting the role map with a second entry
// for the same serviceType.
const PROFESSIONAL_DESTINATIONS = Object.fromEntries(
  Object.values(PROFESSIONAL_ROLES).map((r) => [r.accountType, r.page])
);
PROFESSIONAL_DESTINATIONS.cleaning_team_or_company_owner = PROFESSIONAL_ROLES.cleaning.page;


onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  let dest = 'account.html';
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists()) {
      const data = snap.data();
      // PHASE 3B: routed from the capability map instead of a hand-kept
      // if/else. Before this, only engineer and designer were listed, so a
      // signed-in lawyer, landscaper or cleaning provider was sent to
      // account.html -- the generic customer page -- even though their own
      // profile page existed and worked. Deriving the table from
      // PROFESSIONAL_ROLES means adding a role to that map is the only
      // step needed for its profile to become reachable.
      const proDest = PROFESSIONAL_DESTINATIONS[data.accountType];
      if (proDest) dest = proDest;
      else if (data.role === 'agent') dest = 'agent-dashboard.html';
    }
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
