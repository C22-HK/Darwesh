# Trusted backend layer for real estate office (`companies`) employee
# membership workflows -- Phase 3's additive extension of the
# organizations/{orgId}/members pattern (organization_ops.py) onto the
# legacy `companies` collection, so a real estate office's profile page
# can show a real, queryable team roster instead of inferring membership
# from `users.companyId` alone (BL-04 precedent: name/id matching alone
# is never trusted as proof of real membership).
#
# Deliberately narrower than OrganizationOps in one specific way: an
# employee doc here carries only a membership STATUS
# (pending/invited/active), no `role` or `permissions` map. An office
# employee's actual capabilities continue to come entirely from the
# existing, unchanged `role='agent'` + `accountType` + global
# rolePermissionDefaults system (and from `users.companyId`/
# `listings.agentId` for listing-level authorization) -- this module adds
# a real membership-status record for PROFILE DISPLAY and invite/accept
# workflow only, not a second, parallel permission-delegation surface.
# Building an hasOrgPermission()-equivalent for companies was
# deliberately scoped out: office employees don't need org-scoped
# permission grants the way furniture-store staff do, because listing
# ownership is already fully authorized by the pre-existing agentId/
# companyId model.
#
# Ownership: `companies/{id}.ownerId` is OPTIONAL and, once set, locked
# for every client-SDK update (mirrors organizations.ownerId) -- see
# firestore.rules' Phase 3 comment on the companies match block for why
# it's optional at create (admin.html's existing "Add Agent" flow must
# keep creating ownerless company docs unchanged) and why claiming
# ownership of an already-existing, ownerless legacy company is
# deliberately NOT implemented here (see
# docs/PHASE3_PROFILE_FIELD_CONTRACT.md's migration note) -- this module
# only ever sets ownerId at brand-new company creation, from the
# creator's own uid, never onto an existing doc.
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit, write_denied_audit
from app.access.constants import (
    INVITATION_EXPIRY_DAYS,
    MEMBER_STATUS_ACTIVE,
    MEMBER_STATUS_INVITED,
    MEMBER_STATUS_PENDING,
)
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError

_MAX_NAME_LENGTH = 200
_MAX_TEXT_FIELD_LENGTH = 2000


def _is_expired(expires_at: object) -> bool:
    """Identical fail-safe shape to organization_ops._is_expired."""
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


class CompanyOps:
    def __init__(self, db, logger: logging.Logger | None = None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.access.companies")

    def _log_denied(
        self,
        *,
        actor_uid: str,
        action: str,
        target_id: str,
        target_company_id: str,
        reason_code: str,
    ) -> None:
        write_denied_audit(
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="user",
                action=action,
                target_type="membership",
                target_id=target_id,
                target_organization_id=target_company_id,
                result="denied",
                reason_code=reason_code,
            ),
            logger=self._logger,
        )

    # ---- creation -------------------------------------------------------

    async def create_company(
        self,
        *,
        caller_uid: str,
        name: str,
        description: str | None = None,
        city: str | None = None,
        district: str | None = None,
        address: str | None = None,
    ) -> str:
        """Founds a BRAND-NEW office with the caller as its owner --
        never claims an existing (possibly ownerless) company id; that is
        deliberately not implemented, see this module's header. Mirrors
        OrganizationOps.create_organization's shape; unlike organizations
        there is no `type` to validate (companies are implicitly real
        estate offices)."""
        clean_name = _clean_text(name, field="name", max_length=_MAX_NAME_LENGTH, required=True)
        clean_description = _clean_text(description, field="description", max_length=_MAX_TEXT_FIELD_LENGTH)
        clean_city = _clean_text(city, field="city", max_length=200)
        clean_district = _clean_text(district, field="district", max_length=200)
        clean_address = _clean_text(address, field="address", max_length=_MAX_TEXT_FIELD_LENGTH)

        def _write() -> str:
            company_ref = self._db.collection("companies").document()
            data = {
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
            if clean_address:
                data["address"] = clean_address

            batch = self._db.batch()
            batch.set(company_ref, data)
            write_audit(
                batch,
                self._db,
                AuditEntry(
                    actor_uid=caller_uid,
                    actor_role="user",
                    action="company_created",
                    target_type="organization",
                    target_id=company_ref.id,
                    target_organization_id=company_ref.id,
                    new_value="real_estate_office",
                ),
            )
            batch.commit()
            return company_ref.id

        return await asyncio.to_thread(_write)

    # ---- membership: request / invite / approve / reject / remove -------

    async def request_membership(self, *, company_id: str, caller_uid: str) -> None:
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(caller_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                company_snap = company_ref.get(transaction=txn)
                if not company_snap.exists:
                    raise NotFoundError(f"company '{company_id}' does not exist")
                if company_snap.get("ownerId") == caller_uid:
                    raise ValidationError("the office's owner cannot request membership in their own office")
                employee_snap = employee_ref.get(transaction=txn)
                if employee_snap.exists:
                    raise ConflictError("a membership record already exists for this user at this office")
                txn.set(
                    employee_ref,
                    {
                        "uid": caller_uid,
                        "status": MEMBER_STATUS_PENDING,
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
                        action="company_membership_requested",
                        target_type="membership",
                        target_id=caller_uid,
                        target_organization_id=company_id,
                        new_value=MEMBER_STATUS_PENDING,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def invite_employee(
        self, *, company_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        if target_uid == caller_uid:
            raise ValidationError("cannot invite yourself")
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(target_uid)
        user_ref = self._db.collection("users").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                company_snap = company_ref.get(transaction=txn)
                if not company_snap.exists:
                    raise NotFoundError(f"company '{company_id}' does not exist")
                owner_id = company_snap.get("ownerId")
                if not caller_is_admin and (owner_id is None or owner_id != caller_uid):
                    raise ForbiddenError("only the office's owner or an admin may invite an employee")
                if target_uid == owner_id:
                    raise ValidationError("the office's owner is already its owner, not an invitable employee")
                if not user_ref.get(transaction=txn).exists:
                    raise NotFoundError(f"no user profile exists for uid '{target_uid}'")
                employee_snap = employee_ref.get(transaction=txn)
                if employee_snap.exists:
                    raise ConflictError("a membership record already exists for this user at this office")
                expires_at = datetime.now(UTC) + timedelta(days=INVITATION_EXPIRY_DAYS)
                txn.set(
                    employee_ref,
                    {
                        "uid": target_uid,
                        "status": MEMBER_STATUS_INVITED,
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
                        action="employee_invited",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=company_id,
                        new_value=MEMBER_STATUS_INVITED,
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="employee_invite_denied",
                    target_id=target_uid,
                    target_company_id=company_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    async def accept_invitation(self, *, company_id: str, caller_uid: str) -> None:
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(caller_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                employee_snap = employee_ref.get(transaction=txn)
                if not employee_snap.exists or employee_snap.get("status") != MEMBER_STATUS_INVITED:
                    raise NotFoundError("no pending invitation exists for you at this office")
                expires_at = employee_snap.get("expiresAt")
                if expires_at is not None and _is_expired(expires_at):
                    raise ConflictError("this invitation has expired -- ask the office owner to reinvite you")
                txn.update(
                    employee_ref,
                    {"status": MEMBER_STATUS_ACTIVE, "acceptedAt": fb_firestore.SERVER_TIMESTAMP},
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="user",
                        action="company_invitation_accepted",
                        target_type="membership",
                        target_id=caller_uid,
                        target_organization_id=company_id,
                        previous_value=MEMBER_STATUS_INVITED,
                        new_value=MEMBER_STATUS_ACTIVE,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def decline_invitation(self, *, company_id: str, caller_uid: str) -> None:
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(caller_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                employee_snap = employee_ref.get(transaction=txn)
                if not employee_snap.exists or employee_snap.get("status") != MEMBER_STATUS_INVITED:
                    raise NotFoundError("no pending invitation exists for you at this office")
                txn.delete(employee_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="user",
                        action="company_invitation_declined",
                        target_type="membership",
                        target_id=caller_uid,
                        target_organization_id=company_id,
                        previous_value=MEMBER_STATUS_INVITED,
                        new_value=None,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def revoke_invitation(
        self, *, company_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                company_snap = company_ref.get(transaction=txn)
                if not company_snap.exists:
                    raise NotFoundError(f"company '{company_id}' does not exist")
                owner_id = company_snap.get("ownerId")
                if not caller_is_admin and (owner_id is None or owner_id != caller_uid):
                    raise ForbiddenError("only the office's owner or an admin may revoke an invitation")
                employee_snap = employee_ref.get(transaction=txn)
                if not employee_snap.exists or employee_snap.get("status") != MEMBER_STATUS_INVITED:
                    raise NotFoundError("no pending invitation exists for this user at this office")
                txn.delete(employee_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="company_invitation_revoked",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=company_id,
                        previous_value=MEMBER_STATUS_INVITED,
                        new_value=None,
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="company_invitation_revocation_denied",
                    target_id=target_uid,
                    target_company_id=company_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    async def approve_membership(
        self, *, company_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                company_snap = company_ref.get(transaction=txn)
                if not company_snap.exists:
                    raise NotFoundError(f"company '{company_id}' does not exist")
                owner_id = company_snap.get("ownerId")
                if not caller_is_admin and (owner_id is None or owner_id != caller_uid):
                    raise ForbiddenError("only the office's owner or an admin may approve membership")
                employee_snap = employee_ref.get(transaction=txn)
                if not employee_snap.exists or employee_snap.get("status") != MEMBER_STATUS_PENDING:
                    raise ConflictError("no pending membership request exists for this user at this office")
                txn.update(
                    employee_ref,
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
                        action="company_membership_approved",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=company_id,
                        previous_value=MEMBER_STATUS_PENDING,
                        new_value=MEMBER_STATUS_ACTIVE,
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="company_membership_approval_denied",
                    target_id=target_uid,
                    target_company_id=company_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    async def reject_membership(
        self, *, company_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                company_snap = company_ref.get(transaction=txn)
                if not company_snap.exists:
                    raise NotFoundError(f"company '{company_id}' does not exist")
                owner_id = company_snap.get("ownerId")
                if not caller_is_admin and (owner_id is None or owner_id != caller_uid):
                    raise ForbiddenError("only the office's owner or an admin may reject membership")
                employee_snap = employee_ref.get(transaction=txn)
                if not employee_snap.exists or employee_snap.get("status") != MEMBER_STATUS_PENDING:
                    raise ConflictError("no pending membership request exists for this user at this office")
                txn.delete(employee_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="company_membership_rejected",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=company_id,
                        previous_value=MEMBER_STATUS_PENDING,
                        new_value=None,
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="company_membership_rejection_denied",
                    target_id=target_uid,
                    target_company_id=company_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    async def remove_employee(
        self, *, company_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool
    ) -> None:
        company_ref = self._db.collection("companies").document(company_id)
        employee_ref = company_ref.collection("employees").document(target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                company_snap = company_ref.get(transaction=txn)
                if not company_snap.exists:
                    raise NotFoundError(f"company '{company_id}' does not exist")
                owner_id = company_snap.get("ownerId")
                if not caller_is_admin and (owner_id is None or owner_id != caller_uid):
                    raise ForbiddenError("only the office's owner or an admin may remove an employee")
                employee_snap = employee_ref.get(transaction=txn)
                if not employee_snap.exists:
                    raise NotFoundError("no membership record exists for this user at this office")
                previous_status = employee_snap.get("status")
                txn.delete(employee_ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin" if caller_is_admin else "owner",
                        action="employee_removed",
                        target_type="membership",
                        target_id=target_uid,
                        target_organization_id=company_id,
                        previous_value=previous_status,
                        new_value=None,
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="employee_removal_denied",
                    target_id=target_uid,
                    target_company_id=company_id,
                    reason_code="forbidden_not_owner_or_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    # ---- read: "every office I own or work at" ---------------------------

    async def list_my_companies(self, *, uid: str) -> list[dict]:
        """GET /me/companies. Same two-lookup shape as
        OrganizationOps.list_my_organizations -- owned companies (direct
        query) plus a collection-group query over `employees` (a
        DIFFERENT subcollection name than organizations' `members`, so
        this query structurally cannot return an organization's member
        docs or vice versa). Requires the collection-group index declared
        for `companies/{id}/employees.uid` (see firestore.indexes.json)."""

        def _read() -> list[dict]:
            results: dict[str, dict] = {}

            owned_query = self._db.collection("companies").where("ownerId", "==", uid)
            for company_snap in owned_query.stream():
                company_data = company_snap.to_dict() or {}
                results[company_snap.id] = {
                    "companyId": company_snap.id,
                    "name": company_data.get("name"),
                    "membershipStatus": "owner",
                    "isOwner": True,
                }

            employee_query = self._db.collection_group("employees").where("uid", "==", uid)
            for employee_snap in employee_query.stream():
                company_ref = employee_snap.reference.parent.parent
                if company_ref is None or company_ref.id in results:
                    continue
                employee_data = employee_snap.to_dict() or {}
                status = employee_data.get("status")
                if status not in (MEMBER_STATUS_ACTIVE, MEMBER_STATUS_PENDING, MEMBER_STATUS_INVITED):
                    continue
                company_snap = company_ref.get()
                if not company_snap.exists:
                    continue
                company_data = company_snap.to_dict() or {}
                results[company_ref.id] = {
                    "companyId": company_ref.id,
                    "name": company_data.get("name"),
                    "membershipStatus": status,
                    "isOwner": False,
                }

            return list(results.values())

        return await asyncio.to_thread(_read)
