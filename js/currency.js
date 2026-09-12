// Darwesh Group -- the single source of truth for the IQD/USD conversion.
//
// WHY A CLASSIC SCRIPT SETTING A GLOBAL, AND NOT AN ES MODULE
// ----------------------------------------------------------
// The three call sites do not share a script context:
//
//   sell.html:799            classic <script>   (cannot use a static import)
//   admin.html:2110          <script type="module">
//   agent-dashboard.html:805 <script type="module">
//
// A static `import` is impossible in the classic block, and a dynamic
// import() would make the value asynchronous -- sell.html reads the rate
// synchronously while formatting its live price preview, so an async
// constant would render a blank or wrong figure on first paint. A plain
// classic script assigning to window is readable from BOTH a classic
// block and a module block, resolves synchronously, and introduces no
// import graph at all, so it cannot create a circular import.
//
// LOAD ORDER is guaranteed rather than hoped for: this file is included
// with a plain <script src> in <head>, before every consuming block.
// Classic scripts without defer run in document order, and module blocks
// are deferred by definition, so both kinds of consumer always see the
// value already assigned.
//
// WHAT THIS DOES NOT CHANGE
// -------------------------
// Not the rate (1310, unchanged), not the rounding, not what is stored,
// not the Firestore schema, and not one historical listing. Listings have
// always stored `price` in whole USD; the currency selector is a
// data-entry convenience, and this file simply stops three copies of that
// rule from drifting apart.
//
// backend/app/mam/intent_resolver.py has its OWN IQD_PER_USD. That is a
// different runtime (Python) and a different purpose -- interpreting a
// spoken "٣٠٠ مليون" style amount during MAM intent parsing, explicitly
// never for pricing. It is deliberately NOT unified with this file: a
// browser global cannot reach the server. If the rate is ever revised,
// both this file and that constant must be updated together; each names
// the other so neither can be found alone.

(function () {
  'use strict';

  /**
   * Approximate IQD per 1 USD. A pricing-display convenience, not a live
   * FX feed -- the UI says "(Approx)" wherever it shows a converted
   * figure, and no stored value depends on the rate being current.
   */
  var IQD_PER_USD = 1310;

  /**
   * Normalises an entered amount to the whole USD integer that listings
   * store, which is what every reader (buy.html, map.html, listing.html,
   * admin.html, insights.html) already assumes.
   *
   * Math.round is deliberate and must not be dropped: dividing an IQD
   * amount by 1310 produces a long repeating decimal
   * (300,000,000 IQD -> 229007.633587786...), and an unrounded value used
   * to reach the stored submission, which only surfaced later when
   * admin.html prefilled its Add Listing price field from it.
   */
  function usdFromEntered(amount, currency) {
    var n = Number(amount) || 0;
    return currency === 'IQD' ? Math.round(n / IQD_PER_USD) : n;
  }

  /** The reverse, for "≈ N IQD" readouts. Display only; never stored. */
  function iqdFromUsd(usd) {
    return Math.round((Number(usd) || 0) * IQD_PER_USD);
  }

  window.DARWESH_IQD_PER_USD = IQD_PER_USD;
  window.darweshUsdFromEntered = usdFromEntered;
  window.darweshIqdFromUsd = iqdFromUsd;
})();
