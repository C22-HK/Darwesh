// Builds css/tailwind.css (committed, served as a static file by GitHub
// Pages) -- replaces the unpinned "latest" Play CDN script every page used
// to load (INFRA-03, INFRASTRUCTURE_REMEDIATION.md). Nothing here runs at
// request time; this is a build-time-only dependency, run locally or in CI
// before a deploy, never in the browser or on the server.
//
// theme.extend below is copied verbatim from the `tailwind.config` object
// every page previously embedded inline for the Play CDN to read at
// runtime (all 21 pages carried the identical set of colors/spacing/
// fontFamily/fontSize, confirmed by diffing each page's block against
// index.html's) -- this build must keep producing the exact same utility
// classes with the exact same values, not a redesign.
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  // Every page (*.html) plus every script that can add a Tailwind class
  // name to the DOM at runtime (js/**/*.js) -- Tailwind's scanner treats
  // both as plain text, so a class name that only ever appears inside a
  // JS template literal (e.g. admin.html/agent-dashboard.html's ternary-
  // built badge/pin classes) is still found, as long as the full literal
  // string appears somewhere in one of these files. Confirmed by manual
  // audit that this codebase never constructs a Tailwind class name via
  // runtime string interpolation (e.g. `bg-${color}-500`) -- every
  // dynamic class site found was a ternary between two complete literal
  // strings, both already present verbatim in these files.
  content: ["./*.html", "./js/**/*.js"],
  theme: {
    extend: {
      colors: {
        // ---- DARWESH GROUP brand system (global color migration) -------
        // Deep Navy / Warm Ivory / Warm Gold. This `colors` block is the
        // one real source of truth for every non-cinematic page (in
        // practice: admin.html and agent-dashboard.html -- every other
        // page carries `cine-scope`, which overrides these same semantic
        // roles via its own tokens in css/cinematic.css; see that file's
        // header comment for the parallel light-migration there). Values
        // below are the same on both layers so the two never disagree.
        // error/error-container and tertiary*/on-tertiary* (the
        // success-green family) are UNCHANGED -- semantic status colors,
        // out of scope for this migration.
        // ---- DARK LUXURY CORRECTION (obsidian, not navy) ----------------
        // The prior pass (Deep Navy #071D33/#0D263B/#132E45) read as
        // corporate blue at the scale of a full page background -- flagged
        // and corrected. This palette instead extends `obsidian` below
        // (#0B0E12, MAM's pre-existing identity color, unchanged) into a
        // full neutral ramp, recovered from this repo's OWN pre-light-
        // migration dark theme (git history at commit e6b23a6, "Darwesh
        // signature luxury palette": Obsidian #090A0A / Carbon Black
        // #101111 / Bronzed Black #17150F) and refined per the approved
        // brief to a slightly cooler, less warm-brown neutral: Main
        // Obsidian #0B0E12 / Deep Charcoal #111315 / Elevated Dark
        // #17191B / Card Surface Dark #1C1F21 / Soft Dark Border #2B2C2A /
        // Warm Ivory #F4EFE7 / Soft Cream #DDD4C7 / secondary text #B8B0A5
        // / Darwesh Gold #C69A4B (unchanged) / Soft Gold #D4AF60. Gold
        // stays an accent only (CTAs, active/selected states, focus
        // rings) -- borders and every surface tier are neutral, never
        // navy and never gold-tinted. tertiary*/on-tertiary* (success
        // green) UNCHANGED; error*/on-error* re-tuned only for legible
        // contrast on a dark surface, still red.
        "surface-bright": "#0b0e12",
        "on-secondary-fixed-variant": "#b8b0a5",
        secondary: "#c69a4b",
        "on-secondary-fixed": "#f4efe7",
        "on-primary-fixed": "#f4efe7",
        primary: "#0b0e12",
        error: "#ff8a80",
        "inverse-primary": "#d4af60",
        "surface-container-low": "#111315",
        "on-primary-fixed-variant": "#b8b0a5",
        "tertiary-fixed": "#6bfe9c",
        "surface-variant": "#141619",
        "on-tertiary-fixed": "#00210c",
        "primary-fixed": "#17191b",
        "on-primary": "#f4efe7",
        surface: "#0b0e12",
        "surface-container-high": "#1c1f21",
        "inverse-surface": "#ddd4c7",
        "on-error-container": "#ffb4ab",
        "on-secondary": "#0b0e12",
        "error-container": "#5c1a1a",
        "inverse-on-surface": "#0b0e12",
        "on-error": "#0b0e12",
        "outline-variant": "#2b2c2a",
        outline: "#8f887c",
        "primary-container": "#17191b",
        "tertiary-container": "#0f2e1c",
        "tertiary-fixed-dim": "#4ae183",
        "primary-fixed-dim": "#f4efe7",
        "secondary-container": "#d4af60",
        "secondary-fixed-dim": "#c69a4b",
        "secondary-fixed": "#d4af60",
        "surface-dim": "#111315",
        tertiary: "#001a08",
        "surface-container-lowest": "#17191b",
        "on-background": "#f4efe7",
        "surface-container-highest": "#22262a",
        "on-tertiary-container": "#6bd99a",
        "on-primary-container": "#f4efe7",
        "on-tertiary": "#ffffff",
        "on-tertiary-fixed-variant": "#005228",
        "on-surface-variant": "#b8b0a5",
        "surface-tint": "#0b0e12",
        "on-secondary-container": "#0b0e12",
        "surface-container": "#141619",
        background: "#0b0e12",
        "on-surface": "#f4efe7",
        // Gold accent family (not part of the original M3 token set --
        // used directly, e.g. bg-gold / text-gold / border-gold).
        gold: "#c69a4b",
        "gold-hi": "#d4af60",
        obsidian: "#0b0e12",
        // Soft Stone -- alternating section backgrounds / secondary
        // cards / subtle separation (approved palette, direct utility).
        stone: "#e7ded0",
      },
      borderRadius: {
        DEFAULT: "0.125rem",
        lg: "0.25rem",
        xl: "0.5rem",
        full: "0.75rem",
      },
      spacing: {
        gutter: "24px",
        "stack-lg": "32px",
        "stack-md": "16px",
        "margin-desktop": "48px",
        "stack-sm": "8px",
        "container-max": "1280px",
        "margin-mobile": "16px",
        unit: "8px",
      },
      fontFamily: {
        "headline-md": ["Plus Jakarta Sans"],
        "label-caps": ["IBM Plex Sans"],
        "display-lg-mobile": ["Plus Jakarta Sans"],
        "body-lg": ["Inter"],
        "body-md": ["Inter"],
        "data-mono": ["Inter"],
        "display-lg": ["Plus Jakarta Sans"],
      },
      fontSize: {
        "headline-md": ["24px", { lineHeight: "32px", fontWeight: "600" }],
        "label-caps": ["12px", { lineHeight: "16px", letterSpacing: "0.05em", fontWeight: "600" }],
        "display-lg-mobile": ["32px", { lineHeight: "40px", fontWeight: "700" }],
        "body-lg": ["18px", { lineHeight: "28px", fontWeight: "400" }],
        "body-md": ["16px", { lineHeight: "24px", fontWeight: "400" }],
        "data-mono": ["14px", { lineHeight: "20px", fontWeight: "500" }],
        "display-lg": ["48px", { lineHeight: "60px", letterSpacing: "-0.02em", fontWeight: "700" }],
      },
    },
  },
  // Matches the Play CDN's `?plugins=forms,container-queries` query string
  // every page used to load.
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/container-queries")],
};
