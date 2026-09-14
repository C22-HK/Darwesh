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
from app.access.constants import SELF_ACCOUNT_TYPES
from app.access.errors import NotFoundError, ValidationError

from . import model

_MAX_REASON_LENGTH = 500
_MAX_NOTE_LENGTH = 500
_MAX_NAME_LENGTH = 160
_MAX_CITY_LENGTH = 200
_MAX_BULK_ACCOUNTS = 100
_MAX_LIST_LIMIT = 100
_DEFAULT_LIST_LIMIT = 50
_MAX_PREVIEW_ACCOUNTS = 200
_CANDIDATE_FETCH_MULTIPLIER = 6
_MAX_CANDIDATE_FETCH = 600

_USERS_COLLECTION = "users"
_PRIVATE_PROFILE_SUBCOLLECTION = "privateProfile"
_PRIVATE_PROFILE_DOC = "main"
_VERIFICATION_CASES_COLLECTION = "verificationCases"
_COMPANIES_COLLECTION = "companies"
_ORGANIZATIONS_COLLECTION = "organizations"
# Sentinel id for a not-yet-saved policy passed to preview_policy_matches --
# never a real Firestore document id (those come from .document().id), so
# it can be told apart from any real policy when picking the match winner.
_PREVIEW_POLICY_ID = "__preview__"


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


def _parse_optional_datetime(value: object, *, field: str) -> datetime | None:
    """None/''/None-ish -> None (no bound). A naive datetime, epoch millis,
    or ISO string all become a tz-aware UTC datetime -- same tolerance
    js/offers.js's toMillis() has for whatever shape a caller sends."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value / 1000.0, tz=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValidationError(f"'{field}' must be a valid date") from exc
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    raise ValidationError(f"'{field}' must be a valid date")


def _validate_policy_fields(
    *,
    name: object,
    account_type: object,
    city: object,
    percent: object,
    status: object,
    start_at: object,
    end_at: object,
) -> dict:
    clean_name = _clean_text(name, field="name", max_length=_MAX_NAME_LENGTH)
    if not clean_name:
        raise ValidationError("'name' is required")
    clean_account_type = account_type if isinstance(account_type, str) and account_type.strip() else None
    if clean_account_type is not None and clean_account_type not in SELF_ACCOUNT_TYPES:
        raise ValidationError(f"'{clean_account_type}' is not a valid account type")
    clean_city = _clean_text(city, field="city", max_length=_MAX_CITY_LENGTH)
    if not model.is_valid_percent(percent):
        raise ValidationError("'percent' must be a number between 0 and 100")
    if status not in model.POLICY_STATUSES:
        raise ValidationError(f"'{status}' is not a valid policy status")
    start_dt = _parse_optional_datetime(start_at, field="startAt")
    end_dt = _parse_optional_datetime(end_at, field="endAt")
    if start_dt is not None and end_dt is not None and end_dt <= start_dt:
        raise ValidationError("'endAt' must be after 'startAt'")
    return {
        "name": clean_name,
        "accountType": clean_account_type,
        "city": clean_city,
        "percent": percent,
        "status": status,
        "startAt": start_dt,
        "endAt": end_dt,
    }


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
            has_override = model.is_valid_percent(percent)
            if not has_override:
                percent, active = None, None

            # PRECEDENCE (Phase 2): an explicit per-account override --
            # active or disabled -- is always the final word and policies
            # are never consulted at all. Only an account with NO override
            # ever falls through to the best-matching active policy.
            effective = model.effective_percent(percent, active)
            discount_source = "none"
            policy_id = None
            policy_name = None
            if has_override:
                discount_source = "override"
            else:
                account_type = user.get("accountType")
                city = self._resolve_account_city(user)
                match = model.match_best_policy(
                    self._active_policies_sync(), account_type=account_type, city=city, now=self._clock()
                )
                if match is not None:
                    effective = model.effective_percent(match.get("percent"), True)
                    discount_source = "policy"
                    policy_id = match.get("id")
                    policy_name = match.get("name")

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
                    "effectiveDiscountPercent": effective,
                    "discountUpdatedAt": private.get(model.FIELD_UPDATED_AT),
                    "discountUpdatedBy": private.get(model.FIELD_UPDATED_BY),
                    "discountSource": discount_source,
                    "policyId": policy_id,
                    "policyName": policy_name,
                }
            )

        return await asyncio.to_thread(_read)

    def _verification_status(self, uid: str) -> str:
        snap = self._db.collection(_VERIFICATION_CASES_COLLECTION).document(uid).get()
        if not snap.exists:
            return "unverified"
        return (snap.to_dict() or {}).get("verificationStatus", "unverified")

    def _resolve_account_city(self, user: dict) -> str | None:
        """users/{uid} carries no real city field of its own (confirmed by
        repeated repo grep) -- the real linkage is companyId ->
        companies/{id}.city, or activeOrganizationId (falling back to the
        legacy organizationId, same precedent as
        app.access.permission_ops.py) -> organizations/{id}.city. An
        account with neither, or whose linked doc has no city set, has no
        resolvable city -- a city-scoped policy then simply never matches
        it (explicit product decision, not an error)."""
        company_id = user.get("companyId")
        if isinstance(company_id, str) and company_id:
            company_snap = self._db.collection(_COMPANIES_COLLECTION).document(company_id).get()
            if company_snap.exists:
                city = (company_snap.to_dict() or {}).get("city")
                if isinstance(city, str) and city.strip():
                    return city
        org_id = user.get("activeOrganizationId") or user.get("organizationId")
        if isinstance(org_id, str) and org_id:
            org_snap = self._db.collection(_ORGANIZATIONS_COLLECTION).document(org_id).get()
            if org_snap.exists:
                city = (org_snap.to_dict() or {}).get("city")
                if isinstance(city, str) and city.strip():
                    return city
        return None

    def _active_policies_sync(self) -> list[dict]:
        query = self._db.collection(model.BROKERAGE_DISCOUNT_POLICIES).where("status", "==", "active")
        return [{"id": doc.id, **(doc.to_dict() or {})} for doc in query.stream()]

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
            "discountSource": current.get("discountSource"),
            "policyId": current.get("policyId"),
            "policyName": current.get("policyName"),
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

    # ---- Phase 2: policy engine ------------------------------------------------

    async def list_policies(
        self, *, status: str | None = None, cursor: str | None = None, limit: int = _DEFAULT_LIST_LIMIT
    ) -> dict:
        limit = max(1, min(limit, _MAX_LIST_LIMIT))

        def _read() -> dict:
            # Ordered by updatedAt (most-recently-touched first, matching
            # the admin list's "last updated" column) via the
            # (status, updatedAt) composite index -- start_after() takes
            # the cursor document's own snapshot, so it carries the right
            # updatedAt value for the next page automatically.
            query = self._db.collection(model.BROKERAGE_DISCOUNT_POLICIES).order_by(
                "updatedAt", direction=fb_firestore.Query.DESCENDING
            )
            if status:
                query = query.where("status", "==", status)
            if cursor:
                cursor_snap = self._db.collection(model.BROKERAGE_DISCOUNT_POLICIES).document(cursor).get()
                if cursor_snap.exists:
                    query = query.start_after(cursor_snap)
            docs = list(query.limit(limit).stream())
            rows = [_jsonable({"id": doc.id, **(doc.to_dict() or {})}) for doc in docs]
            next_cursor = docs[-1].id if len(docs) == limit else None
            return {"policies": rows, "nextCursor": next_cursor}

        return await asyncio.to_thread(_read)

    async def get_policy(self, *, policy_id: str) -> dict:
        def _read() -> dict:
            snap = self._db.collection(model.BROKERAGE_DISCOUNT_POLICIES).document(policy_id).get()
            if not snap.exists:
                raise NotFoundError(f"policy '{policy_id}' does not exist")
            return _jsonable({"id": snap.id, **(snap.to_dict() or {})})

        return await asyncio.to_thread(_read)

    async def create_policy(
        self,
        *,
        admin_uid: str,
        admin_role: str,
        name: object,
        account_type: object = None,
        city: object = None,
        percent: object,
        status: object = "draft",
        start_at: object = None,
        end_at: object = None,
        reason: object = None,
    ) -> dict:
        fields = _validate_policy_fields(
            name=name,
            account_type=account_type,
            city=city,
            percent=percent,
            status=status,
            start_at=start_at,
            end_at=end_at,
        )
        clean_reason = _clean_text(reason, field="reason", max_length=_MAX_REASON_LENGTH)
        policy_ref = self._db.collection(model.BROKERAGE_DISCOUNT_POLICIES).document()

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                txn.set(
                    policy_ref,
                    {
                        **fields,
                        "createdAt": fb_firestore.SERVER_TIMESTAMP,
                        "createdBy": admin_uid,
                        "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                        "updatedBy": admin_uid,
                    },
                )
                history_ref = self._db.collection(model.BROKERAGE_DISCOUNT_POLICY_HISTORY).document()
                txn.set(
                    history_ref,
                    {
                        "policyId": policy_ref.id,
                        "action": "create",
                        "previousValue": None,
                        "newValue": fields,
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
                        action="brokerage_policy_create",
                        target_type="brokerageDiscountPolicy",
                        target_id=policy_ref.id,
                        changed_fields=list(fields.keys()),
                        previous_value=None,
                        new_value=fields.get("percent"),
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)
        return _jsonable({"id": policy_ref.id, **fields})

    async def update_policy(
        self,
        *,
        admin_uid: str,
        admin_role: str,
        policy_id: str,
        name: object,
        account_type: object,
        city: object,
        percent: object,
        status: object,
        start_at: object,
        end_at: object,
        reason: object = None,
    ) -> dict:
        fields = _validate_policy_fields(
            name=name,
            account_type=account_type,
            city=city,
            percent=percent,
            status=status,
            start_at=start_at,
            end_at=end_at,
        )
        clean_reason = _clean_text(reason, field="reason", max_length=_MAX_REASON_LENGTH)
        policy_ref = self._db.collection(model.BROKERAGE_DISCOUNT_POLICIES).document(policy_id)
        result: dict = {}

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = policy_ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"policy '{policy_id}' does not exist")
                previous = snap.to_dict() or {}
                txn.update(
                    policy_ref, {**fields, "updatedAt": fb_firestore.SERVER_TIMESTAMP, "updatedBy": admin_uid}
                )

                history_ref = self._db.collection(model.BROKERAGE_DISCOUNT_POLICY_HISTORY).document()
                txn.set(
                    history_ref,
                    {
                        "policyId": policy_id,
                        "action": "update",
                        "previousValue": {key: previous.get(key) for key in fields},
                        "newValue": fields,
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
                        action="brokerage_policy_update",
                        target_type="brokerageDiscountPolicy",
                        target_id=policy_id,
                        changed_fields=list(fields.keys()),
                        previous_value=previous.get("percent"),
                        new_value=fields.get("percent"),
                    ),
                )
                result["id"] = policy_id
                result.update(fields)

            _txn(transaction)

        await asyncio.to_thread(_op)
        return _jsonable(result)

    async def set_policy_status(
        self, *, admin_uid: str, admin_role: str, policy_id: str, status: object, reason: object = None
    ) -> dict:
        if status not in model.POLICY_STATUSES:
            raise ValidationError(f"'{status}' is not a valid policy status")
        clean_reason = _clean_text(reason, field="reason", max_length=_MAX_REASON_LENGTH)
        policy_ref = self._db.collection(model.BROKERAGE_DISCOUNT_POLICIES).document(policy_id)
        result: dict = {}

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = policy_ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"policy '{policy_id}' does not exist")
                previous_status = (snap.to_dict() or {}).get("status")
                txn.update(
                    policy_ref,
                    {"status": status, "updatedAt": fb_firestore.SERVER_TIMESTAMP, "updatedBy": admin_uid},
                )

                history_ref = self._db.collection(model.BROKERAGE_DISCOUNT_POLICY_HISTORY).document()
                txn.set(
                    history_ref,
                    {
                        "policyId": policy_id,
                        "action": "status_change",
                        "previousValue": previous_status,
                        "newValue": status,
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
                        action="brokerage_policy_status_change",
                        target_type="brokerageDiscountPolicy",
                        target_id=policy_id,
                        changed_fields=["status"],
                        previous_value=previous_status,
                        new_value=status,
                    ),
                )
                result["id"] = policy_id
                result["status"] = status

            _txn(transaction)

        await asyncio.to_thread(_op)
        return result

    async def list_policy_history(
        self, *, policy_id: str | None = None, limit: int = _DEFAULT_LIST_LIMIT
    ) -> list[dict]:
        limit = max(1, min(limit, _MAX_LIST_LIMIT))

        def _read() -> list[dict]:
            query = self._db.collection(model.BROKERAGE_DISCOUNT_POLICY_HISTORY)
            if policy_id:
                query = query.where("policyId", "==", policy_id)
            query = query.order_by("changedAt", direction=fb_firestore.Query.DESCENDING).limit(limit)
            return [_jsonable({"id": doc.id, **(doc.to_dict() or {})}) for doc in query.stream()]

        return await asyncio.to_thread(_read)

    async def preview_policy_matches(
        self,
        *,
        account_type: object = None,
        city: object = None,
        percent: object,
        start_at: object = None,
        end_at: object = None,
        exclude_policy_id: str | None = None,
        limit: int = _MAX_PREVIEW_ACCOUNTS,
    ) -> dict:
        """Read-only dry run: which accounts with NO per-account override
        would receive this candidate policy's percent if it (or its edited
        fields) were active right now. Never writes anything -- the admin
        reviews this list, then explicitly triggers the existing,
        unchanged bulk_set_discount() on the uids they want converted into
        permanent per-account overrides."""
        clean_account_type = account_type if isinstance(account_type, str) and account_type.strip() else None
        if clean_account_type is not None and clean_account_type not in SELF_ACCOUNT_TYPES:
            raise ValidationError(f"'{clean_account_type}' is not a valid account type")
        if not model.is_valid_percent(percent):
            raise ValidationError("'percent' must be a number between 0 and 100")
        clean_city = _clean_text(city, field="city", max_length=_MAX_CITY_LENGTH)
        start_dt = _parse_optional_datetime(start_at, field="startAt")
        end_dt = _parse_optional_datetime(end_at, field="endAt")
        limit = max(1, min(limit, _MAX_PREVIEW_ACCOUNTS))

        candidate = {
            "id": _PREVIEW_POLICY_ID,
            "name": "(preview)",
            "accountType": clean_account_type,
            "city": clean_city,
            "percent": percent,
            "status": "active",
            "startAt": start_dt,
            "endAt": end_dt,
            # Always wins a specificity tie against a real policy being
            # edited, so previewing an edit reflects what would happen
            # once it's saved, not the pre-edit version still on record.
            "updatedAt": datetime.max.replace(tzinfo=UTC),
        }

        def _read() -> dict:
            now = self._clock()
            pool = [p for p in self._active_policies_sync() if p.get("id") != exclude_policy_id] + [candidate]

            candidate_docs = list(
                self._db.collection(_USERS_COLLECTION).order_by("__name__").limit(_MAX_CANDIDATE_FETCH).stream()
            )
            uids = [doc.id for doc in candidate_docs]
            private_refs = [_private_ref(self._db, uid) for uid in uids]
            private_snaps = list(self._db.get_all(private_refs)) if uids else []
            private_by_uid = {
                uid: ((private_snaps[i].to_dict() or {}) if private_snaps[i].exists else {})
                for i, uid in enumerate(uids)
            }

            matches: list[dict] = []
            for doc in candidate_docs:
                uid = doc.id
                user = doc.to_dict() or {}
                if user.get("role") == "admin":
                    continue
                private = private_by_uid.get(uid, {})
                if model.is_valid_percent(private.get(model.FIELD_PERCENT)):
                    continue  # has an explicit override -- never affected by any policy
                acc_type = user.get("accountType")
                acc_city = self._resolve_account_city(user)
                winner = model.match_best_policy(pool, account_type=acc_type, city=acc_city, now=now)
                if winner is not None and winner.get("id") == _PREVIEW_POLICY_ID:
                    matches.append(
                        _jsonable(
                            {
                                "uid": uid,
                                "displayName": user.get("displayName") or user.get("fullName") or "",
                                "accountType": acc_type,
                                "city": acc_city,
                            }
                        )
                    )
                    if len(matches) >= limit:
                        break
            return {"accounts": matches, "count": len(matches)}

        return await asyncio.to_thread(_read)
