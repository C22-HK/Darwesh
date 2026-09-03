# MAM Intelligence V2 — Architecture

Status as of this document: **provider-independent**. No live AI provider
(Gemini/Vertex AI, OpenAI, or Anthropic) is wired to a real network call
anywhere in this codebase. Every architectural seam a real provider will
eventually plug into already exists, is tested, and is described below —
activating one is a small, contained change (see §11), not a redesign.

## 1. What MAM actually is today

MAM is **not** a chatbot with an LLM behind it yet. It is:

1. A deterministic intent resolver (`backend/app/mam/intent_resolver.py`)
   that pattern-matches a visitor's message (English/Kurdish Sorani/Arabic)
   against a fixed set of recognized shapes (a city, a property type, a
   deal type, a price, a bedroom count, a map/service/greeting keyword)
   and, on a confident match, dispatches one of 14 real backend tools.
2. A set of deterministic tools (`backend/app/mam/tools.py`) that read
   real Firestore data (`listings`, `projects`, `serviceProviders`,
   `estates/*/publicTransactionSummary`, a signed-in user's own
   `favorites`) and return it in a typed, bounded shape.
3. An orchestrator (`backend/app/mam/orchestrator.py`) that tries the
   resolver first, would try a configured live provider second, and
   returns an honest "AI reasoning is temporarily unavailable, but I can
   still help with navigation" message third — never a fabricated answer.

Because no provider is configured, **every non-degraded response today
comes from step 1/2** — real data, deterministically retrieved, never
generated prose about facts. The frontend never claims otherwise (see §9).

## 2. Request flow

```
Browser (mam-ai.html + js/mam-v2.js)
  │  POST /api/v1/mam/chat  { message, language, sessionId, pageContext }
  │  Authorization: Bearer <Firebase ID token>   (OPTIONAL — see §5)
  ▼
backend/app/mam/routes.py  (MamHandler.chat)
  │  rate limit (IP + uid, §7) → parse/validate (schemas.py) → resolve caller
  ▼
backend/app/mam/orchestrator.py  (Orchestrator.handle_turn)
  │  1. intent_resolver.resolve_intent(message)  — cheap, no model call
  │  2. if no match AND a provider is configured → provider.generate(...)
  │  3. if neither → honest degraded message (ku/ar/en)
  ▼
backend/app/mam/tools.py  (Tools, via dispatch())
  │  per-tool AuthRequirement check (policy.py) → real Firestore read →
  │  project_public_listing_fields() / wrap_untrusted() on any free text
  ▼
Typed ChatResponse (schemas.py) → JSON → rendered by js/mam-v2.js
  (property/project/professional cards, comparison stats, a map action,
  suggested actions — never raw HTML, never model-authored markup)
```

## 3. Provider abstraction

`backend/app/mam/providers/base.py` defines the **only** seam between
MAM's business logic and any AI vendor:

- `ChatProvider` — a `Protocol` with one async method, `generate(*,
  system_instruction, history, tools, tier, max_output_tokens) ->
  ProviderResponse`. Concrete adapters (`GeminiProvider`, `OpenAIProvider`,
  `AnthropicProvider`) implement it *structurally* — they do not inherit
  from it, matching this backend's existing convention for every other
  pluggable dependency (`FirebaseIdTokenVerifier`, `ResendEmailSender`,
  `RateLimiter`).
- `ModelTier` — `FAST` | `REASONING`, a **capability tier**, never a raw
  model string. Each adapter maps a tier to its own concrete model id
  internally; nothing outside a provider adapter ever sees a model name.
- `ProviderNotConfiguredError` — the one exception every adapter's
  `generate()` currently raises. The orchestrator catches exactly this
  type and falls back to the degraded/deterministic path — it never
  catches a provider-specific exception, so swapping providers later
  cannot change orchestrator.py's error handling.

`backend/app/main.py`'s `build_mam_provider(cfg)` is the **only** place a
provider choice is made: it reads `Config.mam_chat_provider` ("gemini" |
"openai" | "anthropic" | "" ) and constructs the matching adapter, or
`None`. `orchestrator.py`, `tools.py`, `policy.py`, and `routes.py` never
import a provider SDK or branch on which one is active.

### Why each adapter is a placeholder today

| Adapter | File | Why it doesn't call out yet |
|---|---|---|
| Gemini/Vertex AI | `providers/gemini.py` | Constructor validated (requires `project_id`/`location`/`model_flash`/`model_pro`), but no `google-genai` call is wired — pending the Sorani benchmark and the Vertex AI IAM grant (§11). |
| OpenAI | `providers/openai.py` | Constructor validated (requires an API key), no `openai` SDK call wired — pending the Sorani benchmark. |
| Anthropic | `providers/anthropic.py` | Same shape, requires an API key, pending the Sorani benchmark. |

Activating one later is: fill in that file's `generate()` body using the
vendor's SDK, add the SDK to `backend/requirements.txt`, and set
`MAM_CHAT_PROVIDER`. No other file in `app/mam/` needs to change.

## 4. Deterministic tool layer

`backend/app/mam/tools.py`'s `Tools` class is **the only way any MAM
response ever touches Firestore.** A live provider (once activated) would
never run its own query — it can only ask the orchestrator to invoke one
of the registered tools by name, with arguments matching that tool's JSON
Schema (`build_tool_specs()`). `dispatch()` is the single chokepoint that
turns a tool name into a real method call — an unknown name raises
`ToolExecutionError`, never a dynamic `getattr` lookup.

14 tools are implemented, each with a bounded result count
(`MAX_RESULTS=12`, `MAX_COMPARE=4`) and an explicit `AuthRequirement`
(§5): `search_properties`, `get_property`, `compare_properties`,
`get_market_summary`, `get_listing_history`, `search_professionals`,
`get_professional`, `search_services`, `search_projects`, `get_project`,
`open_on_map`, `get_saved_properties`, `save_property`,
`remove_saved_property`.

### Tools not implemented this phase, and why

- **`search_nearby`** — no geo-index exists on `listings` yet.
- **`prepare_viewing`** (write to `submissions`) — AI-driven writes to
  that collection need their own security re-audit before an automated
  caller can create one; not done this phase.
- **Estate internal transaction history** beyond the already-separate,
  admin-curated `publicTransactionSummary` — `estates/*/transactionHistory`
  stays admin-only, on purpose (§6).
- **Ratings/reviews** — no such schema exists anywhere in this project;
  MAM cannot show one that doesn't exist.

## 5. Authorization boundary

`backend/app/mam/policy.py` defines `AuthRequirement.PUBLIC` |
`AuthRequirement.AUTHENTICATED` | `AuthRequirement.ADMIN`, and
`require_auth(caller, requirement)` — checked inside **every** tool
method, before any Firestore read. The model (or, today, the
deterministic resolver) never decides authorization; it only asks for a
tool, and the tool itself enforces who may call it.

**MAM's own endpoint is deliberately public.** `routes.py`'s `MamHandler`
authenticates the caller opportunistically: a valid Firebase ID token
resolves to a real `MamCaller(uid, role)`; a missing or invalid token
resolves to `PUBLIC_CALLER`, never a 401. A signed-out visitor can search
listings, read market stats, and browse professionals — the same data
buy.html/services.html already show anonymously. Only
`AuthRequirement.AUTHENTICATED` tools (`get_saved_properties`,
`save_property`, `remove_saved_property`) reject a public caller, with an
honest "you'll need to sign in for that" message, never a silent failure.

## 6. Public/private data boundary & exact-location privacy

MAM's public tools read `listings.lat`/`lng` — this is **not a new
exposure**: those fields are already public per the existing, previously
audited `firestore.rules` (`allow get, list: if isListingPubliclyVisible()
|| isListingOwnerOrAdmin()`), and already rendered on buy.html/map.html
for any anonymous visitor. MAM surfaces nothing beyond what those pages
already show.

The real privacy boundary MAM must never cross, and does not:

- `estates/{id}/protected/*` — admin-only in `firestore.rules`, never
  read by any MAM tool.
- `estates/{id}/transactionHistory` — admin-only, never read by any MAM
  tool. `get_listing_history` reads **only**
  `estates/{id}/publicTransactionSummary` — a deliberately separate,
  admin-curated subcollection that exists specifically so a public-facing
  feature has something safe to read.
- Any user's PII beyond their own `favorites` (and only for that same
  authenticated user).

`policy.project_public_listing_fields()` is the single allowlist every
listing document passes through before any tool returns it — a field not
on that allowlist (e.g. `agentId`, an owner's phone) can never reach a
response body no matter what a future prompt/tool-call asks for.

## 7. Prompt-injection boundary

Any free-text field pulled from Firestore (a listing description, a
professional's bio, a project description) is wrapped by
`policy.wrap_untrusted(label, text)` before it ever reaches a system
prompt: `<<<DARWESH_DATA_START>>>...<<<DARWESH_DATA_END>>>`, with any
literal occurrence of those markers **inside** the text itself escaped
first, so a malicious listing description can never forge a fake
boundary and "close" the data block early. `prompts.py`'s system
instruction explicitly tells a live model that text inside those markers
is content to explain, never an instruction to follow. This is enforced
at the code layer (the wrapping + escaping), not only requested of the
model — the frontend adds a second layer independently (§9: textContent
only, never innerHTML).

## 8. Response schemas

`backend/app/mam/schemas.py` is the single source of truth for the wire
contract. Request (`ChatRequest`): `message` (≤1000 chars),
`language` (`ku`|`ar`|`en`), `sessionId`, `pageContext`
(`page`/`listingId`/`projectId`/`professionalId`/`serviceType`/
`selectedIds`, validated against a fixed `KNOWN_PAGES` set — an
unrecognized page is treated as absent, never trusted as-is). Response
(`ChatResponse`): `message`, `cards` (property/project/professional,
discriminated by a `kind` field), `comparison` (a generic structured
slot), `mapAction` (navigation only, never a data claim),
`suggestedActions`, `degraded` (true only when neither the resolver nor a
live provider produced anything), `sessionId`.

The frontend (`js/mam-v2.js`) mirrors this exactly — see `_serialize_*`
in `routes.py` for the exact camelCase wire shape and
`renderResultsInto()`/`buildPropertyCard()`/etc. in `mam-v2.js` for how
each field is rendered, always via `textContent`/DOM properties, never
`innerHTML`.

## 9. Frontend honesty guarantee

`js/mam-v2.js` computes nothing about the market itself — no keyword
table, no client-side Firestore aggregation, no fabricated "AI valuation."
Every fact rendered came from a backend tool call in `data.cards` /
`data.comparison` / `data.message`. Because no provider is configured
yet, the UI's persistent disclaimer says exactly that: *"MAM answers
using Darwesh Group's real listings, projects, and market data. Full
conversational AI reasoning is not enabled yet"* — true today, and it
naturally becomes inaccurate (and must be revised) the day a real
provider is activated, which is why it lives in one i18n key
(`mam.disclaimer`) rather than being duplicated across the UI.

## 10. Rate limiting & cost controls

`backend/app/mam/rate_limit.py`'s `MamRateLimiters` reuses the existing
`RateLimiter` abstraction (`app.auth.reset`) — no new limiting mechanism.
Two independently-namespaced buckets, both must allow: 20 req/5min per
client IP (covers anonymous visitors), 40 req/5min per signed-in uid
(tighter per-identity control once behind a shared IP/NAT). Backed by
`FirestoreRateLimiter` in production, `InMemoryRateLimiter` in
development — same split every other rate-limited endpoint in this
backend already uses. A 429 from the backend renders as a friendly
"you're sending messages a little fast" state client-side (`js/mam-v2.js`
`sendMessage()`), never a generic error.

Additional cost controls already in place, ready for when a provider is
real: `MAX_MESSAGE_LENGTH=1000`, `MAX_HISTORY_TURNS=12` (bounded
conversation memory, §11), `MAX_RESULTS=12`/`MAX_COMPARE=4` on every tool
(a provider is never handed hundreds of documents to reason over), and
`max_output_tokens=800` passed to `generate()` on every call.

## 11. Conversation / session behavior

`backend/app/mam/session.py`'s `SessionStore` is **process-local,
in-memory**, evicted by a fixed TTL (30 minutes of inactivity) and a
fixed max-session count (5000, oldest evicted first) — a deliberate,
documented tradeoff: MAM only needs a few minutes of "what did we just
talk about" continuity (e.g. "only 3 bedrooms" as a follow-up to an
earlier search), not a durable cross-device chat history. This is
unlike the OTP/rate-limit stores elsewhere in this backend, which
correctness-depend on surviving across Cloud Run instances and are
Firestore-backed for exactly that reason — MAM's session store is not,
on purpose. A future phase needing cross-instance continuity would
extend this the same way `app.otp.store.FirestoreChallengeStore` extends
`InMemoryChallengeStore`.

Client-side, `js/mam-v2.js` stores the backend-issued `sessionId` in
`sessionStorage` (cleared when the tab closes, matching the store's
short-lived intent) and sends it back on every turn. A client-guessed or
foreign session id is never trusted as anyone else's conversation — the
store is keyed so an unknown id simply resolves to a fresh, empty
session.

## 12. Voice: browser fallback, honestly labeled

There is **no dedicated Kurdish STT/TTS provider selected** (see
`docs/MAM_SORANI_BENCHMARK.md`'s findings — no major provider officially
supports Sorani Kurdish text-to-speech, and the STT picture is similarly
thin). `js/mam-v2.js` uses only the browser's built-in
`SpeechRecognition`/`speechSynthesis` APIs, as a graceful fallback the
text experience never depends on:

- **Recognition**: routed through `ar-IQ` for Kurdish/Arabic UI language
  (the same limitation every other page's voice input already has — no
  browser exposes a dedicated Kurdish recognition locale).
- **Synthesis**: tries real Kurdish voice tags first (`ku`, `ckb`, `kmr`)
  if the visitor's device happens to have one installed, then falls back
  to Arabic. When it does fall back, a one-time, session-scoped notice
  (`mam.speechFallbackNote`) tells the visitor explicitly — Arabic
  pronunciation is never presented as native Kurdish.
- **Controls are deliberately minimal**: a language reflection (driven by
  the site's existing language switcher, not a separate MAM-only
  setting), a voice on/off toggle, and a speech-speed slider
  (0.75×–1.25×, persisted in `localStorage`). The full per-voice OS
  catalog picker the legacy `mam-ai.html` exposed (browse/preview every
  installed system voice) is removed — automatic best-voice selection
  (same scoring heuristic as before: language match, "natural/neural/
  premium" name hints, network-served bonus) replaces it.
- If neither `SpeechRecognition` nor `speechSynthesis` exists on a
  device/browser, every text feature above still works unmodified —
  voice is additive, never a dependency.

`mam:speech-start` / `mam:speech-end` are dispatched on `window` around
real `SpeechSynthesisUtterance` playback (`start`/`end`/`error` events) —
preparation for a future Home ambient-audio-ducking feature. **Not
implemented this phase**: no Home ambient audio exists yet to duck.

## 13. Frontend rendering & the MAM visual identity

`mam-ai.html`'s `#mamOrb` is a small, original CSS construct (a still
core within a ring, no mascot/robot glyph, no chat-bubble icon) driven by
a `data-state` attribute: `idle` (slow breathing pulse) | `listening`
(pulsing ring, matches mic activation) | `thinking` (rotating dashed
ring, matches an in-flight request) | `speaking` (quick pulse, matches
`mam:speech-start`/`-end`) | `result-ready` (a brief gold accent when a
turn returns structured data) | `error` (a brief red-tinted accent).
Every animation is disabled under `prefers-reduced-motion: reduce`,
falling back to a static color/border change only. Built entirely from
the existing `--ps-color-*` cinematic tokens (Obsidian/Carbon/Bronzed
Black backgrounds, Champagne/Antique Gold accents, Soft Ivory/Stone Beige
text) — no new brand colors introduced.

Layout: a two-column shell on desktop (conversation column + a sticky
"workspace" panel mirroring the latest turn's structured results at
full size) that collapses to a single full-screen conversation column on
mobile, where the same results render compactly inline in the chat
bubble and a tap opens a bottom sheet (`#mamSheet`) with the full card
plus real navigation actions (an "Open on the map" / "View full listing"
/ "View profile" link built from the same real ids the backend returned
— never a fabricated link). The sheet traps focus, closes on `Escape` or
backdrop click, and restores focus to its trigger element on close.

## 14. Page context

`js/mam-v2.js`'s `readPageContext()` reads `page`/`listingId`/
`projectId`/`professionalId`/`serviceType` from `mam-ai.html`'s own URL
query string and forwards them as `ChatRequest.pageContext` — never
serialized DOM, never full page HTML, and never treated as authoritative
data (the backend re-fetches anything an id points to via a tool; the
client-supplied id is only ever a lookup key, see §6/§4).

**Known limitation, honestly disclosed**: no page in this repository
currently links to `mam-ai.html` with these structured parameters yet
(the existing links from index.html/about.html/services.html/map.html/
profile.html are plain, and index.html's search box passes only `?q=` —
kept working unchanged). This phase implements the real, tested
*receiving* end; wiring an outbound "Ask MAM about this property" link
from listing.html (or similar) to actually populate `page=property&
listingId=...` is a small, natural follow-up, not started here to avoid
touching pages outside MAM's own surface.

## 15. Performance

`js/mam-v2.js` and `js/mam-api.js` are loaded only by `mam-ai.html`
(`<script type="module">`, ES module — fetched once, never inlined into
every page). No other page on the site imports MAM's controller. MAM
performs **zero** direct Firestore reads from the browser — every fact
comes from one backend call per turn; there is no "preload hundreds of
listings" pattern here (that already-audited pattern lives only in the
legacy `loadMarketStats()`, removed in this rebuild — see §16). Cards
render from the single JSON response already fetched; a listing's image
uses `loading="lazy"`.

## 16. Legacy cleanup performed

`mam-ai.html` was rewritten in place (same URL — every existing inbound
link keeps working unchanged) rather than left alongside a new page, so
there is exactly one MAM implementation live at any time. Removed:

- The entire client-side `RESPONSES` keyword table and its ~40 canned
  reply/CTA pairs (`worthReply`, `cityStatsReply`, `investReply`,
  `listingsReply`, `searchReply`, `fallbackReply`, `getResponse`, and
  every `CITY_KEYWORDS`/`PROPERTY_TYPE_KEYWORDS`/price-extraction helper
  duplicated client-side) — this logic's *useful* part (Kurdish/Arabic
  text normalization, city/property/deal-type/price/bedroom detection)
  was not discarded; it was ported server-side into
  `backend/app/mam/intent_resolver.py` in the prior phase, so the same
  real capability now runs once, authoritatively, on the backend instead
  of being duplicated and drifting between two implementations.
- The fake 600–1300ms `setTimeout` "thinking" delay — the new "thinking"
  state is driven by a real in-flight `fetch`, not a fabricated pause.
- Any "AI valuation" framing — the old `cta1`/"Get a Free Valuation" CTA
  and `worthReply()`'s invented per-city price-trend narrative
  ("prices rise 6-9% annually...", a hardcoded fabrication) are gone;
  `get_market_summary` returns only real aggregate counts/min/max/avg
  computed from live `listings` documents.
- The full installed-OS voice-catalog picker (`voiceSettingsBtn`'s panel,
  `renderVoicePanel`/`voicesForPanel`/`previewVoice`/`openVoicePanel`,
  the `.voice-panel` CSS) — replaced by the minimal three-control voice
  fallback in §12.
- `loadMarketStats()`'s direct client-side Firestore query/aggregation
  over the entire `listings` collection — market stats now come from the
  backend's `get_market_summary` tool exclusively.

Every removed `mamai.*` i18n key (128 entries across `ku`/`ar`) was
confirmed unused anywhere else in the repository before deletion
(`grep -rl "mamai\." --include="*.html" --include="*.js"` showed no
other file referencing them) and replaced with a new, smaller `mam.*` key
set matching the new UI exactly — verified by `scripts/ci-checks.js`.

## 17. Environment variables / secrets (names only — no values here or anywhere in this repo)

Read by `backend/app/config.py`, all optional, empty by default:

| Variable | Purpose |
|---|---|
| `MAM_CHAT_PROVIDER` | `"gemini"` \| `"openai"` \| `"anthropic"` \| unset. Selects which adapter `app.main.build_mam_provider` constructs. Unset = deterministic-only (current state). |
| `GEMINI_PROJECT_ID` | GCP project id Vertex AI calls would bill against. No default — never silently guessed. |
| `GEMINI_LOCATION` | Vertex AI region (e.g. a `me-central1`/`us-central1`-style value — confirmed at activation time, see §11 of the PROVIDER CONFIGURATION report). |
| `GEMINI_MODEL_FLASH` / `GEMINI_MODEL_PRO` | Concrete Vertex AI model ids for the FAST/REASONING tiers. Gemini model ids retire on a schedule — these must never be hardcoded into source. |
| `OPENAI_API_KEY` | Real secret. Sourced from Google Secret Manager via Cloud Run's secret-injection env vars in production — never hardcoded, never logged, never placed in a committed `.env` file. |
| `ANTHROPIC_API_KEY` | Same handling as `OPENAI_API_KEY`. |

`FIREBASE_SERVICE_ACCOUNT_JSON`/`FIREBASE_PROJECT_ID` (already-existing,
not MAM-specific) gate whether `/api/v1/mam/chat` registers at all —
MAM's tools need a real Firestore client regardless of which chat
provider (if any) is configured; see `app.main.build_mam_handler`'s
docstring.

## 18. Production deployment requirements

1. This backend must actually be deployed (Cloud Run, per
   `backend/README.md`) with a real `FIREBASE_SERVICE_ACCOUNT_JSON` (or
   Application Default Credentials in production) for `/api/v1/mam/chat`
   to exist at all — today it is not deployed anywhere, matching every
   other backend endpoint's current state.
2. `ALLOWED_ORIGINS` must include the real frontend origin(s) for the
   browser's CORS preflight to succeed.
3. Activating a live chat provider additionally requires the exact
   IAM/API/secret setup detailed in this phase's separate PROVIDER
   CONFIGURATION report (not duplicated here — that report is the
   single source of truth for exact `gcloud` commands and cost
   implications, since those may change between when this document is
   written and when a provider is actually activated).
4. No change to `firestore.rules`/`storage.rules` is required by MAM V2
   — every collection its tools read already has existing, unmodified,
   previously-audited rules (see §6).

## 19. Testing

Backend: 96 new tests across `backend/tests/test_mam_*.py` (policy,
schemas, intent resolver — including a real Unicode-range bug caught and
fixed while writing these tests, see the commit introducing
`backend/app/mam/`, session eviction, every tool against a fake
in-memory Firestore, the orchestrator's fallback chain, and the route's
full HTTP contract). Frontend: validated via `node scripts/ci-checks.js`
(inline script syntax, i18n key parity/coverage, no broken links, no
duplicate ids) and manual Playwright-driven browser QA across desktop/
mobile breakpoints, all three languages/RTL, reduced-motion, and the
provider-unconfigured degraded state (see this phase's final report for
the exact matrix run and results — real browser QA, not simulated).
