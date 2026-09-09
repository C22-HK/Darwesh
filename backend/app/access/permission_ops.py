# Trusted backend layer for the permission system's write side (role
# defaults, per-user overrides) and its one read-side convenience
# (resolving the CALLER'S OWN effective permissions). firestore.rules
# (Phase 1, already published) makes rolePermissionDefaults and
# users/{uid}.permissionOverrides `allow write: if false` for every
# client SDK caller, including an admin session -- this module is the
# only trusted path in for those two writes.
#
# Deliberately absent: any endpoint that GRANTS a protected permission
# (admin_access, manage_roles, manage_permissions, verify_profiles,
# suspend_users, change_organization_owner, manage_platform_security).
# validate_permission_write() rejects every protected key outright, for
# every caller including an admin -- not because an admin couldn't be
# trusted with it, but because no rule anywhere in firestore.rules
# currently CONSULTS a protected-permission grant for anything (every
# admin-gated rule already checks isAdmin() directly, not a permission
# override) -- see the Phase 2 completion report for the explicit
# decision not to build an inert "grant a protected permission" endpoint
# this phase, and the follow-up recommendation to design its real
# consumer before adding one.
from __future__ import annotations

import asyncio
import logging

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit, write_denied_audit
from app.access.constants import ALL_ACCOUNT_TYPES, PROTECTED_PERMISSIONS
from app.access.errors import ForbiddenError, NotFoundError, ValidationError
from app.access.permission_resolver import (
    resolve_effective_permissions,
    resolve_organization_permissions,
    validate_permission_write,
)

ROLE_DEFAULTS_COLLECTION = "rolePermissionDefaults"
USERS_COLLECTION = "users"
ORGANIZATIONS_COLLECTION = "organizations"
MEMBERS_SUBCOLLECTION = "members"


class PermissionOps:
    def __init__(self, db, logger: logging.Logger | None = None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.access.permissions")

    def _log_denied(
        self, *, actor_uid: str, action: str, target_type: str, target_id: str, reason_code: str
    ) -> None:
        """Phase 2.1: best-effort, non-transactional -- see audit.py's
        write_denied_audit docstring and organization_ops.py's identical
        helper. Called only for a non-admin caller attempting a
        permission mutation, or a protected-permission escalation
        attempt -- never for routine validation failures."""
        write_denied_audit(
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="user",
                action=action,
                target_type=target_type,
                target_id=target_id,
                result="denied",
                reason_code=reason_code,
            ),
            logger=self._logger,
        )

    async def set_role_defaults(
        self, *, account_type: str, permissions: dict, caller_uid: str, caller_is_admin: bool
    ) -> None:
        if not caller_is_admin:
            self._log_denied(
                actor_uid=caller_uid,
                action="role_defaults_change_denied",
                target_type="role",
                target_id=account_type,
                reason_code="forbidden_not_admin",
            )
            raise ForbiddenError("only an admin may set role permission defaults")
        if account_type not in ALL_ACCOUNT_TYPES:
            raise ValidationError(f"'{account_type}' is not a recognized accountType")
        validation_error = validate_permission_write(permissions)
        if validation_error:
            if isinstance(permissions, dict) and any(k in PROTECTED_PERMISSIONS for k in permissions):
                self._log_denied(
                    actor_uid=caller_uid,
                    action="role_defaults_change_denied",
                    target_type="role",
                    target_id=account_type,
                    reason_code="protected_permission_escalation_attempt",
                )
            raise ValidationError(validation_error)

        ref = self._db.collection(ROLE_DEFAULTS_COLLECTION).document(account_type)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                previous = (snap.to_dict() or {}).get("permissions", {}) if snap.exists else {}
                txn.set(ref, {"permissions": permissions, "updatedAt": fb_firestore.SERVER_TIMESTAMP})
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin",
                        action="role_defaults_changed",
                        target_type="role",
                        target_id=account_type,
                        changed_fields=sorted(permissions.keys()),
                        previous_value=previous,
                        new_value=permissions,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def set_user_overrides(
        self, *, target_uid: str, permissions: dict, caller_uid: str, caller_is_admin: bool
    ) -> None:
        if not caller_is_admin:
            self._log_denied(
                actor_uid=caller_uid,
                action="user_overrides_change_denied",
                target_type="user",
                target_id=target_uid,
                reason_code="forbidden_not_admin",
            )
            raise ForbiddenError("only an admin may set a user's permission overrides")
        validation_error = validate_permission_write(permissions)
        if validation_error:
            if isinstance(permissions, dict) and any(k in PROTECTED_PERMISSIONS for k in permissions):
                self._log_denied(
                    actor_uid=caller_uid,
                    action="user_overrides_change_denied",
                    target_type="user",
                    target_id=target_uid,
                    reason_code="protected_permission_escalation_attempt",
                )
            raise ValidationError(validation_error)

        ref = self._db.collection(USERS_COLLECTION).document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"no user profile exists for uid '{target_uid}'")
                previous = (snap.to_dict() or {}).get("permissionOverrides", {})
                txn.update(ref, {"permissionOverrides": permissions})
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin",
                        action="user_overrides_changed",
                        target_type="user",
                        target_id=target_uid,
                        changed_fields=sorted(permissions.keys()),
                        previous_value=previous,
                        new_value=permissions,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def get_effective_permissions(self, *, uid: str, organization_id: str | None = None) -> dict:
        """Read-only. Resolves exactly one caller's own effective
        permissions -- there is no "look up anyone else's permissions"
        path in this method; handlers.py enforces that the token-verified
        caller and the uid being resolved are the same, so this can't
        become an arbitrary permission-enumeration endpoint. Uses the
        SAME resolve_effective_permissions() firestore.rules' hasPermission()
        is mirrored from, so this response can never claim a permission
        the rules layer wouldn't also grant.

        API CONTRACT (Phase 2.1). `globalPermissions` is always present
        and org-independent (accountType defaults + user overrides only)
        -- this is what the caller can do outside any organization
        context. `organization` is null unless `organization_id` was
        given; when given, it is ALWAYS present (never silently
        dropped) and states the caller's real relationship to that ONE,
        explicitly-named org -- "missing membership" and "pending"/
        "invited" (not yet accepted) all resolve to
        membershipStatus != 'owner'/'active' and an EMPTY
        `effectivePermissions` for that org, regardless of what
        `globalPermissions` contains -- because every org-scoped rules
        gate (isOrgMember(), Phase 1/2.1) independently requires active
        membership or ownership before ANY permission check even runs,
        so exposing a nonzero `effectivePermissions` for a non-member
        would misrepresent what the write path actually allows.
        `organizationPermissions` is the org member's raw grant map
        (transparency/debugging); `effectivePermissions` is
        globalPermissions unioned with it via resolve_organization_permissions
        -- the same union firestore.rules' hasOrgPermission() computes.
        Cross-org isolation is structural: exactly one org_id is ever
        looked up per call, chosen by the caller, never inferred."""

        def _read() -> dict:
            user_snap = self._db.collection(USERS_COLLECTION).document(uid).get()
            if not user_snap.exists:
                result = {
                    "uid": uid,
                    "role": None,
                    "accountType": None,
                    "activeOrganizationId": None,
                    "globalPermissions": {},
                    "organization": None,
                }
                if organization_id:
                    result["organization"] = _empty_org_block(organization_id, "none")
                return result

            data = user_snap.to_dict() or {}
            account_type = data.get("accountType")
            role_defaults = None
            if isinstance(account_type, str) and account_type:
                rd_snap = self._db.collection(ROLE_DEFAULTS_COLLECTION).document(account_type).get()
                role_defaults = rd_snap.to_dict() if rd_snap.exists else None
            global_permissions = resolve_effective_permissions(
                account_type=account_type,
                role_defaults=role_defaults,
                overrides=data.get("permissionOverrides"),
            )

            result = {
                "uid": uid,
                "role": data.get("role"),
                "accountType": account_type,
                # Phase 2.2: renamed from `organizationId` (dead field,
                # zero production writers -- see firestore.rules' Phase
                # 2.2 comment). `.get('organizationId')` fallback costs
                # nothing and covers a document hand-edited under the
                # old name; it is never treated as authoritative for
                # anything beyond this purely informational echo.
                "activeOrganizationId": data.get("activeOrganizationId", data.get("organizationId")),
                "globalPermissions": global_permissions,
                "organization": None,
            }

            if organization_id:
                result["organization"] = self._resolve_organization_block(organization_id, uid, global_permissions)

            return result

        return await asyncio.to_thread(_read)

    def _resolve_organization_block(self, organization_id: str, uid: str, global_permissions: dict) -> dict:
        """Sync helper (already runs inside get_effective_permissions'
        to_thread) -- resolves the caller's relationship to exactly ONE
        organization. Never trusts organization_id beyond using it to
        look up that specific org's own membership subcollection; a
        non-existent org or a caller with no relationship to it both
        resolve to membershipStatus='none', not an error -- reads carry
        no ambiguity risk the way a forged write would."""
        org_snap = self._db.collection(ORGANIZATIONS_COLLECTION).document(organization_id).get()
        if not org_snap.exists:
            return _empty_org_block(organization_id, "none")

        org_data = org_snap.to_dict() or {}
        if org_data.get("ownerId") == uid:
            # Owner-derived access: no member doc needed or consulted,
            # same as every rules-layer check (orgOwnerId()) -- the
            # owner's OWN accountType-level global permissions are what
            # is expected to cover their own store (see firestore.rules'
            # products rule comment); there is no separate "owner
            # override map" to merge in.
            return {
                "id": organization_id,
                "membershipStatus": "owner",
                "memberRole": None,
                "organizationPermissions": {},
                "effectivePermissions": dict(global_permissions),
            }

        member_snap = (
            self._db.collection(ORGANIZATIONS_COLLECTION)
            .document(organization_id)
            .collection(MEMBERS_SUBCOLLECTION)
            .document(uid)
            .get()
        )
        if not member_snap.exists:
            return _empty_org_block(organization_id, "none")

        member_data = member_snap.to_dict() or {}
        status = member_data.get("status")
        member_role = member_data.get("role")

        if status == "active":
            org_permissions = member_data.get("permissions") or {}
            effective = resolve_organization_permissions(
                global_permissions=global_permissions, org_member_permissions=org_permissions
            )
            return {
                "id": organization_id,
                "membershipStatus": "active",
                "memberRole": member_role,
                "organizationPermissions": org_permissions if isinstance(org_permissions, dict) else {},
                "effectivePermissions": effective,
            }

        # 'pending' (self-requested, not yet approved) or 'invited' (not
        # yet accepted) -- membership state is reported (useful for a UI
        # to show "invitation pending"), but grants NOTHING: an empty
        # effectivePermissions, regardless of any org-scoped permissions
        # map that might already be sitting on the doc (e.g. an invite
        # pre-loaded with intended permissions -- Phase 2.1's invite
        # flow may do this, see organization_ops.py) -- fail closed
        # until the target has actually accepted.
        safe_status = status if status in ("pending", "invited") else "none"
        return {
            "id": organization_id,
            "membershipStatus": safe_status,
            "memberRole": member_role,
            "organizationPermissions": {},
            "effectivePermissions": {},
        }

    async def list_service_requests(
        self, *, caller_uid: str, caller_is_admin: bool, status: str | None = None, limit: int = 100
    ) -> list[dict]:
        """GET /api/v1/access/service-requests[?status=]. Serves TWO
        different views of the same underlying data from one endpoint,
        scoped here rather than trusted from the request:
          - an admin (caller_is_admin) sees every request, across every
            provider (U5's central Customer Services inbox).
          - anyone else sees ONLY their own requests (customerUid ==
            caller_uid, forced -- never taken from the request) across
            every provider they've contacted (account.html's "My
            Requests" tab). There is no way for a non-admin caller to
            widen this to see anyone else's requests; caller_uid is the
            token-verified uid from AuthGate, not a client-supplied
            value.
        See _list_service_requests' own docstring for why BOTH of these
        have to go through the Admin SDK rather than a client-side
        collectionGroup query."""
        if status is not None and status not in _REQUEST_STATUSES:
            raise ValidationError("'status' must be one of pending, accepted, declined, completed.")
        safe_limit = max(1, min(int(limit), 200))
        customer_uid = None if caller_is_admin else caller_uid
        return await _list_service_requests(self._db, status=status, customer_uid=customer_uid, limit=safe_limit)


def _empty_org_block(organization_id: str, membership_status: str) -> dict:
    return {
        "id": organization_id,
        "membershipStatus": membership_status,
        "memberRole": None,
        "organizationPermissions": {},
        "effectivePermissions": {},
    }


_REQUEST_STATUSES = frozenset({"pending", "accepted", "declined", "completed"})


async def _list_service_requests(db, *, status: str | None, customer_uid: str | None, limit: int) -> list[dict]:
    """Backs both admin.html's central service-request inbox (U5) and
    account.html's "My Requests" tab -- one Admin-SDK read, scoped by the
    handler layer (list_service_requests below) rather than by a client
    Firestore query. firestore.rules' serviceProviders/{id}/requests/{id}
    read rule is isAdmin() || own customerUid || owning provider -- correct
    for a single document, but an unfiltered (or even status-filtered)
    collectionGroup('requests') CLIENT query hits Cloud Firestore's
    query-safety check whenever the rule has any resource-dependent OR
    branch the query's own `where` clauses don't pin down. The admin path
    (no customer_uid) reliably fails that check (confirmed empirically:
    even the unconditionally-true isAdmin() branch doesn't rescue an
    otherwise-unconstrained OR). The customer's own path (customerUid ==
    self, exactly the shape Firestore's docs describe as provable) was
    observed to pass in isolation but fail intermittently once run
    alongside the rest of this suite -- not reproduced as a rules defect,
    but not something to build a privacy-relevant read on either. Both
    reasons land on the same fix: one backend method, scoped in Python,
    with a query shape (an equality filter Firestore can always index)
    that behaves identically in an emulator and in production. See B2's
    Requests tab (js/profile-role.js), which only ever reads ONE
    provider's own subcollection directly and never hits any of this."""

    def _read() -> list[dict]:
        query = db.collection_group("requests")
        if customer_uid is not None:
            query = query.where(filter=fb_firestore.FieldFilter("customerUid", "==", customer_uid))
        if status is not None:
            query = query.where(filter=fb_firestore.FieldFilter("status", "==", status))
        query = query.order_by("createdAt", direction=fb_firestore.Query.DESCENDING).limit(limit)
        results: list[dict] = []
        provider_cache: dict[str, dict] = {}
        customer_cache: dict[str, str | None] = {}
        for snap in query.stream():
            data = snap.to_dict() or {}
            provider_ref = snap.reference.parent.parent
            provider_id = provider_ref.id if provider_ref is not None else None
            provider_info = provider_cache.get(provider_id) if provider_id else None
            if provider_id and provider_info is None:
                provider_snap = provider_ref.get()
                provider_data = provider_snap.to_dict() or {} if provider_snap.exists else {}
                provider_info = {
                    "name": provider_data.get("companyName") or provider_data.get("displayName") or provider_id,
                    "serviceType": provider_data.get("serviceType"),
                }
                provider_cache[provider_id] = provider_info
            request_customer_uid = data.get("customerUid")
            customer_name = data.get("customerName")
            if not customer_name and request_customer_uid:
                if request_customer_uid not in customer_cache:
                    user_snap = db.collection(USERS_COLLECTION).document(request_customer_uid).get()
                    user_data = user_snap.to_dict() or {} if user_snap.exists else {}
                    customer_cache[request_customer_uid] = user_data.get("displayName")
                customer_name = customer_cache[request_customer_uid]
            results.append(
                {
                    "providerId": provider_id,
                    "providerName": (provider_info or {}).get("name"),
                    "serviceType": (provider_info or {}).get("serviceType"),
                    "requestId": snap.id,
                    "customerUid": request_customer_uid,
                    "customerName": customer_name,
                    "status": data.get("status"),
                    "message": data.get("message"),
                    "createdAt": data.get("createdAt"),
                    "updatedAt": data.get("updatedAt"),
                }
            )
        return results

    return await asyncio.to_thread(_read)
