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
        "surface-bright": "#f7f9ff",
        "on-secondary-fixed-variant": "#5d4201",
        secondary: "#775a19",
        "on-secondary-fixed": "#261900",
        "on-primary-fixed": "#0b1d2d",
        primary: "#041627",
        error: "#ba1a1a",
        "inverse-primary": "#b7c8de",
        "surface-container-low": "#f1f4f9",
        "on-primary-fixed-variant": "#38485a",
        "tertiary-fixed": "#6bfe9c",
        "surface-variant": "#e0e3e8",
        "on-tertiary-fixed": "#00210c",
        "primary-fixed": "#d2e4fb",
        "on-primary": "#ffffff",
        surface: "#f7f9ff",
        "surface-container-high": "#e5e8ee",
        "inverse-surface": "#2d3135",
        "on-error-container": "#93000a",
        "on-secondary": "#ffffff",
        "error-container": "#ffdad6",
        "inverse-on-surface": "#eef1f6",
        "on-error": "#ffffff",
        "outline-variant": "#c4c6cd",
        outline: "#74777d",
        "primary-container": "#1a2b3c",
        "tertiary-container": "#003115",
        "tertiary-fixed-dim": "#4ae183",
        "primary-fixed-dim": "#b7c8de",
        "secondary-container": "#fed488",
        "secondary-fixed-dim": "#e9c176",
        "secondary-fixed": "#ffdea5",
        "surface-dim": "#d7dadf",
        tertiary: "#001a08",
        "surface-container-lowest": "#ffffff",
        "on-background": "#181c20",
        "surface-container-highest": "#e0e3e8",
        "on-tertiary-container": "#00a656",
        "on-primary-container": "#8192a7",
        "on-tertiary": "#ffffff",
        "on-tertiary-fixed-variant": "#005228",
        "on-surface-variant": "#44474c",
        "surface-tint": "#4f6073",
        "on-secondary-container": "#785a1a",
        "surface-container": "#ebeef3",
        background: "#f7f9ff",
        "on-surface": "#181c20",
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
