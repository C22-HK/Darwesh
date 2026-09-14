# Proves app.alerts.alerts_ops.AlertsOps against a REAL Firestore
# emulator -- the matching engine's privacy gate (never fires on a draft/
# private/unverified/closed listing), the idempotent match/notification
# writes, and the pause/resume/delete transitions can't be meaningfully
# proven against a fake/mock. Skipped automatically when no emulator is
# reachable, same convention as test_arena_ops.py:
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_alerts_ops.py
from __future__ import annotations

import os
import random
import uuid

import pytest

from app.access.errors import ForbiddenError, NotFoundError, ValidationError
from app.alerts import model
from app.alerts.alerts_ops import AlertsOps

pytestmark = pytest.mark.skipif(
    not os.environ.get("FIRESTORE_EMULATOR_HOST"),
    reason="requires a local Firestore emulator (set FIRESTORE_EMULATOR_HOST)",
)


@pytest.fixture(scope="module")
def db():
    from google.cloud import firestore

    return firestore.Client(project="demo-darwesh")


@pytest.fixture()
def ops(db):
    return AlertsOps(db)


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


# Erbil city-centre-ish coordinates, and a second point ~600m away --
# close enough to fall inside a 1km-radius circle, outside a 300m one.
# Used only by the pure model.py tests below (no Firestore involved, so
# no cross-test collision risk).
_CENTER = {"lat": 36.1900, "lng": 44.0090}
_NEARBY = {"lat": 36.1954, "lng": 44.0090}  # ~600m north


def _fresh_geo() -> tuple[dict, dict]:
    """A (center, nearby ~600m away) pair, at a random spot on Earth,
    fresh on every call. This suite shares one emulator Firestore project
    across every test and never deletes every alert it creates, so any
    test that calls notify_new_listing -- which matches against EVERY
    active areaAlerts doc, not just the one this test made -- must use
    its own geography or it will also match circle alerts another test
    left behind at a fixed, shared location."""
    lat = random.uniform(-60.0, 60.0)
    lng = random.uniform(-170.0, 170.0)
    return {"lat": lat, "lng": lng}, {"lat": lat + 0.0054, "lng": lng}


def _circle_area(center: dict, radius_m: float = 1000.0) -> dict:
    return {"type": "circle", "center": dict(center), "radiusM": radius_m}


def _seed_listing(db, listing_id: str, lat: float, lng: float, **overrides) -> dict:
    doc = {
        "private": False,
        "status": "active",
        "verified": True,
        "dealType": "sale",
        "propertyType": "apartment",
        "city": "Erbil",
        "district": "Ankawa",
        "price": 150000,
        "beds": 3,
        "publicLat": lat,
        "publicLng": lng,
        "img": "https://example.com/cover.jpg",
    }
    doc.update(overrides)
    db.collection("listings").document(listing_id).set(doc)
    return doc


async def _create_alert(ops, uid, *, area, filters=None, notify_mode="instant", name="My alert"):
    return await ops.create_alert(uid=uid, name=name, area=area, filters=filters or {}, notify_mode=notify_mode)


# ---- model.py pure functions ----------------------------------------------


def test_haversine_matches_known_short_distance():
    d = model.haversine_m(_CENTER["lat"], _CENTER["lng"], _NEARBY["lat"], _NEARBY["lng"])
    assert 500 <= d <= 700


def test_area_matches_listing_circle_inside_and_outside_radius():
    listing = {"publicLat": _NEARBY["lat"], "publicLng": _NEARBY["lng"]}
    assert model.area_matches_listing(_circle_area(_CENTER, 1000.0), listing) is True
    assert model.area_matches_listing(_circle_area(_CENTER, 300.0), listing) is False


def test_area_matches_listing_city_and_neighborhood():
    listing = {"city": "Erbil", "district": "Ankawa"}
    assert model.area_matches_listing({"type": "city", "city": "Erbil"}, listing) is True
    assert model.area_matches_listing({"type": "city", "city": "Duhok"}, listing) is False
    assert (
        model.area_matches_listing({"type": "neighborhood", "city": "Erbil", "district": "Ankawa"}, listing)
        is True
    )
    assert (
        model.area_matches_listing({"type": "neighborhood", "city": "Erbil", "district": "Downtown"}, listing)
        is False
    )


def test_filters_match_price_and_beds_bounds():
    listing = {"dealType": "sale", "propertyType": "apartment", "price": 150000, "beds": 3}
    assert model.filters_match({"minPrice": 100000, "maxPrice": 200000, "minBeds": 2}, listing) is True
    assert model.filters_match({"minPrice": 160000}, listing) is False
    assert model.filters_match({"dealType": "rent"}, listing) is False
    assert model.filters_match({}, listing) is True


# ---- create_alert -----------------------------------------------------------


async def test_create_alert_rejects_invalid_area(ops):
    with pytest.raises(ValidationError):
        await ops.create_alert(
            uid=_uid("u"),
            name="x",
            area={"type": "circle", "center": {"lat": 999, "lng": 0}, "radiusM": 100},
            filters={},
            notify_mode="instant",
        )


async def test_create_alert_rejects_invalid_notify_mode(ops):
    center, _ = _fresh_geo()
    with pytest.raises(ValidationError):
        await ops.create_alert(
            uid=_uid("u"), name="x", area=_circle_area(center), filters={}, notify_mode="paused"
        )


async def test_create_alert_happy_path_and_list_my_alerts(ops):
    uid = _uid("owner")
    center, _ = _fresh_geo()
    result = await _create_alert(ops, uid, area=_circle_area(center), name="Ankawa apartments")
    assert result["alertId"]
    rows = await ops.list_my_alerts(uid=uid)
    assert len(rows) == 1
    assert rows[0]["name"] == "Ankawa apartments"
    assert rows[0]["status"] == "active"
    assert rows[0]["matchCount"] == 0


# ---- update / pause / resume / delete ---------------------------------------


async def test_update_alert_rejects_non_owner(ops):
    uid = _uid("owner")
    other = _uid("other")
    center, _ = _fresh_geo()
    alert_id = (await _create_alert(ops, uid, area=_circle_area(center)))["alertId"]
    with pytest.raises(ForbiddenError):
        await ops.update_alert(alert_id=alert_id, uid=other, name="hijacked")


async def test_pause_then_resume_alert(ops):
    uid = _uid("owner")
    center, _ = _fresh_geo()
    alert_id = (await _create_alert(ops, uid, area=_circle_area(center)))["alertId"]
    await ops.update_alert(alert_id=alert_id, uid=uid, status="paused")
    rows = await ops.list_my_alerts(uid=uid)
    assert rows[0]["status"] == "paused"
    await ops.update_alert(alert_id=alert_id, uid=uid, status="active")
    rows = await ops.list_my_alerts(uid=uid)
    assert rows[0]["status"] == "active"


async def test_delete_alert_removes_it(ops):
    uid = _uid("owner")
    center, _ = _fresh_geo()
    alert_id = (await _create_alert(ops, uid, area=_circle_area(center)))["alertId"]
    await ops.delete_alert(alert_id=alert_id, uid=uid)
    assert await ops.list_my_alerts(uid=uid) == []
    with pytest.raises(NotFoundError):
        await ops.delete_alert(alert_id=alert_id, uid=uid)


# ---- notify_new_listing: the privacy gate -----------------------------------


async def test_notify_new_listing_ignores_draft_private_unverified_closed(db, ops):
    uid = _uid("owner")
    center, nearby = _fresh_geo()
    await _create_alert(ops, uid, area=_circle_area(center))

    cases = {
        "private": {"private": True},
        "unverified": {"verified": False},
        "closed": {"status": "closed"},
    }
    for label, override in cases.items():
        listing_id = f"listing-{label}-{uuid.uuid4().hex[:8]}"
        _seed_listing(db, listing_id, nearby["lat"], nearby["lng"], **override)
        result = await ops.notify_new_listing(listing_id=listing_id)
        assert result == {"matched": 0, "notified": 0}, label
    assert await ops.list_notifications(uid=uid) == []


async def test_notify_new_listing_nonexistent_listing_is_a_safe_noop(ops):
    result = await ops.notify_new_listing(listing_id="does-not-exist-" + uuid.uuid4().hex)
    assert result == {"matched": 0, "notified": 0}


# ---- notify_new_listing: real matches, idempotency, grouping ----------------


async def test_notify_new_listing_matches_and_is_idempotent(db, ops):
    uid = _uid("owner")
    center, nearby = _fresh_geo()
    alert_id = (await _create_alert(ops, uid, area=_circle_area(center), notify_mode="instant"))["alertId"]
    listing_id = "listing-" + uuid.uuid4().hex[:8]
    _seed_listing(db, listing_id, nearby["lat"], nearby["lng"])

    first = await ops.notify_new_listing(listing_id=listing_id)
    assert first == {"matched": 1, "notified": 1}

    matches = await ops.list_matches(alert_id=alert_id, uid=uid, actor_is_admin=False)
    assert len(matches) == 1
    assert matches[0]["listingId"] == listing_id
    assert matches[0]["publicLat"] == nearby["lat"]

    notifications = await ops.list_notifications(uid=uid)
    assert len(notifications) == 1
    assert notifications[0]["payload"]["matchCount"] == 1
    assert notifications[0]["read"] is False

    alerts = await ops.list_my_alerts(uid=uid)
    assert alerts[0]["matchCount"] == 1
    assert alerts[0]["newMatchCount"] == 1

    # Re-running for the exact same listing must not duplicate anything --
    # the deterministic match doc id makes this idempotent.
    second = await ops.notify_new_listing(listing_id=listing_id)
    assert second == {"matched": 0, "notified": 0}
    assert len(await ops.list_matches(alert_id=alert_id, uid=uid, actor_is_admin=False)) == 1
    assert len(await ops.list_notifications(uid=uid)) == 1


async def test_notify_new_listing_never_fires_for_a_paused_alert(db, ops):
    uid = _uid("owner")
    center, nearby = _fresh_geo()
    alert_id = (await _create_alert(ops, uid, area=_circle_area(center)))["alertId"]
    await ops.update_alert(alert_id=alert_id, uid=uid, status="paused")

    listing_id = "listing-" + uuid.uuid4().hex[:8]
    _seed_listing(db, listing_id, nearby["lat"], nearby["lng"])
    result = await ops.notify_new_listing(listing_id=listing_id)
    assert result == {"matched": 0, "notified": 0}
    assert await ops.list_notifications(uid=uid) == []


async def test_notify_new_listing_groups_multiple_matching_alerts_into_one_notification(db, ops):
    uid = _uid("owner")
    center, nearby = _fresh_geo()
    await _create_alert(ops, uid, area=_circle_area(center), name="Alert A", filters={"propertyType": "apartment"})
    await _create_alert(ops, uid, area=_circle_area(center), name="Alert B", filters={"dealType": "sale"})

    listing_id = "listing-" + uuid.uuid4().hex[:8]
    _seed_listing(db, listing_id, nearby["lat"], nearby["lng"])
    result = await ops.notify_new_listing(listing_id=listing_id)
    assert result == {"matched": 2, "notified": 1}

    notifications = await ops.list_notifications(uid=uid)
    assert len(notifications) == 1
    assert notifications[0]["payload"]["matchCount"] == 2
    alert_names = {m["alertName"] for m in notifications[0]["payload"]["matches"]}
    assert alert_names == {"Alert A", "Alert B"}


async def test_notify_new_listing_does_not_notify_daily_digest_alerts_yet(db, ops):
    """Phase 1: notifyMode='daily_digest' is stored and schema-ready, but
    the scheduled digest job doesn't exist yet -- a digest alert should
    record the match (so it's not lost) without creating an instant
    notification."""
    uid = _uid("owner")
    center, nearby = _fresh_geo()
    alert_id = (await _create_alert(ops, uid, area=_circle_area(center), notify_mode="daily_digest"))["alertId"]
    listing_id = "listing-" + uuid.uuid4().hex[:8]
    _seed_listing(db, listing_id, nearby["lat"], nearby["lng"])

    result = await ops.notify_new_listing(listing_id=listing_id)
    assert result == {"matched": 1, "notified": 0}
    assert len(await ops.list_matches(alert_id=alert_id, uid=uid, actor_is_admin=False)) == 1
    assert await ops.list_notifications(uid=uid) == []


# ---- mark_match_viewed / mark_notification_read -----------------------------


async def test_mark_match_viewed_decrements_new_match_count_and_is_owner_gated(db, ops):
    uid = _uid("owner")
    other = _uid("other")
    center, nearby = _fresh_geo()
    alert_id = (await _create_alert(ops, uid, area=_circle_area(center)))["alertId"]
    listing_id = "listing-" + uuid.uuid4().hex[:8]
    _seed_listing(db, listing_id, nearby["lat"], nearby["lng"])
    await ops.notify_new_listing(listing_id=listing_id)
    match_id = (await ops.list_matches(alert_id=alert_id, uid=uid, actor_is_admin=False))[0]["id"]

    with pytest.raises(ForbiddenError):
        await ops.mark_match_viewed(match_id=match_id, uid=other)

    await ops.mark_match_viewed(match_id=match_id, uid=uid)
    alerts = await ops.list_my_alerts(uid=uid)
    assert alerts[0]["newMatchCount"] == 0
    assert alerts[0]["matchCount"] == 1


async def test_mark_notification_read_is_owner_gated_and_mark_all_works(db, ops):
    uid = _uid("owner")
    other = _uid("other")
    center, nearby = _fresh_geo()
    await _create_alert(ops, uid, area=_circle_area(center))
    listing_id = "listing-" + uuid.uuid4().hex[:8]
    _seed_listing(db, listing_id, nearby["lat"], nearby["lng"])
    await ops.notify_new_listing(listing_id=listing_id)
    notification_id = (await ops.list_notifications(uid=uid))[0]["id"]

    with pytest.raises(ForbiddenError):
        await ops.mark_notification_read(notification_id=notification_id, uid=other)

    await ops.mark_notification_read(notification_id=notification_id, uid=uid)
    assert (await ops.list_notifications(uid=uid))[0]["read"] is True

    await ops.mark_all_notifications_read(uid=uid)  # already all-read: must not raise
    assert (await ops.list_notifications(uid=uid))[0]["read"] is True


async def test_admin_summary_is_aggregate_only(ops):
    uid = _uid("owner")
    await _create_alert(ops, uid, area={"type": "city", "city": "Erbil"}, name="City alert")
    summary = await ops.admin_summary()
    assert summary["activeAlerts"] >= 1
    assert any(row["city"] == "Erbil" for row in summary["alertsByCity"])
    # Aggregate-only by construction: no uid/alertId/name key anywhere.
    assert "uid" not in summary
    for row in summary["alertsByCity"]:
        assert set(row.keys()) == {"city", "count"}
