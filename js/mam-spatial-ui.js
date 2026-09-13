// MAM AI Command Center -- the spatial task/result layer around the
// living entity (js/mam-entity-3d.js). This is presentation only: it
// listens to js/mam-chat-panel.js's `onSpatialEvent` hook, which fires
// at real turn-lifecycle moments that module already reaches for its
// own reasons (a turn was sent, a real backend reply arrived, a real
// navigation is about to happen, a turn failed) -- never a second,
// parallel progress system, and never anything invented ahead of what
// the backend actually returned.
//
// HONESTY RULES this file follows (Part "SPATIAL AI UI" / "REAL
// ACTIONS" of the brief):
//   1. Task nodes are built ONLY from fields really present on the
//      REAL MapAction/cards a turn produced (js/mam-chat-panel.js's own
//      applyMapAction() comment documents the exact filter vocabulary:
//      q/types/deal/maxPrice/minPrice/beds/verified -- the SAME keys
//      backend/app/mam/orchestrator.py's _search_filters_action emits).
//      Nothing here guesses a filter the backend didn't report.
//   2. The single "Searching…" node shown while a turn is in flight
//      reflects a REAL request that is genuinely in flight (sendMamChat
//      really is awaiting a response) -- it is never a fabricated
//      multi-step progress bar for a backend that only ever answers
//      once, in one response. The stagger on the nodes/cards that
//      REPLACE it once the real reply lands is a presentation choice
//      (Part 24's "the visual experience may be fantastical; the
//      information must remain factual"), not a claim that the backend
//      resolved them one at a time.
//   3. Result cards render the EXACT `data.cards` array
//      js/mam-chat-panel.js's own transcript log already renders --
//      this is a second, cinematic VIEW of that same real data, never a
//      second data source.
//   4. The map/sell "beam" plays only when a turn's OWN real MapAction
//      is about to navigate the visitor there (the 'navigate' event),
//      and never delays that navigation -- purely decorative, additive.
import { PROFESSIONAL_PAGES } from './mam-chat-panel.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  let s = tr(key, fallback);
  if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
  return s;
}
function fmtPrice(p) {
  if (typeof p !== 'number' || Number.isNaN(p)) return null;
  return '$' + Math.round(p).toLocaleString();
}
function ensureStylesheet() {
  const already = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .some((l) => (l.getAttribute('href') || '').includes('mam-spatial-ui.css'));
  if (already) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/mam-spatial-ui.css', import.meta.url).href;
  document.head.appendChild(link);
}

// Real filter vocabulary only -- see this file's header comment. `map.*`
// keys are the SAME ones buy.html/map.html's own filter UI already uses
// for these exact property types (reused, not duplicated); a type this
// build has no key for (there are two narrow gaps -- townhouse/retail --
// pre-existing in js/i18n.js, unrelated to this task) still shows its
// real value rather than a blank or invented label.
function filtersToNodeLabels(filters) {
  if (!filters) return [];
  const out = [];
  if (filters.q) out.push((window.cityLabel && window.cityLabel(filters.q)) || filters.q);
  if (Array.isArray(filters.types)) {
    filters.types.forEach((t) => {
      const cap = String(t).charAt(0).toUpperCase() + String(t).slice(1);
      out.push(tr('map.' + t, cap));
    });
  }
  if (filters.deal === 'rent') out.push(tr('map.rentToggle', 'Rent'));
  if (typeof filters.maxPrice === 'number') out.push(trf('mamai.spatial.underPrice', 'Under {price}', { price: fmtPrice(filters.maxPrice) }));
  if (typeof filters.minPrice === 'number') out.push(trf('mamai.spatial.overPrice', 'Over {price}', { price: fmtPrice(filters.minPrice) }));
  // Reuses the exact same chat-context "N beds" phrasing/translation
  // js/mam-chat-panel.js's own transcript already uses (mam.beds) --
  // never a near-duplicate string.
  if (typeof filters.beds === 'number') out.push(trf('mam.beds', '{n} beds', { n: filters.beds }));
  if (filters.verified) out.push(tr('map.verifiedOnly', 'Verified only'));
  return out;
}

function buildResultCard(card) {
  const a = document.createElement('a');
  a.className = 'mam-result-card';
  if (card.kind === 'property') {
    a.href = 'listing.html?id=' + encodeURIComponent(card.listingId);
    const media = document.createElement('div');
    media.className = 'mam-result-media';
    if (card.imageUrl) {
      const img = document.createElement('img');
      img.src = card.imageUrl; img.alt = ''; img.loading = 'lazy';
      media.appendChild(img);
    } else {
      media.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">home_work</span>';
    }
    a.appendChild(media);
    const body = document.createElement('div');
    body.className = 'mam-result-body';
    const t = document.createElement('p');
    t.className = 'mam-result-title';
    t.textContent = card.title || tr('mam.property', 'Property');
    body.appendChild(t);
    const price = fmtPrice(card.price);
    if (price) {
      const p = document.createElement('p');
      p.className = 'mam-result-sub';
      p.textContent = price + (card.dealType === 'rent' ? tr('mam.perMonth', ' / mo') : '');
      body.appendChild(p);
    }
    a.appendChild(body);
    return a;
  }
  if (card.kind === 'professional') {
    const page = PROFESSIONAL_PAGES[card.serviceType];
    if (!page) return null;
    a.href = page + '?id=' + encodeURIComponent(card.providerId);
    const media = document.createElement('div');
    media.className = 'mam-result-media';
    media.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">badge</span>';
    a.appendChild(media);
    const body = document.createElement('div');
    body.className = 'mam-result-body';
    const t = document.createElement('p');
    t.className = 'mam-result-title';
    // Professional cards carry `displayName`, never `name` (see
    // backend/app/mam/routes.py's _serialize_card) -- js/mam-chat-panel.js's
    // own buildRefCard had this exact field name wrong until this pass.
    t.textContent = card.displayName || tr('mam.professional', 'Professional');
    body.appendChild(t);
    if (card.city) {
      const p = document.createElement('p');
      p.className = 'mam-result-sub';
      p.textContent = card.city;
      body.appendChild(p);
    }
    a.appendChild(body);
    return a;
  }
  if (card.kind === 'project') {
    a.href = 'map.html?city=' + encodeURIComponent(card.city || '');
    const media = document.createElement('div');
    media.className = 'mam-result-media';
    media.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">apartment</span>';
    a.appendChild(media);
    const body = document.createElement('div');
    body.className = 'mam-result-body';
    const t = document.createElement('p');
    t.className = 'mam-result-title';
    t.textContent = card.name || tr('mam.project', 'Project');
    body.appendChild(t);
    a.appendChild(body);
    return a;
  }
  return null;
}

/**
 * @param {Object} opts
 * @param {Element} opts.stageEl The entity stage -- must be a positioned
 *   ancestor (position:relative/absolute); the map/sell beam anchors to it.
 * @param {Element} opts.nodesHost Empty container for task-node chips.
 * @param {Element} opts.resultsHost Empty container for materializing result cards.
 */
export function createSpatialUI({ stageEl, nodesHost, resultsHost }) {
  ensureStylesheet();

  const beam = document.createElement('div');
  beam.className = 'mam-spatial-beam';
  beam.setAttribute('aria-hidden', 'true');
  stageEl.appendChild(beam);
  beam.addEventListener('animationend', () => beam.classList.remove('is-active'));

  function clearNodes() { nodesHost.innerHTML = ''; }
  function clearResults() { resultsHost.innerHTML = ''; }

  function addNode(label, state, index) {
    const n = document.createElement('span');
    n.className = 'mam-node';
    n.dataset.state = state;
    n.style.animationDelay = Math.min(index, 6) * 70 + 'ms';
    const dot = document.createElement('span');
    dot.className = 'mam-node-dot';
    n.appendChild(dot);
    const text = document.createElement('span');
    text.textContent = label;
    n.appendChild(text);
    nodesHost.appendChild(n);
    return n;
  }

  function renderResults(cards) {
    clearResults();
    if (!cards || !cards.length) return;
    const kinds = new Set(cards.map((c) => c.kind));
    const headingKey = kinds.has('professional') && !kinds.has('property')
      ? ['mamai.spatial.professionalsHeading', 'Professionals']
      : ['mamai.spatial.propertiesHeading', 'Properties'];
    const heading = document.createElement('p');
    heading.className = 'mam-spatial-results-heading';
    heading.textContent = tr(headingKey[0], headingKey[1]);
    resultsHost.appendChild(heading);
    // A separate inner row for the cards themselves (never the heading) --
    // desktop's own CSS keeps this row as the same grid it always was;
    // mobile (css/mam-spatial-ui.css) turns ONLY this row into a one-
    // dominant-card horizontal swipe strip, matching the exact "never four
    // tiny cards across a phone screen" pattern already established for
    // the spatial choice cards. Presentation-only restructuring -- the
    // cards themselves, their data and their real listing.html/profile
    // links are unchanged.
    const row = document.createElement('div');
    row.className = 'mam-spatial-results-row';
    resultsHost.appendChild(row);
    cards.forEach((card, i) => {
      const el = buildResultCard(card);
      if (!el) return;
      el.style.animationDelay = Math.min(i, 8) * 90 + 'ms';
      row.appendChild(el);
    });
  }

  function fireBeam() {
    beam.classList.remove('is-active');
    void beam.offsetWidth; // restart the animation on repeated navigations
    beam.classList.add('is-active');
  }

  function onStart() {
    clearNodes();
    clearResults();
    addNode(tr('mamai.spatial.searching', 'Searching…'), 'pending', 0);
  }

  function onResult({ cards = [], mapAction, message }) {
    clearNodes();
    const isSell = mapAction && mapAction.target === 'sell.html';
    const isPureMapNav = mapAction && mapAction.target === 'map.html' && !message;
    const labels = filtersToNodeLabels(mapAction && mapAction.filters);
    labels.forEach((label, i) => addNode(label, 'done', i));

    if (isSell) {
      addNode(tr('mamai.spatial.openingSell', 'Opening Sell…'), 'done', labels.length);
    } else if (isPureMapNav) {
      addNode(tr('mamai.spatial.openingMap', 'Opening Map…'), 'done', labels.length);
    } else if (mapAction || cards.length || labels.length) {
      // A real search/discovery turn (filters and/or cards present) --
      // show the genuine result count, zero included, never omitted.
      const countLabel = cards.length
        ? trf('mamai.spatial.resultsCount', cards.length === 1 ? '{n} result' : '{n} results', { n: cards.length })
        : tr('mamai.noResults', 'No results found.');
      addNode(countLabel, cards.length ? 'done' : 'error', labels.length);
    }
    // A plain conversational reply with no filters/cards/mapAction has
    // nothing real to track -- the "Searching…" node is simply cleared,
    // never replaced with an invented one.

    renderResults(cards);
  }

  function onError({ message }) {
    clearNodes();
    if (message) addNode(message, 'error', 0);
    clearResults();
  }

  return {
    onEvent(type, payload) {
      if (type === 'start') onStart();
      else if (type === 'result') onResult(payload || {});
      else if (type === 'navigate') fireBeam();
      else if (type === 'error') onError(payload || {});
    },
    destroy() {
      beam.remove();
      clearNodes();
      clearResults();
    }
  };
}
