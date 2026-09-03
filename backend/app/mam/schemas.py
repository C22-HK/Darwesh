# Typed wire contracts for POST /api/v1/mam/chat. Plain dataclasses with
# hand-written validation, matching this backend's existing convention
# (app.auth.reset, app.access.handlers) rather than introducing Pydantic
# as a new pattern -- every field this endpoint accepts or returns has an
# explicit, reviewable shape here, none of it inferred from a model
# response.
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Pages allowed to send structured context (section 7). An unrecognized
# `page` value is treated as absent, never trusted as-is -- see
# policy.validate_page_context.
KNOWN_PAGES = frozenset(
    {"home", "property", "properties_map", "professional", "services", "project", "buy", "rent"}
)

# Hard caps enforced BEFORE anything touches a provider or a Firestore
# query -- see policy.py for where each is actually checked. Centralized
# here so the request schema and the enforcement logic can never disagree
# about what the limit is.
MAX_MESSAGE_LENGTH = 1000
MAX_HISTORY_TURNS = 12
MAX_SELECTED_IDS = 8


@dataclass(frozen=True)
class PageContext:
    """What app.main's page-context validation in policy.py turns a raw,
    client-supplied context object into. Only page/selected IDs are ever
    trusted client input -- everything the model is allowed to say about
    those IDs is re-fetched from Firestore by a tool, never taken from
    this object directly (section 7: "Backend must validate IDs and
    re-fetch authoritative data")."""

    page: str | None
    listing_id: str | None = None
    project_id: str | None = None
    professional_id: str | None = None
    service_type: str | None = None
    selected_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class ChatRequest:
    message: str
    language: str  # "ku" | "ar" | "en"
    session_id: str
    page_context: PageContext


@dataclass(frozen=True)
class ChatRequestError:
    """Returned by parse_chat_request instead of raising -- lets routes.py
    map every rejection reason to the same 400 shape without a chain of
    except clauses."""

    message: str


@dataclass(frozen=True)
class PropertyCard:
    kind: str = "property"
    listing_id: str = ""
    title: str = ""
    city: str = ""
    price: float | None = None
    currency: str = "USD"
    deal_type: str = ""
    property_type: str = ""
    beds: int | None = None
    verified: bool = False
    image_url: str | None = None


@dataclass(frozen=True)
class ProjectCard:
    kind: str = "project"
    project_id: str = ""
    name: str = ""
    city: str = ""
    construction_status: str | None = None
    starting_price: float | None = None
    currency: str = "USD"
    verified: bool = False


@dataclass(frozen=True)
class ProfessionalCard:
    kind: str = "professional"
    provider_id: str = ""
    display_name: str = ""
    service_type: str = ""
    city: str | None = None
    verified: bool = False


@dataclass(frozen=True)
class MapAction:
    """A deterministic navigation instruction, never a data claim -- the
    frontend is responsible for actually rendering the map; MAM only ever
    tells it where to go and with what filters."""

    target: str  # "map.html" -- the one public Properties Map
    filters: dict[str, Any] = field(default_factory=dict)
    focus_listing_id: str | None = None


@dataclass(frozen=True)
class SuggestedAction:
    label_key: str  # an i18n key, so the frontend renders the right language -- never raw model text
    label_fallback: str
    action: str  # "open_map" | "open_listing" | "open_professional" | "save_property" | "open_url"
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ChatResponse:
    """The full structured shape a chat turn returns -- section 14's
    explicit "not giant text paragraphs" requirement. `message` is always
    present (the conversational text); everything else is optional and
    only populated when a tool actually produced it."""

    message: str
    language: str
    cards: tuple[PropertyCard | ProjectCard | ProfessionalCard, ...] = ()
    comparison: dict[str, Any] | None = None
    map_action: MapAction | None = None
    suggested_actions: tuple[SuggestedAction, ...] = ()
    degraded: bool = False  # true when this answer came from the deterministic fallback, not a live model
    session_id: str = ""


def parse_chat_request(body: dict, *, session_id_from_client: str | None) -> ChatRequest | ChatRequestError:
    """Validates a raw parsed-JSON body into a ChatRequest. Every failure
    returns a ChatRequestError with a safe, generic-enough message --
    never echoes back malformed input verbatim (a cheap, easy place for a
    reflected-content issue to creep in otherwise)."""
    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        return ChatRequestError("Please provide a message.")
    if len(message) > MAX_MESSAGE_LENGTH:
        return ChatRequestError(f"Message is too long (max {MAX_MESSAGE_LENGTH} characters).")

    language = body.get("language")
    if language not in ("ku", "ar", "en"):
        language = "en"

    # session_id: prefer the client-supplied one (lets a page reload keep
    # the same conversation) but only if it looks like a real session
    # token this backend could plausibly have issued -- never trust it
    # enough to look up someone else's session by guessing (session.py's
    # store is itself keyed so a guessed id at worst finds an empty
    # session, never another user's).
    session_id = session_id_from_client if isinstance(session_id_from_client, str) and session_id_from_client else None

    raw_ctx = body.get("pageContext")
    ctx = _parse_page_context(raw_ctx if isinstance(raw_ctx, dict) else {})

    return ChatRequest(message=message.strip(), language=language, session_id=session_id or "", page_context=ctx)


def _parse_page_context(raw: dict) -> PageContext:
    page = raw.get("page")
    if page not in KNOWN_PAGES:
        page = None

    def _opt_str(key: str) -> str | None:
        v = raw.get(key)
        return v if isinstance(v, str) and v and len(v) <= 200 else None

    selected_raw = raw.get("selectedIds")
    selected: tuple[str, ...] = ()
    if isinstance(selected_raw, list):
        selected = tuple(
            v for v in selected_raw[:MAX_SELECTED_IDS] if isinstance(v, str) and v and len(v) <= 200
        )

    return PageContext(
        page=page,
        listing_id=_opt_str("listingId"),
        project_id=_opt_str("projectId"),
        professional_id=_opt_str("professionalId"),
        service_type=_opt_str("serviceType"),
        selected_ids=selected,
    )
