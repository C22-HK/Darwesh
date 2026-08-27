// Shared HTML-escaping helpers for pages that render Firestore-sourced
// text (listing title/address/city/agentName, etc.) via innerHTML/
// template literals. Every one of these fields is attacker-controllable
// by anyone willing to call the Firestore REST API directly (or, for
// listings, anyone with an agent account) instead of going through this
// site's own forms -- firestore.rules validates *who* can write a field,
// not its content. Escaping at the point of rendering closes that
// regardless of how the value got into Firestore.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// For values used as an <img src>/<a href> (photo URLs, etc.) -- HTML-
// escaping alone doesn't stop a `javascript:`/`data:` URI from being
// used as a link target, so such values are checked against this
// allowlist first, in addition to being escaped.
function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
