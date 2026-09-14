# Trusted backend layer for the Brokerage Fee Discount system (Phase 1:
# per-account manual control). firestore.rules make brokerageDiscountHistory
# and brokerageFeeSnapshots `allow write: if false` for every client SDK
# caller, and lock users/{uid}/privateProfile/main's
# brokerageDiscountPercent/brokerageDiscountActive fields to
# isAdmin() && hasPermission('brokerage.manage') only -- this module, called
# only via the Admin SDK from an already-permission-gated handler, is the
# sole path any of these three can ever be written through (same posture as
# app.alerts.alerts_ops / app.arena.arena_ops).
#
# THE CORE RULE (user's own words): admin chooses each account's
# brokerage-fee discount manually; that percentage stays in effect for
# future brokerage-fee calculations until admin changes it. No role, city,
# campaign or automated system may silently change it -- this module never
# reads a role/city/campaign table to decide a percent; every percent this
# module ever writes comes directly from an admin-supplied value.
#
# SCOPE: `compute_fee` discounts a brokerage/service fee amount the caller
# supplies -- it never reads, derives, or touches a property's sale/rent/
# land/unit/project price. There is no price field anywhere in this module.
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit
from app.access.errors import NotFoundError, ValidationError

from . import model

_MAX_REASON_LENGTH = 500
_MAX_NOTE_LENGTH = 500
_MAX_BULK_ACCOUNTS = 100
_MAX_LIST_LIMIT = 100
_DEFAULT_LIST_LIMIT = 50
_CANDIDATE_FETCH_MULTIPLIER = 6
_MAX_CANDIDATE_FETCH = 600

_USERS_COLLECTION = "users"
_PRIVATE_PROFILE_SUBCOLLECTION = "privateProfile"
_PRIVATE_PROFILE_DOC = "main"
_VERIFICATION_CASES_COLLECTION = "verificationCases"


def _clean_text(value: object, *, field: str, max_length: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError(f"'{field}' must be a string")
    stripped = value.strip()
    if len(stripped) > max_length:
        raise ValidationError(f"'{field}' must be at most {max_length} characters")
    return stripped or None


def _jsonable(data: dict) -> dict:
    """Same conversion alerts_ops._jsonable performs -- Starlette's
    JSONResponse has no datetime support, so every Firestore
    DatetimeWithNanoseconds field must become an ISO string first."""
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in data.items()}


def _private_ref(db, uid: str):
    return (
        db.collection(_USERS_COLLECTION)
        .document(uid)
        .collection(_PRIVATE_PROFILE_SUBCOLLECTION)
        .document(_PRIVATE_PROFILE_DOC)
    )


class BrokerageOps:
    def __init__(self, db, logger: logging.Logger | None = None, *, clock=None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.brokerage")
        self._clock = clock or (lambda: datetime.now(UTC))

    # ---- reads -------------------------------------------------------------

    async def get_account_discount(self, *, uid: str) -> dict:
        def _read() -> dict:
            user_snap = self._db.collection(_USERS_COLLECTION).document(uid).get()
            if not user_snap.exists:
                raise NotFoundError(f"account '{uid}' does not exist")
            user = user_snap.to_dict() or {}
            private_snap = _private_ref(self._db, uid).get()
            private = (private_snap.to_dict() or {}) if private_snap.exists else {}
            percent = private.get(model.FIELD_PERCENT)
            active = private.get(model.FIELD_ACTIVE)
            if not model.is_valid_percent(percent):
                percent, active = None, None
            return _jsonable(
                {
                    "uid": uid,
                    "displayName": user.get("displayName") or user.get("fullName") or "",
                    "photoURL": user.get("photoURL"),
                    "accountType": user.get("accountType"),
                    "city": user.get("city"),
                    "verificationStatus": self._verification_status(uid),
                    "discountPercent": percent,
                    "discountActive": active,
                    "effectiveDiscountPercent": model.effective_percent(percent, active),
                    "discountUpdatedAt": private.get(model.FIELD_UPDATED_AT),
                    "discountUpdatedBy": private.get(model.FIELD_UPDATED_BY),
                }
            )

        return await asyncio.to_thread(_read)

    def _verification_status(self, uid: str) -> str:
        snap = self._db.collection(_VERIFICATION_CASES_COLLECTION).document(uid).get()
        if not snap.exists:
            return "unverified"
        return (snap.to_dict() or {}).get("verificationStatus", "unverified")

    async def list_accounts(
        self,
        *,
        search: str | None = None,
        account_type: str | None = None,
        city: str | None = None,
        discount_min: float | None = None,
        discount_max: float | None = None,
        no_discount_only: bool = False,
        cursor: str | None = None,
        limit: int = _DEFAULT_LIST_LIMIT,
    ) -> dict:
        limit = max(1, min(limit, _MAX_LIST_LIMIT))
        search_lower = search.strip().lower() if isinstance(search, str) and search.strip() else None

        def _read() -> dict:
            query = self._db.collection(_USERS_COLLECTION).order_by("__name__")
            if account_type:
                query = query.where("accountType", "==", account_type)
            if city:
                query = query.where("city", "==", city)
            if cursor:
                cursor_snap = self._db.collection(_USERS_COLLECTION).document(cursor).get()
                if cursor_snap.exists:
                    query = query.start_after(cursor_snap)

            fetch_n = min(_MAX_CANDIDATE_FETCH, max(limit * _CANDIDATE_FETCH_MULTIPLIER, limit))
            candidates = list(query.limit(fetch_n).stream())
            uids = [doc.id for doc in candidates]

            private_refs = [_private_ref(self._db, uid) for uid in uids]
            verification_refs = [self._db.collection(_VERIFICATION_CASES_COLLECTION).document(uid) for uid in uids]
            # One batched RPC for both side-tables instead of 2*N
            # individual gets -- order is preserved by get_all() to match
            # the refs list passed in.
            side_snaps = list(self._db.get_all(private_refs + verification_refs)) if uids else []
            n = len(uids)
            private_by_uid = {
                uid: ((side_snaps[i].to_dict() or {}) if side_snaps[i].exists else {})
                for i, uid in enumerate(uids)
            }
            verification_by_uid = {
                uid: ((side_snaps[n + i].to_dict() or {}) if side_snaps[n + i].exists else {})
                for i, uid in enumerate(uids)
            }

            rows: list[dict] = []
            for doc in candidates:
                uid = doc.id
                user = doc.to_dict() or {}
                if user.get("role") == "admin":
                    continue
                private = private_by_uid.get(uid, {})
                percent = private.get(model.FIELD_PERCENT)
                active = private.get(model.FIELD_ACTIVE)
                if not model.is_valid_percent(percent):
                    percent, active = None, None
                effective = model.effective_percent(percent, active)

                if search_lower:
                    display_name = str(user.get("displayName") or user.get("fullName") or "")
                    phone = str(private.get("phone") or "")
                    haystack = " ".join(
                        [display_name, phone, str(user.get("accountType") or ""), str(user.get("city") or ""), uid]
                    ).lower()
                    if search_lower not in haystack:
                        continue
                if discount_min is not None and effective < discount_min:
                    continue
                if discount_max is not None and effective > discount_max:
                    continue
                if no_discount_only and effective > 0:
                    continue

                rows.append(
                    _jsonable(
                        {
                            "uid": uid,
                            "displayName": user.get("displayName") or user.get("fullName") or "",
                            "photoURL": user.get("photoURL"),
                            "accountType": user.get("accountType"),
                            "city": user.get("city"),
                            "verificationStatus": verification_by_uid.get(uid, {}).get(
                                "verificationStatus", "unverified"
                            ),
                            "discountPercent": percent,
                            "discountActive": active,
                            "effectiveDiscountPercent": effective,
                            "discountUpdatedAt": private.get(model.FIELD_UPDATED_AT),
                            "discountUpdatedBy": private.get(model.FIELD_UPDATED_BY),
                        }
                    )
                )
                if len(rows) >= limit:
                    break

            next_cursor = uids[-1] if len(candidates) == fetch_n and uids else None
            return {"accounts": rows, "nextCursor": next_cursor}

        return await asyncio.to_thread(_read)

    async def list_history(self, *, uid: str | None = None, limit: int = _DEFAULT_LIST_LIMIT) -> list[dict]:
        limit = max(1, min(limit, _MAX_LIST_LIMIT))

        def _read() -> list[dict]:
            query = self._db.collection(model.BROKERAGE_DISCOUNT_HISTORY)
            if uid:
                query = query.where("uid", "==", uid)
            query = query.order_by("changedAt", direction=fb_firestore.Query.DESCENDING).limit(limit)
            return [_jsonable({"id": doc.id, **(doc.to_dict() or {})}) for doc in query.stream()]

        return await asyncio.to_thread(_read)

    # ---- writes --------------------------------------------------------------

    async def set_discount(
        self,
        *,
        admin_uid: str,
        admin_role: str,
        target_uid: str,
        percent: object,
        active: bool = True,
        reason: object = None,
        action: str = "set",
    ) -> dict:
        if not model.is_valid_percent(percent):
            raise ValidationError("'percent' must be a number between 0 and 100")
        if not isinstance(active, bool):
            raise ValidationError("'active' must be a boolean")
        if action not in model.HISTORY_ACTIONS:
            raise ValidationError(f"'{action}' is not a valid history action")
        clean_reason = _clean_text(reason, field="reason", max_length=_MAX_REASON_LENGTH)

        user_ref = self._db.collection(_USERS_COLLECTION).document(target_uid)
        private_ref = _private_ref(self._db, target_uid)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                user_snap = user_ref.get(transaction=txn)
                if not user_snap.exists:
                    raise NotFoundError(f"account '{target_uid}' does not exist")
                if (user_snap.to_dict() or {}).get("role") == "admin":
                    raise ValidationError("brokerage discounts cannot be set on admin accounts")

                private_snap = private_ref.get(transaction=txn)
                previous = (private_snap.to_dict() or {}) if private_snap.exists else {}
                previous_percent = previous.get(model.FIELD_PERCENT)
                previous_active = previous.get(model.FIELD_ACTIVE)
                if not model.is_valid_percent(previous_percent):
                    previous_percent, previous_active = None, None

                patch = {
                    model.FIELD_PERCENT: percent,
                    model.FIELD_ACTIVE: active,
                    model.FIELD_UPDATED_AT: fb_firestore.SERVER_TIMESTAMP,
                    model.FIELD_UPDATED_BY: admin_uid,
                }
                if private_snap.exists:
                    txn.update(private_ref, patch)
                else:
                    txn.set(private_ref, patch)

                history_ref = self._db.collection(model.BROKERAGE_DISCOUNT_HISTORY).document()
                txn.set(
                    history_ref,
                    {
                        "uid": target_uid,
                        "previousPercent": previous_percent,
                        "newPercent": percent,
                        "previousActive": previous_active,
                        "newActive": active,
                        "action": action,
                        "changedBy": admin_uid,
                        "changedAt": fb_firestore.SERVER_TIMESTAMP,
                        "reason": clean_reason,
                    },
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=admin_uid,
                        actor_role=admin_role,
                        action=f"brokerage_discount_{action}",
                        target_type="brokerageDiscount",
                        target_id=target_uid,
                        changed_fields=[model.FIELD_PERCENT, model.FIELD_ACTIVE],
                        previous_value=previous_percent,
                        new_value=percent,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)
        return {"uid": target_uid, "discountPercent": percent, "discountActive": active}

    async def disable_discount(
        self, *, admin_uid: str, admin_role: str, target_uid: str, reason: object = None
    ) -> dict:
        """Preserves the stored percent -- only flips `active` off, so
        re-enabling restores the exact prior percent (never re-derives or
        guesses it). Reads the existing percent inside the SAME
        transaction as the flip (not a separate read-then-write pair), so
        a concurrent admin edit can never be silently clobbered."""
        return await self._flip_active(
            admin_uid=admin_uid,
            admin_role=admin_role,
            target_uid=target_uid,
            active=False,
            reason=reason,
            action="disable",
        )

    async def enable_discount(
        self, *, admin_uid: str, admin_role: str, target_uid: str, reason: object = None
    ) -> dict:
        return await self._flip_active(
            admin_uid=admin_uid,
            admin_role=admin_role,
            target_uid=target_uid,
            active=True,
            reason=reason,
            action="enable",
        )

    async def _flip_active(
        self, *, admin_uid: str, admin_role: str, target_uid: str, active: bool, reason: object, action: str
    ) -> dict:
        clean_reason = _clean_text(reason, field="reason", max_length=_MAX_REASON_LENGTH)
        user_ref = self._db.collection(_USERS_COLLECTION).document(target_uid)
        private_ref = _private_ref(self._db, target_uid)
        result: dict = {}

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                user_snap = user_ref.get(transaction=txn)
                if not user_snap.exists:
                    raise NotFoundError(f"account '{target_uid}' does not exist")
                private_snap = private_ref.get(transaction=txn)
                previous = (private_snap.to_dict() or {}) if private_snap.exists else {}
                previous_percent = previous.get(model.FIELD_PERCENT)
                previous_active = previous.get(model.FIELD_ACTIVE)
                if not model.is_valid_percent(previous_percent):
                    raise ValidationError(
                        f"this account has no discount configured to {'disable' if not active else 're-enable'}"
                    )

                patch = {
                    model.FIELD_PERCENT: previous_percent,
                    model.FIELD_ACTIVE: active,
                    model.FIELD_UPDATED_AT: fb_firestore.SERVER_TIMESTAMP,
                    model.FIELD_UPDATED_BY: admin_uid,
                }
                txn.update(private_ref, patch)

                history_ref = self._db.collection(model.BROKERAGE_DISCOUNT_HISTORY).document()
                txn.set(
                    history_ref,
                    {
                        "uid": target_uid,
                        "previousPercent": previous_percent,
                        "newPercent": previous_percent,
                        "previousActive": previous_active,
                        "newActive": active,
                        "action": action,
                        "changedBy": admin_uid,
                        "changedAt": fb_firestore.SERVER_TIMESTAMP,
                        "reason": clean_reason,
                    },
                )
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=admin_uid,
                        actor_role=admin_role,
                        action=f"brokerage_discount_{action}",
                        target_type="brokerageDiscount",
                        target_id=target_uid,
                        changed_fields=[model.FIELD_ACTIVE],
                        previous_value=previous_active,
                        new_value=active,
                    ),
                )
                result["uid"] = target_uid
                result["discountPercent"] = previous_percent
                result["discountActive"] = active

            _txn(transaction)

        await asyncio.to_thread(_op)
        return result

    async def remove_discount(
        self, *, admin_uid: str, admin_role: str, target_uid: str, reason: object = None
    ) -> dict:
        """Sets the percent back to 0% and inactive -- a plain, explicit
        state (never deletes the field), so a removed discount reads
        identically to "admin explicitly set 0%" everywhere in the UI and
        in compute_fee."""
        return await self.set_discount(
            admin_uid=admin_uid,
            admin_role=admin_role,
            target_uid=target_uid,
            percent=0,
            active=False,
            reason=reason,
            action="remove",
        )

    async def bulk_set_discount(
        self,
        *,
        admin_uid: str,
        admin_role: str,
        target_uids: list,
        percent: object,
        active: bool = True,
        reason: object = None,
    ) -> dict:
        if not isinstance(target_uids, list) or not target_uids:
            raise ValidationError("'accountIds' must be a non-empty array")
        if len(target_uids) > _MAX_BULK_ACCOUNTS:
            raise ValidationError(f"you may update at most {_MAX_BULK_ACCOUNTS} accounts at once")
        if not all(isinstance(u, str) and u.strip() for u in target_uids):
            raise ValidationError("'accountIds' must contain only non-empty account ids")

        results = []
        for target_uid in target_uids:
            try:
                await self.set_discount(
                    admin_uid=admin_uid,
                    admin_role=admin_role,
                    target_uid=target_uid,
                    percent=percent,
                    active=active,
                    reason=reason,
                    action="bulk_set",
                )
                results.append({"uid": target_uid, "ok": True})
            except Exception as exc:  # noqa: BLE001 -- one bad account must not abort the batch
                self._logger.warning(
                    "bulk brokerage discount set failed for one account",
                    extra={"uid": target_uid, "error": type(exc).__name__},
                )
                results.append({"uid": target_uid, "ok": False, "error": str(exc)})
        return {"results": results}

    # ---- calculator -----------------------------------------------------------

    async def compute_fee(
        self,
        *,
        admin_uid: str,
        target_uid: str,
        original_fee: object,
        currency: str = "USD",
        record: bool = False,
        note: object = None,
    ) -> dict:
        if not isinstance(original_fee, (int, float)) or isinstance(original_fee, bool) or original_fee < 0:
            raise ValidationError("'originalFee' must be a non-negative number")
        if currency not in model.CURRENCIES:
            raise ValidationError(f"'{currency}' is not a supported currency")
        clean_note = _clean_text(note, field="note", max_length=_MAX_NOTE_LENGTH)

        current = await self.get_account_discount(uid=target_uid)
        percent = current.get("effectiveDiscountPercent") or 0
        discount_amount, final_fee = model.compute_discount(float(original_fee), float(percent))

        result = {
            "uid": target_uid,
            "originalFee": original_fee,
            "currency": currency,
            "discountPercent": percent,
            "discountAmount": discount_amount,
            "finalFee": final_fee,
        }

        if record:

            def _write() -> str:
                ref = self._db.collection(model.BROKERAGE_FEE_SNAPSHOTS).document()
                ref.set(
                    {
                        "uid": target_uid,
                        "originalFee": original_fee,
                        "currency": currency,
                        "discountPercent": percent,
                        "discountAmount": discount_amount,
                        "finalFee": final_fee,
                        "computedBy": admin_uid,
                        "computedAt": fb_firestore.SERVER_TIMESTAMP,
                        "note": clean_note,
                    }
                )
                return ref.id

            result["snapshotId"] = await asyncio.to_thread(_write)

        return result
