# HTTP layer for Phase 2's access-management endpoints. Every method
# here follows the same shape: authenticate (401 if it fails), rate
# limit by the caller's own uid (429 if exceeded), parse+validate the
# JSON body (400 if malformed), call into organization_ops/permission_ops
# (which do the real authorization + Firestore work), and map any
# app.access.errors.AccessOpsError to a safe, generic external response
# -- never a raw exception message, stack trace, or internal Firestore
# path. An unexpected exception is logged with enough to diagnose (never
# a token, password, or secret) and answered with a generic 500.
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

from app.access.caller_context import AuthGate
from app.access.constants import ALL_ACCOUNT_TYPES, ORGANIZATION_TYPES
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.access.organization_ops import OrganizationOps
from app.access.permission_ops import PermissionOps
from app.auth.reset import RateLimiter

_UNAUTHENTICATED = JSONResponse({"error": "Authentication required."}, status_code=401)
_FORBIDDEN = JSONResponse({"error": "You do not have permission to perform this action."}, status_code=403)
_NOT_FOUND = JSONResponse({"error": "Not found."}, status_code=404)
_RATE_LIMITED = JSONResponse({"error": "Too many requests. Please wait a while and try again."}, status_code=429)
_BAD_BODY = JSONResponse({"error": "Please provide a valid request body."}, status_code=400)


async def _parse_json_body(request: Request) -> dict | None:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        return body if isinstance(body, dict) else None
    except json.JSONDecodeError:
        return None


def _map_ops_error(exc: Exception) -> JSONResponse:
    """Translates an app.access.errors.AccessOpsError into a safe
    external response. ValidationError/ConflictError messages are
    author-written, non-leaking, user-facing strings (see errors.py and
    every raise site in organization_ops.py/permission_ops.py) -- safe to
    return verbatim. ForbiddenError/NotFoundError use fixed generic text
    instead of the exception's own message, which may describe internal
    state (e.g. which uid/org was being checked) not appropriate to
    confirm or deny to a caller who isn't authorized to know it."""
    if isinstance(exc, ValidationError):
        return JSONResponse({"error": str(exc)}, status_code=400)
    if isinstance(exc, ConflictError):
        return JSONResponse({"error": str(exc)}, status_code=409)
    if isinstance(exc, ForbiddenError):
        return _FORBIDDEN
    if isinstance(exc, NotFoundError):
        return _NOT_FOUND
    return JSONResponse({"error": "Request failed."}, status_code=400)


def _string_field(body: dict, key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) else None


def _permissions_field(body: dict) -> object:
    """Returns whatever was sent for "permissions" unchanged (including a
    wrong type) -- validate_permission_write() inside the ops layer is
    the single source of truth for what's acceptable, so this handler
    layer doesn't duplicate that validation logic, only extracts the
    raw value."""
    return body.get("permissions")


@dataclass
class OrganizationHandler:
    """Backs every organization creation/membership/ownership endpoint.
    One rate limiter per abuse-sensitive action family, each keyed by
    the CALLER's own uid (never an IP -- these are all authenticated
    actions, and a uid is the correct unit to bound, matching how an
    agent's own Firestore writes are already scoped by uid elsewhere in
    this project) -- reuses the exact same RateLimiter abstraction
    (InMemoryRateLimiter/FirestoreRateLimiter) Stage 5's INFRA-01 fix
    introduced, not a second, parallel rate-limiting mechanism."""

    ops: OrganizationOps
    auth: AuthGate
    create_limiter: RateLimiter
    membership_limiter: RateLimiter
    ownership_transfer_limiter: RateLimiter
    logger: logging.Logger

    async def create(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.create_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        org_type = _string_field(body, "type")
        name = _string_field(body, "name")
        if org_type is None or org_type not in ORGANIZATION_TYPES:
            return JSONResponse(
                {"error": f"'type' must be one of: {sorted(ORGANIZATION_TYPES)}"}, status_code=400
            )
        try:
            org_id = await self.ops.create_organization(
                caller_uid=caller.uid,
                org_type=org_type,
                name=name or "",
                description=_string_field(body, "description"),
                city=_string_field(body, "city"),
                district=_string_field(body, "district"),
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001 -- must never crash the request, see module docstring
            self.logger.error("organization create failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not create the organization right now."}, status_code=500)
        return JSONResponse({"organizationId": org_id}, status_code=201)

    async def request_membership(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        try:
            await self.ops.request_membership(org_id=org_id, caller_uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("membership request failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not submit the membership request right now."}, status_code=500)
        return JSONResponse({"status": "pending"}, status_code=201)

    async def invite_member(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        target_uid = request.path_params.get("target_uid")
        try:
            await self.ops.invite_member(
                org_id=org_id, target_uid=target_uid, caller_uid=caller.uid, caller_is_admin=caller.is_admin
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("member invite failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not invite this member right now."}, status_code=500)
        return JSONResponse({"status": "invited"}, status_code=201)

    async def accept_invitation(self, request: Request) -> JSONResponse:
        """Always operates on the CALLER's own uid within this org --
        there is no target_uid in this route at all, so a caller can
        structurally never accept anyone else's invitation."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        try:
            await self.ops.accept_invitation(org_id=org_id, caller_uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("invitation accept failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not accept this invitation right now."}, status_code=500)
        return JSONResponse({"status": "active"}, status_code=200)

    async def decline_invitation(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        try:
            await self.ops.decline_invitation(org_id=org_id, caller_uid=caller.uid)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("invitation decline failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not decline this invitation right now."}, status_code=500)
        return JSONResponse({"status": "declined"}, status_code=200)

    async def revoke_invitation(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        target_uid = request.path_params.get("target_uid")
        try:
            await self.ops.revoke_invitation(
                org_id=org_id, target_uid=target_uid, caller_uid=caller.uid, caller_is_admin=caller.is_admin
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("invitation revoke failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not revoke this invitation right now."}, status_code=500)
        return JSONResponse({"status": "revoked"}, status_code=200)

    async def approve_membership(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        target_uid = request.path_params.get("target_uid")
        try:
            await self.ops.approve_membership(
                org_id=org_id, target_uid=target_uid, caller_uid=caller.uid, caller_is_admin=caller.is_admin
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("membership approval failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not approve this membership right now."}, status_code=500)
        return JSONResponse({"status": "active"}, status_code=200)

    async def reject_membership(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        target_uid = request.path_params.get("target_uid")
        try:
            await self.ops.reject_membership(
                org_id=org_id, target_uid=target_uid, caller_uid=caller.uid, caller_is_admin=caller.is_admin
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("membership rejection failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not reject this membership right now."}, status_code=500)
        return JSONResponse({"status": "rejected"}, status_code=200)

    async def remove_member(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        org_id = request.path_params.get("org_id")
        target_uid = request.path_params.get("target_uid")
        try:
            await self.ops.remove_member(
                org_id=org_id, target_uid=target_uid, caller_uid=caller.uid, caller_is_admin=caller.is_admin
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("member removal failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not remove this member right now."}, status_code=500)
        return JSONResponse({"status": "removed"}, status_code=200)

    async def set_member_permissions(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        org_id = request.path_params.get("org_id")
        target_uid = request.path_params.get("target_uid")
        try:
            await self.ops.update_member_permissions(
                org_id=org_id,
                target_uid=target_uid,
                caller_uid=caller.uid,
                caller_is_admin=caller.is_admin,
                permissions=_permissions_field(body),
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("member permission change failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not update this member's permissions right now."}, status_code=500)
        return JSONResponse({"status": "updated"}, status_code=200)

    async def transfer_ownership(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        # A tighter, separate limiter -- this is the single most
        # sensitive action in this handler, worth bounding independently
        # of the more routine membership actions above.
        if not await self.ownership_transfer_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        org_id = request.path_params.get("org_id")
        new_owner_uid = _string_field(body, "newOwnerUid")
        if not new_owner_uid:
            return JSONResponse({"error": "'newOwnerUid' is required."}, status_code=400)
        try:
            await self.ops.transfer_ownership(
                org_id=org_id, new_owner_uid=new_owner_uid, caller_uid=caller.uid, caller_is_admin=caller.is_admin
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("ownership transfer failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not transfer ownership right now."}, status_code=500)
        return JSONResponse({"status": "transferred"}, status_code=200)

    async def list_my_organizations(self, request: Request) -> JSONResponse:
        """GET /api/v1/access/me/organizations. Reuses membership_limiter
        -- this is a read, but still per-uid rate-limited like every
        other endpoint here rather than left unbounded."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        try:
            organizations = await self.ops.list_my_organizations(uid=caller.uid)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("list my organizations failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not list your organizations right now."}, status_code=500)
        return JSONResponse({"organizations": organizations}, status_code=200)

    async def set_active_organization(self, request: Request) -> JSONResponse:
        """POST /api/v1/access/me/active-organization {"organizationId": "..."|null}.
        Server independently revalidates real (owner or active-member)
        access to the named org before writing anything -- see
        OrganizationOps.set_active_organization's docstring for why this
        never itself grants access and is not audit-logged."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.membership_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        raw = body.get("organizationId")
        if raw is not None and not isinstance(raw, str):
            return JSONResponse({"error": "'organizationId' must be a string or null."}, status_code=400)
        try:
            await self.ops.set_active_organization(uid=caller.uid, organization_id=raw)
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("set active organization failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not set your active organization right now."}, status_code=500)
        return JSONResponse({"activeOrganizationId": raw}, status_code=200)


@dataclass
class PermissionAdminHandler:
    """Backs role-defaults/user-overrides (admin-only writes) and the
    caller's own effective-permissions read."""

    ops: PermissionOps
    auth: AuthGate
    mutation_limiter: RateLimiter
    read_limiter: RateLimiter
    logger: logging.Logger

    async def set_role_defaults(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not caller.is_admin:
            return _FORBIDDEN
        if not await self.mutation_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        account_type = _string_field(body, "accountType")
        if account_type is None or account_type not in ALL_ACCOUNT_TYPES:
            return JSONResponse({"error": "'accountType' is not a recognized accountType."}, status_code=400)
        try:
            await self.ops.set_role_defaults(
                account_type=account_type,
                permissions=_permissions_field(body),
                caller_uid=caller.uid,
                caller_is_admin=caller.is_admin,
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("role defaults change failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not update role defaults right now."}, status_code=500)
        return JSONResponse({"status": "updated"}, status_code=200)

    async def set_user_overrides(self, request: Request) -> JSONResponse:
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not caller.is_admin:
            return _FORBIDDEN
        if not await self.mutation_limiter.allow(caller.uid):
            return _RATE_LIMITED
        body = await _parse_json_body(request)
        if body is None:
            return _BAD_BODY
        target_uid = request.path_params.get("target_uid")
        try:
            await self.ops.set_user_overrides(
                target_uid=target_uid,
                permissions=_permissions_field(body),
                caller_uid=caller.uid,
                caller_is_admin=caller.is_admin,
            )
        except (ValidationError, ForbiddenError, NotFoundError, ConflictError) as exc:
            return _map_ops_error(exc)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("user override change failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not update this user's permissions right now."}, status_code=500)
        return JSONResponse({"status": "updated"}, status_code=200)

    async def get_my_permissions(self, request: Request) -> JSONResponse:
        """GET /api/v1/access/me/permissions[?organizationId=<id>].
        Phase 2.1 API contract: `globalPermissions` (accountType-level,
        org-independent) is always returned. `organization` is null
        unless `organizationId` is given; when given, it is ALWAYS
        present in the response (never silently omitted) and states the
        caller's real, server-validated relationship to that ONE org --
        see PermissionOps.get_effective_permissions's docstring for the
        full membershipStatus semantics and why a non-member's
        `effectivePermissions` for that org is always empty. The query
        param is read here and only here -- never trusted for a write,
        never combined with more than one org per call, so there is no
        path for an org-scoped result to leak into a different org's
        context."""
        caller = await self.auth.authenticate(request)
        if caller is None:
            return _UNAUTHENTICATED
        if not await self.read_limiter.allow(caller.uid):
            return _RATE_LIMITED
        organization_id = request.query_params.get("organizationId") or None
        try:
            # Always the CALLER's own uid -- there is no "look up
            # anyone else's permissions" path here (see
            # PermissionOps.get_effective_permissions's docstring); an
            # admin who needs another user's resolved permissions reads
            # rolePermissionDefaults/permissionOverrides directly via the
            # Firestore client SDK, already permitted for isAdmin() by
            # firestore.rules (Phase 1).
            result = await self.ops.get_effective_permissions(uid=caller.uid, organization_id=organization_id)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("effective permissions read failed", extra={"error": str(exc)})
            return JSONResponse({"error": "Could not read your permissions right now."}, status_code=500)
        return JSONResponse(result, status_code=200)
