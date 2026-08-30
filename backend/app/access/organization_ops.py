# Trusted backend layer for organization creation and membership/
# ownership workflows. Every write here goes through the Firebase Admin
# SDK, which is exactly why firestore.rules (Phase 1, already published)
# makes organizations/{orgId}/members/{uid} `allow write: if false` for
# every client SDK caller and locks `organizations/{orgId}.ownerId` for
# every client SDK caller including an admin session -- this module is
# the only trusted path in for those two things. Organization CREATION
# itself remains additionally available as a direct, rules-enforced
# client write (Phase 1 already allows any signed-in user to found a new
# org as its own owner) -- this module's create_organization() is not a
# replacement for that, it's an additional, rate-limitable, more heavily
# validated path with audit logging, useful for abuse control (see
# handlers.py's rate limiter wiring). Neither path can ever set ownerId
# to anyone but the caller at creation time.
#
# Every method server-validates its own preconditions from data it reads
# itself (the organization's current ownerId, the member doc's current
# status) -- never from anything the caller merely asserts in the request
# body, mirroring this project's existing "server re-derives trust, never
# trusts a client's claim about its own privilege" convention
# (FirebaseAccountOps.create_user_profile's BL-04 handling is the
# original example of this).
from __future__ import annotations

import asyncio
import logging

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit
from app.access.constants import (
    MEMBER_ROLE_EMPLOYEE,
    MEMBER_STATUS_ACTIVE,
    MEMBER_STATUS_PENDING,
    ORGANIZATION_TYPES,
)
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.access.permission_resolver import validate_permission_write

_MAX_NAME_LENGTH = 200
_MAX_TEXT_FIELD_LENGTH = 2000
_ORG_TEXT_FIELDS = ("description", "logoUrl", "coverImageUrl", "city", "district")


def _clean_text(value: object, *, field: str, max_length: int, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise ValidationError(f"'{field}' is required")
        return None
    if not isinstance(value, str):
        raise ValidationError(f"'{field}' must be a string")
    stripped = value.strip()
    if required and not stripped:
        raise ValidationError(f"'{field}' is required")
    if len(stripped) > max_length:
        raise ValidationError(f"'{field}' must be at most {max_length} characters")
    return stripped or None


class OrganizationOps:
    def __init__(self, db, logger: logging.Logger | None = None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.access.organizations")

    # ---- creation -----------------------------------------------------

    async def create_organization(
        self,
        *,
        caller_uid: str,
        org_type: str,
        name: str,
        description: str | None = None,
        city: str | None = None,
        district: str | None = None,
    ) -> str:
        if org_type not in ORGANIZATION_TYPES:
            raise ValidationError(
                f"'{org_type}' is not a valid organization type (allowed: {sorted(ORGANIZATION_TYPES)})"
            )
        clean_name = _clean_text(name, field="name", max_length=_MAX_NAME_LENGTH, required=True)
        clean_description = _clean_text(description, field="description", max_length=_MAX_TEXT_FIELD_LENGTH)
        clean_city = _clean_text(city, field="city", max_length=200)
        clean_district = _clean_text(district, field="district", max_length=200)

        def _write() -> str:
            org_ref = self._db.collection("organizations").document()
            data = {
                "type": org_type,
                "ownerId": caller_uid,
                "name": clean_name,
                "verified": False,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            }
            if clean_description:
                data["description"] = clean_description
            if clean_city:
                data["city"] = clean_city
            if clean_district:
                data["district"] = clean_district

            batch = self._db.batch()
            batch.set(org_ref, data)
            write_audit(
                batch,
                self._db,
                AuditEntry(
                    actor_uid=caller_uid,
                    actor_role="user",
                    action="organization_created",
                    target_type="organization",
                    target_id=org_ref.id,
                    target_organization_id=org_ref.id,
                    new_value=org_type,
                ),
            )
            batch.commit()
            return org_ref.id

        return await asyncio.to_thread(_write)

    # ---- membership: request / invite / approve / reject / remove -----

    async def request_membership(self, *, org_id: str, caller_uid: str) -> None:
        """A signed-in user asks to join `org_id` as an employee. Creates
        a PENDING member doc -- never itself a grant of access (mirrors
        the existing requestedRole/requestedCompanyId non-authoritative-
        signal pattern). BL-04 precedent: merely requesting can never
        become real membership without an explicit owner/admin decision
        -- there is no auto-approve path here or anywhere else in this
        module."""
        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(caller_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{org_id}' does not exist")
                if org_snap.get("ownerId") == caller_uid:
                    raise ValidationError("the organization's owner cannot request membership in their own organization")
                member_snap = member_ref.get(transaction=txn)
                if member_snap.exists:
                    raise ConflictError("a membership record already exists for this user in this organization")
                txn.set(
                    member_ref,
                    {
                        "role": MEMBER_ROLE_EMPLOYEE,
                        "status": MEMBER_STATUS_PENDING,
                        "permissions": {},
                        "requestedAt": fb_firestore.SERVER_TIMESTAMP,
                        "requestedBy": caller_uid,
                    },
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="user",
                        action="membership_requested",
                        target_type="membership",
                        target_id=caller_uid,
                        target_organization_id=org_id,
                        new_value=MEMBER_STATUS_PENDING,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def invite_member(
        self, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        """The organization owner (or an admin) adds a specific, already-
        known uid directly as an ACTIVE employee -- the invitation IS the
        approval (no separate accept step this phase; see the Phase 2
        completion report's "deferred" section for a two-sided invite-
        then-accept flow). Requires the target to be a real, existing
        user profile -- never creates a membership record for a uid this
        backend can't confirm is a real account."""
        if target_uid == caller_uid:
            raise ValidationError("cannot invite yourself")
        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(target_uid)
        user_ref = self._db.collection("users").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{org_id}' does not exist")
                owner_id = org_snap.get("ownerId")
                if not caller_is_admin and owner_id != caller_uid:
                    raise ForbiddenError("only the organization's owner or an admin may invite a member")
                if target_uid == owner_id:
                    raise ValidationError("the organization's owner is already its owner, not an invitable member")
                if not user_ref.get(transaction=txn).exists:
                    raise NotFoundError(f"no user profile exists for uid '{target_uid}'")
                member_snap = member_ref.get(transaction=txn)
                if member_snap.exists:
                    raise ConflictError("a membership record already exists for this user in this organization")
                txn.set(
                    member_ref,
                    {
                        "role": MEMBER_ROLE_EMPLOYEE,
                        "status": MEMBER_STATUS_ACTIVE,
                        "permissions": {},
                        "addedAt": fb_firestore.SERVER_TIMESTAMP,
                        "addedBy": caller_uid,
                    },
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="member_invited",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=org_id,
                        new_value=MEMBER_STATUS_ACTIVE,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def approve_membership(
        self, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{org_id}' does not exist")
                if not caller_is_admin and org_snap.get("ownerId") != caller_uid:
                    raise ForbiddenError("only the organization's owner or an admin may approve membership")
                member_snap = member_ref.get(transaction=txn)
                if not member_snap.exists or member_snap.get("status") != MEMBER_STATUS_PENDING:
                    raise ConflictError("no pending membership request exists for this user in this organization")
                txn.update(
                    member_ref,
                    {
                        "status": MEMBER_STATUS_ACTIVE,
                        "approvedAt": fb_firestore.SERVER_TIMESTAMP,
                        "approvedBy": caller_uid,
                    },
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="membership_approved",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=org_id,
                        previous_value=MEMBER_STATUS_PENDING,
                        new_value=MEMBER_STATUS_ACTIVE,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def reject_membership(
        self, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        """Deletes a PENDING request outright (no rejected tombstone) --
        the applicant is free to request again later; there is no
        product requirement to remember a past rejection, and keeping
        one would be one more place a stale permission-shaped record
        could be misread by future code."""
        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{org_id}' does not exist")
                if not caller_is_admin and org_snap.get("ownerId") != caller_uid:
                    raise ForbiddenError("only the organization's owner or an admin may reject membership")
                member_snap = member_ref.get(transaction=txn)
                if not member_snap.exists or member_snap.get("status") != MEMBER_STATUS_PENDING:
                    raise ConflictError("no pending membership request exists for this user in this organization")
                txn.delete(member_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="membership_rejected",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=org_id,
                        previous_value=MEMBER_STATUS_PENDING,
                        new_value=None,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def remove_member(
        self, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{org_id}' does not exist")
                if not caller_is_admin and org_snap.get("ownerId") != caller_uid:
                    raise ForbiddenError("only the organization's owner or an admin may remove a member")
                member_snap = member_ref.get(transaction=txn)
                if not member_snap.exists:
                    raise NotFoundError("no membership record exists for this user in this organization")
                previous_status = member_snap.get("status")
                txn.delete(member_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="member_removed",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=org_id,
                        previous_value=previous_status,
                        new_value=None,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def update_member_permissions(
        self,
        *,
        org_id: str,
        target_uid: str,
        caller_uid: str,
        caller_is_admin: bool,
        permissions: dict,
    ) -> None:
        """Sets (replaces) the member's org-scoped permission overrides.
        Validated the same way role-defaults/user-overrides are
        (permission_resolver.validate_permission_write) -- unknown keys
        rejected outright, protected keys never grantable through this
        endpoint either, an org owner has no more power to grant a
        protected permission than an admin does through the generic
        mechanism (protected permissions have no generic-mechanism grant
        path at all this phase -- see permission_ops.py)."""
        validation_error = validate_permission_write(permissions)
        if validation_error:
            raise ValidationError(validation_error)

        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{org_id}' does not exist")
                if not caller_is_admin and org_snap.get("ownerId") != caller_uid:
                    raise ForbiddenError("only the organization's owner or an admin may change member permissions")
                member_snap = member_ref.get(transaction=txn)
                if not member_snap.exists or member_snap.get("status") != MEMBER_STATUS_ACTIVE:
                    raise NotFoundError("no active membership record exists for this user in this organization")
                previous_permissions = member_snap.get("permissions") or {}
                txn.update(member_ref, {"permissions": permissions})
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="member_permissions_changed",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=org_id,
                        changed_fields=sorted(permissions.keys()),
                        previous_value=previous_permissions,
                        new_value=permissions,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    # ---- ownership transfer: heavily protected -------------------------

    async def transfer_ownership(
        self, *, org_id: str, new_owner_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        """Reassigns organizations/{orgId}.ownerId. This is the single
        most sensitive operation in this module -- per explicit
        instruction, heavily protected: only the CURRENT owner or an
        admin may initiate it, and (unless the caller is an admin, who
        may target any real user) the new owner must already be an
        ACTIVE member of this specific organization, never an arbitrary
        uid a caller merely names -- an owner cannot hand the
        organization to a total stranger. Does not automatically grant
        the outgoing owner a regular membership record -- their owner-
        derived rights end the instant ownerId changes (every check in
        this module reads ownerId live, never a cached/claimed value);
        if they should remain staff, a separate invite_member call is
        needed."""
        if new_owner_uid == caller_uid and not caller_is_admin:
            # A non-admin owner "transferring to themselves" is either a
            # no-op or a confused request -- reject rather than silently
            # succeed, so a client bug can't paper over an unintended
            # call.
            raise ValidationError("cannot transfer ownership to yourself")

        org_ref = self._db.collection("organizations").document(org_id)
        new_owner_member_ref = org_ref.collection("members").document(new_owner_uid)
        user_ref = self._db.collection("users").document(new_owner_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{org_id}' does not exist")
                current_owner = org_snap.get("ownerId")
                if not caller_is_admin and current_owner != caller_uid:
                    raise ForbiddenError("only the organization's current owner or an admin may transfer ownership")
                if not user_ref.get(transaction=txn).exists:
                    raise NotFoundError(f"no user profile exists for uid '{new_owner_uid}'")
                member_snap = new_owner_member_ref.get(transaction=txn)
                member_is_active = member_snap.exists and member_snap.get("status") == MEMBER_STATUS_ACTIVE
                if not caller_is_admin and not member_is_active:
                    raise ValidationError(
                        "ownership can only be transferred to a current active member of this organization"
                    )
                txn.update(org_ref, {"ownerId": new_owner_uid, "updatedAt": fb_firestore.SERVER_TIMESTAMP})
                # The new owner no longer needs a `members` doc (owner
                # rights come from organizations.ownerId directly, see
                # this module's header) -- remove it if present so the
                # member list doesn't show the owner as their own
                # employee.
                if member_snap.exists:
                    txn.delete(new_owner_member_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="organization_ownership_transferred",
                        target_type="organization",
                        target_id=org_id,
                        target_organization_id=org_id,
                        previous_value=current_owner,
                        new_value=new_owner_uid,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)
