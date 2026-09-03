from __future__ import annotations

from app.mam.intent_resolver import (
    detect_city,
    detect_deal_type,
    detect_property_type,
    extract_bedrooms,
    extract_price,
    normalize_text,
    resolve_intent,
)


def test_normalize_text_unifies_letter_variants_and_digits():
    # ك -> ک, ي -> ی, Arabic-Indic digits -> Latin, diacritics stripped.
    assert normalize_text("كیف حالك؟ ١٢٣") == normalize_text("کیف حالک؟ 123")


def test_normalize_text_empty_input():
    assert normalize_text("") == ""
    assert normalize_text(None) == ""  # type: ignore[arg-type]


def test_detect_city_english_and_kurdish():
    assert detect_city(normalize_text("apartments in Erbil")) == "Erbil"
    assert detect_city(normalize_text("خانوو له هەولێر")) == "Erbil"
    assert detect_city(normalize_text("nothing relevant here")) is None


def test_detect_property_type():
    assert detect_property_type(normalize_text("looking for a villa")) == "villa"
    assert detect_property_type(normalize_text("no match")) is None


def test_detect_deal_type_rent_vs_sale():
    assert detect_deal_type(normalize_text("apartment for rent")) == "rent"
    assert detect_deal_type(normalize_text("I want to buy a house")) == "sale"
    assert detect_deal_type(normalize_text("just looking")) is None


def test_extract_price_million_magnitude():
    price = extract_price(normalize_text("under 2 million dollars"))
    assert price is not None
    assert price["usdValue"] == 2_000_000
    assert price["isMax"] is True


def test_extract_price_none_without_currency_context():
    assert extract_price(normalize_text("I have 5 rooms")) is None


def test_extract_bedrooms():
    assert extract_bedrooms(normalize_text("3 bedroom house")) == 3
    assert extract_bedrooms(normalize_text("a nice house")) is None


def test_resolve_intent_empty_message_returns_none():
    assert resolve_intent("") is None
    assert resolve_intent("   ") is None


def test_resolve_intent_specific_search_maps_to_search_properties():
    resolved = resolve_intent("2 bedroom apartment for rent in Erbil")
    assert resolved is not None
    assert resolved.tool_name == "search_properties"
    assert resolved.arguments["city"] == "Erbil"
    assert resolved.arguments["dealType"] == "rent"
    assert resolved.arguments["propertyType"] == "apartment"
    assert resolved.arguments["minBeds"] == 2


def test_resolve_intent_city_only_maps_to_market_summary():
    resolved = resolve_intent("Erbil")
    assert resolved is not None
    assert resolved.tool_name == "get_market_summary"
    assert resolved.arguments == {"city": "Erbil"}


def test_resolve_intent_map_keyword():
    resolved = resolve_intent("show me the map")
    assert resolved is not None
    assert resolved.tool_name == "open_on_map"


def test_resolve_intent_service_keyword():
    resolved = resolve_intent("I need an engineer")
    assert resolved is not None
    assert resolved.tool_name == "search_services"


def test_resolve_intent_greeting_has_no_tool_and_a_fallback_reply():
    resolved = resolve_intent("hello")
    assert resolved is not None
    assert resolved.tool_name is None
    assert resolved.reply_fallback


def test_resolve_intent_bye_and_thanks():
    bye = resolve_intent("goodbye")
    assert bye is not None and bye.tool_name is None and bye.reply_key == "mamai.replyBye"

    thanks = resolve_intent("thank you")
    assert thanks is not None and thanks.tool_name is None and thanks.reply_key == "mamai.replyThanks"


def test_resolve_intent_unrelated_gibberish_returns_none():
    assert resolve_intent("asdkfjhaskldfjh qwoeiruqwoeiru") is None
