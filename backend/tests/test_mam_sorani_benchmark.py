# A small, honest Sorani-Kurdish benchmark for the deterministic intent
# resolver (app/mam/intent_resolver.py). This is NOT a claim that MAM
# understands Sorani generally -- it is a fixed set of real phrases run
# through the real resolve_intent()/search_properties() code path, so any
# claim this repo makes about Sorani support is backed by a passing test,
# not prose. Cases the resolver genuinely cannot handle today are asserted
# as such (see test_known_limitation_* below) rather than hidden.
from __future__ import annotations

import logging

import pytest

from app.mam.intent_resolver import resolve_intent
from app.mam.policy import PUBLIC_CALLER
from app.mam.tools import Tools
from tests.mam_fakes import FakeFirestore


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.mam.sorani")
    logger.addHandler(logging.NullHandler())
    return logger


def make_tools() -> tuple[Tools, FakeFirestore]:
    db = FakeFirestore()
    return Tools(db=db, logger=make_test_logger()), db


def seed_listing(db: FakeFirestore, listing_id: str, **overrides) -> None:
    base = {
        "title": "Listing",
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


# ---- Simple property search --------------------------------------------
def test_sorani_simple_search_house_in_erbil():
    intent = resolve_intent("خانوو لە هەولێر")
    assert intent is not None
    assert intent.tool_name == "search_properties"
    assert intent.arguments == {"city": "Erbil", "propertyType": "house"}


# ---- Price ranges --------------------------------------------------------
def test_sorani_max_price_kemtir():
    # "kemtir le" (کەمتر لە) = "less than" -- already-supported max-price path
    intent = resolve_intent("خانوو لە هەولێر کەمتر لە 80000 دۆلار")
    assert intent is not None
    assert intent.arguments.get("maxPrice") == 80000.0
    assert "minPrice" not in intent.arguments


def test_sorani_min_price_ziyatr_le():
    # "ziyatr le" (زیاتر لە) = "more than" -- must map to minPrice, not be dropped
    intent = resolve_intent("خانوو لە هەولێر زیاتر لە 100000 دۆلار")
    assert intent is not None
    assert intent.arguments.get("minPrice") == 100000.0
    assert "maxPrice" not in intent.arguments


def test_sorani_min_price_le_ser():
    # "le ser" (لە سەر) is the other common colloquial "more than X" phrasing
    # this benchmark exists specifically to cover (see resolve_intent()).
    intent = resolve_intent("خانوو لە هەولێر لە سەر 50000 دۆلار")
    assert intent is not None
    assert intent.arguments.get("minPrice") == 50000.0


@pytest.mark.asyncio
async def test_sorani_min_price_filters_real_listings():
    # Proves the minPrice mapping isn't just a resolver artifact -- it
    # actually filters real Firestore-backed results the same way
    # maxPrice already did.
    tools, db = make_tools()
    seed_listing(db, "cheap", city="Erbil", price=50000, propertyType="house")
    seed_listing(db, "expensive", city="Erbil", price=250000, propertyType="house")
    result = await tools.search_properties(
        PUBLIC_CALLER, city="Erbil", property_type="house", min_price=150000
    )
    ids = {r["listingId"] for r in result["results"]}
    assert ids == {"expensive"}


# ---- Bedrooms + Arabic-Indic digits --------------------------------------
def test_sorani_bedrooms_latin_digit():
    intent = resolve_intent("خانووی 3 ژووری نوستن لە کەرکووک")
    assert intent is not None
    assert intent.arguments.get("minBeds") == 3
    assert intent.arguments.get("city") == "Kirkuk"


def test_sorani_bedrooms_arabic_indic_digit():
    # ٣ is the Arabic-Indic digit for 3 -- normalize_text must convert it
    # to Latin '3' before extract_bedrooms's regex ever sees it.
    intent = resolve_intent("٣ ژوور لە هەولێر")
    assert intent is not None
    assert intent.arguments.get("minBeds") == 3
    assert intent.arguments.get("city") == "Erbil"


# ---- Sale vs rent ---------------------------------------------------------
def test_sorani_rent_apartment_in_duhok():
    intent = resolve_intent("شوقه بۆ کرێ لە دهۆک")
    assert intent is not None
    assert intent.arguments == {
        "city": "Duhok",
        "propertyType": "apartment",
        "dealType": "rent",
    }


# ---- City / district spelling variation -----------------------------------
def test_sorani_city_alt_spelling_sulaymaniyah():
    intent = resolve_intent("خانوو لە سلێمانی")
    assert intent is not None
    assert intent.arguments.get("city") == "Sulaymaniyah"


def test_sorani_city_alt_spelling_kirkuk_variant():
    # کرکوک is a common alternate spelling of کەرکووک -- both map to Kirkuk.
    intent = resolve_intent("ڤیلا لە کرکوک")
    assert intent is not None
    assert intent.arguments.get("city") == "Kirkuk"
    assert intent.arguments.get("propertyType") == "villa"


# ---- Native Sorani "شوقە" (apartment) spelling, U+06D5 AE not U+0647 heh --
# Found live: a real deployed request for "شوقە بۆ کرێ لە کەرکووک" returned
# deal=rent/q=Kirkuk but no types=["apartment"] in mapAction -- the keyword
# list only had the Arabic-script "شوقه" (heh) spelling, never the native
# Sorani "شوقە" (AE) one a real Sorani speaker actually typed.
def test_sorani_apartment_native_spelling_rent_kirkuk():
    intent = resolve_intent("شوقە بۆ کرێ لە کەرکووک")
    assert intent is not None
    assert intent.tool_name == "search_properties"
    assert intent.arguments == {
        "city": "Kirkuk",
        "propertyType": "apartment",
        "dealType": "rent",
    }


def test_sorani_apartment_native_spelling_sale_erbil():
    intent = resolve_intent("شوقە بۆ فرۆشتن لە هەولێر")
    assert intent is not None
    assert intent.arguments.get("propertyType") == "apartment"
    assert intent.arguments.get("city") == "Erbil"
    assert intent.arguments.get("dealType") == "sale"


def test_sorani_apartment_native_spelling_with_bedrooms_rent():
    intent = resolve_intent("شوقەی ٢ ژوور بۆ کرێ")
    assert intent is not None
    assert intent.arguments.get("propertyType") == "apartment"
    assert intent.arguments.get("minBeds") == 2
    assert intent.arguments.get("dealType") == "rent"


def test_sorani_apartment_native_spelling_produces_map_action_types():
    # End-to-end proof this reaches the actual MapAction.filters shape the
    # live bug was reported against, not just resolve_intent()'s own args.
    from app.mam.orchestrator import _search_filters_action

    intent = resolve_intent("شوقە بۆ کرێ لە کەرکووک")
    action = _search_filters_action(intent.arguments)
    assert action is not None
    assert action.filters.get("types") == ["apartment"]


# ---- Mixed English/Kurdish -------------------------------------------------
def test_sorani_mixed_english_kurdish():
    intent = resolve_intent("house بۆ فرۆشتن لە Erbil")
    assert intent is not None
    assert intent.arguments.get("city") == "Erbil"
    assert intent.arguments.get("propertyType") == "house"
    assert intent.arguments.get("dealType") == "sale"


# ---- Known limitations (documented honestly, not fixed this pass) ---------
def test_known_limitation_unlisted_district_name_not_recognized():
    # "Ankawa" is a real Erbil-governorate district, but CITY_KEYWORDS only
    # covers the 8 top-level cities today -- district-level names fall
    # through to None rather than being silently mis-resolved to the wrong
    # city. This is a real, current gap, not something this pass claims to
    # fix; recorded here so it can't be silently regressed further or
    # quietly overclaimed as "supported."
    intent = resolve_intent("خانوو لە عەنکاوا")
    assert intent is None


def test_known_limitation_pure_colloquial_price_without_currency_word():
    # "For under a hundred and fifty" with no currency/magnitude word and
    # no digits at all is not parseable by extract_price's regex-based
    # approach -- a real limitation of the deterministic path (a live
    # provider call, when configured, can still handle this turn; the
    # deterministic fallback honestly returns None instead of guessing).
    intent = resolve_intent("خانوویەکی هەرزان دەوێت")
    assert intent is None
