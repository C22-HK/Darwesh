from __future__ import annotations

from app.mam.schemas import (
    MAX_MESSAGE_LENGTH,
    MAX_SELECTED_IDS,
    ChatRequest,
    ChatRequestError,
    parse_chat_request,
)


def test_missing_message_is_rejected():
    result = parse_chat_request({}, session_id_from_client=None)
    assert isinstance(result, ChatRequestError)


def test_blank_message_is_rejected():
    result = parse_chat_request({"message": "   "}, session_id_from_client=None)
    assert isinstance(result, ChatRequestError)


def test_oversized_message_is_rejected():
    result = parse_chat_request({"message": "x" * (MAX_MESSAGE_LENGTH + 1)}, session_id_from_client=None)
    assert isinstance(result, ChatRequestError)


def test_valid_message_parses_and_trims():
    result = parse_chat_request({"message": "  hello  "}, session_id_from_client=None)
    assert isinstance(result, ChatRequest)
    assert result.message == "hello"


def test_unknown_language_defaults_to_english():
    result = parse_chat_request({"message": "hi", "language": "fr"}, session_id_from_client=None)
    assert isinstance(result, ChatRequest)
    assert result.language == "en"


def test_known_language_is_kept():
    result = parse_chat_request({"message": "سڵاو", "language": "ku"}, session_id_from_client=None)
    assert isinstance(result, ChatRequest)
    assert result.language == "ku"


def test_session_id_from_client_is_used_when_present():
    result = parse_chat_request({"message": "hi"}, session_id_from_client="abc123")
    assert isinstance(result, ChatRequest)
    assert result.session_id == "abc123"


def test_session_id_defaults_to_empty_string():
    result = parse_chat_request({"message": "hi"}, session_id_from_client=None)
    assert isinstance(result, ChatRequest)
    assert result.session_id == ""


def test_page_context_unrecognized_page_is_dropped():
    result = parse_chat_request(
        {"message": "hi", "pageContext": {"page": "not-a-real-page"}}, session_id_from_client=None
    )
    assert isinstance(result, ChatRequest)
    assert result.page_context.page is None


def test_page_context_known_page_and_ids_are_kept():
    result = parse_chat_request(
        {
            "message": "hi",
            "pageContext": {"page": "property", "listingId": "L1", "selectedIds": ["a", "b"]},
        },
        session_id_from_client=None,
    )
    assert isinstance(result, ChatRequest)
    assert result.page_context.page == "property"
    assert result.page_context.listing_id == "L1"
    assert result.page_context.selected_ids == ("a", "b")


def test_page_context_selected_ids_capped_and_type_filtered():
    raw_ids = [f"id-{i}" for i in range(MAX_SELECTED_IDS + 5)] + [123, None, ""]
    result = parse_chat_request(
        {"message": "hi", "pageContext": {"page": "buy", "selectedIds": raw_ids}}, session_id_from_client=None
    )
    assert isinstance(result, ChatRequest)
    assert len(result.page_context.selected_ids) <= MAX_SELECTED_IDS
    assert all(isinstance(i, str) for i in result.page_context.selected_ids)


def test_page_context_missing_is_empty_but_valid():
    result = parse_chat_request({"message": "hi"}, session_id_from_client=None)
    assert isinstance(result, ChatRequest)
    assert result.page_context.page is None
    assert result.page_context.selected_ids == ()
