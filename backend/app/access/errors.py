# Shared exception hierarchy for app.access -- handlers.py maps each of
# these to a specific, safe HTTP status/message (never a raw stack trace
# or internal Firestore path -- see handlers.py's error-mapping table).
from __future__ import annotations


class AccessOpsError(Exception):
    """Base for every expected, handled failure in app.access.*_ops.
    Anything else (an unexpected exception) is treated by handlers.py as
    an internal error and logged, never surfaced to the caller in detail."""


class ValidationError(AccessOpsError):
    """The request itself is malformed or fails a business rule -- maps
    to 400."""


class NotFoundError(AccessOpsError):
    """The referenced organization/member/resource doesn't exist -- maps
    to 404. Never distinguishes "doesn't exist" from "exists but you
    can't see it" beyond what's already true of the resource's own
    visibility rules, to avoid leaking existence where it isn't already
    public (organizations are public-readable per firestore.rules, so
    this is a non-issue for that collection; membership existence is
    scoped by caller authorization, handled by ForbiddenError instead)."""


class ForbiddenError(AccessOpsError):
    """The caller is authenticated but not authorized for this specific
    action on this specific target -- maps to 403."""


class ConflictError(AccessOpsError):
    """The action can't proceed because of the resource's current state
    (already a member, membership not pending, duplicate request) --
    maps to 409."""
