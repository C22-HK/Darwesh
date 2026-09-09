// Darwesh Group -- About page "Darwesh World" ecosystem renderer.
//
// Builds both the desktop radial layout and the mobile accordion from the
// SAME single source of truth (js/service-catalog.js's SERVICE_CATALOG) --
// no invented services, no duplicated data. Both DOM structures are always
// rendered; css/about-cinematic.css's max-width:767px query alone decides
// which is visible, so there is no JS breakpoint branching.
//
// 'mamai' is excluded here on purpose -- it gets its own dedicated
// entrance moment immediately after this section (see about.html's inline
// MAM module), so it would otherwise appear twice on the same page.
import { SERVICE_CATALOG } from './service-catalog.js';

function tr(key, fallback) {
  return (window.t && window.t(key)) || fallback;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NODES = SERVICE_CATALOG.filter((s) => s.key !== 'mamai');

// Property & Projects is Darwesh's own core platform (real listings + real
// developer projects, both already public/queryable elsewhere on the
// site) -- not a SERVICE_CATALOG entry, since nobody "signs up" as it.
const HUB = {
  titleKey: 'about.worldHubTitle', title: 'Property & Projects',
  taglineKey: 'about.worldHubBody', tagline: 'Verified listings and developer projects across the Kurdistan Region, at the center of every other service.',
  icon: 'home_work',
  href: 'map.html',
  ctaKey: 'about.ctaMap', ctaFallback: 'Explore the Map',
};

export function initAboutEcosystem(rootEl) {
  if (!rootEl) return;

  const orbit = rootEl.querySelector('.ab-world-orbit');
  const linesSvg = rootEl.querySelector('.ab-world-lines');
  const hubEl = rootEl.querySelector('.ab-world-hub');
  const detailEl = rootEl.querySelector('.ab-world-detail');
  const accordionEl = rootEl.querySelector('.ab-world-accordion');
  if (!orbit || !linesSvg || !hubEl || !detailEl || !accordionEl) return;

  let nodeEls = [];
  let lineEls = [];
  let activeIndex = -1;

  function renderHub() {
    hubEl.innerHTML =
      '<span class="material-symbols-outlined" aria-hidden="true">' + esc(HUB.icon) + '</span>' +
      '<strong>' + esc(tr(HUB.titleKey, HUB.title)) + '</strong>';
  }

  function setRadius() {
    const w = orbit.clientWidth;
    const radius = Math.max(120, Math.round(w / 2 - 56));
    orbit.style.setProperty('--radius', radius + 'px');
  }

  function positionLines() {
    const rect = orbit.getBoundingClientRect();
    if (!rect.width) return;
    linesSvg.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    nodeEls.forEach((btn, i) => {
      const bRect = btn.getBoundingClientRect();
      const nx = bRect.left - rect.left + bRect.width / 2;
      const ny = bRect.top - rect.top + bRect.height / 2;
      const line = lineEls[i];
      if (!line) return;
      line.setAttribute('x1', String(cx));
      line.setAttribute('y1', String(cy));
      line.setAttribute('x2', String(nx));
      line.setAttribute('y2', String(ny));
    });
  }

  function renderDetail(index) {
    if (index < 0) {
      detailEl.innerHTML =
        '<h3>' + esc(tr(HUB.titleKey, HUB.title)) + '</h3>' +
        '<p>' + esc(tr(HUB.taglineKey, HUB.tagline)) + '</p>' +
        '<a href="' + esc(HUB.href) + '">' + esc(tr(HUB.ctaKey, HUB.ctaFallback)) + '</a>';
      return;
    }
    const svc = NODES[index];
    if (!svc) return;
    const href = svc.directoryHref || svc.profileHref || '#';
    detailEl.innerHTML =
      '<h3>' + esc(tr(svc.titleKey, svc.title)) + '</h3>' +
      '<p>' + esc(tr(svc.taglineKey, svc.tagline)) + '</p>' +
      '<a href="' + esc(href) + '">' + esc(tr(svc.ctaKey, svc.ctaFallback)) + '</a>';
  }

  function selectNode(index) {
    activeIndex = activeIndex === index ? -1 : index;
    nodeEls.forEach((b, i) => b.setAttribute('aria-pressed', String(i === activeIndex)));
    lineEls.forEach((l, i) => l.classList.toggle('is-active', i === activeIndex));
    renderDetail(activeIndex);
  }

  function previewNode(index) {
    if (activeIndex !== -1) return; // a committed selection wins over a hover preview
    renderDetail(index);
  }

  function clearPreview() {
    if (activeIndex === -1) renderDetail(-1);
  }

  function renderNodes() {
    orbit.querySelectorAll('.ab-world-node').forEach((n) => n.remove());
    linesSvg.innerHTML = '';
    nodeEls = [];
    lineEls = [];
    const fineHover = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    NODES.forEach((svc, i) => {
      const angle = (360 / NODES.length) * i - 90;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ab-world-node';
      btn.style.setProperty('--angle', angle + 'deg');
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', tr(svc.titleKey, svc.title));
      btn.innerHTML =
        '<span class="material-symbols-outlined" aria-hidden="true">' + esc(svc.fallbackIcon || svc.icon) + '</span>' +
        '<span class="ab-world-node-label" aria-hidden="true">' + esc(tr(svc.titleKey, svc.title)) + '</span>';
      btn.addEventListener('click', () => selectNode(i));
      if (fineHover) {
        btn.addEventListener('mouseenter', () => previewNode(i));
        btn.addEventListener('mouseleave', clearPreview);
      }
      btn.addEventListener('focus', () => previewNode(i));
      btn.addEventListener('blur', clearPreview);
      orbit.appendChild(btn);
      nodeEls.push(btn);

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      linesSvg.appendChild(line);
      lineEls.push(line);
    });
  }

  function renderAccordion() {
    accordionEl.innerHTML = '';
    const items = [HUB, ...NODES];
    items.forEach((svc) => {
      const isHub = svc === HUB;
      const href = isHub ? HUB.href : (svc.directoryHref || svc.profileHref || '#');
      const item = document.createElement('div');
      item.className = 'ab-world-acc-item';
      item.dataset.open = 'false';
      item.innerHTML =
        '<button type="button" class="ab-world-acc-trigger" aria-expanded="false">' +
          '<span class="material-symbols-outlined" aria-hidden="true">' + esc(svc.fallbackIcon || svc.icon) + '</span>' +
          '<span class="ab-world-acc-title">' + esc(tr(svc.titleKey, svc.title)) + '</span>' +
          '<span class="material-symbols-outlined ab-world-acc-chevron" aria-hidden="true">expand_more</span>' +
        '</button>' +
        '<div class="ab-world-acc-panel">' +
          '<div class="ab-world-acc-panel-inner">' +
            '<p>' + esc(tr(svc.taglineKey, svc.tagline)) + '</p>' +
            '<a href="' + esc(href) + '">' + esc(tr(svc.ctaKey, svc.ctaFallback)) + '</a>' +
          '</div>' +
        '</div>';
      const trigger = item.querySelector('.ab-world-acc-trigger');
      trigger.addEventListener('click', () => {
        const willOpen = item.dataset.open !== 'true';
        accordionEl.querySelectorAll('.ab-world-acc-item').forEach((other) => {
          other.dataset.open = 'false';
          other.querySelector('.ab-world-acc-trigger').setAttribute('aria-expanded', 'false');
        });
        if (willOpen) {
          item.dataset.open = 'true';
          trigger.setAttribute('aria-expanded', 'true');
        }
      });
      accordionEl.appendChild(item);
    });
  }

  function renderAll() {
    activeIndex = -1;
    renderHub();
    renderNodes();
    renderAccordion();
    renderDetail(-1);
    setRadius();
    positionLines();
  }

  renderAll();

  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      setRadius();
      positionLines();
    });
  }, { passive: true });

  document.addEventListener('darwesh:langchange', renderAll);
}
