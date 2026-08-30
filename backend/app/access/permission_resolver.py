# Pure-logic mirror of firestore.rules' hasPermission()/roleDefaultPermissions()
# (Phase 1, already published to production). No I/O here on purpose --
# every function takes already-fetched documents as plain dicts, so this
# module is trivially unit-testable and so the SAME resolution algorithm
# can be exercised identically from permission_ops.py (computing an
# authoritative "effective permissions" response) without duplicating the
# fail-closed logic in two places that could quietly drift apart.
#
# FAIL-CLOSED CONTRACT (must match firestore.rules exactly):
#   - a missing/None/unrecognized accountType -> {} (no permissions)
#   - no matching role_defaults document -> {} (no permissions)
#   - a protected permission key -> never resolves True, regardless of
#     what role_defaults or overrides claim -- this is the same defense-
#     in-depth backstop firestore.rules' isProtectedPermissionKey() is,
#     kept here so a bug in ONE layer's protected-key list can't alone
#     grant one (both layers must agree, and both currently do -- see
#     constants.PROTECTED_PERMISSIONS).
#   - .get(key, False) everywhere, never a bare lookup that could raise
#     or default to True.
from __future__ import annotations

from app.access.constants import KNOWN_PERMISSIONS, PROTECTED_PERMISSIONS, SELF_ACCOUNT_TYPES

# Kept in its own set (not reused from SELF_ACCOUNT_TYPES) because a
# resolved-permissions lookup is legitimately allowed for 'admin' too
# (an admin has a real accountType of 'admin' and may have a
# rolePermissionDefaults/admin document, even though 'admin' is never a
# publicly self-settable value at signup, per constants.py).
_RESOLVABLE_ACCOUNT_TYPES = SELF_ACCOUNT_TYPES | {"admin"}


def resolve_effective_permissions(
    *,
    account_type: str | None,
    role_defaults: dict | None,
    overrides: dict | None,
) -> dict[str, bool]:
    """Returns the caller's resolved permission map: {key: True} for
    every permission actually granted. Absent keys are implicitly False
    -- callers should use `.get(key, False)`, mirroring firestore.rules'
    own `.get(key, false)` convention, never assume a key's presence.

    `role_defaults` is the already-fetched rolePermissionDefaults/{accountType}
    document body (or None if it doesn't exist) -- expected shape
    {"permissions": {key: bool, ...}}. `overrides` is the caller's own
    users/{uid}.permissionOverrides map (or None) -- {key: bool, ...},
    layered on top of the defaults exactly like firestore.rules'
    `myPermissionOverrides().get(key, roleDefaultPermissions().get(key, false))`.
    """
    if not account_type or account_type not in _RESOLVABLE_ACCOUNT_TYPES:
        return {}
    if not isinstance(role_defaults, dict):
        return {}

    defaults = role_defaults.get("permissions")
    defaults = defaults if isinstance(defaults, dict) else {}
    overrides = overrides if isinstance(overrides, dict) else {}

    resolved: dict[str, bool] = {}
    for key in set(defaults) | set(overrides):
        if key in PROTECTED_PERMISSIONS:
            continue  # never resolvable true (or even present) via this path
        value = overrides.get(key, defaults.get(key, False))
        if value is True:
            resolved[key] = True
    return resolved


def has_permission(key: str, *, effective_permissions: dict[str, bool]) -> bool:
    """Single-key convenience check, mirroring firestore.rules'
    hasPermission(key). A protected key is refused unconditionally, even
    if it somehow ended up truthy in `effective_permissions` (defense in
    depth -- resolve_effective_permissions() above already excludes
    protected keys, this is the second, independent check at the call
    site)."""
    if key in PROTECTED_PERMISSIONS:
        return False
    return effective_permissions.get(key, False) is True


def validate_permission_write(permissions: dict) -> str | None:
    """Validates a caller-supplied {key: bool} map intended for a
    rolePermissionDefaults or permissionOverrides write. Returns None if
    valid, or a human-readable rejection reason otherwise. Rejects:
      - a non-dict payload
      - any key not in KNOWN_PERMISSIONS (typo'd/invented keys must
        error loudly, never silently become a no-op grant)
      - any protected key, under any value -- protected permissions are
        never grantable through this generic mechanism, full stop (see
        this module's docstring)
      - any non-bool value (no "maybe", no truthy-string, no nested
        object -- a permission is granted or it isn't)
    """
    if not isinstance(permissions, dict):
        return "permissions must be an object"
    for key, value in permissions.items():
        if not isinstance(key, str):
            return "permission keys must be strings"
        if key in PROTECTED_PERMISSIONS:
            return f"'{key}' is a protected permission and cannot be granted through this endpoint"
        if key not in KNOWN_PERMISSIONS:
            return f"unknown permission key: '{key}'"
        if not isinstance(value, bool):
            return f"permission '{key}' must be a boolean"
    return None
