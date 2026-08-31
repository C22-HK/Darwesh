import { auth, db, getDoc } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  let dest = 'account.html';
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists()) {
      const data = snap.data();
      if (data.accountType === 'professional_engineer') dest = 'engineer.html';
      else if (data.accountType === 'professional_designer') dest = 'designer.html';
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
