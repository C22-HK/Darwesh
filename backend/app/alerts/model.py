# Area Alerts domain model -- pure vocabulary and matching logic, no I/O.
# Every write goes through alerts_ops.py, which imports only this module
# for its rules (same split as app.arena.model / app.arena.arena_ops).
from __future__ import annotations

from math import asin, cos, radians, sin, sqrt

# ---------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------

AREA_ALERTS = "areaAlerts"
AREA_ALERT_MATCHES = "areaAlertMatches"
NOTIFICATIONS = "notifications"

# ---------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------

AREA_TYPES = frozenset({"circle", "city", "neighborhood"})
# Whether an ACTIVE alert notifies instantly or batches into a digest.
# 'paused' is deliberately NOT a notifyMode value -- pausing an alert
# entirely (no matching at all, not just no notification) is what
# ALERT_STATUSES' 'paused' already means; a second, overlapping "paused"
# concept on notifyMode would just be two switches for one idea.
# 'daily_digest' is accepted and stored (schema-ready) but inert in Phase
# 1 -- no scheduler exists yet to drive the actual digest email.
NOTIFY_MODES = frozenset({"instant", "daily_digest"})
ALERT_STATUSES = frozenset({"active", "paused"})
NOTIFICATION_TYPES = frozenset({"area_alert_match"})

# Mirrors sell.html's #typeSelect options exactly -- there is no shared
# enum module for this yet anywhere in the codebase (copy-pasted across
# sell.html/admin.html/agent-dashboard.html/map.html today), so this list
# is the same 8 values, kept here as the one place alerts validates
# against, not a second taxonomy.
PROPERTY_TYPES = frozenset(
    {"house", "villa", "apartment", "land", "building", "office", "shop", "commercialProperty"}
)
DEAL_TYPES = frozenset({"sale", "rent"})

_MIN_RADIUS_M = 50
_MAX_RADIUS_M = 50_000
_EARTH_RADIUS_M = 6_371_000.0


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres. Server-side port of map.html's own
    Leaflet-backed `map.distance()` circle math (spatialMatch()) -- same
    formula, so a listing that would show inside the drawn circle on the
    map is exactly the listing that matches here."""
    phi1, phi2 = radians(lat1), radians(lat2)
    d_phi = radians(lat2 - lat1)
    d_lambda = radians(lng2 - lng1)
    a = sin(d_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(d_lambda / 2) ** 2
    return 2 * _EARTH_RADIUS_M * asin(sqrt(a))


def area_matches_listing(area: dict, listing: dict) -> bool:
    """`area` is an areaAlerts doc's own `area` field; `listing` is the
    real listings/{id} document (already confirmed public/active/verified
    by the caller -- this function only ever answers the geography
    question). Every branch reads ONLY publicLat/publicLng (never a
    precise coordinate -- LOC-01, js/listing-location.js), exactly what
    map.html's own spatialMatch() plots."""
    area_type = area.get("type")
    if area_type == "circle":
        lat = listing.get("publicLat")
        lng = listing.get("publicLng")
        center = area.get("center") or {}
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            return False
        c_lat, c_lng = center.get("lat"), center.get("lng")
        if not isinstance(c_lat, (int, float)) or not isinstance(c_lng, (int, float)):
            return False
        radius_m = area.get("radiusM")
        if not isinstance(radius_m, (int, float)) or radius_m <= 0:
            return False
        return haversine_m(c_lat, c_lng, float(lat), float(lng)) <= float(radius_m)
    if area_type == "city":
        city = area.get("city")
        return bool(city) and listing.get("city") == city
    if area_type == "neighborhood":
        city = area.get("city")
        district = area.get("district")
        if not city or listing.get("city") != city:
            return False
        # `district` is not reliably written on listings today (only on
        # organizations/professionals/estates) -- treated as a best-effort
        # narrowing match: absent on either side falls back to the city
        # match above rather than rejecting the alert outright.
        if not district or not listing.get("district"):
            return True
        return listing.get("district") == district
    return False


def filters_match(filters: dict, listing: dict) -> bool:
    """`filters` reuses the SAME field names/values the existing search
    already filters on (js/data-model-fixes.js's canonical filter shape) --
    no second taxonomy. Every clause is optional: an unset filter never
    excludes a listing."""
    filters = filters or {}

    deal_type = filters.get("dealType")
    if deal_type and listing.get("dealType") != deal_type:
        return False

    property_type = filters.get("propertyType")
    if property_type and listing.get("propertyType") != property_type:
        return False

    price = listing.get("price")
    min_price = filters.get("minPrice")
    if isinstance(min_price, (int, float)):
        if not isinstance(price, (int, float)) or price < min_price:
            return False
    max_price = filters.get("maxPrice")
    if isinstance(max_price, (int, float)):
        if not isinstance(price, (int, float)) or price > max_price:
            return False

    min_beds = filters.get("minBeds")
    if isinstance(min_beds, (int, float)):
        beds = listing.get("beds")
        if not isinstance(beds, (int, float)) or beds < min_beds:
            return False

    return True


def alert_matches_listing(alert: dict, listing: dict) -> bool:
    """The one function that decides "does this alert fire for this
    listing". Pure, unit-testable -- alerts_ops.notify_new_listing is the
    only caller, and it has ALREADY confirmed the listing is public/
    active/verified before this is ever reached."""
    return area_matches_listing(alert.get("area") or {}, listing) and filters_match(
        alert.get("filters") or {}, listing
    )


def is_valid_area(area: object) -> bool:
    if not isinstance(area, dict):
        return False
    area_type = area.get("type")
    if area_type not in AREA_TYPES:
        return False
    if area_type == "circle":
        center = area.get("center")
        if not isinstance(center, dict):
            return False
        lat, lng = center.get("lat"), center.get("lng")
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            return False
        if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            return False
        radius_m = area.get("radiusM")
        if not isinstance(radius_m, (int, float)):
            return False
        return _MIN_RADIUS_M <= radius_m <= _MAX_RADIUS_M
    if area_type == "city":
        return isinstance(area.get("city"), str) and bool(area.get("city").strip())
    if area_type == "neighborhood":
        return isinstance(area.get("city"), str) and bool(area.get("city").strip())
    return False
