// Darwesh Group -- About page (v5). Integrates the user-supplied cinematic
// design (DarweshGroup-About-3D-Preview.html) into the real site.
//
// LANGUAGE: unlike the supplied preview (which carried its own EN/KU/AR
// dictionaries), every static string here is a real data-i18n element --
// js/i18n.js's own applyTranslations() already handles initial load and
// re-translation on `darwesh:langchange` for all of it, no duplicate
// dictionary needed. Only the handful of strings this file sets itself at
// runtime (the selected service's name/description, the motion-toggle
// label, the 3D-model caption) go through window.t() with a small local
// EN fallback below, since window.t() returns null for English (this
// repo's convention: English lives only as inline fallback text, not a
// stored dictionary) and these particular strings are JS-driven rather
// than static data-i18n content.
//
// MOTION: vendored GSAP + ScrollTrigger (vendor/gsap/) drive every scroll
// effect via gsap.context() so it can be torn down and rebuilt cleanly
// when motion is paused/resumed or reduced-motion changes. No GSAP: every
// element simply renders in its resolved state (see css/about-story.css's
// reduced-motion block) -- the page never depends on it to be usable.
//
// 3D MODEL: vendor/three/three.module.min.js (an ES module build) is
// loaded via a dynamic import() rather than the classic global
// `window.THREE` the supplied preview used, matching how
// js/mam-entity-3d.js already consumes the exact same vendored file
// elsewhere on this site -- avoids loading Three.js twice. If the import
// fails, or WebGLRenderer construction throws, the frame's supplied
// fallback image stays visible (see .dg-model-fallback in
// css/about-story.css) -- the technology section is never left blank.
(function () {
  'use strict';
  var root = document.getElementById('dgAbout');
  if (!root || root.dataset.initialized === 'yes') return;
  if (window.__darweshAboutCleanup) window.__darweshAboutCleanup();
  root.dataset.initialized = 'yes';

  var ac = new AbortController();
  var signal = ac.signal;
  var media = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  var paused = !!(media && media.matches);
  var selection = 'properties';
  var ctx = null;
  var animationState = { progress: 0.65 };
  var model = null;

  // Fallback strings for the runtime-set bits only (see file header).
  var EN = {
    properties: 'Properties', propertiesDetail: 'Compare homes, apartments, shops and land. Arrange your next step through Darwesh Group.',
    projects: 'Projects', projectsDetail: 'Discover residential communities and commercial projects, with their available property details.',
    designService: 'Design', designServiceDetail: 'Find designers for your home, apartment, workspace or interior project.',
    engineering: 'Engineering', engineeringDetail: 'Connect with engineers and construction specialists, from plans to execution.',
    legalService: 'Legal support', legalServiceDetail: 'Reach a property lawyer for advice and review of contracts and documents.',
    cleaning: 'Cleaning', cleaningDetail: 'Arrange cleaning for a home, apartment or office with the appropriate service provider.',
    landscaping: 'Landscaping', landscapingDetail: 'Find specialists for planting, garden design and ongoing maintenance.',
    moving: 'Moving', movingDetail: 'Explore moving and transport support for your next home through the services directory.',
    furniture: 'Furniture', furnitureDetail: 'Explore furniture and home arrangement enquiries through Darwesh Group services.',
    exploreService: 'Explore this service',
    pauseMotion: 'Pause motion', resumeMotion: 'Resume motion',
    view3d: '3D architectural study', conceptShort: 'Architectural concept',
  };
  var routes = {
    properties: 'buy.html', projects: 'projects.html', designService: 'design.html',
    engineering: 'engineer.html', legalService: 'lawyer.html', cleaning: 'cleaning.html',
    landscaping: 'landscaping.html', moving: 'services.html', furniture: 'services.html',
  };
  function t(key) {
    return (window.t && window.t('about.' + key)) || EN[key] || key;
  }
  function all(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

  function updateService() {
    root.querySelector('#dgServiceName').textContent = t(selection);
    root.querySelector('#dgServiceDescription').textContent = t(selection + 'Detail');
    root.querySelector('#dgServiceLink').setAttribute('href', routes[selection]);
    all('[data-service]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.service === selection));
    });
  }
  function updateMotionLabel() {
    var btn = root.querySelector('#dgMotionToggle');
    btn.setAttribute('aria-pressed', String(paused));
    btn.querySelector('span').textContent = t(paused ? 'resumeMotion' : 'pauseMotion');
  }

  all('[data-service]').forEach(function (b) {
    b.addEventListener('click', function () { selection = b.dataset.service; updateService(); }, { signal: signal });
  });
  root.querySelector('#dgMotionToggle').addEventListener('click', function () {
    paused = !paused;
    rebuildMotion();
  }, { signal: signal });

  // Real site language switch -- js/i18n.js dispatches this after
  // applyTranslations() already re-rendered every static data-i18n
  // element; this only needs to refresh the JS-driven bits and let
  // ScrollTrigger re-measure (RTL/LTR can change section heights).
  document.addEventListener('darwesh:langchange', function () {
    updateService();
    updateMotionLabel();
    if (model) root.querySelector('#dgModelState').textContent = t('view3d');
    if (window.ScrollTrigger) requestAnimationFrame(function () { window.ScrollTrigger.refresh(); });
  }, { signal: signal });

  if (media && media.addEventListener) {
    media.addEventListener('change', function (e) { paused = e.matches; rebuildMotion(); }, { signal: signal });
  }

  function rebuildMotion() {
    if (ctx) { ctx.revert(); ctx = null; }
    var hasGsap = !!(window.gsap && window.ScrollTrigger);
    root.classList.toggle('dg-motion', !paused && hasGsap);
    if (paused || !hasGsap) {
      animationState.progress = 0.68;
      if (model) model.render(0.68);
      updateMotionLabel();
      return;
    }
    var gsap = window.gsap;
    gsap.registerPlugin(window.ScrollTrigger);
    ctx = gsap.context(function () {
      gsap.from('.dg-hero-copy', { opacity: 0, y: 18, duration: 1.1, ease: 'power2.out' });
      gsap.to('.dg-hero-image', { scale: 1.13, yPercent: 3, ease: 'none', scrollTrigger: { trigger: root.querySelector('.dg-hero'), start: 'top top', end: 'bottom bottom', scrub: 0.7 } });
      gsap.to('.dg-hero-copy', { y: -70, opacity: 0, ease: 'none', scrollTrigger: { trigger: root.querySelector('.dg-hero'), start: 'top -20%', end: 'bottom 105%', scrub: 0.6 } });
      all('[data-dg-reveal]').forEach(function (el) {
        gsap.from(el, { y: 38, opacity: 0, duration: 0.85, ease: 'power2.out', scrollTrigger: { trigger: el, start: 'top 91%', toggleActions: 'play none none none' } });
      });
      gsap.from('.dg-value', { rotationY: 30, y: 30, opacity: 0, stagger: 0.12, duration: 0.85, ease: 'power2.out', scrollTrigger: { trigger: root.querySelector('.dg-values'), start: 'top 90%' } });
      gsap.from('.dg-step', { y: 26, opacity: 0, stagger: 0.12, duration: 0.7, scrollTrigger: { trigger: root.querySelector('.dg-steps'), start: 'top 92%' } });
      var cards = all('.dg-service');
      cards.forEach(function (card, i) {
        gsap.fromTo(card,
          { rotationY: window.innerWidth > 1000 ? (i - 4) * -9 : 12, rotationZ: window.innerWidth > 1000 ? (i - 4) * -1.2 : 0, y: 60 + Math.abs(i - 4) * 8, opacity: 0 },
          { rotationY: 0, rotationZ: 0, y: 0, opacity: 1, duration: 1, ease: 'power2.out', scrollTrigger: { trigger: card, start: 'top 99%', end: 'top 65%', scrub: 0.65 } }
        );
      });
      gsap.to('.dg-city .dg-photo', { scale: 1.09, ease: 'none', scrollTrigger: { trigger: root.querySelector('.dg-city'), start: 'top bottom', end: 'bottom top', scrub: 0.9 } });
      gsap.fromTo(animationState, { progress: 0 }, {
        progress: 1, ease: 'none',
        scrollTrigger: { trigger: root.querySelector('.dg-tech'), start: 'top 90%', end: 'bottom 15%', scrub: 0.8 },
        onUpdate: function () { if (model) model.render(animationState.progress); },
      });
    }, root);
    updateMotionLabel();
  }

  // A real procedural 3D architectural study, distinct from the
  // photographic hero -- ported verbatim from the supplied design, only
  // the THREE source changed (dynamic module import instead of a global).
  function makeModel(THREE) {
    var host = root.querySelector('#dgModel'), frame = host.parentElement, renderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); } catch (e) { return null; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    frame.classList.add('dg-webgl');
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    scene.add(new THREE.HemisphereLight(0xfff8e6, 0xbab19d, 2.2));
    var light = new THREE.DirectionalLight(0xffdf9b, 3); light.position.set(8, 12, 7); scene.add(light);
    var fill = new THREE.DirectionalLight(0xffffff, 1.4); fill.position.set(-6, 4, -4); scene.add(fill);
    var group = new THREE.Group(); scene.add(group);
    var geometries = [], materials = [], wireMaterials = [], meshes = [];
    function mat(options) { var m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.63, metalness: 0.05, transparent: true }, options)); materials.push(m); return m; }
    var stone = mat({ color: 0xe4d5b9 }), bronze = mat({ color: 0x604d2d, metalness: 0.5 }), glass = mat({ color: 0x9aabb0, opacity: 0.55, metalness: 0.5, roughness: 0.17 }), wood = mat({ color: 0x886039 }), green = mat({ color: 0x586146, roughness: 0.9 }), water = mat({ color: 0x9aaea8, opacity: 0.6, roughness: 0.14, metalness: 0.45 });
    function box(w, h, d, x, y, z, material) {
      var g = new THREE.BoxGeometry(w, h, d); geometries.push(g);
      var m = new THREE.Mesh(g, material); m.position.set(x, y, z); m.userData.baseY = y; group.add(m); meshes.push(m);
      var eg = new THREE.EdgesGeometry(g), wm = new THREE.LineBasicMaterial({ color: 0xa37a37, transparent: true, opacity: 0.65 }); geometries.push(eg); wireMaterials.push(wm);
      var edges = new THREE.LineSegments(eg, wm); m.add(edges); return m;
    }
    box(10, 0.12, 7, 0, -0.12, 0, stone); box(4.9, 0.06, 1.45, 0.7, -0.01, 2.45, water);
    box(6.4, 0.2, 3.9, 0, 0.12, -0.35, stone); box(6.6, 0.2, 4.05, 0, 2.45, -0.35, stone); box(4.6, 0.26, 3.55, 0.85, 4.8, -0.45, stone);
    box(0.22, 2.15, 3.65, -3.05, 1.3, -0.4, stone); box(0.22, 2.15, 3.65, 3.05, 1.3, -0.4, stone); box(5.8, 2.1, 0.2, 0, 1.3, -2.1, stone);
    box(4.05, 2.08, 0.08, 0.85, 3.6, 1.16, glass); box(0.08, 2.08, 3.2, 3.04, 3.6, -0.45, glass); box(6, 1.98, 0.08, 0, 1.35, 1.47, glass);
    box(0.3, 2.15, 3.3, -1.47, 3.63, -0.45, stone); box(4.3, 2.15, 0.2, 0.75, 3.63, -2.07, stone);
    for (var i = 0; i < 8; i++) box(0.065, 2.1, 0.16, -2.87 + i * 0.19, 3.6, 1.15, wood);
    for (var j = 0; j < 7; j++) box(0.055, 2.08, 0.085, -2.85 + j * 0.94, 1.33, 1.52, bronze);
    for (var k = 0; k < 5; k++) box(0.05, 2.1, 0.08, -1.06 + k * 0.99, 3.58, 1.23, bronze);
    box(2, 0.09, 0.75, -1.9, 2.58, 1.19, bronze); box(2, 0.65, 0.07, -1.9, 2.95, 1.54, glass);
    box(1.1, 0.35, 0.62, 2.1, 0.4, -0.9, wood); box(1.5, 0.12, 0.65, 0.65, 0.65, 0.1, wood);
    for (var a = 0; a < 3; a++) {
      var tx = -4 + a * 4; box(0.52, 0.3, 0.52, tx, 0.12, -2.9, stone); box(0.08, 0.85, 0.08, tx, 0.65, -2.9, wood);
      var sg = new THREE.IcosahedronGeometry(0.46, 1); geometries.push(sg);
      var shrub = new THREE.Mesh(sg, green); shrub.position.set(tx, 1.12, -2.9); shrub.scale.set(0.8, 1.3, 0.8); group.add(shrub);
    }
    var grid = new THREE.GridHelper(11, 22, 0xc5a46e, 0xd6c4a5); grid.position.y = -0.18; scene.add(grid);
    var disposed = false, visible = true;
    function resize() {
      if (disposed) return;
      var w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
      render(animationState.progress);
    }
    function render(p) {
      if (disposed || !visible || document.hidden) return;
      var q = Math.max(0, Math.min(1, p)), angle = 0.65 + q * 0.58;
      camera.position.set(Math.cos(angle) * 14, 8 - q * 1.4, Math.sin(angle) * 16);
      camera.lookAt(0, 1.7, 0);
      group.rotation.y = (q - 0.5) * 0.16;
      materials.forEach(function (m) { var target = m === glass ? 0.55 : m === water ? 0.6 : 1; m.opacity = target * (0.2 + 0.8 * q); });
      wireMaterials.forEach(function (m) { m.opacity = 0.85 - q * 0.69; });
      meshes.forEach(function (m) { var y = m.userData.baseY; m.position.y = y + (y > 2.2 ? (1 - q) * 0.95 : 0); });
      renderer.render(scene, camera);
    }
    var resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
    var observer = new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; if (visible) render(animationState.progress); });
    observer.observe(host);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) render(animationState.progress); }, { signal: signal });
    host.addEventListener('webglcontextlost', function () { frame.classList.remove('dg-webgl'); }, { signal: signal, capture: true });
    resize();
    return {
      render: render,
      dispose: function () {
        disposed = true; observer.disconnect(); resizeObserver.disconnect();
        geometries.forEach(function (g) { g.dispose(); });
        materials.concat(wireMaterials).forEach(function (m) { m.dispose(); });
        grid.geometry.dispose();
        if (Array.isArray(grid.material)) grid.material.forEach(function (m) { m.dispose(); }); else grid.material.dispose();
        renderer.dispose(); renderer.domElement.remove(); frame.classList.remove('dg-webgl');
      },
    };
  }

  updateService();
  updateMotionLabel();
  rebuildMotion();

  if (window.THREE) {
    model = makeModel(window.THREE);
  } else {
    import('./vendor/three/three.module.min.js').then(function (THREE) {
      if (ac.signal.aborted) return;
      model = makeModel(THREE);
      if (model) {
        root.querySelector('#dgModelState').textContent = t('view3d');
        model.render(animationState.progress);
      }
    }).catch(function () {
      // Left in place: the frame's fallback image (see .dg-model-fallback
      // in css/about-story.css) already renders without it.
    });
  }

  function cleanup() {
    ac.abort();
    if (ctx) ctx.revert();
    if (model) model.dispose();
    if (removalObserver) removalObserver.disconnect();
    root.dataset.initialized = '';
    delete window.__darweshAboutCleanup;
  }
  window.__darweshAboutCleanup = cleanup;
  var removalObserver = new MutationObserver(function () { if (!root.isConnected) cleanup(); });
  removalObserver.observe(document.body, { childList: true, subtree: true });
})();
