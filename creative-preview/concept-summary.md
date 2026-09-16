# Darwesh Group — Creative Redesign: Concept Preview Summary

**Status: awaiting your approval. Nothing in this preview is wired into the
production site, and nothing production-facing was changed to build it.**

## 1. What this is

A visual concept preview for the full-site creative redesign you described,
built to let you react to the *direction* — palette, typography, layout,
motion — before any real implementation begins. It lives entirely in
`/creative-preview/`, isolated from every production HTML/CSS/JS file.

## 2. Preview image files

All in `creative-preview/screenshots/`, captured at 2x device scale:

| File | Scene | Size |
|---|---|---|
| `01-home-hero.png` | Home hero + search | 1440×900 |
| `02-service-universe.png` | Service Universe (9-card collection) | 1440×900 |
| `03-about-cinematic.png` | About — layered scroll depth | 1440×900 |
| `04-projects.png` | Projects browsing experience | 1440×900 |
| `05-property-map.png` | Property map (light UI) | 1440×900 |
| `06-profile.png` | Professional profile | 1440×900 |
| `07-arena-challenge.png` | Darwesh Challenge / Arena | 1440×900 |
| `08-mobile.png` | Mobile home (intentionally mobile-designed) | 390×844 |

## 3. Concept video

`video/darwesh-concept-reel.webm` — ~28 seconds, cycles through all 8 scenes
per the shot list in `storyboard.md`. WebM (not MP4): this environment's
`ffmpeg` build is Playwright's minimal internal one (webm/vp8 only, no
general-purpose H.264 encoder available), and your own spec explicitly
allowed either format. WebM plays natively in Chrome, Edge, and Firefox.

## 4. Storyboard

`storyboard.md` — full scene-by-scene breakdown (timing, motion, text,
transition, purpose) plus honest notes on what the "photography" in this
preview actually is (see §6 below).

## 5. Source files (for reference, not for production)

Each scene is a standalone HTML file sharing `preview.css` (the token
system: colors, type, buttons, cards). These are the working files the
screenshots and video were rendered from — `01-home-hero.html` through
`08-mobile.html`.

## 6. Important honesty note on imagery

**No OpenAI API key or image-generation tool was configured in this
environment** (checked `OPENAI_API_KEY` and for a connected image-gen MCP
tool — found neither). Per your own instructions, I did not fabricate the
appearance of AI-generated photography. Every "photograph" you see in this
preview — the skyline behind the hero, the service category cards, the
about-page depth layers — is a **CSS gradient + abstracted SVG silhouette**,
built to communicate composition, color grading, and hierarchy only.

The one real asset used throughout is `images/brand/darwesh-mark.png` (your
actual logo mark), reused as-is in every scene's navigation.

If you approve this direction, the next step is generating real photography
to the same brief — architectural, warm-neutral, natural light, no
oversaturation — via a proper prompt-and-review pipeline (asset manifest,
named files, staging → review → approved folders), exactly as your original
spec described. That pipeline is not built yet; this preview only proves
out the layout, palette, and motion language it would slot into.

## 7. What came from your original redesign spec

- Palette: deep charcoal + warm ivory + restrained gold (not "every button
  gold" — gold reserved for primary actions and rank/emphasis)
- Typography: a display serif paired with a clean geometric sans
- "One coordinated campaign" treatment for the Service Universe cards,
  using the tagline pattern you gave as examples (Engineering — "Built
  with confidence.", Legal — "Clarity at every step.", Landscaping — "Make
  space grow.")
- Apple-inspired button system: pill shape, soft depth, restrained gold
  only on primary actions
- Cinematic layered-scroll concept for About
- Explicit light/dark surface split (map = light editorial, everything
  else = dark) per your "warm ivory where light UI is used" note
- Mobile designed as its own layout (bottom nav, floating MAM AI action,
  condensed hero), not desktop shrunk down
- The real-listing-vs-marketing-imagery distinction from your spec is
  preserved conceptually: the map scene never invents a real listing —
  its "$185,000 · 3 bed villa" card is clearly a placeholder pattern, not
  live data

## 8. What would change on the real website if approved

Only what you scope per-phase. Nothing is implied to happen all at once.
Based on your own phased order:
- **Phase 2**: Home hero + global button/nav system (`js/site-header.js`,
  `js/site-mobile-nav.js`, a new shared button stylesheet)
- **Phase 3**: Service Universe (`js/services-carousel.js` and
  `css/services-carousel.css` already exist from an earlier design pass —
  they'd be evaluated against this new direction, not assumed obsolete)
- **Phase 4**: About (`about.html`) + Projects
- **Phase 5**: Map shell (`map.html`) — chrome/controls only; **real listing
  data and imagery are never touched or replaced**
- **Phase 6**: Profile pages (agent/office/organization/professional roles)
  + Arena/Challenge
- **Phase 7**: Mobile/i18n/performance consistency pass across everything above

## 9. What stays untouched, always

- **All real property/listing photography** — uploaded by agents and
  owners. Never replaced by generated imagery, per your explicit rule.
- All backend logic, Firestore rules, and data models — this is a visual
  layer proposal only.
- The existing `design-preview/` folder (an earlier, separate design
  exploration for the services carousel) — not touched or reused; this new
  work lives in its own `creative-preview/` folder specifically to avoid
  any collision with that prior work.
- Any already-shipped feature (Brokerage Discounts, Area Alerts, Darwesh
  Arena backend, etc.) — none of this preview implies functional changes.

## 10. Next step

Nothing has been committed or pushed. Review the 8 images and the video,
tell me what to keep/change/drop, and when you're ready say:

**"Approved — implement it."**

I'll then come back with a concrete phase-by-phase implementation plan
(starting with Phase 1's full audit + `creative/` brand system docs, as
your original spec asked for) before touching any production file.
