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

from app.access.audit import AuditEntry, write_audit
from app.access.constants import ALL_ACCOUNT_TYPES
from app.access.errors import ForbiddenError, NotFoundError, ValidationError
from app.access.permission_resolver import resolve_effective_permissions, validate_permission_write

ROLE_DEFAULTS_COLLECTION = "rolePermissionDefaults"
USERS_COLLECTION = "users"


class PermissionOps:
    def __init__(self, db, logger: logging.Logger | None = None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.access.permissions")

    async def set_role_defaults(
        self, *, account_type: str, permissions: dict, caller_uid: str, caller_is_admin: bool
    ) -> None:
        if not caller_is_admin:
            raise ForbiddenError("only an admin may set role permission defaults")
        if account_type not in ALL_ACCOUNT_TYPES:
            raise ValidationError(f"'{account_type}' is not a recognized accountType")
        validation_error = validate_permission_write(permissions)
        if validation_error:
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
            raise ForbiddenError("only an admin may set a user's permission overrides")
        validation_error = validate_permission_write(permissions)
        if validation_error:
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

    async def get_effective_permissions(self, *, uid: str) -> dict:
        """Read-only. Resolves exactly one caller's own effective
        permissions -- there is no "look up anyone else's permissions"
        path in this method; handlers.py enforces that the token-verified
        caller and the uid being resolved are the same, so this can't
        become an arbitrary permission-enumeration endpoint. Uses the
        SAME resolve_effective_permissions() firestore.rules' hasPermission()
        is mirrored from, so this response can never claim a permission
        the rules layer wouldn't also grant."""

        def _read() -> dict:
            user_snap = self._db.collection(USERS_COLLECTION).document(uid).get()
            if not user_snap.exists:
                return {"uid": uid, "role": None, "accountType": None, "organizationId": None, "permissions": {}}
            data = user_snap.to_dict() or {}
            account_type = data.get("accountType")
            role_defaults = None
            if isinstance(account_type, str) and account_type:
                rd_snap = self._db.collection(ROLE_DEFAULTS_COLLECTION).document(account_type).get()
                role_defaults = rd_snap.to_dict() if rd_snap.exists else None
            resolved = resolve_effective_permissions(
                account_type=account_type,
                role_defaults=role_defaults,
                overrides=data.get("permissionOverrides"),
            )
            return {
                "uid": uid,
                "role": data.get("role"),
                "accountType": account_type,
                "organizationId": data.get("organizationId"),
                "permissions": resolved,
            }

        return await asyncio.to_thread(_read)
