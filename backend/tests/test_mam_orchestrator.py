from __future__ import annotations

import logging

import pytest

from app.mam.orchestrator import Orchestrator
from app.mam.policy import PUBLIC_CALLER
from app.mam.providers.base import ChatTurn, ModelTier, ProviderNotConfiguredError, ProviderResponse, ToolSpec
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
