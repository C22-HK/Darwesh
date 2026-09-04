# HTTP-contract tests for app.mam.routes, via FastAPI's TestClient and
# fakes for AuthGate/Orchestrator/rate limiting -- mirrors
# test_access_handlers.py's approach. The real tool/orchestrator behavior
# is already proven against a fake Firestore in test_mam_tools.py and
# test_mam_orchestrator.py; this file only proves the HTTP-layer contract:
# public-by-default auth, rate limiting, request validation, response
# serialization shape, and that an unexpected exception never leaks.
from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app.access.caller_context import CallerContext
from app.mam.policy import PUBLIC_CALLER, MamCaller
from app.mam.rate_limit import MamRateLimiters
from app.mam.routes import MamHandler
from app.mam.schemas import ChatResponse, MapAction, PropertyCard, SuggestedAction
from app.server import create_app


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.mam.routes")
    logger.addHandler(logging.NullHandler())
    return logger


class FakeAuthGate:
    def __init__(self, caller: CallerContext | None = None, *, raises: bool = False):
        self.caller = caller
        self.raises = raises

    async def authenticate(self, request):
        if self.raises:
            raise RuntimeError("token verification blew up")
        return self.caller


class AllowAllLimiter:
    async def allow(self, key: str) -> bool:  # unused directly -- see FakeRateLimiters
        return True


class FakeRateLimiters:
    def __init__(self, *, allow: bool = True):
        self._allow = allow
        self.calls: list[tuple[str, str | None]] = []

    async def allow(self, *, client_ip: str, uid: str | None) -> bool:
        self.calls.append((client_ip, uid))
        return self._allow


class FakeOrchestrator:
    def __init__(self, *, response: ChatResponse | None = None, raises: bool = False):
        self._response = response or ChatResponse(message="hi", language="en", session_id="s1")
        self.raises = raises
        self.calls: list[tuple] = []

    async def handle_turn(self, *, caller: MamCaller, request):
        self.calls.append((caller, request))
        if self.raises:
            raise RuntimeError("orchestrator blew up")
        return self._response


def make_client(handler: MamHandler) -> TestClient:
    from app.config import Config

    cfg = Config(port="8080", env="development")
    return TestClient(create_app(cfg, None, mam_handler=handler))


def test_chat_route_not_registered_when_handler_is_none():
    from app.config import Config

    cfg = Config(port="8080", env="development")
    client = TestClient(create_app(cfg, None, mam_handler=None))
    resp = client.post("/api/v1/mam/chat", json={"message": "hi"})
    assert resp.status_code == 404


def test_missing_auth_header_proceeds_as_public_caller():
    orchestrator = FakeOrchestrator()
    handler = MamHandler(
        orchestrator=orchestrator,
        auth=FakeAuthGate(None),
        rate_limiters=FakeRateLimiters(),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", json={"message": "hi"})
    assert resp.status_code == 200
    caller, _ = orchestrator.calls[0]
    assert caller == PUBLIC_CALLER


def test_auth_layer_failure_degrades_to_public_caller_not_a_500():
    orchestrator = FakeOrchestrator()
    handler = MamHandler(
        orchestrator=orchestrator,
        auth=FakeAuthGate(None, raises=True),
        rate_limiters=FakeRateLimiters(),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", json={"message": "hi"})
    assert resp.status_code == 200
    caller, _ = orchestrator.calls[0]
    assert caller == PUBLIC_CALLER


def test_valid_token_produces_a_real_mam_caller():
    orchestrator = FakeOrchestrator()
    caller_ctx = CallerContext(uid="u1", email="a@b.com", role="customer", is_admin=False)
    handler = MamHandler(
        orchestrator=orchestrator,
        auth=FakeAuthGate(caller_ctx),
        rate_limiters=FakeRateLimiters(),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", json={"message": "hi"}, headers={"Authorization": "Bearer faketoken"})
    assert resp.status_code == 200
    caller, _ = orchestrator.calls[0]
    assert caller.uid == "u1"
    assert caller.role == "customer"


def test_rate_limited_returns_429_without_calling_orchestrator():
    orchestrator = FakeOrchestrator()
    handler = MamHandler(
        orchestrator=orchestrator,
        auth=FakeAuthGate(None),
        rate_limiters=FakeRateLimiters(allow=False),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", json={"message": "hi"})
    assert resp.status_code == 429
    assert orchestrator.calls == []


def test_missing_message_returns_400():
    handler = MamHandler(
        orchestrator=FakeOrchestrator(),
        auth=FakeAuthGate(None),
        rate_limiters=FakeRateLimiters(),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", json={})
    assert resp.status_code == 400


def test_malformed_json_body_returns_400():
    handler = MamHandler(
        orchestrator=FakeOrchestrator(),
        auth=FakeAuthGate(None),
        rate_limiters=FakeRateLimiters(),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", content=b"{not json", headers={"Content-Type": "application/json"})
    assert resp.status_code == 400


def test_unexpected_orchestrator_exception_returns_generic_500():
    handler = MamHandler(
        orchestrator=FakeOrchestrator(raises=True),
        auth=FakeAuthGate(None),
        rate_limiters=FakeRateLimiters(),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", json={"message": "hi"})
    assert resp.status_code == 500
    assert "boom" not in resp.text  # never leak the raw exception message
    assert "blew up" not in resp.text


def test_response_serialization_shape():
    response = ChatResponse(
        message="Found 1 result:",
        language="en",
        cards=(
            PropertyCard(
                listing_id="l1",
                title="Nice villa",
                city="Erbil",
                price=300000,
                deal_type="sale",
                property_type="villa",
                beds=4,
                verified=True,
                image_url="https://example.com/x.jpg",
            ),
        ),
        map_action=MapAction(target="map.html", filters={"q": "Erbil"}, focus_listing_id="l1"),
        suggested_actions=(
            SuggestedAction(label_key="k", label_fallback="Open map", action="open_map", payload={}),
        ),
        session_id="s1",
    )
    handler = MamHandler(
        orchestrator=FakeOrchestrator(response=response),
        auth=FakeAuthGate(None),
        rate_limiters=FakeRateLimiters(),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/chat", json={"message": "villa in Erbil"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"] == "Found 1 result:"
    assert body["sessionId"] == "s1"
    assert body["cards"][0]["listingId"] == "l1"
    assert body["cards"][0]["imageUrl"] == "https://example.com/x.jpg"
    assert body["mapAction"]["focusListingId"] == "l1"
    assert body["suggestedActions"][0]["labelFallback"] == "Open map"
    assert body["degraded"] is False


def test_rate_limiter_is_keyed_by_client_ip_and_uid():
    orchestrator = FakeOrchestrator()
    limiters = FakeRateLimiters()
    caller_ctx = CallerContext(uid="u1", email=None, role=None, is_admin=False)
    handler = MamHandler(
        orchestrator=orchestrator, auth=FakeAuthGate(caller_ctx), rate_limiters=limiters, logger=make_test_logger()
    )
    client = make_client(handler)
    client.post("/api/v1/mam/chat", json={"message": "hi"}, headers={"Authorization": "Bearer x"})
    assert limiters.calls[0][1] == "u1"
