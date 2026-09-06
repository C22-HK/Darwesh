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
        // ---- LUXURY PALETTE REFINEMENT (color-only, Home/Intro-led) -----
        // Darwesh Navy #031D39 / Deep Navy #071B2F / Warm Ivory #F3EDE3 /
        // Premium Cream #EDE3D4 / Architectural Stone #D5C7B5 / Darwesh
        // Gold #C69A4B / Gold Highlight #D8B665 / Primary Dark Text
        // #172334 / Secondary Text #70685F / White #FFFFFF. Every M3 role
        // below is re-pointed at one of these values only -- no new colors
        // introduced. tertiary* (success green) and error* (red) are
        // semantic status colors and are UNCHANGED. obsidian is MAM's
        // identity color and is UNCHANGED. on-surface now uses the softer
        // Primary Dark Text (not the fully saturated brand navy) for
        // everyday body/heading copy; primary/surfaces keep the full
        // Darwesh Navy.
        "surface-bright": "#ede3d4",
        "on-secondary-fixed-variant": "#25231f",
        secondary: "#c69a4b",
        "on-secondary-fixed": "#031d39",
        "on-primary-fixed": "#031d39",
        primary: "#031d39",
        error: "#ba1a1a",
        "inverse-primary": "#d8b665",
        "surface-container-low": "#ede3d4",
        "on-primary-fixed-variant": "#25231f",
        "tertiary-fixed": "#6bfe9c",
        "surface-variant": "#d5c7b5",
        "on-tertiary-fixed": "#00210c",
        "primary-fixed": "#d5c7b5",
        "on-primary": "#f3ede3",
        surface: "#f3ede3",
        "surface-container-high": "#d5c7b5",
        "inverse-surface": "#031d39",
        "on-error-container": "#93000a",
        "on-secondary": "#ffffff",
        "error-container": "#ffdad6",
        "inverse-on-surface": "#ede3d4",
        "on-error": "#ffffff",
        "outline-variant": "#d5c7b5",
        outline: "#70685f",
        "primary-container": "#071b2f",
        "tertiary-container": "#003115",
        "tertiary-fixed-dim": "#4ae183",
        "primary-fixed-dim": "#f3ede3",
        "secondary-container": "#d8b665",
        "secondary-fixed-dim": "#c69a4b",
        "secondary-fixed": "#d8b665",
        "surface-dim": "#d5c7b5",
        tertiary: "#001a08",
        "surface-container-lowest": "#ffffff",
        "on-background": "#172334",
        "surface-container-highest": "#d5c7b5",
        "on-tertiary-container": "#00a656",
        "on-primary-container": "#f3ede3",
        "on-tertiary": "#ffffff",
        "on-tertiary-fixed-variant": "#005228",
        "on-surface-variant": "#70685f",
        "surface-tint": "#031d39",
        "on-secondary-container": "#031d39",
        "surface-container": "#f3ede3",
        background: "#f3ede3",
        "on-surface": "#172334",
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
