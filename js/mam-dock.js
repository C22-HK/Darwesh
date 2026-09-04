// MAM dock -- the ONE compact assistant surface, on every page.
//
// What this replaces: map.html used to mount a large standalone orb
// docked to the viewport edge (js/mam-properties-map.js constructing a
// MamCompanion with no mountTarget, so it landed on <body>) AND render a
// second, purely decorative orb inside its own assistant bar. Two orbs,
// two visual identities, one assistant. Every other page mounted only the
// bare orb. This module is the single compact surface for all of them:
// the living orb (js/mam-companion.js) sits INSIDE the bar, so there is
// one identity and exactly one launcher per page.
//
// Responsibilities, and deliberately only these:
//   * build the compact bar and host the orb component inside it
//   * be draggable, with a movement threshold that keeps tap-to-open and
//     drag-to-move distinguishable
//   * start in a page-appropriate default spot (bottom-safe on the map,
//     right-edge everywhere else -- see `defaultSide`) and dock sensibly
//     on release, remembering where it was put separately per page type
//   * expose the orb, the mic button and the open-target to whoever wires
//     conversation behaviour onto them
//
// It owns NO conversation, session, network or voice state -- all of that
// lives in js/mam-chat-panel.js, which this module never imports. A page
// contributes at most layout information (elements marked
// `data-mam-avoid`, and the darwesh:mam-suppress event), never a second
// implementation of anything.
import { MamCompanion } from './mam-companion.js';

// Drag threshold in CSS px. Below this a pointer sequence is a tap and
// the click is allowed through to whatever was pressed; at or above it
// the sequence is a drag and the click is swallowed, so dragging can
// never open the panel, submit anything, or start voice by accident.
const DRAG_THRESHOLD_PX = 8;
const EDGE_MARGIN = 12;
// Kept clear of the fixed mobile bottom nav this site puts on public
// pages, so the default position never lands on top of it.
const MOBILE_BOTTOM_RESERVE = 92;
const DESKTOP_BOTTOM_RESERVE = 20;
const MOBILE_BREAKPOINT = 768;

// Desktop and mobile remember separate positions: the same fraction of a
// 1440px-wide window and a 390px-wide phone are not the same place, and a
// spot chosen on one is rarely the right spot on the other.
//
// Positions are ALSO scoped by `defaultSide` ('bottom' on the map,
// 'right' everywhere else) rather than shared globally. Without this, a
// position dragged out on the map (a bottom-safe dock) would leak onto
// Home (a right-edge dock) and vice versa the next time either loaded --
// each page type keeps its own memory, and moving between the two
// contexts always shows that context's own last-chosen spot, or its
// default if none was ever chosen.
//
// Stored as fractions of the free space, not pixels, so a stored position
// still means something after a resize or an orientation change. This is
// a UI preference and nothing else -- no identifiers, no auth state, and
// certainly no coordinates.
const POS_KEY_PREFIX = 'darwesh_mam_dock_pos_v1_';

function isMobile() { return window.innerWidth < MOBILE_BREAKPOINT; }
function posKey(defaultSide) { return POS_KEY_PREFIX + defaultSide + '_' + (isMobile() ? 'mobile' : 'desktop'); }

function readStoredPos(defaultSide) {
  try {
    const raw = JSON.parse(localStorage.getItem(posKey(defaultSide)) || 'null');
    if (!raw || typeof raw.fx !== 'number' || typeof raw.fy !== 'number') return null;
    if (!Number.isFinite(raw.fx) || !Number.isFinite(raw.fy)) return null;
    return { fx: Math.min(1, Math.max(0, raw.fx)), fy: Math.min(1, Math.max(0, raw.fy)) };
  } catch { return null; }   // private mode, disabled storage, corrupt value
}
function writeStoredPos(defaultSide, fx, fy) {
  try { localStorage.setItem(posKey(defaultSide), JSON.stringify({ fx, fy })); } catch { /* nothing breaks without it */ }
}

function safeInsets() {
  // env(safe-area-inset-*) is only readable from CSS, so it is resolved
  // through a throwaway probe element rather than guessed.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
    'padding-bottom:env(safe-area-inset-bottom,0px);padding-top:env(safe-area-inset-top,0px);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const bottom = parseFloat(cs.paddingBottom) || 0;
  const top = parseFloat(cs.paddingTop) || 0;
  probe.remove();
  return { top, bottom };
}

const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';

function ensureStylesheet() {
  if (document.querySelector('link[data-mamdock-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/mam-dock.css', import.meta.url).href;
  link.setAttribute('data-mamdock-style', '1');
  document.head.appendChild(link);
}

/**
 * @param {Object} [opts]
 * @param {() => string} [opts.getLanguage]
 * @param {string} [opts.label] Visible prompt text on the bar.
 * @param {'bottom'|'right'} [opts.defaultSide] Where the dock lives before
 *   the visitor has ever moved it, and the scope its remembered position
 *   is stored under (see the POS_KEY_PREFIX comment above). 'bottom' is
 *   the map's own bottom-safe dock; 'right' -- the default -- is every
 *   other public page.
 * @param {string} [opts.bottomAnchorSelector] Only consulted when
 *   defaultSide is 'bottom': an element (e.g. map.html's own `#mapPanel`)
 *   to horizontally centre the default position over instead of the
 *   whole window. On the map, the window's own centre can land inside
 *   the listing panel that sits beside the map, not over the map at all
 *   -- this is what keeps the default actually over the map.
 * @returns {{root, orbEl, micBtn, openBtn, companion, setLabel, suppress, destroy}}
 */
export function mountMamDock({ getLanguage, label, defaultSide = 'right', bottomAnchorSelector } = {}) {
  ensureStylesheet();

  const root = document.createElement('div');
  root.className = 'mamdock';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'mamdock-open';

  // The orb component mounts INTO the bar. `interactive: false` here on
  // purpose: the orb is inside a real <button> that is already focusable
  // and already announced, so giving the orb its own role="button" and
  // tabindex would put two controls in the tab order for one action.
  const companion = new MamCompanion({ mountTarget: openBtn, getLanguage, interactive: false });

  const labelEl = document.createElement('span');
  labelEl.className = 'mamdock-label';
  labelEl.textContent = label || 'Ask MAM';
  openBtn.appendChild(labelEl);
  root.appendChild(openBtn);

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'mamdock-mic';
  micBtn.hidden = true;   // revealed only if the browser really has speech recognition
  micBtn.innerHTML = MIC_SVG;
  root.appendChild(micBtn);

  const resumeHint = document.createElement('div');
  resumeHint.className = 'mamdock-resume-hint';
  resumeHint.hidden = true;
  resumeHint.setAttribute('role', 'status');
  root.appendChild(resumeHint);

  document.body.appendChild(root);

  // ---- placement ------------------------------------------------------
  // Position is always written as explicit left/top pixels, computed from
  // the stored fractions and the CURRENT viewport, so the dock cannot end
  // up off-screen after a resize, a rotation, or a move between devices.
  function bounds() {
    const insets = safeInsets();
    const w = root.offsetWidth || 220;
    const h = root.offsetHeight || 46;
    const bottomReserve = (isMobile() ? MOBILE_BOTTOM_RESERVE : DESKTOP_BOTTOM_RESERVE) + insets.bottom;
    return {
      w, h,
      minX: EDGE_MARGIN,
      maxX: Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN),
      minY: EDGE_MARGIN + insets.top,
      maxY: Math.max(EDGE_MARGIN, window.innerHeight - h - bottomReserve)
    };
  }

  function applyPx(x, y) {
    const b = bounds();
    const cx = Math.min(b.maxX, Math.max(b.minX, x));
    const cy = Math.min(b.maxY, Math.max(b.minY, y));
    root.style.left = cx + 'px';
    root.style.top = cy + 'px';
    return { x: cx, y: cy };
  }

  function fractionsFromPx(x, y) {
    const b = bounds();
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanY = Math.max(1, b.maxY - b.minY);
    return {
      fx: Math.min(1, Math.max(0, (x - b.minX) / spanX)),
      fy: Math.min(1, Math.max(0, (y - b.minY) / spanY))
    };
  }

  // Where the dock sits before anyone has moved it -- genuinely different
  // per page type, not one universal spot:
  //
  //   'bottom' (the map): centred along the bottom, which is where an
  //   assistant bar is expected and which is clear of the map's own
  //   trailing-edge tools. Centred over `bottomAnchorSelector` (the map
  //   half specifically) rather than the whole window when one is given
  //   -- the window's own horizontal centre can land inside the listing
  //   panel beside the map on desktop, which is exactly the "must not
  //   cover listing cards" case this is written to avoid by construction.
  //
  //   'right' (every other public page): the right edge, vertically
  //   centred -- the position the standalone orb this dock replaced
  //   already used, so a returning visitor sees MAM in the place they
  //   already expect it.
  function defaultPx() {
    const b = bounds();
    if (defaultSide === 'bottom') {
      const anchor = bottomAnchorSelector && document.querySelector(bottomAnchorSelector);
      const r = anchor && anchor.getBoundingClientRect();
      const centreX = (r && r.width > 0) ? r.left + r.width / 2 : window.innerWidth / 2;
      return { x: Math.round(Math.min(b.maxX, Math.max(b.minX, centreX - b.w / 2))), y: b.maxY };
    }
    return { x: b.maxX, y: Math.round((b.minY + b.maxY) / 2) };
  }

  function place() {
    const stored = readStoredPos(defaultSide);
    if (!stored) { const d = defaultPx(); const cleared = nudgeClear(d.x, d.y); applyPx(cleared.x, cleared.y); return; }
    const b = bounds();
    applyPx(b.minX + stored.fx * (b.maxX - b.minX), b.minY + stored.fy * (b.maxY - b.minY));
  }

  // ---- collision avoidance -------------------------------------------
  // A page marks the things the dock should not cover with
  // `data-mam-avoid` -- that is the whole contract. The dock does not
  // know what a Leaflet zoom control or a map legend is, and no page
  // needs to reach into this module to describe one.
  function avoidRects() {
    return Array.from(document.querySelectorAll('[data-mam-avoid]'))
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0);
  }
  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }
  // Nudges vertically (never horizontally -- horizontal is the edge the
  // user just chose) until the dock is clear, giving up rather than
  // wandering if nothing works.
  function nudgeClear(x, y) {
    const b = bounds();
    const rects = avoidRects();
    if (!rects.length) return { x, y };
    const step = 12;
    for (let i = 0; i <= 12; i++) {
      for (const dir of (i === 0 ? [0] : [-1, 1])) {
        const cy = Math.min(b.maxY, Math.max(b.minY, y + dir * i * step));
        const candidate = { left: x, right: x + b.w, top: cy, bottom: cy + b.h };
        if (!rects.some(r => overlaps(candidate, r))) return { x, y: cy };
      }
    }
    return { x, y };
  }

  // ---- drag -----------------------------------------------------------
  let drag = null;
  let suppressNextClick = false;

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const r = root.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - r.left, offsetY: e.clientY - r.top,
      moved: false,
      captured: false
    };
    // Pointer capture is deliberately NOT taken here. While an element
    // holds the capture, the browser retargets the whole pointer sequence
    // -- and the `click` it synthesizes -- to the CAPTURING element. Taking
    // it on pointerdown therefore dispatches every tap's click on this
    // root instead of on the button that was actually pressed, so the
    // open/mic handlers never fire and the dock cannot be opened by
    // tapping at all. Capture is taken in pointermove, once the movement
    // threshold proves this is a drag and there is no click to preserve.
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;   // still a tap
      drag.moved = true;
      root.classList.add('is-dragging');
      // Now that this is definitely a drag, take the capture so moves that
      // leave the dock (over the map, off the window edge) still arrive.
      try { root.setPointerCapture(e.pointerId); drag.captured = true; } catch { /* capture unsupported -- moves still arrive while over the dock */ }
    }
    // Only once this is genuinely a drag: preventDefault here would
    // otherwise cancel the tap-to-open click on some browsers.
    e.preventDefault();
    applyPx(e.clientX - drag.offsetX, e.clientY - drag.offsetY);
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDrag = drag.moved;
    if (drag.captured) {
      try { root.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    }
    drag = null;
    root.classList.remove('is-dragging');
    if (!wasDrag) return;   // a tap: leave the click alone, it opens MAM

    // A drag must never also count as a press on what is underneath the
    // finger, so the click that follows this pointerup is swallowed once.
    suppressNextClick = true;

    const r = root.getBoundingClientRect();
    const b = bounds();
    // Snap to whichever side edge is nearer -- an assistant parked
    // half-way across the screen covers more than one parked against an
    // edge, and the edge is where it is expected to live.
    const centreX = r.left + r.width / 2;
    const snappedX = centreX < window.innerWidth / 2 ? b.minX : b.maxX;
    const cleared = nudgeClear(snappedX, r.top);
    const final = applyPx(cleared.x, cleared.y);
    const f = fractionsFromPx(final.x, final.y);
    writeStoredPos(defaultSide, f.fx, f.fy);
  }
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  root.addEventListener('click', (e) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);   // capture phase: runs before the open/mic handlers below it

  // ---- viewport changes ----------------------------------------------
  // A stored position that is fine on a laptop can be off-screen on a
  // rotated phone. Re-placing from the stored fractions re-clamps it.
  let resizeTimer = null;
  function onViewportChange() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(place, 120);
  }
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  // ---- host-page suppression ------------------------------------------
  // A page whose own gesture needs the whole screen (map.html arming the
  // circle area search) says so with this event. The dock is hidden, not
  // unmounted -- no conversation, position or voice state is lost.
  document.addEventListener('darwesh:mam-suppress', (e) => {
    const on = !!(e.detail && e.detail.suppressed);
    root.classList.toggle('is-suppressed', on);
  });

  // Position after layout has settled, so offsetWidth/Height are real.
  if (document.readyState === 'complete') place();
  else window.addEventListener('load', place, { once: true });
  requestAnimationFrame(place);

  return {
    root,
    openBtn,
    micBtn,
    orbEl: openBtn.querySelector('.mamco-orb'),
    companion,
    setLabel(text) { labelEl.textContent = text; },
    /**
     * Collapses the compact bar while the conversation overlay is up.
     * The two are one surface in two states, and both are fixed-position
     * with a user-chosen dock position, so leaving both on screen means
     * one will eventually cover the other -- and the overlay covering the
     * dock swallows taps meant for it. Hidden, never unmounted: position,
     * orb state and voice state all survive.
     */
    setCollapsed(on) { root.classList.toggle('is-collapsed', !!on); },
    /** Shows/clears the "voice needs a tap to resume" explanation (see J). */
    setResumeHint(text) {
      resumeHint.textContent = text || '';
      resumeHint.hidden = !text;
    },
    destroy() {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      companion.destroy();
      root.remove();
    }
  };
}
