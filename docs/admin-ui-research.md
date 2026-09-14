# Darwesh Admin — UI Research & Visual Redesign Specification

Status: **research + direction, not yet implemented.** Nothing in this document has been applied to production code. It is the "before implementation" deliverable requested for the full Admin visual redesign — comparative research, then a concrete design-system spec (tokens, type scale, spacing, component system, CSS architecture) for sign-off before Stage 2 begins.

---

## 1. Why this exists

The Admin Panel went through three redesign phases (Phase 1: shell/tokens/shared primitives; Phase 2: Overview/People/Properties hubs; Phase 3: Sales/Discounts/Demand hubs) that fixed **information architecture** — 27 flat destinations became 10 consistent hubs with shared `AdminTabs`/`AdminPageHeader`. That work is sound and is being kept. What it did *not* fix is **visual language**: the panel still reads as "dark theme + gold accents applied phase by phase" rather than a single, deliberate system. The request this document answers is to rebuild that visual language from first principles, informed by real research, not by polishing the current look.

## 2. Current state — audited, not assumed

Before proposing anything, here is what actually exists today (measured, not guessed):

| Fact | Evidence |
|---|---|
| `admin.html` is 4,411 lines; `css/admin-shell.css` is 1,145 lines; `css/admin-tokens.css` (the one real token file) is 87 lines | `wc -l` |
| `admin.html` carries a 238-line inline `<style>` block | grep on `<style>`/`</style>` |
| That inline block alone hardcodes **18 distinct raw hex colors**, including **four different gold values** (`#c69a4b`, `#d9b76a`, `#a9822f`, `#8a6a38`) that should all be one accent token | grep for `#[0-9a-f]{6}` in `admin.html` |
| `css/admin-shell.css` hardcodes its own separate hex set, including a case-duplicated gold (`#c69a4b` and `#C69A4B` as different literals) plus a fifth gold value (`#D4AF60`) never reconciled with the token file | same grep on the CSS file |
| `--ash-accent` (the one real gold token) is referenced 30 times in `admin-shell.css` alone — before counting inline styles or the ~10 admin-\*.js modules that each carry their own component CSS | grep count |
| `css/admin-tokens.css`'s own header comment documents that it replaced **two previously-conflicting token blocks** (a dead warm-cream pass silently overridden by a later "Apple-style" pass) — i.e., the token duplication problem already happened once and was partially fixed | direct read of the file |
| Per-module CSS is scattered: `admin-brokerage.js` alone (1,334 lines) carries its own `.bd-*` classes for avatars/filters/detail buttons that don't exist in the shared system, and similar module-local classes exist in `admin-arena.js` (773 lines) and `admin-offers.js` (693 lines) | direct reads across Phase 1–3 work |
| There is **no spacing-scale, radius-scale, shadow-scale, or type-scale token set** — only two radius values (`--ash-radius`, `--ash-radius-lg`) and no spacing tokens at all; type sizing is done ad hoc via Tailwind arbitrary values (`text-[13px]`, `text-[22px]`, `text-[11.5px]`, …) sprinkled per element | direct reads |

**Conclusion:** the "dark + gold everywhere" feeling the user is reacting to is not a matter of taste that needs a different accent color — it is a structural gap (no spacing/type/radius scale, five different gold hex values still live, a 238-line hardcoded inline style block) that a values-only tweak cannot fix. The fix is architectural: finish what `admin-tokens.css`'s own comment already started, extend it into a complete token system, and migrate every hardcoded value onto it.

## 3. Comparative research

Seven references were studied in depth (sourced below), chosen to cover the specific surfaces this redesign touches: dense financial tables (Stripe, Ramp), calm dashboard information hierarchy (Linear, Notion), an open, fully-documented token system usable as a structural model (GitHub Primer, Shopify Polaris), and a restrained dark-first utility aesthetic (Vercel/Geist, Raycast). None is copied — each entry below records what is *usable as a principle* versus what is specific to that brand and therefore not transferable.

| Product | What works | Why it feels professional | Layout pattern | Spacing system | Typography | Sidebar | Tables | Filters | Forms | Cards | Color usage | Motion | Mobile |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **GitHub Primer** | Token system with a real **primitive → semantic** split (raw color values vs. purpose-named tokens like `fg.default`, `border.muted`), so a whole theme reskins without touching component code | Same component set ships light, dark, dark-dimmed and high-contrast themes purely by swapping token values — proof that a good token architecture is portable | Persistent left rail + content, minimal chrome | **Base unit 4px; scale 4/8/12/16/24/32/40/48** | System font stack, tight but not extreme | Icon + label rows, one accent color reserved for links/primary/focus | Zebra-free, hairline row dividers, dense | Simple chip/select row above table | Standard label-above-input, generous helper text | Used sparingly, mostly for grouped settings | One blue for interactive, green=success, red=danger/close — **never decorative** | Not a focus of the system; kept minimal | Primer's grid collapses predictably; not the strongest reference for admin-specific mobile patterns |
| **Shopify Polaris** | Most complete **admin-specific** system studied — built explicitly for merchant back-office screens, not a marketing site | Full type scale is mathematically derived (1.2 ratio "major third," every size still rounds to the 4px grid) so nothing is an arbitrary pixel value | Sidebar + page + card-grouped content, the closest structural analog to Darwesh Admin | **4px base grid**, spacing values as multiples of 4 | Two roles only — **Heading** and **Body** — each with a small number of controlled variants, not a dozen ad hoc sizes | Grouped nav sections with clear section labels | Mature data-table component with defined column alignment and row-action conventions | Dedicated filter component with save/clear built in | Extremely mature (60+ components) — exactly the "financial/admin form" case Darwesh needs | Used for logical grouping only, not decoration | Semantic color only (success/warning/critical/info), brand color kept out of the data layer | Standard, restrained | Mature responsive table fallback patterns (this is the single most directly-applicable reference for Darwesh's table system) |
| **Stripe Dashboard** | Table-first philosophy: "the primary surface is a dense, impeccably-set table; charts are a summary *above* it, not the main event" — directly answers the brief's "tables are the most important surface" | Reserves color for status signals only; every status message answers "what happened / what do I do next" instead of a generic error | Chrome (headers, nav, page frame) generously spaced; the table itself tightly packed — "controlled density" | Not publicly tokenized, but visually: wide margins around a dense grid | Tabular figures (fixed-width numerals), units set visually lighter than the values themselves | Not the strongest reference (Stripe's nav is comparatively simple) | **Primary reference for Darwesh's table redesign**: inline sparklines, drill-down that never loses place, numeric alignment | Compact, inline with the table, not a separate heavy panel | Financial-grade: precision and unit-consistency treated as a trust signal | Rare, used only where grouping genuinely helps scanning | Color strictly reserved for status; brand color never used as UI chrome | Subtle, fast | Not the reference used here — Polaris and Primer cover this better |
| **Linear** | "Not every element should carry equal visual weight" — nav recedes, work area advances; exactly the "don't mix all three hierarchy levels visually" principle the brief asks for | Restraint as a philosophy, not just an aesthetic choice — motion designer (ex-Vercel) known for "if most people don't notice what changed, that's a good sign" | Sidebar dimmed relative to content; compact tabs with rounded corners rather than full-width nav bars | Not publicly documented in detail; visually tight, 4px-family spacing | Compact, high information density without feeling cramped | **Primary reference for the sidebar's "dimmed until relevant" treatment** | Not a public reference for table density specifically | Compact segmented filters | Not the focus | Minimal, content-first | Single accent, everything else genuinely neutral | **150–220ms, purposeful, restrained** — matches the brief's own motion spec exactly | Not the primary reference here |
| **Vercel / Geist** | Radically stripped: "the interface like a compiler treats code — every unnecessary token is stripped away until only structure remains" | Near-white/near-black neutrals plus a 200-step gray scale, nothing decorative survives | Dense text counterbalanced by vast surrounding whitespace | **Spacing scale: 4/8/12/16/24/32/48/64** | Display sizes use aggressive negative letter-spacing that *relaxes* at body sizes — a concrete, checkable rule (`-2.4px` at 48px trending to normal at 14px) | Not the primary reference | Monospace (Geist Mono) used specifically for numeric/technical columns — directly reusable for Darwesh's price/ID columns | Minimal, text-first | Minimal, code-adjacent | Rare | Ink-near-black text (`#171717`), not pure black — directly informs "graphite, not pure black" in section 4 | Fast, structural | Not the primary reference |
| **Ramp** | Oversized numerals for money figures, single accent used *only* where money actually moves (CTAs, live counters) | One deliberate accent against a disciplined neutral field reads as "switched on" precisely because it's rare | Editorial, generous whitespace | Not publicly tokenized | Single-weight neo-grotesque, tight leading at display sizes | Not the primary reference | Flat, hairline-bordered, **shadow-free** cards — informs "no card inside card" | Not the primary reference | Not the primary reference | Flat, border-only (no shadow), 12–16px radius | **Directly informs the gold-restraint rule**: one accent, reserved for where value/action actually happens, everywhere else neutral | Not documented | Not the primary reference |
| **Notion** | Calm software as a category: hierarchy from spacing/weight, not borders/shadows; interactive elements recede until needed | Built for long sessions — deliberately generous line-height is framed as a *legibility* decision, not wasted space | Classic sidebar + fluid content | **4px-based**, sidebar nav block measured at 131px with a 6px gap between sections (i.e., spacing itself carries meaning, not just aesthetics) | One custom font family spans 54px headings down to 14px captions — a single controlled scale, not a font per surface | **Second reference (with Linear) for calm, low-chrome sidebar treatment** | Not the primary reference | Not the primary reference | Not the primary reference | Subtle elevation over hard borders | Restrained | Not the primary reference |

**Sources consulted:**
- [GitHub's Primer Design System](https://primer.style/) / [Primer Primitives — DeepWiki](https://deepwiki.com/primer/primitives) / [Unlocking inclusive design: Primer's color system — The GitHub Blog](https://github.blog/engineering/user-experience/unlocking-inclusive-design-how-primers-color-system-is-making-github-com-more-inclusive/)
- [Spacing — Shopify Polaris](https://legacy.polaris.shopify.com/design/spacing) / [Using type — Shopify Polaris React](https://polaris-react.shopify.com/design/typography/using-type)
- [Stripe Dashboard Design Breakdown: Trust Through Clarity](https://www.925studios.co/blog/stripe-dashboard-design-breakdown) / ["Make It Like Stripe," or Why Imitation Is a Tricky Design Strategy](https://www.eleken.co/blog-posts/making-it-like-stripe)
- [A calmer interface for a product in motion — Linear](https://linear.app/now/behind-the-latest-design-refresh) / [Linear design: The SaaS design trend — LogRocket](https://blog.logrocket.com/ux-design/linear-design/)
- [Vercel design system — DESIGN.md + live preview](https://opendesigner.io/design-systems/vercel) / [Vercel Design Tokens, Typography & CSS Variables — DesignMD](https://designmd.cc/benchmarks/vercel)
- [Ramp Design System — Colors, Typography & Tokens](https://oh-my-design.kr/design-systems/ramp) / [Ramp Design System for React](https://www.shadcn.io/design/ramp)
- [UI Breakdown of Notion's Sidebar](https://medium.com/@quickmasum/ui-breakdown-of-notions-sidebar-2121364ec78d) / [Notion's Design Language: How Calm Software Became a Category — DesignMD](https://www.designmd.co/blog/notion-design-language)

## 4. What Darwesh Admin will take, and what it will explicitly reject

**Taken:**
- Polaris's **4px base grid with a mathematically derived type scale** (not Ramp's/Geist's bespoke display faces — Darwesh Admin is a back-office tool, not a marketing surface).
- Stripe's **table-first hierarchy**: table is the primary surface, charts/KPIs are a summary strip above it, never the whole page.
- Linear/Notion's **weight-based hierarchy**: sidebar and chrome recede, content advances — achieved with muted color and spacing, not borders.
- Ramp's **single-accent discipline**: one gold, used only for primary action / active nav / selected state — never as a border or fill decoration.
- Primer's **primitive → semantic token split**, extending the existing `admin-tokens.css` rather than replacing it.
- Geist's **ink-near-black over pure black** for the base surface, and monospace/tabular-figure treatment for numeric columns.

**Rejected, explicitly:**
- Ramp's oversized-numeral marketing typography — Darwesh Admin is an operations tool, not a landing page; the brief itself asks to avoid "oversized marketing typography inside Admin."
- Any bespoke display typeface — added asset weight and licensing risk for no operational benefit; the existing system-font stack (`-apple-system, 'SF Pro…', 'Inter', …`) stays.
- Notion's writing-surface line-height philosophy (built for prose, not tables — a dense table needs the opposite: tight row height with the same 4px discipline).
- Any dark-mode-only assumption — Darwesh Admin is intentionally single-theme dark (already true today, and the user has not asked for a light mode), unlike Primer/Polaris which are documented as multi-theme.
- Copying any product's literal component shapes (Linear's specific rounded-tab pixel radii, Ramp's literal yellow, Stripe's literal blue) — only the *principles* transfer.

## 5. Visual direction

**Palette** — extends `css/admin-tokens.css` (kept, not replaced — see §7):

| Token | Value | Role |
|---|---|---|
| `--ash-bg` | `#131417` (was `#15171b`) | App background — near-black graphite, not pure black |
| `--ash-surface` | `#1a1c20` (was `#1c1f24`) | Sidebar / topbar / card background |
| `--ash-surface-sunken` | `#202226` (was `#23262c`) | Table zebra / input background |
| `--ash-surface-hover` | `#26282d` *(new)* | Row/item hover — currently missing as its own token, inferred ad hoc per component today |
| `--ash-border` | `rgba(247,242,232,.08)` (was `.10`) | Hairline — quieter than today |
| `--ash-border-strong` | `rgba(247,242,232,.16)` *(new)* | Table header rule, active input border |
| `--ash-text` | `#f3efe6` | Primary text (kept — already correct: warm off-white, not `#fff`) |
| `--ash-text-secondary` | `rgba(243,239,230,.62)` | Secondary text (kept) |
| `--ash-text-muted` | `rgba(243,239,230,.40)` *(new)* | Metadata / timestamps / placeholder |
| `--ash-accent` | `#c69a4b` | Gold — kept as the single canonical value; every other gold hex in the codebase (`#d9b76a`, `#a9822f`, `#8a6a38`, `#D4AF60`) is retired in favor of this one plus `--ash-accent-strong`/`--ash-accent-wash` |
| `--ash-success` / `--ash-warning` / `--ash-error` / `--ash-info` | kept as-is | Already correctly semantic (green/amber/red/blue) — no change needed, already matches the brief's "controlled semantic colors" requirement |

**Gold discipline (the concrete fix for "random gold borders"):** gold is used in exactly four places after this redesign — the active sidebar item, the primary button, the active tab underline/pill, and a selected-row/selected-item indicator. Every other border in the system uses `--ash-border`. This is enforced structurally: `--ash-accent` will not appear in any shared table, card, or filter-bar rule — only in `buttons.css` (primary variant), the sidebar active state, and `tabs.css` (active state).

**Typography** — one real scale, replacing the current ad hoc `text-[13px]`/`text-[22px]`/etc. sprinkled per element:

| Role | Size / weight / line-height | Replaces |
|---|---|---|
| Hub title (AdminPageHeader) | 20px / 600 / 1.25 | already close to this — codifies it as a token instead of a one-off class |
| Page section heading | 15px / 700 / 1.3 | today's `text-[15px] font-bold` repeated ad hoc per hub |
| Table header | 11px / 600 / uppercase, `.02em` tracking | today's per-table `<th data-i18n>` with no consistent size rule |
| Body / table cell | 13px / 500 / 1.4 | today's dominant `text-[13px]`, now codified |
| Secondary / metadata | 12px / 500 / `--ash-text-secondary` | today's inconsistent 11–13px range across modules |
| Caption / micro-label | 11px / 600 / uppercase | today's stat-mini labels, KPI labels — already close, now shared |

Numeric columns (price, %, IDs, dates) get `font-variant-numeric: tabular-nums` — currently applied nowhere, and directly responsible for the "hard to scan" feeling in the Discounts/Brokerage tables today.

**Spacing** — new token scale (does not exist today at all):

```
--space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
--space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
```

**Radius / shadow** — extends the existing two-value radius system:

```
--radius-sm: 8px;  --radius-md: 12px (= current --ash-radius); --radius-lg: 18px (= current --ash-radius-lg);
--shadow-sm: 0 1px 2px rgba(0,0,0,.24);
--shadow-md: (= current --ash-shadow, kept — it's already restrained and correct)
```

**Density:** default to **comfortable** (44px row height, 16px cell padding) per the brief; a `data-density="compact"` attribute on `.admin-tab-panel` (34px rows, 10px padding) is wired into the token system but not exposed as a user toggle in this pass — that's explicitly deferred (see §9).

## 6. Sidebar, page header, table, filter/form — proposed design

*(Full HTML/CSS mockup delivered separately as a rendered artifact — this section is the written spec behind it.)*

- **Sidebar**: unchanged information architecture (10 hubs: Overview, People, Properties, Sales, Discounts, Demand, Arena, Services, Finance, Analytics, System — already correct from Phases 1–3). Visual change only: group labels drop to `--ash-text-muted` at 11px, inactive items use `--ash-text-secondary` with no border at all (today's items already avoid a "giant gold block," but hover/active use `--ash-accent-wash` too heavily across too many states — this pass narrows gold to the *active* state only, hover becomes a neutral `--ash-surface-hover`).
- **Top bar**: kept structurally (logo, search/⌘K, quick create, language, profile) — visual change: quiet the command-palette button chrome (currently a bordered box; becomes a borderless `--ash-surface-sunken` pill, matching Linear/Raycast's "instrument, not a website" restraint), and the language selector loses its border.
- **Page header** (`AdminPageHeader`, already built in Phase 1–2): kept structurally (icon + title + one-line description + action slot) — this already matches the brief's spec almost exactly. Only change: the icon chip's background moves off `--ash-accent-wash` (today, every hub's header icon is gold-washed — five gold chips visible in a single sidebar scroll) to a neutral `--ash-surface-sunken`, with gold reserved for cases where the header action itself is primary.
- **Table** (the highest-value change per the research above): row height → comfortable density token; header → uppercase 11px/`--ash-border-strong` bottom rule, sticky where a table can scroll independently; entity cell becomes a two-line stack (name + secondary metadata) instead of one long row, per the brief's explicit example; status column always a semantic pill (never gold); actions column collapses to a single `⋯` action-menu trigger instead of 3–5 inline buttons (today's Discounts/Properties tables put 3+ text buttons in the actions column — this is the single biggest per-row visual-noise source found in the audit).
- **Filter bar**: one shared component — search + up to 3 compact selects + "Clear" — replacing each module's own filter-chip markup (`.filter-chip`, `.pr-filter-chip`, brokerage's own `bd-filter-row` are three separate implementations of the same idea today).
- **Forms**: label above input, helper text in `--ash-text-muted`, grouped into labeled sections (already partially true in the Discounts policy form; this pass makes it the shared pattern instead of a one-off).

## 7. CSS architecture

**Decision: extend the existing structure, do not fragment into 12 files.** The repo's own convention (confirmed across every prior phase) is few, purpose-named files per surface, not a deep folder tree — `css/admin-tokens.css` + `css/admin-shell.css` already is that pattern for the shell. Splitting into `css/admin/tokens.css, shell.css, typography.css, buttons.css, forms.css, tables.css, tabs.css, cards.css, badges.css, dialogs.css, responsive.css` (11 files) fits the *spirit* of the request (one file per concern, no duplication) while staying inside the project's real folder convention (`css/` flat, not `css/admin/` nested) — matching how `css/admin-tokens.css` and `css/admin-shell.css` already sit next to `css/services-carousel.css`, `css/site-footer.css`, etc.

Proposed structure:

```
css/admin-tokens.css     (extended: + spacing/radius/shadow/type scale — existing file, existing role)
css/admin-shell.css      (trimmed: shell/sidebar/topbar only — existing file, narrowed role)
css/admin-typography.css (new: the type-scale classes from §5)
css/admin-buttons.css    (new: one button system — primary/secondary/ghost/danger/quiet/icon, all states)
css/admin-forms.css      (new: label/input/select/switch/checkbox/radio/textarea, validation states)
css/admin-tables.css     (new: shared table system — header/row/cell/entity-cell/action-menu/pagination)
css/admin-tabs.css       (new: extracted from admin-shell.css's current `.ash-tabs*` rules)
css/admin-badges.css     (new: one status-badge system replacing badge-active/badge-pending/etc. scattered today)
css/admin-dialogs.css    (new: drawer/dialog/confirmation, replacing per-module modal markup in admin.html)
```
`css/admin-shell.css`'s current ~1,145 lines split roughly: 300 stay (shell/sidebar/topbar), ~500 move into the new table/badge/tabs files (already-identifiable blocks), ~345 are today's per-module one-offs (`.bd-*`, `.ash-offers-*`, etc.) that get generalized into the shared files and deleted from their modules.

**Migration rule:** every hardcoded hex found in §2 gets replaced with a token reference in the same commit that touches that file — no hex value survives Stage 2 in `admin.html`'s inline `<style>` block or in `admin-shell.css`.

## 8. Files expected to change

| File | Change |
|---|---|
| `css/admin-tokens.css` | Extended with spacing/radius/shadow/type/surface-hover/border-strong tokens; gold values consolidated to one hex |
| `css/admin-shell.css` | Trimmed to shell/sidebar/topbar; duplicated component rules removed |
| `css/admin-typography.css`, `admin-buttons.css`, `admin-forms.css`, `admin-tables.css`, `admin-tabs.css`, `admin-badges.css`, `admin-dialogs.css` | New shared component stylesheets |
| `admin.html` | 238-line inline `<style>` block removed (migrated to token-based classes); markup for tables/filters/forms updated to the shared component classes hub-by-hub, in the Stage 2–7 order already used for Phases 1–3 |
| `js/admin-page-header.js`, `js/admin-tabs.js` | Audited and extended (icon-chip background token, gold-restraint fix) — kept as the existing, working components |
| New: `js/admin-table.js`, `js/admin-filter-bar.js`, `js/admin-status-badge.js`, `js/admin-action-menu.js`, `js/admin-empty-state.js` (promoting the existing `.ash-empty-state` pattern) | Only built where real duplication exists today (confirmed in §2/§6), per the brief's "only create components that reduce real duplication" instruction |
| `js/admin-brokerage.js`, `js/admin-arena.js`, `js/admin-offers.js`, `js/admin-orgs-pros.js`, `js/admin-map.js`, `js/admin-alerts.js` | Markup/CSS-class updates only to consume the new shared components — **zero business-logic changes**, matching the explicit constraint |
| **Not touched**: `backend/app/**`, `firestore.rules`, `firestore.indexes.json`, any `*_ops.py` | This is a UI/CSS/HTML redesign; no backend or rules file is implicated by anything in this document |

## 9. Staged plan (matches the brief's Stage 1–7 structure)

1. ✅ **Stage 1 — this document** (research + spec).
2. **Stage 2** — tokens extension, trimmed shell CSS, sidebar/topbar visual pass, remove the inline `<style>` block.
3. **Stage 3** — shared primitives: tables, forms, filters, buttons, tabs, badges (the components listed in §8).
4. **Stage 4** — Overview, People, Properties re-skinned onto the new primitives (structure/IDs unchanged from Phases 1–2).
5. **Stage 5** — Sales, Discounts, Demand re-skinned (structure/IDs unchanged from Phase 3).
6. **Stage 6** — Arena, Services, Finance, Analytics, System.
7. **Stage 7** — mobile/RTL/accessibility/performance consistency pass across all ten hubs.

Density toggle (compact/comfortable), if wanted later, slots into Stage 7 without touching earlier stages, since the token (`data-density`) is defined in Stage 2 even though the UI control isn't built until explicitly requested.

## 10. What this document does not decide

Per the brief's own instruction not to ask for approval of tiny cosmetic variants, this document does not present color/type alternatives to choose between — §5–§7 are the recommended, research-backed direction, ready to implement. The one open question genuinely worth confirming before Stage 2 starts is scope-level, not cosmetic: **whether to proceed stage-by-stage with a checkpoint after Stage 3** (shared primitives visible on a couple of real hubs before all ten are migrated) or to run Stages 2–6 in one continuous pass. A rendered mockup of the sidebar/header/table/filter/button direction from §5–§6 is delivered as an artifact alongside this document so the direction itself can be reviewed against real Darwesh content before either path begins.
