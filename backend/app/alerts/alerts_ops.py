# Trusted backend layer for Property Watch / Area Alerts. Every write here
# goes through the Firebase Admin SDK -- firestore.rules make areaAlerts,
# areaAlertMatches and notifications `allow write: if false` for every
# client SDK caller, admin sessions included, so this module is the only
# path in (same posture as app.arena.arena_ops / app.verification).
#
# THE MATCHING DECISION IS SERVER-AUTHORITATIVE. notify_new_listing is the
# one entry point that decides "does a newly-published listing match any
# saved alert" -- it re-fetches the real listings/{id} document itself and
# re-derives every fact it matches on (private/status/verified, price,
# beds, coordinates). The two existing listing-creation call sites
# (admin.html's submission conversion, agent-dashboard.html's direct
# write) only ever pass a listing id to trigger this; neither can supply
# match data, and there is no client path that can create a match or a
# notification directly.
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from firebase_admin import firestore as fb_firestore

from app.access.audit import AuditEntry, write_audit
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError

from . import model

_MAX_NAME_LENGTH = 200
_MAX_ALERTS_PER_USER = 50
_BACKFILL_WINDOW = timedelta(days=30)
_BACKFILL_CANDIDATE_LIMIT = 300
_ADMIN_SUMMARY_WINDOW = timedelta(days=7)

_LISTINGS_COLLECTION = "listings"

_IMAGE_FIELD_CANDIDATES = (
    "img",
    "coverImage",
    "coverImageUrl",
    "imageUrl",
    "photoURL",
)
_IMAGE_ARRAY_FIELD_CANDIDATES = ("photoUrls", "images", "photos")


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


def _clean_area(area: dict) -> dict:
    """`area` has already passed model.is_valid_area -- this rebuilds a
    clean doc from only the known fields, never a raw pass-through of
    whatever extra keys the client sent."""
    area_type = area["type"]
    if area_type == "circle":
        center = area["center"]
        return {
            "type": "circle",
            "center": {"lat": float(center["lat"]), "lng": float(center["lng"])},
            "radiusM": float(area["radiusM"]),
        }
    if area_type == "city":
        return {"type": "city", "city": area["city"].strip()}
    district = area.get("district")
    return {
        "type": "neighborhood",
        "city": area["city"].strip(),
        "district": district.strip() if isinstance(district, str) and district.strip() else None,
    }


def _clean_filters(filters: object) -> dict:
    if filters is None:
        return {}
    if not isinstance(filters, dict):
        raise ValidationError("'filters' must be an object")

    deal_type = filters.get("dealType")
    if deal_type is not None and deal_type not in model.DEAL_TYPES:
        raise ValidationError(f"'{deal_type}' is not a valid dealType")

    property_type = filters.get("propertyType")
    if property_type is not None and property_type not in model.PROPERTY_TYPES:
        raise ValidationError(f"'{property_type}' is not a valid propertyType")

    min_price = filters.get("minPrice")
    max_price = filters.get("maxPrice")
    for label, value in (("minPrice", min_price), ("maxPrice", max_price)):
        if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0):
            raise ValidationError(f"'{label}' must be a non-negative number")

    min_beds = filters.get("minBeds")
    if min_beds is not None and (
        not isinstance(min_beds, (int, float)) or isinstance(min_beds, bool) or min_beds < 0
    ):
        raise ValidationError("'minBeds' must be a non-negative number")

    return {
        "dealType": deal_type,
        "propertyType": property_type,
        "minPrice": min_price,
        "maxPrice": max_price,
        "minBeds": min_beds,
    }


def _jsonable(data: dict) -> dict:
    """Firestore's Admin SDK returns Timestamp fields as
    DatetimeWithNanoseconds (a datetime subclass) -- Starlette's
    JSONResponse has no datetime support at all (plain `json.dumps`, no
    custom encoder), so every doc a handler hands back must have its
    datetime fields converted first, or the response 500s."""
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in data.items()}


def _listing_image_url(listing: dict) -> str | None:
    for field in _IMAGE_FIELD_CANDIDATES:
        value = listing.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for field in _IMAGE_ARRAY_FIELD_CANDIDATES:
        value = listing.get(field)
        if isinstance(value, list) and value and isinstance(value[0], str) and value[0].strip():
            return value[0].strip()
    return None


class AlertsOps:
    def __init__(self, db, logger: logging.Logger | None = None, *, clock=None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.alerts")
        self._clock = clock or (lambda: datetime.now(UTC))

    # ---- CRUD ------------------------------------------------------------

    async def create_alert(
        self, *, uid: str, name: object, area: object, filters: object, notify_mode: object
    ) -> dict:
        clean_name = _clean_text(name, field="name", max_length=_MAX_NAME_LENGTH, required=True)
        if not model.is_valid_area(area):
            raise ValidationError("'area' is not a valid alert area")
        clean_area = _clean_area(area)
        clean_filters = _clean_filters(filters)
        if notify_mode not in model.NOTIFY_MODES:
            raise ValidationError(f"'{notify_mode}' is not a valid notifyMode")

        def _write() -> str:
            existing = list(
                self._db.collection(model.AREA_ALERTS).where("uid", "==", uid).limit(_MAX_ALERTS_PER_USER).stream()
            )
            if len(existing) >= _MAX_ALERTS_PER_USER:
                raise ConflictError(f"you may have at most {_MAX_ALERTS_PER_USER} saved alerts")
            ref = self._db.collection(model.AREA_ALERTS).document()
            batch = self._db.batch()
            batch.set(
                ref,
                {
                    "uid": uid,
                    "name": clean_name,
                    "area": clean_area,
                    "filters": clean_filters,
                    "notifyMode": notify_mode,
                    "status": "active",
                    "matchCount": 0,
                    "newMatchCount": 0,
                    "lastMatchedAt": None,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                    "updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
            write_audit(
                batch,
                self._db,
                AuditEntry(
                    actor_uid=uid,
                    actor_role="user",
                    action="area_alert_created",
                    target_type="areaAlert",
                    target_id=ref.id,
                    new_value=clean_name,
                ),
            )
            batch.commit()
            return ref.id

        alert_id = await asyncio.to_thread(_write)
        # Best-effort: shows the alert something right away instead of an
        # empty card while it waits for the next listing to publish. Never
        # notifies (the user is already looking at the alert they just
        # made) and never blocks/fails the create itself.
        await asyncio.to_thread(self._backfill_alert, alert_id, uid, clean_area, clean_filters)
        return {"alertId": alert_id}

    async def update_alert(
        self,
        *,
        alert_id: str,
        uid: str,
        name: object = None,
        area: object = None,
        filters: object = None,
        notify_mode: object = None,
        status: object = None,
    ) -> dict:
        patch: dict = {}
        if name is not None:
            patch["name"] = _clean_text(name, field="name", max_length=_MAX_NAME_LENGTH, required=True)
        if area is not None:
            if not model.is_valid_area(area):
                raise ValidationError("'area' is not a valid alert area")
            patch["area"] = _clean_area(area)
        if filters is not None:
            patch["filters"] = _clean_filters(filters)
        if notify_mode is not None:
            if notify_mode not in model.NOTIFY_MODES:
                raise ValidationError(f"'{notify_mode}' is not a valid notifyMode")
            patch["notifyMode"] = notify_mode
        if status is not None:
            if status not in model.ALERT_STATUSES:
                raise ValidationError(f"'{status}' is not a valid status")
            patch["status"] = status
        if not patch:
            raise ValidationError("no fields to update")
        patch["updatedAt"] = fb_firestore.SERVER_TIMESTAMP

        ref = self._db.collection(model.AREA_ALERTS).document(alert_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"alert '{alert_id}' does not exist")
                if snap.get("uid") != uid:
                    raise ForbiddenError("this is not your alert")
                txn.update(ref, patch)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=uid,
                        actor_role="user",
                        action="area_alert_updated",
                        target_type="areaAlert",
                        target_id=alert_id,
                        changed_fields=sorted(k for k in patch if k != "updatedAt"),
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)
        return {"alertId": alert_id}

    async def delete_alert(self, *, alert_id: str, uid: str) -> None:
        ref = self._db.collection(model.AREA_ALERTS).document(alert_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError(f"alert '{alert_id}' does not exist")
                if snap.get("uid") != uid:
                    raise ForbiddenError("this is not your alert")
                txn.delete(ref)
                write_audit(
                    txn,
                    self._db,
                    AuditEntry(
                        actor_uid=uid,
                        actor_role="user",
                        action="area_alert_deleted",
                        target_type="areaAlert",
                        target_id=alert_id,
                    ),
                )

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def list_my_alerts(self, *, uid: str) -> list[dict]:
        def _read() -> list[dict]:
            query = (
                self._db.collection(model.AREA_ALERTS)
                .where("uid", "==", uid)
                .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
            )
            return [_jsonable({"id": doc.id, **(doc.to_dict() or {})}) for doc in query.stream()]

        return await asyncio.to_thread(_read)

    async def list_matches(self, *, alert_id: str, uid: str, actor_is_admin: bool, limit: int = 50) -> list[dict]:
        def _read() -> list[dict]:
            alert_snap = self._db.collection(model.AREA_ALERTS).document(alert_id).get()
            if not alert_snap.exists:
                raise NotFoundError(f"alert '{alert_id}' does not exist")
            if alert_snap.get("uid") != uid and not actor_is_admin:
                raise ForbiddenError("this is not your alert")
            query = (
                self._db.collection(model.AREA_ALERT_MATCHES)
                .where("alertId", "==", alert_id)
                .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
                .limit(max(1, min(limit, 200)))
            )
            return [_jsonable({"id": doc.id, **(doc.to_dict() or {})}) for doc in query.stream()]

        return await asyncio.to_thread(_read)

    async def mark_match_viewed(self, *, match_id: str, uid: str) -> None:
        ref = self._db.collection(model.AREA_ALERT_MATCHES).document(match_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError("match not found")
                if snap.get("uid") != uid:
                    raise ForbiddenError("this is not your match")
                if snap.get("viewedAt") is None:
                    txn.update(ref, {"viewedAt": fb_firestore.SERVER_TIMESTAMP})
                    alert_id = snap.get("alertId")
                    if alert_id:
                        alert_ref = self._db.collection(model.AREA_ALERTS).document(alert_id)
                        txn.update(alert_ref, {"newMatchCount": fb_firestore.Increment(-1)})

            _txn(transaction)

        await asyncio.to_thread(_op)

    # ---- notifications -----------------------------------------------------

    async def list_notifications(self, *, uid: str, limit: int = 40) -> list[dict]:
        def _read() -> list[dict]:
            query = (
                self._db.collection(model.NOTIFICATIONS)
                .where("uid", "==", uid)
                .order_by("createdAt", direction=fb_firestore.Query.DESCENDING)
                .limit(max(1, min(limit, 200)))
            )
            return [_jsonable({"id": doc.id, **(doc.to_dict() or {})}) for doc in query.stream()]

        return await asyncio.to_thread(_read)

    async def mark_notification_read(self, *, notification_id: str, uid: str) -> None:
        ref = self._db.collection(model.NOTIFICATIONS).document(notification_id)

        def _op() -> None:
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn) -> None:
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    raise NotFoundError("notification not found")
                if snap.get("uid") != uid:
                    raise ForbiddenError("this is not your notification")
                txn.update(ref, {"read": True})

            _txn(transaction)

        await asyncio.to_thread(_op)

    async def mark_all_notifications_read(self, *, uid: str) -> None:
        def _write() -> None:
            query = (
                self._db.collection(model.NOTIFICATIONS)
                .where("uid", "==", uid)
                .where("read", "==", False)
                .limit(500)
            )
            batch = self._db.batch()
            touched = False
            for doc in query.stream():
                batch.update(doc.reference, {"read": True})
                touched = True
            if touched:
                batch.commit()

        await asyncio.to_thread(_write)

    # ---- the matching engine ----------------------------------------------

    def _public_listing_fields(self, listing: dict) -> dict:
        price = listing.get("price")
        return {
            "propertyType": listing.get("propertyType") or None,
            "dealType": listing.get("dealType") or None,
            "city": listing.get("city") or None,
            "price": price if isinstance(price, (int, float)) and not isinstance(price, bool) else None,
            "coverImageUrl": _listing_image_url(listing),
            "publicLat": listing.get("publicLat"),
            "publicLng": listing.get("publicLng"),
        }

    def _record_match(
        self, alert_ref, alert_id: str, alert: dict, listing_id: str, listing_public: dict, *, notify: bool
    ) -> bool:
        """Idempotent: the match doc id is deterministic
        (`{alertId}_{listingId}`), so calling this twice for the same pair
        (a retried publish-time hook, a backfill that overlaps a later
        real match) creates no duplicate match and awards no duplicate
        notification."""
        match_ref = self._db.collection(model.AREA_ALERT_MATCHES).document(f"{alert_id}_{listing_id}")
        transaction = self._db.transaction()

        @fb_firestore.transactional
        def _txn(txn) -> bool:
            if match_ref.get(transaction=txn).exists:
                return False
            txn.set(
                match_ref,
                {
                    "alertId": alert_id,
                    "uid": alert.get("uid"),
                    "listingId": listing_id,
                    **listing_public,
                    "viewedAt": None,
                    "notifiedAt": fb_firestore.SERVER_TIMESTAMP if notify else None,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )
            update: dict = {
                "matchCount": fb_firestore.Increment(1),
                "lastMatchedAt": fb_firestore.SERVER_TIMESTAMP,
            }
            if notify:
                update["newMatchCount"] = fb_firestore.Increment(1)
            txn.update(alert_ref, update)
            return True

        return _txn(transaction)

    def _create_grouped_notification(self, uid: str, listing_id: str, matches: list[dict]) -> None:
        ref = self._db.collection(model.NOTIFICATIONS).document()
        ref.set(
            {
                "uid": uid,
                "type": "area_alert_match",
                "payload": {"listingId": listing_id, "matches": matches, "matchCount": len(matches)},
                "read": False,
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
            }
        )

    async def notify_new_listing(self, *, listing_id: str) -> dict:
        """The publish-time hook's entry point. `listing_id` is the ONLY
        thing the caller supplies -- everything this decides on is
        re-fetched from the real document right here, never trusted from
        the request. Silently a no-op (never raises) for a listing that
        isn't public/active/verified, so calling this from a client
        write-path is always safe regardless of what that listing turns
        out to be."""

        def _run() -> dict:
            listing_snap = self._db.collection(_LISTINGS_COLLECTION).document(listing_id).get()
            if not listing_snap.exists:
                return {"matched": 0, "notified": 0}
            listing = listing_snap.to_dict() or {}
            # Reproduces firestore.rules' isListingPubliclyVisible() plus
            # the verified gate -- the closest signal this codebase has to
            # "an admin has actually published this", and exactly what
            # keeps this from ever firing on a draft/rejected/unverified/
            # private listing.
            if (
                listing.get("private") is not False
                or listing.get("status") != "active"
                or listing.get("verified") is not True
            ):
                return {"matched": 0, "notified": 0}

            listing_public = self._public_listing_fields(listing)

            matches_by_uid: dict[str, list[dict]] = {}
            total_matched = 0
            alerts_query = self._db.collection(model.AREA_ALERTS).where("status", "==", "active")
            for alert_snap in alerts_query.stream():
                alert = alert_snap.to_dict() or {}
                if not alert.get("uid"):
                    continue
                if not model.alert_matches_listing(alert, listing):
                    continue
                notify = alert.get("notifyMode") == "instant"
                created = self._record_match(
                    alert_snap.reference, alert_snap.id, alert, listing_id, listing_public, notify=notify
                )
                if not created:
                    continue
                total_matched += 1
                if notify:
                    matches_by_uid.setdefault(alert["uid"], []).append(
                        {"alertId": alert_snap.id, "alertName": alert.get("name") or ""}
                    )

            for uid, matches in matches_by_uid.items():
                self._create_grouped_notification(uid, listing_id, matches)

            return {"matched": total_matched, "notified": len(matches_by_uid)}

        return await asyncio.to_thread(_run)

    def _backfill_alert(self, alert_id: str, uid: str, area: dict, filters: dict) -> None:
        """Best-effort, never raises -- a failure here must never fail
        the create_alert call it follows. Deliberately does not notify:
        the user just made this alert and is looking at it already."""
        try:
            cutoff = self._clock() - _BACKFILL_WINDOW
            alert_ref = self._db.collection(model.AREA_ALERTS).document(alert_id)
            probe = {"uid": uid, "area": area, "filters": filters}
            # Pure-equality filter (no inequality/orderBy) -- Firestore's
            # automatic per-field indexes cover this without a manual
            # composite index. verified + createdAt are checked in Python
            # below rather than added to the query, for the same reason.
            query = (
                self._db.collection(_LISTINGS_COLLECTION)
                .where("private", "==", False)
                .where("status", "==", "active")
                .limit(_BACKFILL_CANDIDATE_LIMIT)
            )
            for doc in query.stream():
                listing = doc.to_dict() or {}
                if listing.get("verified") is not True:
                    continue
                created_at = listing.get("createdAt")
                created_ms = created_at.timestamp() if hasattr(created_at, "timestamp") else None
                if created_ms is not None and datetime.fromtimestamp(created_ms, tz=UTC) < cutoff:
                    continue
                if not model.alert_matches_listing(probe, listing):
                    continue
                self._record_match(
                    alert_ref, alert_id, probe, doc.id, self._public_listing_fields(listing), notify=False
                )
        except Exception:  # noqa: BLE001 -- best-effort, must never block alert creation
            self._logger.warning("area alert backfill failed for %s", alert_id, exc_info=False)

    # ---- admin --------------------------------------------------------------

    async def admin_summary(self) -> dict:
        """Aggregate counts only -- deliberately never returns a per-user
        or per-alert row, so this is aggregate-safe by construction and
        needs no separate redaction step."""

        def _read() -> dict:
            active_alerts = 0
            by_city: dict[str, int] = {}
            for doc in self._db.collection(model.AREA_ALERTS).where("status", "==", "active").stream():
                active_alerts += 1
                area = (doc.to_dict() or {}).get("area") or {}
                city = area.get("city")
                if isinstance(city, str) and city:
                    by_city[city] = by_city.get(city, 0) + 1

            since = self._clock() - _ADMIN_SUMMARY_WINDOW
            matches_this_week = sum(
                1 for _ in self._db.collection(model.AREA_ALERT_MATCHES).where("createdAt", ">=", since).stream()
            )

            return {
                "activeAlerts": active_alerts,
                "matchesThisWeek": matches_this_week,
                "alertsByCity": [
                    {"city": city, "count": count}
                    for city, count in sorted(by_city.items(), key=lambda kv: -kv[1])
                ][:20],
            }

        return await asyncio.to_thread(_read)
