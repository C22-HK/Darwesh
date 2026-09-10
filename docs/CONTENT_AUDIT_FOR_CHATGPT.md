# Darwesh Group — Full-Site Content Audit (Phase 1: Discovery Only)

**Prepared for:** ChatGPT (editorial/content authority)
**Prepared by:** Claude Code (codebase discovery/implementation authority)
**Branch audited:** `claude/web-project-hqdo8o`
**Scope:** Complete inventory of user-facing content across the production site — no copy has been rewritten. This is discovery only, per the Phase 1 brief.

---

## 1. Methodology

- English source text lives directly in HTML (`data-i18n*` attributes carry the key; the element's own literal text is the English fallback) or as the `fallback` argument of `tr()`/`trDash()`/`trAdmin()` calls in JS. There is **no `en:` block** in `js/i18n.js` — English is never stored as translated data, only as fallback text.
- Kurdish (`ku:`) and Arabic (`ar:`) translations live in `js/i18n.js`, looked up by dotted key.
- **Turkish (`tr`) status at the time of this audit: 0% implemented.** No `tr:` block existed anywhere in `js/i18n.js` when every section below was reviewed. Every "TR" column in every table is `MISSING` for that reason — stated once here, not repeated as a discovery on every row. (Note: Turkish has since been added as a fourth locale in a separate, later piece of work — see the branch's current `js/i18n.js` for that. This audit describes the site's copy quality/consistency, which Turkish's addition does not change.)
- KU/AR values were pulled by grepping `js/i18n.js` for the exact dotted key. Where a string has no `data-i18n*` attribute at all, it is marked **(no i18n key — hardcoded)**.
- No Firebase/App Check/Auth/backend/Firestore/permissions/data models/routes/design/layout were modified in the course of this audit. This document contains no code changes — inventory only.

### Approved brand spelling (reference for every flag below)

| Locale | Full form | Short form |
|---|---|---|
| Kurdish (KU) | دەروێش گروپ | دەروێش |
| Arabic (AR) | مجموعة درويش | درويش |
| English/Turkish | Darwesh Group | Darwesh |

**Wrong variants found in the live site** (flagged wherever they appear): KU `دەرەوش`, `دەرەوشی`, `دەرویش`, `داروێش`; AR `دارويش`, `دارويش جروب`, `داروش`. A more severe class of defect, found repeatedly across the site, is **literal Kurdish-script brand text pasted directly into an Arabic sentence** (e.g. an Arabic string that ends in the raw word `دەرەوش` instead of writing `درويش`) — this reads as broken to any Arabic reader, not merely inconsistent, and is called out explicitly wherever found.

### Problem-flag legend used throughout

`awkward` · `literal-translation` · `unnatural-sorani` · `grammar` · `mixed-language` · `inconsistent-terminology` · `brand-spelling` · `unclear-cta` · `unsupported-marketing-claim` · `missing-translation` · `duplicate-wording` · `needs-context`

---

## 2. Home (`index.html`), Shared Header, Shared Mobile Nav, Shared Footer

### Home (`index.html`)

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `<title>` (no i18n key) | Darwesh Group — Real Estate Network | *(never changes — not wired to i18n)* | *(same)* | MISSING | missing-translation |
| `<meta name="description">` / og / twitter (no i18n key) | Find properties, trusted professionals, and real estate services across Kurdistan — all in one place with Darwesh Group. | *(never changes)* | *(same)* | MISSING | missing-translation, unsupported-marketing-claim |
| `intro.eyebrow` | Welcome | بەخێربێیت | أهلاً بك | MISSING | |
| `intro.statement` (used twice) | Real estate, real professionals, and real trust — brought together, quietly. | خانووبەرەی ڕاستەقینە، پیشەگەری ڕاستەقینە، و متمانەی ڕاستەقینە — بە هێمنی پێکەوە. | عقارات حقيقية، محترفون حقيقيون، وثقة حقيقية — مجتمعين بهدوء. | MISSING | literal-translation, unnatural-sorani (triple repetition mirrors English word-for-word rather than reading as natural Kurdish prose) |
| `intro.enter` | Enter Darwesh | بچۆرە **دەرویش** | ادخل **دەرویش** | MISSING | **brand-spelling** (KU wrong variant); AR embeds **Kurdish script inside the Arabic locale** instead of writing Arabic `درويش` — also **mixed-language** |
| `intro.hint` | Press Enter, tap, or click to continue. | ئینتەر لێبدە، کرتە بکە، یان دەستی لێبدە بۆ بەردەوامبوون. | اضغط إنتر، أو انقر، أو اضغط مطولاً للمتابعة. | MISSING | |
| `intro.skip` | Skip | بازدان | تخطٍّ | MISSING | |
| `aria-label="Enter Darwesh Group"` on `#cineEnterBtn` (no i18n key) | Enter Darwesh Group | *(stays English)* | *(same)* | MISSING | missing-translation, inconsistent-terminology (screen-reader text disagrees with the translated visible button) |
| `index.heroEyebrow` | Property · Professionals · Services | خانووبەرە · پیشەگەران · خزمەتگوزاری | عقارات · محترفون · خدمات | MISSING | |
| `index.heroLine1` | Premium Real Estate. | خانووبەرەی تایبەت. | عقارات مميزة. | MISSING | |
| `index.heroLine2` | Verified Intelligence. | زانیاری پشتڕاستکراو. | معلومات موثوقة. | MISSING | needs-context (vague EN marketing phrase — unclear what "intelligence" means) |
| `index.searchPlaceholder` | Search properties in Kurdistan... | گەڕان بۆ خانووبەرە لە کوردستان... | ابحث عن عقارات في كردستان... | MISSING | |
| `index.searchAction` | Search | گەڕان | بحث | MISSING | duplicate-wording — key is defined **twice** in both `ku:` and `ar:` blocks, identical values; harmless but a maintenance foot-gun |
| `index.heroExploreMap` | Explore the map | نەخشەکە بگەڕێ | استكشف الخريطة | MISSING | inconsistent-terminology — same EN phrase also exists as `nav.exploreMap` with **different** KU/AR wording elsewhere on this same page |
| `aria-label="Darwesh social channels"` (no i18n key) | Darwesh social channels | *(stays English)* | *(same)* | MISSING | missing-translation |
| `index.categoryEyebrow` | Get Started | دەستپێبکە | ابدأ الآن | MISSING | |
| `index.categoryTitle` | What are you looking to do? | ئامادەیت چی بکەیت؟ | ما الذي تريد فعله؟ | MISSING | needs-context — KU literally reads "What are you **ready** to do?", a semantic drift |
| `index.buy`/`buySub`, `rent`/`rentSub`, `build`/`buildSub`, `renovate`/`renovateSub`, `sell`/`sellSub` (5 intent panels) | Buy — Find your next property / Rent — Find a place to call home / Build — with trusted professionals / Renovate — Transform your property / Sell — List your property | (localized, values below) | (localized) | MISSING | **needs-context (systemic)** — every panel's richer `aria-label` (e.g. "Buy — Homes & land") is overwritten at runtime by the shorter nav-style `data-i18n-aria` key, collapsing the accessible description to one word in every language, English included, once JS runs. Also: `renovateSub`/`sellSub` say "your **house**" (خانووەکەت) rather than "your property" — see terminology note below |
| `index.browseByCitySubtitle` | Explore apartment projects and residential communities in your preferred city. | پرۆژەی شوقە و **گوندە نیشتەجێبوونەکان** لە شارە دڵخوازەکەت بدۆزەرەوە. | استكشف مشاريع الشقق والمجمعات السكنية في المدينة التي تفضلها. | MISSING | unnatural-sorani — "گوندە نیشتەجێبوونەکان" literally means "residential **villages**" (گوند = village), a semantic misfit for urban apartment complexes; also uses Arabic loanword "شوقە" for apartment |
| `index.fastSaleSubtitle` | Properties available for fast sale. | ئەو موڵکانەی خاوەنەکانیان دەیانەوێت بە خێرایی بفرۆشرێن. | عقارات يرغب أصحابها في بيعها بسرعة. | MISSING | inconsistent-terminology — "موڵک" is a *third* KU word for "property" on this one page, alongside "خانووبەرە" and "خانوو" |
| `index.activeSubtitle` | Independently verified by the Darwesh Group team. | بە شێوەیەکی سەربەخۆ پشتڕاستکراوە لەلایەن تیمی **دەرەوشی** گروپەوە. | تم التحقق منها بشكل مستقل من قبل فريق مجموعة درويش. | MISSING | **brand-spelling** — KU wrong variant "دەرەوش" (AR correct) |
| `index.viewOfferOnline` | View Offer Online | بینینی دەرفەتەکە بە ئۆنلاین | مشاهدة العرض عبر الإنترنت | MISSING | awkward — KU "بە ئۆنلاین" ("by online") is a stiff calque |
| `index.trustPrivacyBody` | Public maps show an approximate area. Exact coordinates stay private to the listing's agent. | نەخشە گشتییەکان ناوچەیەکی نزیکەیی پیشان دەدەن. هێڵەکانی وردی شوێن تەنها بۆ بریکاری خانووەکە دەمێننەوە. | تعرض الخرائط العامة منطقة تقريبية. تبقى الإحداثيات الدقيقة خاصة بوكيل العقار. | MISSING | awkward — KU "هێڵەکانی وردی شوێن" ("the lines of location detail") is an odd calque for "exact coordinates" |
| `index.trustNetworkBody` | Engineers, designers, lawyers and contractors with their own profiles — not a directory of names. | ئەندازیار، دیزاینەر، پارێزەر و **کۆمپانیای بیناسازی** لەگەڵ پرۆفایلی خۆیان — نەک لیستێکی ناو. | مهندسون ومصمّمون ومحامون ومقاولون لكل منهم ملفّه الخاص — لا مجرد دليل أسماء. | MISSING | inconsistent-terminology/grammar — KU breaks the parallel individual-profession list by translating "contractors" as "کۆمپانیای بیناسازی" (construction **companies**); AR keeps the parallel structure correctly |
| `index.trustVerifiedBody` | The verified badge is set by Darwesh Group staff, never by the person listing the property. | نیشانەی پشتڕاستکردنەوە لەلایەن ستافی گرووپی **دەرویشەوە** دادەنرێت... | شارة التوثيق يضعها فريق مجموعة درويش، ولا يضعها أبدًا من يعرض العقار. | MISSING | **brand-spelling** — KU wrong "دەرویش" |
| `index.ctaBody`/`ctaPrimary`/`ctaSecondary` | Search every active listing... / Explore Properties / List Your Property | (uses "خانوو"/"خانووەکان"/"خانووەکەت" = house(s)/your house) | (localized, "عقار"-based, consistent) | MISSING | inconsistent-terminology — KU again drifts to "house" vocabulary distinct from "خانووبەرە" used elsewhere |
| Empty/error states, retry, badges, quick-sale copy, discount/QR block | (all localized) | (localized) | (localized) | MISSING | no additional issues beyond terminology notes above |

### Shared Header (`js/site-header.js`)

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `aria-label="Language"`, `"Notifications"`, `"Darwesh Group — Home"`, `"Buy or rent"` (all no i18n key) | (as shown) | *(stays English)* | *(same)* | MISSING | missing-translation ×4 |
| `nav.propertiesMap`/`buy`/`rent`/`home`/`sell`/`about`/`login`/`signUp`/`profile` | Properties Map / Buy / Rent / Home / Sell / About / Login / Sign Up / Profile | (all correctly localized) | (all correctly localized) | MISSING | |
| `mamai.navLabel` | MAM AI | MAM AI | MAM AI | MISSING | brand/product name kept as-is in every locale — correct by design |

### Shared Mobile Nav (`js/site-mobile-nav.js`)

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `nav.home`/`mamai.navLabel`/`nav.propertiesMap`/`nav.sell`/`nav.services`/`nav.profile` | (as Header) | (localized, reused) | (localized) | MISSING | duplicate-wording (expected reuse, not a defect) |
| `aria-label="Profile"`, `aria-label="Primary mobile"` (no i18n key) | Profile / Primary mobile | *(stays English)* | *(same)* | MISSING | missing-translation ×2 |

### Shared Footer (`js/site-footer.js`)

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `aria-label="Darwesh Group — Home"` (no i18n key) | Darwesh Group — Home | *(stays English)* | *(same)* | MISSING | missing-translation |
| `footer.tagline` | Darwesh Group connects property seekers, owners, professionals and services across Kurdistan through one trusted platform. | **دەرویش** گروپ گەڕۆکان و خاوەنانی موڵک... | تربط مجموعة درويش الباحثين... | MISSING | **brand-spelling** (KU wrong opening); unsupported-marketing-claim ("across Kurdistan") |
| Properties/Services/Professionals/Company/Account columns | (headings + links, mostly reused nav.* keys) | (localized) | (localized) | MISSING | duplicate-wording (expected reuse). Services/Professionals column *items* come from `js/service-catalog.js`, out of this audit's scope |
| `footer.rights`, Copyright line | All rights reserved. / 2026 Darwesh Group. All rights reserved. | هەموو مافەکان پارێزراون. / ٢٠٢٦ Darwesh Group. هەموو مافەکان پارێزراون. | (localized) | MISSING | mixed-language — the Latin "Darwesh Group" sits mid-sentence inside an RTL string with no bidi-isolation markup |

**Section summary — ~95 strings reviewed.** Recurring problems: brand-spelling errors in 4 places (KU, with one AR mixed-language case); three different KU words for "property" cycling across one page (خانووبەرە / خانوو / موڵک); systemic accessible-name loss on the 5 intent panels; a cluster of never-localized hardcoded strings (title, meta/OG/Twitter, several aria-labels); duplicate/inconsistent renderings of the same English phrase; unsupported marketing claims; stiff literal translations.

---

## 3. Buy, Rent, Map, Listing Detail

**TR confirmed MISSING for every key in this section.**

### Buy (`buy.html`)

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `<title>` / `<meta description>` | Darwesh Group - Buy a Property / Browse properties for sale in Erbil, Sulaymaniyah... | — (not localized) | — | MISSING | missing-translation |
| `buy.subtitle` | Verified homes for sale across the Kurdistan Region, backed by Darwesh Group's trust guarantee. | ...پشتگیریکراو بە دڵنیایی **دەرەوش گروپ**. | ...مدعومة بضمان الثقة من مجموعة درويش. | MISSING | **brand-spelling** (KU wrong; AR correct); unsupported-marketing-claim ("trust guarantee") |
| property type / sort options (shared across Buy/Rent/Map/Listing) | House/Villa/Apartment/Land/Building/Office/Shop/Commercial; Sort variants | (localized) | (localized) | MISSING | shared key set, consistent |
| `buy.apartmentsSuffix` | Apartments | شوقەکان | شقق | MISSING | unnatural-sorani/inconsistent-terminology — awkward Kurdicized Arabic loanword vs. site-standard "ئاپارتمان" |
| resultCount fallback (JS) | `"${list.length} properties for sale"` | *(raw English regardless of language)* | — | MISSING | **missing-translation** — no i18n key; inconsistent with rent.html's `rent.propertiesFound` |
| Toast: "Log in to save favorites" / "Removed from favorites" / "Saved to favorites" / "Log in to save searches" / "Search saved to your account" | (hardcoded English) | (hardcoded English) | — | MISSING | **missing-translation, duplicate-wording** — working keys (`listing.loginToSave`, `listing.removedFromFavorites`, `listing.savedToFavorites`, `map.searchSavedToAccount`) already exist and are used correctly on rent/map/listing.html; **buy.html alone bypasses them** |
| `saveCurrentSearch()` label (JS, stored to Firestore) | `"${type} — \"q\" on Buy"` | (hardcoded English) | — | MISSING | missing-translation — a KU/AR user's saved search is permanently labeled in English |
| favorite-button aria-label / "Property" title fallback (JS) | Save to favorites / Property | (untranslated) | — | MISSING | missing-translation |

### Rent (`rent.html`)

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `<title>` / `<meta description>` | Darwesh Group - Rent a Property / Find apartments... | — | — | MISSING | missing-translation |
| `rent.subtitle` | Verified properties for rent across Kurdistan. | (localized) | (localized) | MISSING | unsupported-marketing-claim |
| Several field `aria-label`s (keyword search, property type, city, beds, min/max price, Sort, filters-drawer Close) | (as shown) | *(hardcoded English — placeholders ARE localized, aria-labels are not)* | *(same)* | MISSING | missing-translation (systemic gap: placeholder localized, aria-label not, repeated ~8×) |
| `cities.koya` (Koya) | Koya | کۆیە | **كويە** | MISSING | grammar/mixed-language — AR value ends in the **Kurdish** letter ە (U+06D5) instead of standard Arabic, confirmed at codepoint level |
| favorite/search toasts | (localized correctly) | (localized) | (localized) | MISSING | positive contrast to buy.html's hardcoded versions |
| `rent.propertiesFound` | properties for rent | خانووبەرە بۆ کرێ | عقار للإيجار | MISSING | |

### Map (`map.html`)

*No standalone MAM AI dock exists on this page — confirmed removed site-wide; MAM lives only on mam-ai.html.*

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `<title>`/`<meta description>`, `#citySuggestList` aria-label, viewing-modal Close aria-label, `saveCurrentSearch()` label (JS) | (various) | (hardcoded English) | (same) | MISSING | missing-translation, cluster |
| City suggestion dropdown (JS array: Erbil, Sulaymaniyah, Duhok, Kirkuk, Halabja, Zakho, Koya, Soran) | (raw English regardless of language) | same | — | MISSING | **missing-translation, inconsistent-terminology** — `cities.*` keys exist and work correctly on rent.html's select, unused here |
| Map style `drm.satellite` | Satellite | **مانگی دەستکرد** ("artificial moon") | (localized) | MISSING | **literal-translation/unnatural-sorani** — odd calque; transliteration "سەتەلایت" would be more recognizable |
| `map.bedrooms` vs `common.beds` (same page) | Bedrooms / Beds | **ژووری نووستن** vs **ژووری نوستن** | (localized) | MISSING | **inconsistent-terminology/grammar** — double-و vs single-و spelling for the same word on the same page |
| `map.titleTypeForRent` vs `common.forRent`/`map.rentToggle` | "for Rent" | **بۆ بەکرێدان** vs **بۆ کرێ** | (localized) | MISSING | **inconsistent-terminology** — two different KU renderings of "for rent" on the same page |
| `map.verifiedByDarwesh` | Verified by Darwesh Group | **پشتڕاستکراوە لەلایەن دەرەوش گروپەوە** | موثّق من قبل مجموعة درويش | MISSING | **brand-spelling** — KU wrong; AR correct |
| map popup `card()` "Price on request" (JS) vs `wheelCard()`'s `map.priceOnRequest` | Price on request (both) | *(card(): hardcoded English)* vs *(wheelCard(): localized)* | | MISSING | **missing-translation, inconsistent-terminology** — same concept, two code paths, only one localized |
| `map.viewingRequestSent` | ...an agent will contact you within 24 hours | (localized) | (localized) | MISSING | unsupported-marketing-claim ("within 24 hours") |
| **`PROPERTY_TYPE_KEYS` lookup (JS code, not copy)** | — | — | — | — | **Functional bug, not a translation issue**: lookup key `commercial` vs canonical stored value `commercialProperty` — commercial listings never resolve to a localized type label in any language |

### Listing Detail (`listing.html`)

| Key / Location | Current EN | Current KU | Current AR | TR | Flags |
|---|---|---|---|---|---|
| `<title>`/`<meta description>`, viewing-modal Close aria-label | (various) | (hardcoded English) | (same) | MISSING | missing-translation |
| `map.verifiedByDarwesh` (reused) | Verified by Darwesh Group | **دەرەوش گروپ** (wrong) | (correct) | MISSING | **brand-spelling** — same wrong KU spelling, shared key with map.html |
| type label map (JS) | House…**Commercial Property** | (localized) | (localized) | MISSING | inconsistent-terminology — EN fallback string here doesn't match map.html's "Commercial" for the same concept |
| favorites toasts, `map.viewingRequestSent` (reused) | (localized correctly) | (localized) | (localized) | MISSING | contrast with buy.html; unsupported-marketing-claim reused from map.html |

**Section summary — ~155 strings reviewed.** Recurring problems: 2 confirmed brand-spelling errors (KU wrong, same pattern recurring across the site); **buy.html silently bypasses working i18n keys for its own toasts** even though the identical keys work on rent/map/listing.html — the single most repeated inconsistency in this group; Firestore-persisted saved-search labels stored permanently in English; aria-labels are a systemic blind spot; a real **code bug** (not translation) in `PROPERTY_TYPE_KEYS`; Kurdish terminology drift within single files (bedrooms spelling, "for rent" phrasing, apartment loanword); a literal "artificial moon" calque for Satellite; raw English city names in map.html's suggestion dropdown; "within 24 hours" SLA language.

---

## 4. Sell (+ 7-step wizard) and Installments

**TR confirmed MISSING for every key below.**

| Area | Key | EN | KU | AR | TR | Flags |
|---|---|---|---|---|---|---|
| Header | `sell.subtitle` | List with Darwesh Group and reach verified buyers across the Kurdistan Region. | لەگەڵ **دەرەوش گروپ** لیست بکە... | أدرج عقارك مع **مجموعة درويش**... | MISSING | **brand-spelling** (KU wrong; AR correct); unsupported-marketing-claim; mixed-language (KU "لیست" loanword) |
| Step 1 – Location | `cities.koya` | Koya | کۆیە | **كويە** | MISSING | grammar/script-mixing — AR ends in Kurdish letter ە (same bug independently confirmed in rent.html and projects.html) |
| Step 2 – Price & Size | `sell.askingPrice` | Asking Price | نرخی داواکراو **(بە دۆلار)** | السعر المطلوب **(دولار أمريكي)** | MISSING | inconsistent-terminology — both hardcode "(in USD)" though a live USD/IQD currency selector sits next to the field |
| Step 2 | `sell.valuationTitle`/`benefit2`/`trust.mamValuation` | MAM AI Valuation | (localized) | (localized) | MISSING | unsupported-marketing-claim — labeled "AI" but the underlying logic is a plain median price-per-m² calculation over live listings, not ML; flag the framing, not the number |
| Step 3 – Property Details | `sell.selectType` | Select type | جۆر هەڵبژێرە | اختر النوع | MISSING | duplicate-wording — same generic key reused for both Property Type AND Property Condition dropdowns |
| Step 3 | `sell.amenity.centralAc` | Central A/C | سەرمایشتنی ناوەندی | تكييف مركزي | MISSING | unnatural-sorani (tentative) — not the standard Sorani term; needs native review |
| Step 3 | yearBuilt placeholder | e.g. 2020 | *(no i18n wiring at all)* | *(none)* | MISSING | **missing-translation (hardcoded)** — unlike every sibling placeholder in Steps 1–2 |
| Step 4 – Photos | "Remove photo" aria-label (JS) | Remove photo | *(none — always EN)* | *(none)* | MISSING | missing-translation |
| Step 5 – Review | `sell.step5Heading` | Review Listing | پێداچوونەوەی **لیست** | مراجعة الإعلان | MISSING | mixed-language (KU "لیست" loanword) |
| Step 7 – Verification | `sell.verify.privacyNotice` | Your verification photo is private and will only be used by Darwesh Group to verify... | ...تەنها لەلایەن **دەرەوش گروپ**ەوە... | ...لن تُستخدم إلا من قبل **مجموعة درويش**... | MISSING | **brand-spelling** (KU wrong; AR correct) — this is the privacy disclaimer for a biometric selfie capture, worth prioritizing given the trust-sensitivity of the moment |
| Submit/footer | `sell.reviewNote` | A Darwesh Group agent will review your listing and contact you within 24 hours. | ...**دەرەوش گروپ**... ٢٤ کاتژمێردا... | ...**مجموعة درويش**... 24 ساعة. | MISSING | **brand-spelling** (KU wrong); unsupported-marketing-claim |
| Confirmation | `sell.confirmationBody` | ...Darwesh Group agent will verify your details and reach out within 24 hours to schedule photography... | ...**دەرەوش گروپ**... | ...**مجموعة درويش**... | MISSING | **brand-spelling** (KU wrong); unsupported-marketing-claim (implied guaranteed photography service) |
| Sidebar | `sell.whySell` | Why Sell With Darwesh Group? | بۆچی لەگەڵ **دەرەوش گروپ** بفرۆشیت؟ | لماذا تبيع مع **مجموعة درويش**؟ | MISSING | **brand-spelling** (KU wrong) |
| Sidebar | `sell.benefit4` | Professional photography included | (localized) | (localized) | MISSING | unsupported-marketing-claim — confirm this is a real funded SLA before shipping copy that promises it |
| Trust footer | `sell.trust.verifiedBuyers`/`fastReviewSub`/`securePrivateSub`/`exposureSub` | Verified Buyers / Reviewed within 24 hours / Your data is always safe / Featured across platforms | (localized) | (localized) | MISSING | unsupported-marketing-claim — "verified buyers" appears 5+ times and "within 24 hours" 4 times across this one page; duplicate-wording |
| Location Picker modal | Close / search aria-labels | Close / Search for area, street or landmark | *(none — always EN)* | *(none)* | MISSING | missing-translation + duplicate-wording (a working `sell.loc.searchPlaceholder` exists, just not wired to this control) |
| Hardcoded | `<title>`/`<meta description>` | Darwesh Group - Sell a Property / Submit your property... | — | — | MISSING | missing-translation |
| Hardcoded | JS `dealLabel` for stored Firestore listing title | "for Rent"/"for Sale" (lowercase) | (same, hardcoded English) | — | MISSING | **missing-translation + inconsistent-terminology + mixed-language** — a *separate* hardcoded literal from the properly-translated `common.forRent`/`common.forSale` shown one line away; the stored listing title is always English regardless of the seller's language |

### Installments (`installments.html`)

| Key | EN | KU | AR | TR | Flags |
|---|---|---|---|---|---|
| `inst.eyebrow`/`inst.subtitle` | Darwesh Service / ...Darwesh does not estimate or calculate payment terms. | خزمەتگوزاری **دەروێش** (correct) / ...**دەروێش**... (correct) | خدمة **درويش** (correct) | MISSING | brand spelling **correct** here — good contrast with sell.html; the subtitle is a deliberate disclaimer against an unsupported claim, good practice |
| filter section aria-label | Installment filters | *(none — always EN)* | *(none)* | MISSING | missing-translation |
| `inst.countLabel`/`inst.emptyFiltered` | {n} installment offers / No installment properties match these filters. | {n} **ئۆفەری** قیستی / ...**فلتەرانە**... | (localized) | MISSING | mixed-language (mild, common colloquial loanwords) |
| `<title>`/`<meta description>` | Darwesh Group - Installment Properties / ... | — | — | MISSING | missing-translation |

**Section summary — ~185 strings reviewed.** Recurring problems: **5 confirmed KU-only brand-spelling errors on sell.html** (`sell.subtitle`, `sell.reviewNote`, `sell.confirmationBody`, `sell.whySell`, `sell.verify.privacyNotice`) — corresponding Arabic is correct for all 5, while `installments.html`'s two brand mentions are correct in both languages, showing the error is inconsistent even within one codebase, not systemic; a heavy cluster of unsupported marketing/SLA claims concentrated on sell.html ("verified buyers" 5+×, "within 24 hours" 4×, "Professional photography included", "MAM AI" branding on a non-ML calculation); hardcoded never-localized strings including, most consequentially, the JS-built Firestore listing title that always stores lowercase English regardless of the seller's UI language; low-to-moderate English loanwords throughout KU copy; no cases found where a wired-up KU/AR key is simply *missing* from the dictionary — every missing-translation flag here is for strings never wired into i18n at all.

---

## 5. About and MAM / MAM AI

**TR: 100% unimplemented at time of audit — every TR cell below is MISSING.**

### About (`about.html`)

| Key | EN | KU | AR | TR | Flags |
|---|---|---|---|---|---|
| `about.eyebrow` | ABOUT DARWESH GROUP | دەربارەی **دەرەوشی گروپ** | من نحن - **دارويش جروب** | MISSING | brand-spelling (KU wrong; AR wrong + transliterated "جروب") |
| `about.heroHeadline` | Every space. Every step. Together. | هەموو شوێنێک. هەموو هەنگاوێک. پێکەوە. | كل مساحة. كل خطوة. معًا. | MISSING | minor only — no real issue |
| `about.worldEyebrow` | THE DARWESH WORLD | جیهانی **دەرەوش** | عالم **دارويش** | MISSING | brand-spelling |
| `about.worldHubBody` | ...listings and developer projects... | ...**ڕیکلامی** پشتڕاستکراو... | ...إعلانات موثقة... | MISSING | inconsistent-terminology — uses ڕیکلام ("ad") vs موڵک/لیستە used elsewhere for "listing" |
| `svc.designer.tagline` | ...published by real Darwesh designers. | ...دیزاینەرە ڕاستەقینەکانی **دەرویش**. | ...مصممي **دارويش** الحقيقيين. | MISSING | **brand-spelling** — both wrong |
| `svc.cleaning.tagline` | ...move-in/move-out cleaning... | ...**کاتی گواستنەوە**... | (localized) | MISSING | awkward — stiff calque ("time of moving") |
| `svc.cta.browseProviders` (shared key, 5 distinct EN CTAs) | *(varies: Browse Engineers / Landscapers / Cleaning / Maintenance / Lawyers)* | *(one identical generic string for all 5)* | *(one identical generic string for all 5)* | MISSING | **duplicate-wording/needs-context** — architecture-level loss of specificity: EN visitors get category-specific CTAs, KU/AR visitors see identical text everywhere |
| `about.editorialEngineeringHeadline`/`editorialLegalHeadline` | From structure to home. / Every step, verified. | (current shipped KU) | (localized) | MISSING | missing-translation — Issue #75-approved KU replacements exist but are **not yet shipped** (see table below) |
| `about.storyBody1` | Darwesh Group started with a simple frustration... | **دەرەوشی گروپ**... | بدأت **دارويش جروب**... | MISSING | brand-spelling (both wrong, confirmed) |
| `about.valuesTitle` | Four things we don't compromise on | چوار شت کە **دانپیانانادەین** | أربعة أمور لا نتنازل عنها | MISSING | **grammar/unnatural-sorani** — reads as garbled, doesn't parse as a clean Sorani verb phrase; needs native rewrite |
| `about.value1Title` | Verified Listings | **خانووبەرە**ی پشتڕاستکراو | إعلانات موثقة | MISSING | inconsistent-terminology (خانووبەرە vs موڵک elsewhere in about.*) |
| `about.value4Body` | ...turn raw listings into decisions... | ...ڕیکلامە **خاوەکان** دەگۆڕن... | (localized) | MISSING | awkward/literal-translation — "خاو" (raw/uncooked food) is an unidiomatic calque |
| `about.mamLabelNavigate`/`mamLabelTasks` | Navigate / Tasks | **ڕێنمایی** ("guidance") / **ئەرکەکان** | التنقل / المهام | MISSING | missing-translation, inconsistent-terminology — Issue #75-approved replacements (ڕێنیشاندان / کارەکان) not yet shipped |
| `about.finaleCta` | Explore Darwesh | گەڕان بە **داروێش**دا | استكشف **دارويش** | MISSING | brand-spelling (both wrong) + missing-translation — Issue #75 approved full replacement "دەروێش بناسە" not yet shipped |
| `about.followEyebrow` | STAY CONNECTED | **پەیوەندیدار بمێنەرەوە** | ابق على تواصل | MISSING | grammar — spurious extra ر; standard imperative is بمێنەوە, reads as a typo |
| `about.followTitle` | Follow Darwesh Group | **دەرەوشی گروپ** بەدواداچن | تابع **دارويش جروب** | MISSING | brand-spelling (both wrong) |
| `<title>`/`<meta description>` | Darwesh Group - About Us / ... | (hardcoded, never localized) | (same) | MISSING | missing-translation |

*Two corrections to earlier internal assumptions, confirmed by direct file read: `about.storyBody2` and `about.ctaTitle` do **not** actually contain a brand mention in the current live file — do not carry those forward as bugs. The actual related issue belongs to a separate, out-of-scope key `vrf.brandTitle` on verification.html (see Section 6), which uses a **third**, previously uncatalogued wrong AR variant, "داروش."*

#### Pending Issue #75 KU replacements — approved but not yet shipped in code

| Key | Currently shipped KU | Approved KU (not yet applied) |
|---|---|---|
| `about.mamLabelNavigate` | ڕێنمایی | ڕێنیشاندان |
| `about.mamLabelTasks` | ئەرکەکان | کارەکان |
| `about.editorialEngineeringHeadline` | لە پێکهاتەوە بۆ ماڵ. | لە بناغەوە تا ماڵێکی تەواو. |
| `about.editorialLegalHeadline` | هەموو هەنگاوێک، پشتڕاستکراوە. | هەر هەنگاوێک، بە دڵنیایی. |
| `about.finaleCta` | گەڕان بە داروێشدا | دەروێش بناسە |

(`about.mamLabelProperties`/`mamLabelServices` are already correct — no change needed.)

### MAM / MAM AI (`mam-ai.html` + `js/mam-chat-panel.js`)

| Key / Location | EN | KU | AR | TR | Flags |
|---|---|---|---|---|---|
| `mamai.pageH1` | MAM AI, the Darwesh Group property assistant | ...یاریدەدەری خانووبەرەی **دەرەوش گروپ** | ...مساعد **دارويش جروب** العقاري | MISSING | brand-spelling (both wrong) |
| `mam.disclaimer` | ...Darwesh Group's real, current listings... | ...داتای ڕاستەقینەی **دەرەوش گروپ**... | ...بيانات **مجموعة درويش** الحقيقية... | MISSING | brand-spelling — KU wrong; AR correct |
| `mam.greeting` | Ask me about Darwesh listings... | سڵاو، من MAMـم... لە داتای ڕاستەقینەی **دەرەوش گروپ**ەوە... (×2 mentions) | مرحبًا، أنا MAM... من بيانات **درويش**... | MISSING | brand-spelling (KU wrong ×2; AR correct); duplicate-wording vs. `GREETING_TEXT_KU` below |
| `mam.actionOpenedPage` (`{page}` var) | Opening {page}... | کردنەوەی {page}... | فتح {page}... | MISSING | mixed-language — `{page}` is filled by an English-only command detector in `js/mam-actions.js`, so KU/AR visitors can see a raw English word mid-sentence |
| `mam.offline` | I couldn't reach the Darwesh server... | نەمتوانی پەیوەندی بە سێرڤەری **دەرەوشەوە** بکەم... | تعذر الوصول إلى خادم **درويش**... | MISSING | brand-spelling — KU wrong; AR correct |
| voiceToggleBtn / input / micBtn / sendBtn aria-labels (JS, no i18n key) | "Voice replies" / "Ask MAM" / "Speak your question" / "Send message" | (hardcoded English, permanent gap on sendBtn) | (same) | MISSING | missing-translation ×4, one permanent (sendBtn never gets dynamically overridden) |
| `GREETING_TEXT_KU` (JS constant, hardcoded) | — | "سڵاو، من مامم. چۆن دەتوانم یارمەتیت بدەم؟" | — | MISSING | duplicate-wording/needs-context — a second, entirely hardcoded KU greeting bypassing i18n.js completely, diverging from `mam.greeting` |
| `<title>`/`<meta description>` | Darwesh Group - MAM AI / ... | (hardcoded, never localized) | (same) | MISSING | missing-translation; meta claims KU/AR/EN support, no mention TR exists |

**Section summary — 126 strings reviewed (77 About + 49 MAM/MAM AI).** Brand-spelling errors are pervasive in both KU and AR; this pass independently confirmed brand-spelling problems in `svc.designer.tagline`, `mam.greeting` (×2), and `mam.offline`; `mam.disclaimer`'s KU is wrong even though its AR sibling is correct — languages are drifting independently rather than reviewed together. MAM maintains two independent, drifting greetings. Four hardcoded English aria-labels/titles on composer buttons never localize. Terminology inconsistency for "property" recurs (خانووبەرە vs موڵک). All 5 of Issue #75's approved KU replacements for About remain unshipped as of this audit. Kurdish grammar/naturalness issues on close reading: `about.valuesTitle` reads as garbled and needs a native rewrite; `about.followEyebrow` has an apparent typo; `about.value4Body`'s "raw listings" calque is unidiomatic.

---

## 6. Projects, Services, Build, Renovate, Per-Service Pages

**Locale architecture confirmed:** only `ku:` and `ar:` blocks existed in `js/i18n.js` at audit time — no `tr:` block anywhere.

**Correction to earlier internal assumptions:** several keys previously believed wrong are actually **correct**: `build.introTitle`, `build.ctaServices`, `build.providersEmpty`, `build.providersSubtitle`, `renovate.introTitle`, `renovate.ctaServices`, `renovate.providersEmpty`, `renovate.providersSubtitle`, and `svc.mamai.tagline` all use the approved short brand form correctly in both languages — **`build.html` and `renovate.html` have zero brand-spelling problems.** Two new, more severe bugs were found elsewhere instead (below).

| Page / Area | Key | EN | KU | AR | TR | Flags |
|---|---|---|---|---|---|---|
| Projects | `cities.koya` | Koya | کۆیە | **كويە** | MISSING | grammar/mixed-language — same Kurdish-letter-in-Arabic bug confirmed independently three times now (sell.html, rent.html, projects.html) |
| Projects | `proj.categoryApartment` | Apartments | شوقەکان | الشقق | MISSING | inconsistent-terminology — Arabic-loan شوقەکان vs design.html's ئاپارتمان for the same concept |
| Project detail | `proj.contactNote` | All inquiries are handled by Darwesh Group on behalf of the developer. | ...لەلایەن **دەرویش گروپ**ەوە... | ...فريق **دارويش جروب**... | MISSING | **brand-spelling** — KU wrong; AR doubly wrong (extra alef + transliterated "جروب" instead of "مجموعة") |
| Project detail | `proj.whatsappPrefill` | Hello, I am interested in {ref} on Darwesh Group. | ...**دەرویش گروپ**. | ...**دارويش جروب**. | MISSING | brand-spelling — same wrong pattern |
| Project detail | `proj.inquireSent` | ...Darwesh Group will contact you soon. | ...**دەرویش گروپ**... | ...**مجموعة درويش** (correct)... | MISSING | brand-spelling (KU only) — **inconsistent within one page's 3 near-identical "Darwesh will contact you" messages** |
| Services hub | `svc.universeTitle`/`universeSubtitle`/`carouselAriaLabel`/`designer.tagline`/`directoryEyebrow` | Explore the Darwesh Service Universe / Real professionals, verified by Darwesh. / etc. | **دەرویش** throughout | **دارويش** throughout | MISSING | **brand-spelling** confirmed both wrong, both languages, across 5 keys |
| Services hub | `svc.cta.browseProviders` (shared key, 5 distinct EN CTAs) | *(varies)* | *(one generic string for all 5)* | *(one generic string for all 5)* | MISSING | inconsistent-terminology/needs-context — same architecture-level gap as About |
| design.html | `pwork.discoveryTagline` | Discover interior, architectural, and design work from Darwesh professionals. | ...پیشەگەرانی **دەرەوش** بدۆزەرەوە. | اكتشف...من محترفي **دەرەوش**. | MISSING | **brand-spelling + mixed-language — severe**: KU wrong; **the Arabic string literally contains the raw Kurdish word دەرەوش pasted inside an Arabic sentence** instead of translating it |
| rp-profile pages (shared) | `rp.requestsIntro` | Requests sent to you... Only you and Darwesh Group admins can see them. | ...تەنها تۆ و بەڕێوەبەرانی **گروپی دەروێش** دەیانبینن. (correct — best-formed brand mention found in this whole audit) | ...لا يراها سوى أنت ومشرفو مجموعة **دەرەوش**. | MISSING | **brand-spelling + mixed-language — severe**: AR ends with the raw Kurdish word دەرەوش pasted into an Arabic sentence, even though the KU sibling on the same key is the best-formed mention found anywhere in this audit |
| rp-profile pages | `rp.contactPrivateNote` | ...only you and Darwesh Group admins can. | ...**دەرەوش گروپ**. | ...**مجموعة درويش** (correct). | MISSING | brand-spelling (KU wrong) — opposite pattern from `requestsIntro` on the same tab set, genuinely scattershot |
| lawyer.html | `lawyer.tabProjects` | Cases & Work | **کەیسەکان** (drops "& Work") | القضايا والأعمال (both halves) | MISSING | missing-translation/literal — KU incomplete vs AR |
| maintenance.html | `maintenance.tabProjects` | Projects | **کارەکان**/"Works" (doesn't match own EN "Projects" — matches cleaning.html's tab instead) | — | MISSING | inconsistent-terminology — looks copy-pasted from cleaning.html rather than translated from maintenance's own EN |
| rp-profile pages | `rp.markVerified` | Mark as verified | (localized) | **التعليم كموثّق** | MISSING | awkward/grammar — AR reads as a noun phrase, not an imperative button label |

**Section summary — ~260 strings reviewed.** Two severe, previously-uncatalogued **mixed-language bugs**: `pwork.discoveryTagline` and `rp.requestsIntro` have Arabic translations that literally end with the raw Kurdish word دەرەوش pasted in place of the Arabic brand name. Brand-spelling inconsistency exists even within a single page/tab set (project.html's 3 near-identical messages; the rp-profile Contact/Requests tabs have opposite wrong/right patterns on adjacent keys) — proving the correct spelling exists in the codebase but isn't applied consistently. `svc.cta.browseProviders` collapses 5 distinct English CTAs into one generic KU/AR phrase. Missing/incomplete KU vs AR, copy-paste drift between near-duplicate pages, inconsistent apartment terminology, and ~19 hardcoded never-localized aria-labels/alt text across this whole group. Build.html and renovate.html are genuinely clean — don't carry forward the earlier assumption that they weren't.

---

## 7. Login, Signup, Password Recovery/OTP, Account

**TR: MISSING for all keys.** **Scope note:** `verification.html` is **not** the OTP screen — it's a separate, orphaned mobile "Apartments" leads-dashboard mockup with hardcoded demo data. Real OTP flows live inside signup.html Step 2, signup-professional.html Step 6, reset-password.html Step B.

| Page | Key | EN | KU | AR | Flags |
|---|---|---|---|---|---|
| Login — cleanest page audited, every string routes through i18n with sane fallbacks | `auth.loggingIn`/`logInBtn`/`logInTitle` | Log In / Log in / Logging in… | same KU word reused 3× | (same pattern) | duplicate-wording — states indistinguishable by text alone |
| Signup | `sell.phoneNumber` (reused for auth phone field) | Phone Number | "Mobile Number" specifically | generic "Phone Number" | inconsistent-terminology — cross-namespace key reuse |
| Signup | `auth.pro.professionalSignupLink` | Create a Professional Profile | "Use the professional sign-up" | "Use the professional sign-up" | **unclear-cta** — different action framing (create vs. use) between EN and KU/AR |
| Signup/Pro-Signup/Reset (shared) | `auth.otp.ariaDigitLabel` + index concatenation | "Verification code digit" + " 1" | same raw concatenation | same | awkward/literal-translation — ignores KU/AR ordinal grammar |
| Signup/Pro-Signup/Reset (shared) | `auth.otp.resendPrefix` + literal `${s}s` | "Resend code in" + "45s" | + "45s" (Latin "s" hardcoded) | + "45s" | mixed-language, repeats on 3 pages |
| **Signup / Pro-Signup / Reset (cross-cutting)** | Backend OTP/reset errors | `"That code is incorrect or has expired."` etc. (Python backend literals) | **raw English, never translated** | **raw English, never translated** | **missing-translation, mixed-language** — `describeBackendError()` passes `err.message` straight through; this is the single most important validation-error category in the whole audit (wrong/expired OTP, rate-limited) |
| Professional Signup | `auth.visual.proHeadline` | Grow your business on Darwesh Group | ...لەسەر **دەرویش گروپ** | نمِّ أعمالك مع مجموعة **دەرویش** | **brand-spelling + mixed-language** — KU wrong; **AR embeds the raw Kurdish word دەرویش inside an Arabic sentence** instead of writing درويش |
| Professional Signup | `auth.pro.pageSubtitle` | ...on Darwesh Group. | ...لەسەر **دەرەوش گروپ** ڕێکبخە. | ...في مجموعة درويش. (correct) | **brand-spelling** — KU wrong, AR correct |
| Professional Signup | `auth.pro.errNetwork` vs `auth.otp.errBackendUnavailable` | (same concept) | "سێرڤەر" (server, loanword) vs "ڕاژەکار" (different KU word) | — | inconsistent-terminology — two different KU words for "server" in the same error scenario across sibling pages |
| Password Reset | `auth.resetPasswordPageH1` | Reset your Darwesh Group password | ...هەژماری **دەرەوش گروپ** | ...حساب مجموعة درويش (correct) | **brand-spelling** — KU wrong, AR correct |
| Password Reset | `auth.reqNotCommon` | Not a commonly used password | (mildly redundant phrasing) | (localized) | awkward — KU doubles up "common" + "much-used" |
| Verification (mislabeled demo page) | `vrf.brandTitle` | Darwesh Verification | پشتڕاستکردنەوەی **داروێش** (known-wrong) | توثيق **داروش** | **brand-spelling** — AR "داروش" is a distinct typo (missing ي), not even matching the already-known wrong "دارويش" variant |
| Verification | `vrf.leads` | Leads | **ڕێنماییەکان** ("guidelines/instructions" — wrong sense entirely) | العملاء المحتملون (correct CRM sense) | unnatural-sorani/literal-translation — KU picked the wrong meaning of the English word "leads" |
| Account | `acct.roleCard.projectsDesc` | ...Nothing becomes public until Darwesh Group approves it. | ...تا **گروپی دەروێش** (correct) پەسەندی دەکات. | ...حتى توافق عليه مجموعة **دەرەوش** (Kurdish word pasted into Arabic) | **brand-spelling + mixed-language** |
| Account | **JS-rendered dynamic content — no i18n key at all**: Favorites/Submissions/Searches/My-Agent empty states, "Welcome, {name}" hero text, count pluralization, upload status (incl. raw `err.message`), Remove/Open buttons, submission-status fallback "Pending", agent name/office fallbacks | (all hardcoded English) | **always shows in English regardless of selected language** | same | **missing-translation, mixed-language, inconsistent-terminology** — jarring: page frame is in KU/AR but all loaded content is English; contrast with the page's own *Requests* tab, whose equivalent content IS correctly localized |

**Section summary — ~265 strings reviewed.** Backend OTP/reset error messages are never localized at all across Signup, Professional Signup, and Password Reset — the single most important validation-error category in the whole audit. `account.html`'s dynamic JS-rendered content is almost entirely unlocalized while its static markup is fully translated. Brand-name spelling drifts in both directions and, in 2 instances found here, literally embeds Kurdish-script brand spelling inside Arabic sentences (`auth.visual.proHeadline`, `acct.roleCard.projectsDesc`). Duplicate i18n keys for identical EN error messages diverge in Kurdish but stay identical in Arabic, suggesting Kurdish was translated ad hoc without a shared glossary. Mechanical string-concatenation breaks grammar in the OTP digit aria-label and resend-cooldown timer, repeating across 3 pages. `verification.html` is scope-mislabeled (a demo mockup, not the real OTP screen).

---

## 8. Profiles, Offices, Organizations, Designer Portfolio, Admin, Insights, Promo

**TR: MISSING for every string in this entire group (~520 strings)** — confirmed no `tr:` block existed at audit time.

### Critical, non-editorial bug found in this section (flagging for engineering, not ChatGPT)

**`admin.html`'s Estate Data/Intelligence tabs reuse i18n keys with different English fallback strings at different call sites.** English is fine (each call site supplies its own fresh fallback string), but KU/AR are fixed to whichever meaning was translated first for that key — so KU/AR users see **wrong field labels**:
- `admin.ei.office` → translated "Office" but also used for District and Organization fields → **KU/AR mislabels District/Organization as "Office"**
- `admin.ei.currentAsking` → translated "Current Asking Price" but also used for Project ID (the code even has an English-only `.replace('Current Asking','Project ID')` patch that silently no-ops in KU/AR) → **KU/AR mislabels Project ID as "Current Asking Price"**
- `admin.ei.status` also reused for "Updated"; `admin.ei.agent` also reused for "Verified By"; `admin.thAgentId`/`admin.thScannedAt` reused across Scan Log / Estate Data tables with different intended meanings

This is a functional bug in the admin dashboard, not a wording problem — flagging it here since it was found during this audit, but it needs an engineering fix (giving each field its own key), not new copy.

Also found: **untranslated native `alert()`/`confirm()` dialogs** for high-stakes actions — including the role-change confirmation that grants admin access — inconsistent with nearby dialogs that already use the translation pattern correctly.

### Copy findings

| Page | Key | EN | KU | AR | Flags |
|---|---|---|---|---|---|
| Agent Profile | `agent.unnamed` | Darwesh agent | بریکاری دەروێش (correct) | وكيل درويش (correct) | brand spelling correct here — good example |
| Agent Dashboard | `agentDash.accessOnlyDesc`/`listingsNote` | ...Darwesh Group... | ...**دەرەوش گروپ**... (wrong) | ...**مجموعة درويش**... (correct) | brand-spelling |
| Office | `office.unassignedHint`/`teamPrivateHint` | ...Darwesh Group support... | ...**دەرەوش گروپ**... (wrong) | ...**مجموعة درويش**... (correct) | brand-spelling |
| Office | `office.tabListings` | Listings | "بەرهەمەکان" (products/output, not listings) | (localized) | inconsistent-terminology — drifts from agent-dashboard's "خانووبەرە" for the same concept |
| Organization | `org.financeDisclaimer` | ...Darwesh Group does not calculate... | ...گروپی **دەرەوش**... (wrong) | ...مجموعة **دەرەوش**... (**Kurdish word pasted into Arabic sentence**) | **brand-spelling + mixed-language — severe** |
| Organization | `org.productsHint`, `org.teamPrivateHint` | ...Darwesh Group... | ...**دەرەوش**... (wrong, both) | ...**دەرەوش**... pasted into Arabic (both) | **brand-spelling + mixed-language — severe, ×2 more** |
| Org Projects | `op.noOrgsBody` | ...Contact Darwesh Group... | ...**دەرویش گروپ**... (wrong) | ...**دارويش جروب**... (extra alef + transliterated "جروب") | brand-spelling |
| Org Projects | `op.fPhoneNote` | ...Darwesh Group staff... (×2 mentions) | ...**دەرویش گروپ**...×2 (wrong) | ...**دارويش جروب**...×2 (wrong) | brand-spelling ×2 each language |
| Org Projects | Property/listing type + city `<option>`s (Add Unit form) | House/Villa/etc, city names | **no data-i18n at all** | same | missing-translation — every other dropdown on this same form is localized, these aren't |
| Designer Profile | `rp.requestsIntro` | ...Darwesh Group admins... | ...**گروپی دەروێش**... (correct) | مشرفو **مجموعة دەرەوش**... (Kurdish pasted into Arabic) | **mixed-language** — only AR broken here, KU correct |
| Designer Profile | `rp.contactPrivateNote` | ...Darwesh Group admins... | ...**دەرەوش گروپ**... (wrong) | ...**مجموعة درويش**... (correct) | brand-spelling — opposite pattern from `requestsIntro` on the very same page |
| Designer Profile | `rp.markVerified`/`markUnverified` | Mark as verified | (localized) | "التعليم كموثّق" (noun form, awkward) | grammar/inconsistent-terminology — office.html/org.html use "تمييز" correctly for the same action |
| Add/Edit Work | `pwork.notAuthorized`/`addWorkSubtitle` | ...Darwesh Designer profiles. / ...Darwesh design community. | **دەرەوش** (wrong, both) | **دەرەوش** pasted into Arabic (both) | **brand-spelling + mixed-language**, ×2 |
| Admin | `admin.pageH1`/`signInDesc`/`title`/`notice`/`networkRootLabel`/`dashboardTitle` | ...Darwesh Group... | **دەرەوش گروپ**/**دەرەوش** (wrong, 6 keys) | (correct or n/a) | brand-spelling ×6 |
| Admin | relative-time strings | X minutes/hours/days ago | full words spelled out | single-letter abbreviations (د/س/ي) | inconsistent-terminology — "ي" for day is non-standard Arabic abbreviation |
| Insights | `insights.subtitle`/`methodology` | ...Darwesh Group's... | ...**دەرەوش گروپ**... (wrong) | ...**مجموعة درويش**... (correct) | brand-spelling |
| Insights | JS `renderKPIs()` "All cities" scope label | All cities | **hardcoded, never routed through tr()** | same | **missing-translation** — the city dropdown itself translates correctly; the KPI subtitle echoing the selection doesn't |
| Insights | "View as table"/"Hide table" toggle | — | **overwrites the correctly-localized initial label with hardcoded English on first click, and never recovers for the rest of the session** | same | **functional regression, not just a missing string** |
| Promo | `promo.subtitle` | Verified in person by a Darwesh Group agent... | ...**دەرەوش گروپ**... (wrong) | ...**مجموعة درويش**... (correct) | brand-spelling + **unsupported-marketing-claim** |
| Promo | `promo.placeholderNote` | Placeholder roster for testing — swap in your real staff list before going live. | (localized) | (localized) | **Product-honesty issue** (not a translation issue): this admin-facing note admits the "Agent Check-In" roster is fake test data, directly contradicting `promo.subtitle`'s customer-facing "Verified in person" claim |
| Promo | WhatsApp message body (JS) | "Darwesh Group discount check-in: Agent {name}..." | **hardcoded English, never localized** | same | missing-translation — sent verbatim regardless of the admin's UI language |

**Section summary — ~520 strings reviewed across 11 files.** Brand-spelling errors in ~20 keys spanning nearly every file, with KU almost always wrong where AR is correct. **8+ instances of literal Kurdish-script text embedded inside Arabic sentences** — a worse defect class than simple misspelling, confirmed at: `org.financeDisclaimer`, `org.productsHint`, `org.teamPrivateHint`, `rp.requestsIntro` (designer.html), `pwork.notAuthorized`, `pwork.addWorkSubtitle`, plus `design.html`'s `pwork.discoveryTagline` from Section 6. A genuine functional i18n-key-reuse bug silently mislabels fields in admin.html's Estate Data/Intelligence tabs in KU/AR only. Untranslated native `alert()`/`confirm()` dialogs for high-stakes actions. Two more functional (not editorial) bugs in insights.html. A product-honesty issue on promo.html where an admin-facing admission of fake data contradicts a customer-facing verification claim. Every file in this group lacks i18n for page `<title>`/meta description.

---

## 9. Cross-cutting problem categories (site-wide)

1. **Brand-spelling errors, overwhelmingly in Kurdish, in ~30+ locations across nearly every page group.** The pattern is consistent: Kurdish is usually wrong (`دەرەوش`, `دەرویش`, `داروێش`, and variants), Arabic is often — but not always — correct. The correct forms exist correctly in the codebase (e.g. `agent.unnamed`, `installments.html`, `office.html`'s some strings), proving this is inconsistent application, not a universal misunderstanding of the approved spelling.
2. **A more severe defect class: literal Kurdish-script text pasted directly inside Arabic sentences**, found in at least 8 confirmed locations (`org.financeDisclaimer`, `org.productsHint`, `org.teamPrivateHint`, `rp.requestsIntro`, `pwork.notAuthorized`, `pwork.addWorkSubtitle`, `pwork.discoveryTagline`, `acct.roleCard.projectsDesc`, plus the `intro.enter` case on Home) — this reads as visibly broken to any Arabic reader, not merely inconsistent branding.
3. **Inconsistent Kurdish terminology for "property"** — the same concept is rendered as خانووبەرە, خانوو, and موڵک interchangeably, sometimes on the very same page (Home cycles through all three).
4. **Turkish is 0% implemented across the entire site** at the time of this audit (confirmed directly on every section — no `tr:` block existed in `js/i18n.js`).
5. **Unsupported/broad marketing claims**, concentrated heavily on sell.html ("verified buyers" 5+×, "within 24 hours" 4×, "Professional photography included") but present throughout (meta descriptions, footer tagline, buy/rent subtitles, promo.html).
6. **A systemic aria-label blind spot** — placeholders and visible labels are frequently localized while the corresponding aria-label on the same control stays hardcoded English, across Buy/Rent/Map/Listing/Sell/Signup/Account/Admin/Org pages alike.
7. **Several genuine functional/code bugs surfaced incidentally during this content pass** (not wording issues, flagged for engineering): `map.html`'s `PROPERTY_TYPE_KEYS` commercial-listing lookup mismatch; `admin.html`'s Estate Data/Intelligence tab key-reuse mislabeling District/Organization/Project ID/Updated/Verified-By fields in KU/AR only; `insights.html`'s "View/Hide table" toggle permanently overwriting a correct translation with hardcoded English after first click; `insights.html`'s "All cities" KPI label bypassing `tr()` entirely.
8. **`buy.html` silently bypasses working, correctly-localized toast/favorite/save-search keys** that the same concepts use correctly on rent.html/map.html/listing.html — the single most repeated same-concept inconsistency found.
9. **Backend-sourced validation errors (OTP/password-reset) are never localized anywhere** — raw English Python backend error strings are shown verbatim to KU/AR users across Signup, Professional Signup, and Password Reset. Given how failure-prone OTP flows are in practice, this is arguably the highest-impact single gap in the whole audit.
10. **Firestore-persisted, permanently-English content**: saved-search labels (buy.html, map.html) and the Sell wizard's stored listing-title `dealLabel` are written in English regardless of the author's UI language and then displayed back to every future viewer in English forever.
11. **`account.html`'s entire dynamically-rendered content layer (favorites, submissions, searches, agent info, empty states, "Welcome, {name}")** is unlocalized English inside an otherwise fully-translated KU/AR page frame — the most visible "half-translated page" found in the audit.
12. **Duplicate/diverging translations of the same underlying concept**, both across pages (e.g. two different KU words for "server" in sibling error-handling code) and within one page (e.g. `map.bedrooms` vs `common.beds` spelled two different ways on the same page).
13. **Shared CTA-key architecture loses per-service specificity in KU/AR**: `svc.cta.browseProviders` collapses 5 distinct English CTAs (Browse Engineers/Lawyers/Landscapers/Cleaning/Maintenance Providers) into one identical generic KU/AR string, on both about.html and services.html.
14. **A product-honesty contradiction on promo.html**: a customer-facing "Verified in person" marketing claim sits next to an admin-facing note admitting the underlying roster is fake placeholder data — present identically in all languages, a content-integrity issue rather than a translation one.
15. **Several Kurdish grammar/naturalness issues on close native-level reading**, independent of any brand-spelling or terminology flag: `about.valuesTitle` reads as garbled, `about.followEyebrow` has an apparent typo, `about.value4Body`'s "raw listings" calque is unidiomatic, `map.html`'s "artificial moon" for Satellite is an overly literal calque.
16. **5 of Issue #75's previously-approved Kurdish copy replacements for About remain unshipped** in the current `js/i18n.js` as of this audit — worth reconciling before any further About-page copy work.

---

## 10. Totals

| Section | Strings/keys reviewed |
|---|---|
| Home / Header / Mobile Nav / Footer | ~95 |
| Buy / Rent / Map / Listing Detail | ~155 |
| Sell (7-step wizard) / Installments | ~185 |
| About / MAM / MAM AI | ~126 |
| Projects / Services / Build / Renovate / Per-Service Pages | ~260 |
| Login / Signup / Password Recovery / OTP / Account | ~265 |
| Profiles / Offices / Organizations / Designer Portfolio / Admin / Insights / Promo | ~520 |
| **Total** | **~1,606 distinct strings/keys reviewed** |

Turkish coverage confirmed at 0% for all ~1,606 strings at the time of this audit (a `tr:` block has since been added in separate work; its content has not been reviewed as part of this editorial audit).

---

*This document contains findings only — no copy has been rewritten and no code has been changed. Phase 2 (approved wording implementation) should not begin until ChatGPT has reviewed this audit and supplied approved EN/KU/AR/TR copy.*
