# Everything about WHO may do WHAT and WHAT the model is allowed to see,
# centralized here so no individual tool has to re-derive it. The model
# never decides authorization (section 9) -- it only ever reaches this
# code indirectly, by asking to invoke a tool that then calls through
# here before touching Firestore.
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


# UP042 suppressed on the class line only, deliberately and permanently.
#
# Ruff wants `StrEnum` here. That is NOT a behaviour-preserving swap: a
# (str, Enum) member stringifies to 'AuthRequirement.PUBLIC', while a
# StrEnum member stringifies to 'public'. Measured, not assumed. Equality
# against a plain str and json.dumps output are identical for both, and no
# current call site interpolates a member -- but this is a str subclass
# whose whole purpose is being usable as a string, so the day someone adds
# an f-string log line or uses a member as a dict key, the output silently
# changes. The legacy contract is kept on purpose.
#
# Scoped to this one statement: no global UP042 disable, no file-level
# blanket, no ruff config change. Any OTHER class in this file that
# inherits (str, Enum) will still be flagged.
class AuthRequirement(str, Enum):  # noqa: UP042 -- legacy str-Enum contract, see above
    PUBLIC = "public"  # any caller, signed in or not
    AUTHENTICATED = "authenticated"  # a real, verified Firebase uid required
    ADMIN = "admin"  # reserved -- no MAM tool uses this yet (see tools.py's "not implemented" list)


class ToolAuthorizationError(Exception):
    """Raised when a caller isn't allowed to invoke a tool. routes.py maps
    this to the user-facing "Authentication required for this action"
    state (section 26) -- never a raw exception message."""


@dataclass(frozen=True)
class MamCaller:
    """The one thing any tool is allowed to trust about who is asking.
    uid is None for a public/unauthenticated visitor -- a legitimate,
    expected case for MAM (unlike the Phase 2 access-management
    endpoints, which 401 on this), not an error. Built ONLY from a
    verified Firebase ID token via app.access.caller_context.AuthGate --
    never from anything the client claims about itself in the request
    body (section 9: "Do NOT trust client-supplied user ID")."""

    uid: str | None
    role: str | None = None

    @property
    def is_authenticated(self) -> bool:
        return self.uid is not None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


PUBLIC_CALLER = MamCaller(uid=None, role=None)


def require_auth(caller: MamCaller, requirement: AuthRequirement) -> None:
    """Raises ToolAuthorizationError if `caller` doesn't meet
    `requirement`. This is the ONLY function any tool implementation
    calls to check authorization -- see tools.py's TOOL_REGISTRY, where
    every entry's `auth` field is one of these enum values, checked here
    before the tool's own Firestore call ever runs."""
    if requirement is AuthRequirement.PUBLIC:
        return
    if requirement is AuthRequirement.AUTHENTICATED:
        if not caller.is_authenticated:
            raise ToolAuthorizationError("Authentication required for this action.")
        return
    if requirement is AuthRequirement.ADMIN:
        if not caller.is_admin:
            raise ToolAuthorizationError("This action requires admin access.")
        return


# ---- Prompt-injection defense -----------------------------------------
# Every piece of free text this backend pulls out of Firestore (a listing
# title, a project description, a professional's bio) is DATA the model
# is explaining, never an instruction it should obey (section 11). Two
# defenses, applied together:
#
# 1. Delimiting: wrap the text in a clearly-labeled block with a random-
#    ish, hard-to-forge boundary marker, and escape any literal
#    occurrence of that marker inside the text itself -- so a malicious
#    description can never forge a fake closing tag and "escape" into
#    what looks like a new system instruction.
# 2. Length capping: an oversized field is truncated before it ever
#    reaches a provider, both as a cost control (section 23) and because
#    a very long untrusted block is exactly the shape a prompt-injection
#    payload wants room for.
_UNTRUSTED_OPEN = "<<<DARWESH_DATA_START>>>"
_UNTRUSTED_CLOSE = "<<<DARWESH_DATA_END>>>"
MAX_UNTRUSTED_FIELD_LENGTH = 600


def wrap_untrusted(label: str, text: str | None) -> str:
    """Wraps ONE untrusted text field for inclusion in a tool result the
    model will read. `label` is a fixed, developer-chosen string (e.g.
    "listing description"), never derived from the untrusted text itself.
    An empty/missing value returns a clean "not provided" -- never an
    empty pair of tags a model might read as license to invent content."""
    if not text or not text.strip():
        return f"{label}: not provided"
    cleaned = text.strip()[:MAX_UNTRUSTED_FIELD_LENGTH]
    # Neutralize any attempt to forge the boundary marker itself.
    cleaned = cleaned.replace(_UNTRUSTED_OPEN, "[blocked]").replace(_UNTRUSTED_CLOSE, "[blocked]")
    return f"{label}: {_UNTRUSTED_OPEN}{cleaned}{_UNTRUSTED_CLOSE}"


# ---- Location privacy ---------------------------------------------------
# Per the repo's own AUTHZ/BUSINESS_LOGIC security review history: a
# `listings` document's lat/lng ARE already public data today -- the same
# fields buy.html/map.html/rent.html already render to every visitor
# (firestore.rules' `listings` read rule is `allow get, list: if
# isListingPubliclyVisible() || isListingOwnerOrAdmin()`, with no separate
# exact/approximate location split in the schema). A MAM tool reading a
# publicly-visible listing therefore exposes nothing beyond what those
# pages already show -- this is NOT a new bypass, it inherits the
# existing, already-reviewed public contract.
#
# What MUST stay out of reach of every MAM tool implemented this phase
# (see tools.py) regardless of caller: `estates/{id}/protected/*` (owner
# contact info, internal notes -- admin-only by firestore.rules itself)
# and `estates/{id}/transactionHistory` (internal verified-sale records,
# admin-only read) -- only `estates/{id}/publicTransactionSummary` (an
# admin-curated, deliberately separate public projection) is ever read.
# This function exists to make that boundary an explicit, named decision
# a future tool must deliberately opt out of, not an accident of which
# fields happened to be queried.
PUBLIC_LISTING_FIELDS = frozenset(
    {
        "title",
        "address",
        "city",
        "lat",
        "lng",
        "dealType",
        "propertyType",
        "price",
        "beds",
        "baths",
        "sqft",
        "img",
        "amenities",
        "verified",
        "estateId",
    }
)


def project_public_listing_fields(doc: dict) -> dict:
    """Returns ONLY the allowlisted public-safe fields from a raw listing
    document -- even though today's schema has no additional private
    fields on `listings` beyond what's already public, this is the single
    choke point a future private field would have to be deliberately
    added to PUBLIC_LISTING_FIELDS to ever reach a MAM response."""
    return {k: v for k, v in doc.items() if k in PUBLIC_LISTING_FIELDS}
