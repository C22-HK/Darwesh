// Darwesh Group -- shared listing-favorites controller.
//
// Extracted from three independent copies (index.html's rail favorites,
// buy.html, rent.html) that all wrote to the exact same place --
// users/{uid}/favorites/{'buy-'+id} -- but each with its own auth wiring,
// its own optimistic-update logic, and (in rent.html's case) no rollback
// on a failed write and no double-click guard. One controller now, with
// buy.html's more defensive behavior (optimistic update + rollback +
// per-listing in-flight guard) as the standard for every caller.
//
// Convention preserved exactly: 'buy-' + id regardless of dealType. A
// rental listing keeps the 'buy-' prefix so its favorite state stays in
// sync with listing.html, which hardcodes that prefix for both sale and
// rent listings (the single shared detail page for both).
export function createFavoritesController({ onChange, showToast } = {}) {
  let favAuth = null, favDb = null, favFns = null;
  let favoriteIds = new Set();
  const favoritePending = new Set();

  function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
  function notify() { if (onChange) onChange(); }
  function toast(msg, icon) { if (showToast) showToast(msg, icon); }

  async function init() {
    const [{ auth, db, getDocs }, authMod, storeMod] = await Promise.all([
      import('./firebase-init.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js')
    ]);
    favAuth = auth; favDb = db;
    favFns = { ...authMod, ...storeMod, getDocs };
    favFns.onAuthStateChanged(auth, async (user) => {
      if (user) {
        const snap = await favFns.getDocs(favFns.collection(db, 'users', user.uid, 'favorites'));
        favoriteIds = new Set();
        snap.forEach((d) => favoriteIds.add(d.id));
      } else {
        favoriteIds = new Set();
      }
      notify();
    });
  }

  function isFavorite(id) { return favoriteIds.has('buy-' + id); }

  /**
   * @param {string} id  the listing's own document id
   * @param {object} listing  { address, city, price, img } -- used only
   *   to write a small denormalized favorites-list preview doc, never
   *   read back for the toggle itself.
   * @param {(p:number)=>string} fmtPrice
   */
  async function toggle(id, listing, fmtPrice) {
    if (!favAuth || !favAuth.currentUser) {
      toast(tr('listing.loginToSave', 'Log in to save favorites'), 'favorite');
      setTimeout(() => { window.location.href = 'login.html'; }, 900);
      return;
    }
    const uid = favAuth.currentUser.uid;
    const idStr = 'buy-' + id;
    if (favoritePending.has(idStr)) return;
    favoritePending.add(idStr);

    const ref = favFns.doc(favDb, 'users', uid, 'favorites', idStr);
    const wasFavorited = favoriteIds.has(idStr);
    if (wasFavorited) favoriteIds.delete(idStr); else favoriteIds.add(idStr);
    notify();

    try {
      if (wasFavorited) {
        await favFns.deleteDoc(ref);
        toast(tr('listing.removedFromFavorites', 'Removed from favorites'), 'favorite');
      } else {
        await favFns.setDoc(ref, {
          listingId: idStr,
          address: listing.address || '',
          city: listing.city || '',
          priceLabel: fmtPrice(listing.price),
          img: listing.img || null,
          savedAt: favFns.serverTimestamp()
        });
        toast(tr('listing.savedToFavorites', 'Saved to favorites'), 'favorite');
      }
    } catch (err) {
      if (wasFavorited) favoriteIds.add(idStr); else favoriteIds.delete(idStr);
      notify();
      console.error('[rail-favorites] Firestore write failed, rolled back', err);
      toast(tr('listing.saveFailed', 'Could not save. Try again'), 'error');
    } finally {
      favoritePending.delete(idStr);
    }
  }

  return { init, isFavorite, toggle };
}
