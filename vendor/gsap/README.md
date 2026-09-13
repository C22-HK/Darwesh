# Vendored GSAP + ScrollTrigger

`gsap.min.js` and `ScrollTrigger.min.js` are the official GSAP **3.15.0**
production UMD builds (npm `gsap@3.15.0`), fetched directly from the npm
registry (`https://registry.npmjs.org/gsap/-/gsap-3.15.0.tgz`,
`package/dist/gsap.min.js` and `package/dist/ScrollTrigger.min.js`) and
committed as-is -- license header intact, nothing else modified.

As of this version GSAP's core library and every plugin, ScrollTrigger
included, ship under GreenSock's standard "no charge" license -- free for
commercial use, no Club GreenSock membership required. Terms:
https://gsap.com/standard-license.

Why vendored instead of loaded from a CDN (unpkg, jsdelivr, etc.), same
reasoning as `vendor/three/README.md`: the About page's scroll storytelling
is the primary experience on `about.html`, not a decorative extra -- if a
CDN request fails or is slow, the page must still render and be usable
(`js/about-story.js` also has its own no-GSAP fallback for the same
reason, so this is defense in depth, not a substitute for it). Loading
these two files as plain classic `<script>` tags means the page's CSP
`script-src` needs no third-party host added for this at all.

Load order matters: `gsap.min.js` first (defines `window.gsap`), then
`ScrollTrigger.min.js` (reads `window.gsap` and registers itself onto it
as `window.ScrollTrigger`) -- see the two `<script>` tags in `about.html`.

**To upgrade**: download the new version's tarball from
`https://registry.npmjs.org/gsap/-/gsap-<version>.tgz`, extract
`package/dist/gsap.min.js` and `package/dist/ScrollTrigger.min.js`,
replace these two files, and update the version noted here and in
`js/about-story.js`'s own header comment. Same-origin, same pin
discipline as every other exact-version dependency already used in this
repo (see `vendor/three/README.md`, `vendor/qrcode/`).
