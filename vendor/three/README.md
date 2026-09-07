# Vendored Three.js

`three.module.min.js` is the official Three.js **r160** (npm `three@0.160.0`)
production ES module build, fetched directly from the npm registry
(`https://registry.npmjs.org/three/-/three-0.160.0.tgz`, `package/build/three.module.min.js`)
and committed as-is -- license header intact, nothing else modified.

Why vendored instead of loaded from a CDN (unpkg, jsdelivr, etc.): the MAM
AI Command Center's living entity is the primary experience on
`mam-ai.html`, not a decorative extra -- if a CDN request fails or is slow,
the page must not depend on it to render something real. `js/mam-entity-3d.js`
now imports this local, pinned file (`./vendor/three/three.module.min.js`)
instead of `https://unpkg.com/three@.../three.module.js`; the page's CSP no
longer needs `unpkg.com` in `script-src` for this to work.

**To upgrade**: download the new version's tarball from
`https://registry.npmjs.org/three/-/three-<version>.tgz`, extract
`package/build/three.module.min.js`, replace this file, and update the
version noted here and in `js/mam-entity-3d.js`'s own header comment.
Same-origin, same pin discipline as every other exact-version dependency
already used in this repo.
