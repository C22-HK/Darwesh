# Trusted backend layer for admin moderation of serviceProviders (Admin
# Panel Phase 2's "Professionals" tab -- individual engineer/designer/
# lawyer/landscaping/cleaning/maintenance profiles). Deliberately minimal:
# unlike OrganizationOps/CompanyOps this module has no create/membership
# surface -- serviceProviders creation already has a working, rules-
# enforced direct-client path (firestore.rules:1180-1198, any signed-in
# professional creates their own profile), and there is no membership
# concept on an individual profile. This module exists for exactly one
# reason: `verify_profiles`/`suspend_users` have sat in PROTECTED_PERMISSIONS
# since Phase 1 with no method anywhere that actually used them -- these
# two methods are that method. Admin-only, no owner/self branch at all
# (structurally prevents a professional from verifying or reactivating
# themselves), audited in the same transaction as the mutation, same
# shape as OrganizationOps.set_status/set_verified.
from __future__ import annotations

import asyncio
import logging

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit, write_denied_audit
from app.access.constants import ENTITY_STATUS_REASON_REQUIRED, ENTITY_STATUSES
from app.access.errors import ForbiddenError, NotFoundError, ValidationError

_MAX_TEXT_FIELD_LENGTH = 2000


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


class ProfessionalOps:
    def __init__(self, db, logger: logging.Logger | None = None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.access.professionals")

    def _log_denied(self, *, actor_uid: str, action: str, target_id: str, reason_code: str) -> None:
        write_denied_audit(
            self._db,
            AuditEntry(
                actor_uid=actor_uid,
                actor_role="user",
                action=action,
                target_type="serviceProvider",
                target_id=target_id,
                result="denied",
                reason_code=reason_code,
            ),
            logger=self._logger,
        )

    async def set_status(
        self, *, provider_id: str, new_status: str, reason: str | None, caller_uid: str, caller_is_admin: bool
    ) -> None:
        if new_status not in ENTITY_STATUSES:
            raise ValidationError(f"'{new_status}' is not a valid status (allowed: {sorted(ENTITY_STATUSES)})")
        clean_reason = _clean_text(reason, field="reason", max_length=_MAX_TEXT_FIELD_LENGTH)
        if new_status in ENTITY_STATUS_REASON_REQUIRED and not clean_reason:
            raise ValidationError(f"'reason' is required when setting status to '{new_status}'")
        provider_ref = self._db.collection("serviceProviders").document(provider_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                if not caller_is_admin:
                    raise ForbiddenError("only an admin may change a professional's status")
                provider_snap = provider_ref.get(transaction=txn)
                if not provider_snap.exists:
                    raise NotFoundError(f"service provider '{provider_id}' does not exist")
                data = provider_snap.to_dict() or {}
                previous_status = data.get("status") or ("active" if data.get("verified") else "pending")
                update = {
                    "status": new_status,
                    "statusUpdatedAt": fb_firestore.SERVER_TIMESTAMP,
                    "statusUpdatedBy": caller_uid,
                    "rejectionReason": clean_reason if new_status in ENTITY_STATUS_REASON_REQUIRED else None,
                }
                txn.update(provider_ref, update)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin",
                        action="provider_status_changed",
                        target_type="serviceProvider",
                        target_id=provider_id,
                        previous_value=previous_status,
                        new_value=new_status,
                        changed_fields=["status"],
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="provider_status_change_denied",
                    target_id=provider_id,
                    reason_code="forbidden_not_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    async def set_verified(
        self, *, provider_id: str, verified: bool, caller_uid: str, caller_is_admin: bool
    ) -> None:
        """No self-verification path exists anywhere in this method --
        `caller_is_admin` is required, not merely preferred, satisfying
        'professionals must not approve/verify themselves' structurally."""
        provider_ref = self._db.collection("serviceProviders").document(provider_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                if not caller_is_admin:
                    raise ForbiddenError("only an admin may verify a professional")
                provider_snap = provider_ref.get(transaction=txn)
                if not provider_snap.exists:
                    raise NotFoundError(f"service provider '{provider_id}' does not exist")
                previous_verified = bool((provider_snap.to_dict() or {}).get("verified"))
                txn.update(provider_ref, {"verified": verified, "updatedAt": fb_firestore.SERVER_TIMESTAMP})
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=caller_uid,
                        actor_role="admin",
                        action="provider_verified",
                        target_type="serviceProvider",
                        target_id=provider_id,
                        previous_value=previous_verified,
                        new_value=verified,
                        changed_fields=["verified"],
                    ),
                )

            try:
                _txn(transaction)
            except ForbiddenError as exc:
                self._log_denied(
                    actor_uid=caller_uid,
                    action="provider_verification_denied",
                    target_id=provider_id,
                    reason_code="forbidden_not_admin",
                )
                raise exc

        await asyncio.to_thread(_op)

    # ---- admin notes: private, staff-only, never owner-visible --------
    #
    # serviceProviders/{id}/adminNotes is `allow write: if false` in
    # firestore.rules, mirroring organizations'/companies' own adminNotes
    # -- this is the one trusted path in. `author_name` is a display label
    # the client sends (the caller's Firebase displayName), never the
    # authorization signal (caller_is_admin is), and falls back to
    # caller_uid if empty.
    async def add_note(
        self, *, provider_id: str, text: str, caller_uid: str, author_name: str | None, caller_is_admin: bool
    ) -> str:
        if not caller_is_admin:
            self._log_denied(
                actor_uid=caller_uid,
                action="provider_note_denied",
                target_id=provider_id,
                reason_code="forbidden_not_admin",
            )
            raise ForbiddenError("only an admin may add a note to a professional's profile")
        clean_text = _clean_text(text, field="text", max_length=_MAX_TEXT_FIELD_LENGTH, required=True)
        clean_author = _clean_text(author_name, field="authorName", max_length=200) or caller_uid
        provider_ref = self._db.collection("serviceProviders").document(provider_id)

        def _op() -> str:
            if not provider_ref.get().exists:
                raise NotFoundError(f"service provider '{provider_id}' does not exist")
            note_ref = provider_ref.collection("adminNotes").document()
            note_ref.set(
                {
                    "authorUid": caller_uid,
                    "authorName": clean_author,
                    "text": clean_text,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                }
            )
            return note_ref.id

        return await asyncio.to_thread(_op)
