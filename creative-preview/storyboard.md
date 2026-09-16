# Darwesh Group — Creative Concept Preview: Storyboard

Status: **PREVIEW ONLY.** Nothing in this folder is wired into the production
site. No production file was modified to build this preview. This document
maps the ~24-second concept reel (`video/darwesh-concept-reel.webm`) scene by
scene, and doubles as the shot list for the 8 static concept images in
`screenshots/`.

Visual system used throughout: deep charcoal (`#14171c`) + warm ivory
(`#f7f2e8`), restrained gold accent (`#c9a227`) reserved for primary actions
and emphasis, `Fraunces` (display serif) paired with `Manrope` (body/UI sans).
Full token list in `preview.css`.

---

## Scene 01 — Logo intro
**0:00–0:03**
- Page/section: title card, no site chrome
- Camera/motion: slow fade-in on the Darwesh mark, soft upward drift (8px), 1.5s ease
- Text: "Darwesh Group"
- Image: dark charcoal ground, no imagery — the mark carries the moment
- Transition out: cross-fade to Scene 02
- Purpose: establish the palette and pace before any content — quiet, not loud

## Scene 02 — Home hero
**0:03–0:07**
- Page/section: `01-home-hero.html`
- Camera/motion: slow push-in (scale 1.0 → 1.04) on the skyline silhouette; headline and search pill rise in with a 60ms stagger
- Text: "Kurdistan's next chapter, built well."
- Image: abstracted skyline silhouette over a warm gold-to-charcoal gradient (CSS/SVG placeholder — see Image Notes below)
- Transition: soft horizontal wipe into Scene 03
- Purpose: the thesis frame — what Darwesh Group is, in one held shot

## Scene 03 — Service Universe
**0:07–0:11**
- Page/section: `02-service-universe.html`
- Camera/motion: the 9-card grid drifts left-to-right at a slow, constant speed (a "shelf" pan), cards keep a fixed 18px gap so nothing crowds
- Text: card labels only ("Engineering — Built with confidence.", etc.) — no narration text
- Image: one coordinated set of tinted gradient cards, each carrying its category's accent hue but the same grain/vignette treatment, so the set reads as one campaign
- Transition: cross-fade into Scene 04
- Purpose: show breadth (9 services) without it feeling like 9 different products

## Scene 04 — About: cinematic depth
**0:11–0:15**
- Page/section: `03-about-cinematic.html`
- Camera/motion: three text layers ("Architecture" / "People" / headline) at different depths and blur, drifting at different speeds (parallax) — the classic "layered scroll" moment frozen mid-transition
- Text: "Rooted in Kurdistan. Built for what's next."
- Image: no photography — pure typographic depth on a warm-dark gradient, deliberately quiet
- Transition: fade to black, then up into Scene 05
- Purpose: this is the emotional/brand beat, not a feature demo — give it room

## Scene 05 — Map + Save as Alert
**0:15–0:19**
- Page/section: `05-property-map.html`
- Camera/motion: a marker pulses once, the "Save as Alert" button gets a brief highlight ring, listing card slides up from the bottom-right
- Text: none (UI speaks for itself)
- Image: light ivory map surface with abstract parcel shapes — explicitly not real geographic data
- Transition: cross-fade into Scene 06
- Purpose: show the light-mode surface (contrast with the dark scenes) and one concrete interaction (saving an area alert)

## Scene 06 — Profile → Challenge → Projects montage
**0:19–0:23**
- Page/section: `06-profile.html`, `07-arena-challenge.html`, `04-projects.html` (quick 3-up montage, ~1.3s each)
- Camera/motion: each frame does a small scale-up (1.0 → 1.02) then hard-cuts to the next — the only place in the reel with a harder cut, to signal "here's the rest of the system" without slowing down
- Text: none
- Image: profile trust panel, leaderboard/rank ring, project hero card
- Transition: fade to charcoal
- Purpose: prove the system extends past the homepage — professionals, gamification, and projects all share the same language

## Scene 07 — Mobile
**0:23–0:24.5**
- Page/section: `08-mobile.html`
- Camera/motion: device-shaped frame slides up from the bottom, settles
- Text: none
- Image: condensed mobile hero + bottom nav + floating MAM AI action button
- Transition: fade to black
- Purpose: confirm the system was designed for mobile, not just shrunk onto it

## Scene 08 — Closing frame
**0:24.5–0:25**
- Page/section: title card
- Camera/motion: static hold
- Text: "DARWESH GROUP — People. Property. Possibility."
- Image: charcoal ground, gold mark
- Transition: hard cut to black (end)
- Purpose: sign-off

---

## Image notes (read before judging the visuals)

**No OpenAI/image-generation connection was available in this environment**
(checked `OPENAI_API_KEY` and for a configured image-gen MCP tool — neither
was present). Every "photograph" in this preview is a CSS gradient +
abstracted SVG silhouette, not a generated or real photo. They exist only to
communicate composition, color, and hierarchy — not final imagery.

If this direction is approved, the CSS placeholders get replaced by real
generated (or licensed/shot) photography using the prompt briefs that would
be written in `creative/asset-manifest.json` as part of full implementation
— see `concept-summary.md` for what that next step looks like.

## What was reused from the real site (not fabricated)
- `images/brand/darwesh-mark.png` — the real Darwesh mark, used as-is in every scene's nav.
- Copy voice, city names (Erbil, Sulaymaniyah, Duhok, Halabja), and page/section names — taken from the actual site structure, not invented.
