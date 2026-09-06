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
        // ---- DARK LUXURY REFINEMENT (color-only restyle, current pass) --
        // Main Background #0B1117 / Deep Darwesh Navy #071D33 / Luxury
        // Navy Surface #0D263B / Elevated Navy #132E45 / Soft Dark Card
        // #172B3C / Warm Ivory #F5F0E7 / Darwesh Gold #C69A4B / Gold
        // Light #D8B667 / body copy #C9C2B8 / muted metadata #9E9A93.
        // Every M3 role below is re-pointed at one of these values only --
        // no new colors introduced, keeping this file in lockstep with
        // css/cinematic.css's .cine-scope block (the same palette, same
        // roles) so admin.html/agent-dashboard.html -- the only two pages
        // that read these raw values directly instead of through
        // cine-scope -- match the rest of the site. tertiary* (success
        // green) is UNCHANGED; error*/on-error* are re-tuned only for
        // legible contrast on a dark surface, still red. obsidian is
        // MAM's identity color and is UNCHANGED.
        "surface-bright": "#0b1117",
        "on-secondary-fixed-variant": "#afa89d",
        secondary: "#c69a4b",
        "on-secondary-fixed": "#f5f0e7",
        "on-primary-fixed": "#f5f0e7",
        primary: "#071d33",
        error: "#ff8a80",
        "inverse-primary": "#d8b667",
        "surface-container-low": "#071d33",
        "on-primary-fixed-variant": "#afa89d",
        "tertiary-fixed": "#6bfe9c",
        "surface-variant": "#172b3c",
        "on-tertiary-fixed": "#00210c",
        "primary-fixed": "#132e45",
        "on-primary": "#f5f0e7",
        surface: "#0b1117",
        "surface-container-high": "#132e45",
        "inverse-surface": "#e8e0d4",
        "on-error-container": "#ffb4ab",
        "on-secondary": "#071d33",
        "error-container": "#5c1a1a",
        "inverse-on-surface": "#071d33",
        "on-error": "#071d33",
        "outline-variant": "rgba(198,154,75,0.18)",
        outline: "#9e9a93",
        "primary-container": "#132e45",
        "tertiary-container": "#0f2e1c",
        "tertiary-fixed-dim": "#4ae183",
        "primary-fixed-dim": "#f5f0e7",
        "secondary-container": "#d8b667",
        "secondary-fixed-dim": "#c69a4b",
        "secondary-fixed": "#d8b667",
        "surface-dim": "#071d33",
        tertiary: "#001a08",
        "surface-container-lowest": "#172b3c",
        "on-background": "#f5f0e7",
        "surface-container-highest": "#132e45",
        "on-tertiary-container": "#6bd99a",
        "on-primary-container": "#f5f0e7",
        "on-tertiary": "#ffffff",
        "on-tertiary-fixed-variant": "#005228",
        "on-surface-variant": "#c9c2b8",
        "surface-tint": "#071d33",
        "on-secondary-container": "#071d33",
        "surface-container": "#0d263b",
        background: "#0b1117",
        "on-surface": "#f5f0e7",
        // Gold accent family (not part of the original M3 token set --
        // used directly, e.g. bg-gold / text-gold / border-gold).
        gold: "#c69a4b",
        "gold-hi": "#d9b76a",
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
