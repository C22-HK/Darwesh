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
from datetime import UTC, datetime, timedelta

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit, write_denied_audit
from app.access.constants import (
    INVITATION_EXPIRY_DAYS,
    MEMBER_ROLE_EMPLOYEE,
    MEMBER_STATUS_ACTIVE,
    MEMBER_STATUS_INVITED,
    MEMBER_STATUS_PENDING,
    ORGANIZATION_TYPES,
    PROTECTED_PERMISSIONS,
)
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.access.permission_resolver import validate_permission_write

_MAX_NAME_LENGTH = 200
_MAX_TEXT_FIELD_LENGTH = 2000
_ORG_TEXT_FIELDS = ("description", "logoUrl", "coverImageUrl", "city", "district")


def _is_expired(expires_at: object) -> bool:
    """`expires_at` comes back from the Admin SDK as a timezone-aware
    `datetime` (Firestore Timestamp fields decode that way) -- this
    tolerates any other shape (a naive datetime, an unexpected type)
    by failing safe: anything it can't confidently parse as still-valid
    is treated as expired, never as still-acceptable, matching this
    whole architecture's fail-closed convention."""
    if not isinstance(expires_at, datetime):
        return True
    now = datetime.now(expires_at.tzinfo) if expires_at.tzinfo else datetime.now(UTC).replace(tzinfo=None)
    return now > expires_at


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

    def _log_denied(
        self,
        *,
        actor_uid: str,
        action: str,
        target_type: str,
        target_id: str,
        target_organization_id: str | None,
        reason_code: str,
    ) -> None:
        """Phase 2.1: best-effort, non-transactional -- see audit.py's
        write_denied_audit docstring. Called only from the specific,
        security-relevant denial branches documented at each call site
        below (an unauthorized membership/permission/ownership action,
        or a protected-permission escalation attempt) -- never for a
        NotFoundError/ConflictError, which are routine, not security
        events."""
        write_denied_audit(
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="user",
                action=action,
                target_type=target_type,
                target_id=target_id,
                target_organization_id=target_organization_id,
                result="denied",
                reason_code=reason_code,
            ),
            logger=self._logger,
        )

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
                    raise ValidationError(
                        "the organization's owner cannot request membership in their own organization"
                    )
                member_snap = member_ref.get(transaction=txn)
                if member_snap.exists:
                    raise ConflictError("a membership record already exists for this user in this organization")
                txn.set(
                    member_ref,
                    {
                        # Phase 2.2: `uid` duplicates this doc's own id as
                        # a real field -- Firestore collection-group
                        # queries (list_my_organizations() below) can't
                        # filter by "document id equals X" across
                        # multiple orgs' members subcollections, only by
                        # a field value, so this is what makes "every
                        # organization I belong to, across all orgs"
                        # queryable at all.
                        "uid": caller_uid,
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

    async def invite_member(self, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool) -> None:
        """Phase 2.1: the organization owner (or an admin) invites a
        specific, already-known uid -- this creates a PENDING-for-the-
        target 'invited' record, NOT immediate membership (the earlier
        Phase 2 behavior). Only the invited uid itself can activate it,
        via accept_invitation() below; the owner/admin may revoke_invitation()
        instead. Requires the target to be a real, existing user profile
        -- never creates a membership record for a uid this backend
        can't confirm is a real account. Never activates from a
        matching company/office name or any signal but the target's own
        explicit accept."""
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
                expires_at = datetime.now(UTC) + timedelta(days=INVITATION_EXPIRY_DAYS)
                txn.set(
                    member_ref,
                    {
                        "uid": target_uid,  # Phase 2.2: see request_membership's identical comment
                        "role": MEMBER_ROLE_EMPLOYEE,
                        "status": MEMBER_STATUS_INVITED,
                        "permissions": {},
                        "invitedAt": fb_firestore.SERVER_TIMESTAMP,
                        "invitedBy": caller_uid,
                        "expiresAt": expires_at,
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
                        new_value=MEMBER_STATUS_INVITED,
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="member_invite_denied",
                    target_type="membership",
                    target_id=target_uid,
                    target_organization_id=org_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    async def accept_invitation(self, *, org_id: str, caller_uid: str) -> None:
        """The invited target -- and ONLY the invited target -- accepts.
        There is no target_uid parameter: this always operates on
        members/{caller_uid} for this org, so a caller can structurally
        never accept anyone else's invitation (there is no path to name
        a different uid). Race-safe against a concurrent revoke_invitation
        via Firestore's transaction semantics (see this module's header)
        -- whichever transaction commits first wins; the loser re-reads
        the now-changed/deleted doc and its own precondition check fails
        cleanly, never double-activating or reviving a revoked invite."""
        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(caller_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                member_snap = member_ref.get(transaction=txn)
                if not member_snap.exists or member_snap.get("status") != MEMBER_STATUS_INVITED:
                    raise NotFoundError("no pending invitation exists for you in this organization")
                expires_at = member_snap.get("expiresAt")
                if expires_at is not None and _is_expired(expires_at):
                    raise ConflictError(
                        "this invitation has expired -- ask the organization owner to reinvite you"
                    )
                txn.update(
                    member_ref,
                    {"status": MEMBER_STATUS_ACTIVE, "acceptedAt": fb_firestore.SERVER_TIMESTAMP},
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="user",
                        action="invitation_accepted",
                        target_type="membership",
                        target_id=caller_uid,
                        target_organization_id=org_id,
                        previous_value=MEMBER_STATUS_INVITED,
                        new_value=MEMBER_STATUS_ACTIVE,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def decline_invitation(self, *, org_id: str, caller_uid: str) -> None:
        """The invited target declines -- same self-uid-only shape as
        accept_invitation(). Deletes the record outright (no tombstone),
        matching reject_membership's precedent."""
        org_ref = self._db.collection("organizations").document(org_id)
        member_ref = org_ref.collection("members").document(caller_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                member_snap = member_ref.get(transaction=txn)
                if not member_snap.exists or member_snap.get("status") != MEMBER_STATUS_INVITED:
                    raise NotFoundError("no pending invitation exists for you in this organization")
                txn.delete(member_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="user",
                        action="invitation_declined",
                        target_type="membership",
                        target_id=caller_uid,
                        target_organization_id=org_id,
                        previous_value=MEMBER_STATUS_INVITED,
                        new_value=None,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def revoke_invitation(
        self, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        """Owner/admin cancels a not-yet-accepted invitation. Race-safe
        against a concurrent accept_invitation() the same way -- see
        accept_invitation's docstring."""
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
                    raise ForbiddenError("only the organization's owner or an admin may revoke an invitation")
                member_snap = member_ref.get(transaction=txn)
                if not member_snap.exists or member_snap.get("status") != MEMBER_STATUS_INVITED:
                    raise NotFoundError("no pending invitation exists for this user in this organization")
                txn.delete(member_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="invitation_revoked",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=org_id,
                        previous_value=MEMBER_STATUS_INVITED,
                        new_value=None,
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="invitation_revocation_denied",
                    target_type="membership",
                    target_id=target_uid,
                    target_organization_id=org_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

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

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="membership_approval_denied",
                    target_type="membership",
                    target_id=target_uid,
                    target_organization_id=org_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

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

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="membership_rejection_denied",
                    target_type="membership",
                    target_id=target_uid,
                    target_organization_id=org_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    async def remove_member(self, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool) -> None:
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

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="member_removal_denied",
                    target_type="membership",
                    target_id=target_uid,
                    target_organization_id=org_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

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
            if isinstance(permissions, dict) and any(k in PROTECTED_PERMISSIONS for k in permissions):
                self._log_denied(
                    actor_uid=caller_uid,
                    action="member_permissions_change_denied",
                    target_type="membership",
                    target_id=target_uid,
                    target_organization_id=org_id,
                    reason_code="protected_permission_escalation_attempt",
                )
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

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="member_permissions_change_denied",
                    target_type="membership",
                    target_id=target_uid,
                    target_organization_id=org_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

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
                    raise ForbiddenError(
                        "only the organization's current owner or an admin may transfer ownership"
                    )
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

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="ownership_transfer_denied",
                    target_type="organization",
                    target_id=org_id,
                    target_organization_id=org_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc
            except ValidationError as exc:
                # Specifically the "target isn't an active member" case
                # -- an unauthorized-target ownership transfer attempt,
                # not routine input validation, so it's worth the same
                # security-monitoring visibility as the ForbiddenError
                # branch above (both are "unauthorized ownership
                # transfer" per this phase's spec). The earlier "cannot
                # transfer ownership to yourself" ValidationError (raised
                # before _op/_txn even runs) is NOT logged here -- that's
                # an ordinary client-input guard, not a security event.
                self._log_denied(
                    actor_uid=caller_uid,
                    action="ownership_transfer_denied",
                    target_type="organization",
                    target_id=org_id,
                    target_organization_id=org_id,
                    reason_code="ownership_transfer_target_not_eligible",
                )
                raise exc

        await asyncio.to_thread(_op)

    # ---- multi-organization context (Phase 2.2) ------------------------

    async def list_my_organizations(self, *, uid: str) -> list[dict]:
        """GET /me/organizations. Returns every organization the caller
        has a REAL, currently-relevant relationship to: owns, or holds
        ANY membership record in (active/pending/invited -- the caller
        needs to see a pending self-request or an incoming invitation
        here too, that's the whole point of a "my organizations" list;
        this is a READ, so exposing membershipStatus='pending'/'invited'
        grants nothing, unlike the fail-closed rule for effective
        PERMISSIONS in that state). Two independent lookups, never one
        inferred from the other:
          1. organizations where ownerId == uid (a direct, indexed,
             already-public-read query -- no new index needed).
          2. a collection-group query across every org's `members`
             subcollection, filtered by the `uid` field (see
             request_membership/invite_member's `"uid": ...` write) --
             REQUIRES a Firestore collection-group index on
             `members.uid` (see firestore.indexes.json) to succeed in
             production; the local emulator does not enforce this the
             same way, so a passing emulator test alone does not prove
             the index exists where it will actually matter."""

        def _read() -> list[dict]:
            results: dict[str, dict] = {}

            owned_query = self._db.collection("organizations").where("ownerId", "==", uid)
            for org_snap in owned_query.stream():
                org_data = org_snap.to_dict() or {}
                results[org_snap.id] = {
                    "organizationId": org_snap.id,
                    "name": org_data.get("name"),
                    "type": org_data.get("type"),
                    "membershipStatus": "owner",
                    "memberRole": None,
                    "isOwner": True,
                }

            member_query = self._db.collection_group("members").where("uid", "==", uid)
            for member_snap in member_query.stream():
                org_ref = member_snap.reference.parent.parent
                if org_ref is None or org_ref.id in results:
                    continue  # already listed as owner, or a malformed path -- skip, never guess
                member_data = member_snap.to_dict() or {}
                status = member_data.get("status")
                if status not in (MEMBER_STATUS_ACTIVE, MEMBER_STATUS_PENDING, MEMBER_STATUS_INVITED):
                    continue  # an unrecognized/malformed status is never listed as real access
                org_snap = org_ref.get()
                if not org_snap.exists:
                    continue  # dangling reference (org deleted) -- fail safe, omit rather than guess
                org_data = org_snap.to_dict() or {}
                results[org_ref.id] = {
                    "organizationId": org_ref.id,
                    "name": org_data.get("name"),
                    "type": org_data.get("type"),
                    "membershipStatus": status,
                    "memberRole": member_data.get("role"),
                    "isOwner": False,
                }

            return list(results.values())

        return await asyncio.to_thread(_read)

    async def set_active_organization(self, *, uid: str, organization_id: str | None) -> None:
        """POST /me/active-organization. Writes users/{uid}.activeOrganizationId
        -- ALWAYS after server-side revalidation that the caller currently
        owns or is an ACTIVE member of `organization_id` (pending/invited
        is not enough -- selecting an org you've only been invited to,
        or merely requested, must not silently be treated as "current
        org"). `organization_id=None` clears it (e.g. the user left/was
        removed from their only organization).

        This is a UX/navigation preference, not a permission grant --
        matches this module's docstring convention, this method does
        not write an accessAuditLog entry (success or denied): it
        changes nothing about what the caller can DO, only which org
        context the frontend defaults to next, so it carries none of
        the audit obligations a real permission/ownership/membership
        mutation does. Every real authorization check elsewhere
        (isOrgMember(), hasOrgPermission(), PermissionOps.
        get_effective_permissions) independently re-verifies membership
        every time regardless of what this field currently says --
        never trusts it, and never falls back to a DIFFERENT
        organization if the stored value turns out to be stale (fails
        closed to "no org context selected", not to "guess one")."""
        if organization_id is None:

            def _clear() -> None:
                self._db.collection("users").document(uid).update({"activeOrganizationId": None})

            await asyncio.to_thread(_clear)
            return

        org_ref = self._db.collection("organizations").document(organization_id)
        member_ref = org_ref.collection("members").document(uid)
        user_ref = self._db.collection("users").document(uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                org_snap = org_ref.get(transaction=txn)
                if not org_snap.exists:
                    raise NotFoundError(f"organization '{organization_id}' does not exist")
                is_owner = org_snap.get("ownerId") == uid
                if not is_owner:
                    member_snap = member_ref.get(transaction=txn)
                    if not member_snap.exists or member_snap.get("status") != MEMBER_STATUS_ACTIVE:
                        raise ValidationError("you do not currently have active access to this organization")
                if not user_ref.get(transaction=txn).exists:
                    raise NotFoundError("no user profile exists for this account")
                txn.update(user_ref, {"activeOrganizationId": organization_id})

            _txn(transaction)

        await asyncio.to_thread(_op)
