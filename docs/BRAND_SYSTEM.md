# Darwesh Group Brand System

## Audit finding: there was no burgundy/red brand color to remove

A full sweep of every hex color in this repository (`css/*.css`, every
`*.html`, `tailwind.config.js`) found no burgundy, maroon, or red used as a
brand, CTA, or theme color anywhere. The only red-family hexes in the
codebase are semantic and were left untouched, per the standing instruction
not to blindly recolor state/map colors:

| Hex | Where | Meaning |
|---|---|---|
| `#8b0000` | `admin.html`, `map.html` | Leaflet "Draw Area" boundary stroke |
| `#c62828` / `#8f1c1c` | `admin.html`, `agent-dashboard.html` | `.pin-unverified` map pin + "Agent Listing" legend dot |
| `#ba1a1a` | `tailwind.config.js` (`error`), `css/profile-tokens.css` (`--ps-color-error`) | Material error/destructive state |

The site's actual dominant palette has been navy + gold + ivory since the
Phase 3 profile-shell token system (`css/profile-tokens.css`) and the
cinematic redesign (`css/cinematic.css`, `css/mam-companion.css`,
`css/home-world.css`): navy `#041627` as the Tailwind `primary` on every
button and header, gold `#775a19`/`#b89a63` as the accent, ivory/near-white
surfaces throughout. This work formalizes that existing palette into one
canonical, brand-named token layer rather than changing what's on screen.

## The token layer

`css/profile-tokens.css`'s `:root` block now carries a `--brand-*` alias
for each role, all pointing at colors already live elsewhere in the
codebase -- nothing here is a new hex value:

```
--brand-navy:               #041627   /* dominant surface */
--brand-navy-container:     #1a2b3c   /* raised navy surface */
--brand-navy-on:            #ffffff   /* text/icons on navy */
--brand-gold:                #b89a63  /* controlled accent */
--brand-gold-soft:          #d8bc80   /* lighter touch */
--brand-gold-on:             #1a1400  /* text on gold */
--brand-ivory:               #f2eee5  /* warm light text/surface */
--brand-ivory-surface:      #f7f9ff   /* cooler near-white page surface */
--brand-neutral-dark:        #0a0a0a  /* supporting depth */
--brand-neutral-dark-raised: #17150f
```

The same values are exported, flat and framework-agnostic, at
`docs/brand/darwesh-brand-tokens.json` -- a future iOS/Android app reads
that file rather than re-deriving hex values from screenshots.

### Two golds, deliberately

`--ps-color-secondary` (`#775a19`, container `#fed488`) is the muted
Material utility gold already used on data-dense classic pages
(`admin.html`, `agent-dashboard.html`, `buy.html`). `--brand-gold`
(`#b89a63`, "Antique Gold") is the warmer premium accent already used
throughout the cinematic consumer-facing pages and MAM. These stay
separate on purpose -- a duller gold on data screens is what keeps an
admin console legible instead of turning it into a jewelry catalog. This
matches the brief's "GOLD = controlled accent," not a wash across every
surface.

## The logo: blocked on an asset, not a decision

The authoritative logo (navy "D" wordmark with a gold bridge-arch
letterform) does not exist anywhere in this repository yet -- there is no
SVG, no favicon, no manifest, no PWA icon set. The header currently
renders "Darwesh Group" as styled text (`js/site-header.js`), not a
graphic mark.

This session has no tool that can save an image attached to the
conversation onto disk -- the same limitation that applied to a reference
photo used earlier for MAM's redesign. Given the explicit instruction to
lock the logo's geometry exactly, freehand-redrawing it from description
was ruled out rather than attempted: an approximation is not "geometry
unchanged."

**To finish this piece:** commit the logo file (SVG preferred; PNG at
1024x1024+ is workable) to the repository -- `images/brand/darwesh-logo.svg`
is a reasonable path -- and this session can wire it into the header,
favicon, `apple-touch-icon`, and a new web manifest for PWA/app-icon use,
recoloring only via the `--brand-navy`/`--brand-gold`/`--brand-ivory`
tokens above, with the artwork's geometry untouched.
