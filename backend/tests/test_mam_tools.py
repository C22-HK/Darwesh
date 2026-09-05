from __future__ import annotations

import logging

import pytest

from app.mam.policy import PUBLIC_CALLER, MamCaller, ToolAuthorizationError
from app.mam.tools import MAX_RESULTS, ToolExecutionError, Tools, _coerce_arguments, dispatch
from tests.mam_fakes import FakeFirestore


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.mam.tools")
    logger.addHandler(logging.NullHandler())
    return logger


def make_tools() -> tuple[Tools, FakeFirestore]:
    db = FakeFirestore()
    return Tools(db=db, logger=make_test_logger()), db


def seed_listing(db: FakeFirestore, listing_id: str, **overrides) -> None:
    base = {
        "title": "Nice home",
        "city": "Erbil",
        "price": 100000,
        "dealType": "sale",
        "propertyType": "house",
        "beds": 3,
        "private": False,
        "status": "active",
        "verified": False,
    }
    base.update(overrides)
    db.collection("listings").document(listing_id).set(base)


@pytest.mark.asyncio
async def test_search_properties_excludes_private_and_inactive():
    tools, db = make_tools()
    seed_listing(db, "public1")
    seed_listing(db, "private1", private=True)
    seed_listing(db, "inactive1", status="sold")

    result = await tools.search_properties(PUBLIC_CALLER, city="Erbil")
    ids = {r["listingId"] for r in result["results"]}
    assert ids == {"public1"}


@pytest.mark.asyncio
async def test_search_properties_filters_by_city_and_price():
    tools, db = make_tools()
    seed_listing(db, "erbil-cheap", city="Erbil", price=50000)
    seed_listing(db, "erbil-expensive", city="Erbil", price=500000)
    seed_listing(db, "duhok-cheap", city="Duhok", price=50000)

    result = await tools.search_properties(PUBLIC_CALLER, city="Erbil", max_price=100000)
    ids = {r["listingId"] for r in result["results"]}
    assert ids == {"erbil-cheap"}


@pytest.mark.asyncio
async def test_search_properties_never_leaks_private_fields():
    tools, db = make_tools()
    seed_listing(db, "l1", agentId="secret-agent-uid", ownerPhone="+964-555")

    result = await tools.search_properties(PUBLIC_CALLER)
    assert "agentId" not in result["results"][0]
    assert "ownerPhone" not in result["results"][0]


@pytest.mark.asyncio
async def test_search_properties_survives_a_malformed_createdAt():
    # Regression: the sort key used to call .timestamp() on createdAt
    # unconditionally whenever the field was present -- a document
    # written by anything other than the normal listing-creation path
    # (e.g. a seed/test script storing createdAt as a plain string) made
    # that ONE document crash the sort, taking the entire search down
    # with it (caught only by routes.py's generic 500, indistinguishable
    # from a real outage to every visitor searching that city/type).
    tools, db = make_tools()
    seed_listing(db, "good1", city="Kirkuk", createdAt="not-a-real-timestamp")
    seed_listing(db, "good2", city="Kirkuk")

    result = await tools.search_properties(PUBLIC_CALLER, city="Kirkuk")
    ids = {r["listingId"] for r in result["results"]}
    assert ids == {"good1", "good2"}


@pytest.mark.asyncio
async def test_search_properties_respects_result_cap():
    tools, db = make_tools()
    for i in range(MAX_RESULTS + 5):
        seed_listing(db, f"l{i}")

    result = await tools.search_properties(PUBLIC_CALLER, limit=999)
    assert len(result["results"]) == MAX_RESULTS
    assert result["truncated"] is True


@pytest.mark.asyncio
async def test_get_property_found():
    tools, db = make_tools()
    seed_listing(db, "l1", title="Sunny apartment")
    result = await tools.get_property(PUBLIC_CALLER, listing_id="l1")
    assert result["found"] is True
    assert result["property"]["title"] == "Sunny apartment"


@pytest.mark.asyncio
async def test_get_property_private_listing_reads_as_not_available():
    tools, db = make_tools()
    seed_listing(db, "l1", private=True)
    result = await tools.get_property(PUBLIC_CALLER, listing_id="l1")
    assert result["found"] is False


@pytest.mark.asyncio
async def test_get_property_missing_id_raises():
    tools, _ = make_tools()
    with pytest.raises(ToolExecutionError):
        await tools.get_property(PUBLIC_CALLER, listing_id="")


@pytest.mark.asyncio
async def test_compare_properties_requires_at_least_two_ids():
    tools, db = make_tools()
    seed_listing(db, "l1")
    with pytest.raises(ToolExecutionError):
        await tools.compare_properties(PUBLIC_CALLER, listing_ids=["l1"])


@pytest.mark.asyncio
async def test_compare_properties_reports_unavailable_ids():
    tools, db = make_tools()
    seed_listing(db, "l1")
    result = await tools.compare_properties(PUBLIC_CALLER, listing_ids=["l1", "does-not-exist"])
    assert len(result["compared"]) == 1
    assert result["unavailable"] == ["does-not-exist"]


@pytest.mark.asyncio
async def test_get_listing_history_only_exposes_public_summary():
    tools, db = make_tools()
    seed_listing(db, "l1", estateId="e1", price=200000)
    db.collection("estates").document("e1").collection("publicTransactionSummary").document("t1").set(
        {"soldPrice": 190000, "date": "2025-01-01"}
    )
    # transactionHistory (admin-only) exists too -- must never be read by this tool.
    db.collection("estates").document("e1").collection("transactionHistory").document("secret").set(
        {"buyerName": "confidential"}
    )

    result = await tools.get_listing_history(PUBLIC_CALLER, listing_id="l1")
    assert result["available"] is True
    assert result["askingPrice"] == 200000
    assert result["verifiedTransactions"] == [{"soldPrice": 190000, "date": "2025-01-01"}]
    assert "buyerName" not in str(result)


@pytest.mark.asyncio
async def test_search_professionals_requires_valid_service_type():
    tools, _ = make_tools()
    with pytest.raises(ToolExecutionError):
        await tools.search_professionals(PUBLIC_CALLER, service_type="not-a-real-type")


@pytest.mark.asyncio
async def test_search_professionals_wraps_bio_as_untrusted():
    tools, db = make_tools()
    db.collection("serviceProviders").document("p1").set(
        {"serviceType": "engineer", "city": "Erbil", "verified": True, "description": "Great engineer"}
    )
    result = await tools.search_professionals(PUBLIC_CALLER, service_type="engineer")
    assert "<<<DARWESH_DATA_START>>>" in result["results"][0]["bio"]


@pytest.mark.asyncio
async def test_search_services_returns_static_catalog():
    tools, _ = make_tools()
    result = await tools.search_services(PUBLIC_CALLER)
    assert {s["service_type"] for s in result["services"]} == {
        "engineer",
        "designer",
        "lawyer",
        "landscaping",
        "cleaning",
    }


@pytest.mark.asyncio
async def test_open_on_map_is_pure_action_never_a_data_claim():
    tools, _ = make_tools()
    result = await tools.open_on_map(PUBLIC_CALLER, deal_type="rent", city="Erbil")
    assert result == {"target": "map.html", "filters": {"deal": "rent", "q": "Erbil"}, "focusListingId": None}


@pytest.mark.asyncio
async def test_saved_properties_require_authentication():
    tools, _ = make_tools()
    with pytest.raises(ToolAuthorizationError):
        await tools.get_saved_properties(PUBLIC_CALLER)
    with pytest.raises(ToolAuthorizationError):
        await tools.save_property(PUBLIC_CALLER, listing_id="l1")
    with pytest.raises(ToolAuthorizationError):
        await tools.remove_saved_property(PUBLIC_CALLER, listing_id="l1")


@pytest.mark.asyncio
async def test_save_and_remove_property_round_trip_for_signed_in_caller():
    tools, db = make_tools()
    seed_listing(db, "l1")
    caller = MamCaller(uid="user-1", role="customer")

    saved = await tools.save_property(caller, listing_id="l1")
    assert saved["saved"] is True

    listed = await tools.get_saved_properties(caller)
    assert listed["listingIds"] == ["l1"]

    removed = await tools.remove_saved_property(caller, listing_id="l1")
    assert removed["removed"] is True

    listed_after = await tools.get_saved_properties(caller)
    assert listed_after["listingIds"] == []


@pytest.mark.asyncio
async def test_save_property_rejects_unavailable_listing():
    tools, db = make_tools()
    seed_listing(db, "l1", private=True)
    caller = MamCaller(uid="user-1", role="customer")
    with pytest.raises(ToolExecutionError):
        await tools.save_property(caller, listing_id="l1")


@pytest.mark.asyncio
async def test_dispatch_unknown_tool_name_raises():
    tools, _ = make_tools()
    with pytest.raises(ToolExecutionError):
        await dispatch(tools, PUBLIC_CALLER, "not_a_real_tool", {})


@pytest.mark.asyncio
async def test_dispatch_coerces_camelcase_wire_arguments():
    tools, db = make_tools()
    seed_listing(db, "l1", city="Erbil", dealType="rent")
    result = await dispatch(tools, PUBLIC_CALLER, "search_properties", {"dealType": "rent", "city": "Erbil"})
    assert result["count"] == 1


def test_coerce_arguments_maps_known_keys():
    coerced = _coerce_arguments("search_properties", {"maxPrice": 1000, "minBeds": 2})
    assert coerced == {"max_price": 1000, "min_beds": 2}


def test_coerce_arguments_ignores_non_dict():
    assert _coerce_arguments("search_properties", None) == {}  # type: ignore[arg-type]
