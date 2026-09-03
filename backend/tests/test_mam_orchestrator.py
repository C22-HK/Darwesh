from __future__ import annotations

import logging

import pytest

from app.mam.orchestrator import _MAX_TOOL_ROUNDS, Orchestrator
from app.mam.policy import PUBLIC_CALLER
from app.mam.providers.base import (
    ChatTurn,
    ModelTier,
    ProviderNotConfiguredError,
    ProviderResponse,
    ToolCallRequest,
    ToolSpec,
)
from app.mam.schemas import ChatRequest, PageContext
from app.mam.session import SessionStore
from app.mam.tools import Tools
from tests.mam_fakes import FakeFirestore


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.mam.orchestrator")
    logger.addHandler(logging.NullHandler())
    return logger


def make_request(message: str, *, session_id: str = "") -> ChatRequest:
    return ChatRequest(
        message=message, language="en", session_id=session_id, page_context=PageContext(page=None)
    )


class FakeProvider:
    def __init__(self, *, text: str | None = None, raise_not_configured: bool = False, raise_unexpected: bool = False):
        self._text = text
        self._raise_not_configured = raise_not_configured
        self._raise_unexpected = raise_unexpected
        self.calls = 0

    async def generate(
        self, *, system_instruction: str, history: list[ChatTurn], tools: list[ToolSpec], tier: ModelTier,
        max_output_tokens: int,
    ) -> ProviderResponse:
        self.calls += 1
        if self._raise_not_configured:
            raise ProviderNotConfiguredError("placeholder adapter")
        if self._raise_unexpected:
            raise RuntimeError("boom")
        return ProviderResponse(text=self._text)


class FakeScriptedProvider:
    """Returns each ProviderResponse in `responses` in order, one per
    generate() call -- lets a test script a real multi-round tool-call
    exchange (request tools -> receive results -> answer) the same way
    orchestrator.py's loop actually drives a live provider, without
    needing a real Gemini/OpenAI/Anthropic SDK."""

    def __init__(self, responses: list[ProviderResponse]):
        self._responses = responses
        self.calls = 0
        self.seen_history: list[list[ChatTurn]] = []

    async def generate(
        self, *, system_instruction: str, history: list[ChatTurn], tools: list[ToolSpec], tier: ModelTier,
        max_output_tokens: int,
    ) -> ProviderResponse:
        self.seen_history.append(list(history))
        response = self._responses[self.calls]
        self.calls += 1
        return response


def make_orchestrator(*, provider=None) -> Orchestrator:
    db = FakeFirestore()
    db.collection("listings").document("l1").set(
        {"title": "Nice villa", "city": "Erbil", "price": 300000, "dealType": "sale",
         "propertyType": "villa", "beds": 4, "private": False, "status": "active", "verified": True}
    )
    return Orchestrator(
        tools=Tools(db=db, logger=make_test_logger()),
        sessions=SessionStore(),
        provider=provider,
        logger=make_test_logger(),
    )


@pytest.mark.asyncio
async def test_deterministic_intent_produces_real_property_cards_without_calling_provider():
    provider = FakeProvider(text="should never be used")
    orch = make_orchestrator(provider=provider)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("villa for sale in Erbil"))

    assert provider.calls == 0
    assert len(response.cards) == 1
    assert response.cards[0].listing_id == "l1"
    assert response.degraded is False


@pytest.mark.asyncio
async def test_deterministic_search_properties_reports_real_filters_used_for_buy_rent_map():
    # Proves the natural-language -> real-filter translation the Buy/Rent
    # AI integration depends on: the returned mapAction.filters must be
    # built from the SAME arguments that produced the returned cards, in
    # buy-rent-map.html's own filter key vocabulary (deal/q/types/
    # maxPrice/beds) -- never a second, independently-guessed filter set.
    orch = make_orchestrator(provider=None)
    response = await orch.handle_turn(
        caller=PUBLIC_CALLER, request=make_request("villa for sale in Erbil under 3 bedrooms")
    )
    assert len(response.cards) == 1
    assert response.map_action is not None
    assert response.map_action.target == "buy-rent-map.html"
    assert response.map_action.filters.get("q") == "Erbil"
    assert response.map_action.filters.get("types") == ["villa"]
    assert "deal" not in response.map_action.filters  # sale is the default, never sent explicitly


@pytest.mark.asyncio
async def test_deterministic_search_properties_rent_and_price_map_to_real_filter_keys():
    orch = make_orchestrator(provider=None)
    response = await orch.handle_turn(
        caller=PUBLIC_CALLER, request=make_request("apartment for rent in Erbil under 5000 dollar")
    )
    assert response.map_action is not None
    assert response.map_action.filters.get("deal") == "rent"
    assert response.map_action.filters.get("maxPrice") == 5000.0


@pytest.mark.asyncio
async def test_greeting_returns_navigational_reply_with_no_data_claim():
    orch = make_orchestrator(provider=None)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("hello"))
    assert response.cards == ()
    assert response.message


@pytest.mark.asyncio
async def test_no_provider_and_no_intent_match_degrades_honestly():
    orch = make_orchestrator(provider=None)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))
    assert response.degraded is True
    assert "unavailable" in response.message.lower()


@pytest.mark.asyncio
async def test_provider_not_configured_falls_back_to_degraded_not_a_crash():
    provider = FakeProvider(raise_not_configured=True)
    orch = make_orchestrator(provider=provider)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))
    assert provider.calls == 1
    assert response.degraded is True


@pytest.mark.asyncio
async def test_provider_unexpected_exception_degrades_instead_of_propagating():
    provider = FakeProvider(raise_unexpected=True)
    orch = make_orchestrator(provider=provider)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))
    assert response.degraded is True


@pytest.mark.asyncio
async def test_configured_provider_is_used_when_no_deterministic_match():
    provider = FakeProvider(text="Here is a real, model-produced answer.")
    orch = make_orchestrator(provider=provider)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))
    assert provider.calls == 1
    assert response.message == "Here is a real, model-produced answer."
    assert response.degraded is False


@pytest.mark.asyncio
async def test_session_id_is_preserved_and_populated_on_first_turn():
    orch = make_orchestrator(provider=None)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("hello", session_id=""))
    assert response.session_id  # a fresh id was minted, not left empty

    second = await orch.handle_turn(
        caller=PUBLIC_CALLER, request=make_request("hello again", session_id=response.session_id)
    )
    assert second.session_id == response.session_id


@pytest.mark.asyncio
async def test_map_intent_produces_map_action_never_a_data_claim():
    orch = make_orchestrator(provider=None)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("open the map"))
    assert response.map_action is not None
    assert response.map_action.target == "buy-rent-map.html"


@pytest.mark.asyncio
async def test_unauthenticated_caller_gets_sign_in_message_for_authenticated_only_tool():
    orch = make_orchestrator(provider=None)
    # resolve_intent never routes to save_property directly, so drive the
    # authorization-error path through the deterministic dispatcher the
    # same way the orchestrator itself would for any AUTHENTICATED tool.
    from app.mam.intent_resolver import ResolvedIntent

    response = await orch._respond_from_intent(
        PUBLIC_CALLER, ResolvedIntent(tool_name="save_property", arguments={"listing_id": "l1"}), "en"
    )
    assert "sign in" in response.message.lower()


# ---------------------------------------------------------------------
# Provider tool-call loop -- exercises the SAME dispatch()/authorization
# path _respond_from_intent uses, but driven by a (fake) live provider's
# tool_calls instead of the deterministic resolver. These are the tests
# that prove Gemini's real function-calling round trip is wired
# correctly end to end at the orchestrator layer, independent of the
# real google-genai SDK (which test_mam_gemini_provider.py covers).
# ---------------------------------------------------------------------

@pytest.mark.asyncio
async def test_provider_tool_call_is_dispatched_and_result_fed_back():
    provider = FakeScriptedProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[ToolCallRequest(call_id="c1", tool_name="search_properties", arguments={"city": "Erbil"})],
                finish_reason="tool_calls",
            ),
            ProviderResponse(text="I found a villa in Erbil for you."),
        ]
    )
    orch = make_orchestrator(provider=provider)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))

    assert provider.calls == 2
    assert response.message == "I found a villa in Erbil for you."
    assert response.degraded is False

    # The second generate() call's history must contain the real tool
    # result (real listing "l1"), never a fabricated one -- this is what
    # proves the model's eventual answer was actually grounded in a real
    # dispatch() call rather than the model's own invention.
    second_call_history = provider.seen_history[1]
    tool_turns = [t for t in second_call_history if t.role == "tool"]
    assert len(tool_turns) == 1
    assert tool_turns[0].tool_name == "search_properties"
    assert '"l1"' in tool_turns[0].content


@pytest.mark.asyncio
async def test_provider_multiple_tool_calls_in_one_round_are_all_dispatched():
    provider = FakeScriptedProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[
                    ToolCallRequest(call_id="c1", tool_name="search_properties", arguments={"city": "Erbil"}),
                    ToolCallRequest(call_id="c2", tool_name="get_market_summary", arguments={}),
                ],
                finish_reason="tool_calls",
            ),
            ProviderResponse(text="Here's what I found."),
        ]
    )
    orch = make_orchestrator(provider=provider)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))

    assert response.message == "Here's what I found."
    second_call_history = provider.seen_history[1]
    tool_names = {t.tool_name for t in second_call_history if t.role == "tool"}
    assert tool_names == {"search_properties", "get_market_summary"}


@pytest.mark.asyncio
async def test_provider_tool_call_denied_by_authorization_feeds_back_error_not_crash():
    provider = FakeScriptedProvider(
        [
            ProviderResponse(
                text=None,
                tool_calls=[ToolCallRequest(call_id="c1", tool_name="save_property", arguments={"listing_id": "l1"})],
                finish_reason="tool_calls",
            ),
            ProviderResponse(text="You'll need to sign in to save that."),
        ]
    )
    orch = make_orchestrator(provider=provider)
    # PUBLIC_CALLER is not signed in -- save_property requires AUTHENTICATED.
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))

    assert provider.calls == 2
    assert response.degraded is False
    assert response.message == "You'll need to sign in to save that."
    second_call_history = provider.seen_history[1]
    tool_turn = next(t for t in second_call_history if t.role == "tool")
    assert "not_authorized" in tool_turn.content


@pytest.mark.asyncio
async def test_provider_exhausting_tool_rounds_degrades_honestly():
    # Every round keeps requesting a tool, never producing final text --
    # must stop after _MAX_TOOL_ROUNDS, never loop forever.
    responses = [
        ProviderResponse(
            text=None,
            tool_calls=[ToolCallRequest(call_id=f"c{i}", tool_name="search_properties", arguments={})],
            finish_reason="tool_calls",
        )
        for i in range(_MAX_TOOL_ROUNDS)
    ]
    provider = FakeScriptedProvider(responses)
    orch = make_orchestrator(provider=provider)
    response = await orch.handle_turn(caller=PUBLIC_CALLER, request=make_request("qwertyuiop asdfghjkl"))

    assert provider.calls == _MAX_TOOL_ROUNDS
    assert response.degraded is True
