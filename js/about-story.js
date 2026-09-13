// Darwesh Group -- About page scroll choreography (v4, full reset).
//
// PRIMARY PATH: vendored GSAP + ScrollTrigger (vendor/gsap/, see its
// README) drive every pinned scene's scrub (Hero/Connect/Journey/
// Ecosystem) and gate every other scene's reveal through
// ScrollTrigger.create({ once: true, onEnter }) -- a robust replacement
// for IntersectionObserver that still fires correctly for content already
// scrolled past on a hash jump or a restored scroll position.
//
// FALLBACK PATH: if either vendored script fails to load, every reveal
// below falls through to a plain IntersectionObserver, and every pinned
// scene simply renders its final resolved state without a pin (no scrub
// var is possible without GSAP's scroll math -- the CSS default takes
// over via each scene's `:not([style*="--xp"])` rule in
// css/about-story.css). Nothing on this page ever depends on GSAP to be
// legible.
//
// REDUCED MOTION: prefers-reduced-motion skips this file's scene wiring
// entirely -- css/about-story.css's reduced-motion block already renders
// every scene's finished state with zero JS involvement.
(function () {
  const HAS_GSAP = !!(window.gsap && window.ScrollTrigger);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMobile = window.innerWidth < 760;

  if (HAS_GSAP) {
    window.gsap.registerPlugin(window.ScrollTrigger);
  }

  // ---------------------------------------------------------------------
  // Shared reveal helper -- GSAP ScrollTrigger.create when available,
  // IntersectionObserver otherwise, immediate activation if neither
  // exists. Used for every "fires once when scrolled into view" moment.
  // ---------------------------------------------------------------------
  function onceInView(el, activate, opts) {
    opts = opts || {};
    if (!el) return;
    if (HAS_GSAP) {
      window.ScrollTrigger.create({
        trigger: el,
        start: opts.start || 'top 82%',
        once: true,
        onEnter: activate,
      });
    } else if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              activate();
              io.unobserve(entry.target);
            }
          });
        },
        { threshold: opts.threshold || 0.15, rootMargin: '0px 0px -8% 0px' }
      );
      io.observe(el);
    } else {
      activate();
    }
  }

  function wireReveal(list, staggerMs) {
    list.forEach((el, i) => {
      onceInView(el, () => {
        if (staggerMs) {
          setTimeout(() => el.classList.add('is-active'), i * staggerMs);
        } else {
          el.classList.add('is-active');
        }
      });
    });
  }

  // Pins a section and scrubs `varName` (0->1) as a CSS custom property on
  // it -- the one shared mechanic behind Hero/Connect/Journey/Ecosystem.
  // Every visual step for that scene is pure CSS calc() keyed off the var
  // (see css/about-story.css), so GSAP never writes inline styles on the
  // animated elements themselves -- nothing for a stray CSS `transition`
  // to fight.
  function pinScrub(id, varName, distance, onUpdate) {
    const pin = document.getElementById(id);
    if (!pin || !HAS_GSAP) return;
    pin.style.setProperty(varName, '0');
    window.ScrollTrigger.create({
      trigger: pin,
      start: 'top top',
      end: distance,
      pin: true,
      pinSpacing: true,
      scrub: 0.6,
      onUpdate(self) {
        pin.style.setProperty(varName, self.progress.toFixed(4));
        if (onUpdate) onUpdate(self.progress);
      },
    });
  }

  // ---------------------------------------------------------------------
  // Scene 1 -- Hero.
  // ---------------------------------------------------------------------
  function initHero() {
    pinScrub('dwaHeroPin', '--hp', isMobile ? '+=170%' : '+=300%');
  }

  // ---------------------------------------------------------------------
  // Scene 2 -- Story. Three verbs cross-dissolve once in view, then the
  // answer settles in.
  // ---------------------------------------------------------------------
  function initStory() {
    const story = document.getElementById('dwaStory');
    if (!story) return;
    const verbs = Array.prototype.slice.call(story.querySelectorAll('.dwa-story-verb'));
    const inner = story.querySelector('.dwa-story-inner');

    function run() {
      let i = 0;
      verbs.forEach((v) => v.classList.remove('is-active'));
      (function step() {
        verbs.forEach((v) => v.classList.remove('is-active'));
        if (verbs[i]) verbs[i].classList.add('is-active');
        i += 1;
        if (i < verbs.length) {
          setTimeout(step, 850);
        } else if (inner) {
          setTimeout(() => inner.classList.add('is-active'), 500);
        }
      })();
    }

    onceInView(story, run, { start: 'top 75%', threshold: 0.3 });
  }

  // ---------------------------------------------------------------------
  // Scene 3 -- Connect. Property/People/Professionals/Services nodes join
  // via gold lines, scrubbed via --cp.
  // ---------------------------------------------------------------------
  function initConnect() {
    pinScrub('dwaConnectPin', '--cp', isMobile ? '+=90%' : '+=140%');
  }

  // ---------------------------------------------------------------------
  // Scene 4 -- Journey. Plan -> Design -> Build -> Live, scrubbed via
  // --jp; the rail fill and the "current stage" highlight both derive
  // from the same progress value.
  // ---------------------------------------------------------------------
  function initJourney() {
    const railFill = document.getElementById('dwaJourneyRailFill');
    const stages = Array.prototype.slice.call(document.querySelectorAll('#dwaJourneyStages .dwa-journey-stage'));
    pinScrub('dwaJourneyPin', '--jp', isMobile ? '+=140%' : '+=200%', (progress) => {
      if (railFill) railFill.style.width = (progress * 100).toFixed(1) + '%';
      const stageIndex = Math.min(stages.length - 1, Math.floor(progress * stages.length));
      stages.forEach((s, i) => s.classList.toggle('is-current', i === stageIndex));
    });
    if (!HAS_GSAP) {
      if (railFill) railFill.style.width = '100%';
      stages.forEach((s) => s.classList.add('is-current'));
    }
  }

  // ---------------------------------------------------------------------
  // Scene 5 -- Ecosystem. Central Darwesh node, real services fan out,
  // scrubbed via --ep.
  // ---------------------------------------------------------------------
  function initEcosystem() {
    pinScrub('dwaEcosystemPin', '--ep', isMobile ? '+=170%' : '+=240%');
  }

  // ---------------------------------------------------------------------
  // Scene 6 -- Professionals. Real cards, staggered reveal.
  // ---------------------------------------------------------------------
  function initPros() {
    wireReveal(Array.prototype.slice.call(document.querySelectorAll('#dwaProsGrid .dwa-pro-card')), 120);
  }

  // ---------------------------------------------------------------------
  // Scene 7 -- Technology. The physical world's connections resolve into
  // a graph once in view.
  // ---------------------------------------------------------------------
  function initTech() {
    const tech = document.getElementById('dwaTech');
    if (tech) onceInView(tech, () => tech.classList.add('is-active'), { start: 'top 70%', threshold: 0.3 });
  }

  // ---------------------------------------------------------------------
  // Scene 8 -- Final. Four pillar labels converge to one statement, then
  // the five operating principles and the closing frame follow.
  // ---------------------------------------------------------------------
  function initFinal() {
    const pillars = Array.prototype.slice.call(document.querySelectorAll('#dwaFinalPillars .dwa-final-pillar'));
    const title = document.getElementById('dwaFinalTitle');
    onceInView(document.getElementById('dwaFinalSyn'), () => {
      pillars.forEach((p, i) => setTimeout(() => p.classList.add('is-active'), i * 120));
      setTimeout(() => { if (title) title.classList.add('is-active'); }, pillars.length * 120 + 150);
    }, { start: 'top 70%', threshold: 0.3 });
    wireReveal(Array.prototype.slice.call(document.querySelectorAll('#dwaValuesRow .dwa-value')), 80);
    const cityInner = document.getElementById('dwaFinalCityInner');
    onceInView(document.getElementById('dwaFinalCity'), () => cityInner && cityInner.classList.add('is-active'), { start: 'top 75%', threshold: 0.3 });
  }

  if (reduced) {
    // css/about-story.css's reduced-motion block already renders every
    // scene's finished state; nothing else on this page needs to run.
    return;
  }

  initHero();
  initStory();
  initConnect();
  initJourney();
  initEcosystem();
  initPros();
  initTech();
  initFinal();
})();
