// ---------------------------------------------------------------------
// "Cities & Apartments" nav dropdown — shared across every public page
// that has a #citiesNavSlot placeholder in its header nav. Fetches real
// listings from Firestore once, groups them by city, and renders a
// dropdown of every known city plus any other city that actually shows
// up in the data (so a listing added under a new city still surfaces
// here, not just the curated majors). Every city links to
// map.html?city=<city>&type=all — the map shows every deal type, so a
// city with only rentals (or only sales) still leads somewhere real
// instead of a dead end. Counts include every listing regardless of
// dealType, matching what that map view actually shows.
// ---------------------------------------------------------------------
import { db, getDocs } from './firebase-init.js';
import { collection } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const KNOWN_CITIES = ['Erbil', 'Sulaymaniyah', 'Duhok', 'Zakho', 'Soran', 'Koya', 'Halabja', 'Kirkuk'];

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

function cityLabel(city) { return (window.cityLabel && window.cityLabel(city)) || city; }

// `city` ultimately comes from listings.city in Firestore, which any
// agent account (or a direct Firestore REST write, since firestore.rules
// only checks who can write a listing, not its field content) can set to
// arbitrary text -- and this widget renders on every page site-wide via
// #citiesNavSlot, so an unescaped value here would be a zero-click,
// site-wide stored XSS. Escaped before ever reaching innerHTML.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Dynamically-injected content never gets caught by i18n.js's one-time
// data-i18n walk on DOMContentLoaded (this runs later, after an async
// Firestore fetch), so every string here is translated directly via
// tr() at render time instead of relying on data-i18n attributes.
function buildDropdownHtml(cityCounts, totalCount) {
  const cities = [...new Set([...KNOWN_CITIES, ...Object.keys(cityCounts)])]
    .map(city => ({ city, count: cityCounts[city] || 0 }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));

  const rows = cities.map(({ city, count }) => `
    <a href="map.html?city=${encodeURIComponent(city)}&type=all" class="flex items-center justify-between px-4 py-2.5 hover:bg-surface-container transition-colors">
      <span class="flex items-center gap-2 font-body-md text-[13.5px] text-on-surface">
        <span class="material-symbols-outlined text-[16px] text-on-surface-variant">location_on</span>
        ${escapeHtml(cityLabel(city))}
      </span>
      <span class="font-data-mono text-data-mono text-[12px] text-on-surface-variant">${count}</span>
    </a>`).join('');

  return `
    <a href="map.html?type=all" class="flex items-center justify-between px-4 py-2.5 border-b border-outline-variant hover:bg-surface-container transition-colors">
      <span class="font-label-caps text-label-caps text-secondary">${tr('citiesNav.allListings', 'All Listings')}</span>
      <span class="font-data-mono text-data-mono text-[12px] text-on-surface-variant">${totalCount}</span>
    </a>
    <div class="py-1 max-h-80 overflow-y-auto">${rows}</div>`;
}

function renderTrigger(slot, dropdownHtml) {
  slot.innerHTML = `
    <div class="relative">
      <button id="citiesNavBtn" type="button" class="flex items-center gap-1 font-label-caps text-label-caps text-on-surface-variant dark:text-on-surface-variant hover:text-primary transition-colors" aria-expanded="false">
        <span>${tr('citiesNav.title', 'Cities &amp; Apartments')}</span>
        <span class="material-symbols-outlined text-[18px]">expand_more</span>
      </button>
      <div id="citiesNavMenu" class="hidden absolute left-0 top-full mt-2 bg-surface-container-lowest border border-outline-variant rounded-xl shadow-lg py-1 min-w-[260px] z-50">
        ${dropdownHtml}
      </div>
    </div>`;

  const btn = slot.querySelector('#citiesNavBtn');
  const menu = slot.querySelector('#citiesNavMenu');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.classList.contains('hidden');
    document.querySelectorAll('.lang-menu').forEach(m => m.classList.add('hidden'));
    menu.classList.toggle('hidden', !willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  });
}

async function init() {
  const slots = document.querySelectorAll('#citiesNavSlot');
  if (!slots.length) return;

  let cityCounts = {};
  let totalCount = 0;
  try {
    const snap = await getDocs(collection(db, 'listings'));
    snap.forEach(d => {
      const l = d.data();
      if (l.status === 'closed') return;
      totalCount++;
      if (l.city) cityCounts[l.city] = (cityCounts[l.city] || 0) + 1;
    });
  } catch (e) {
    cityCounts = {};
    totalCount = 0;
  }

  const dropdownHtml = buildDropdownHtml(cityCounts, totalCount);
  slots.forEach(slot => renderTrigger(slot, dropdownHtml));

  document.addEventListener('darwesh:langchange', () => {
    slots.forEach(slot => renderTrigger(slot, buildDropdownHtml(cityCounts, totalCount)));
  });
}

init();
