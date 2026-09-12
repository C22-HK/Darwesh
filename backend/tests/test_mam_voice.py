# Tests for app.mam.voice -- the KurdishTTS Sorani voice proxy. No test
# here makes a live call to kurdishtts.com: every httpx call goes through
# an httpx.MockTransport standing in for KurdishTTS, so these tests never
# depend on network access or a real (paid, quota-limited) API key.
# Mirrors test_mam_routes.py's HTTP-contract-testing approach for the
# handler-level tests.
from __future__ import annotations

import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from app.mam.voice import (
    KurdishTTSClient,
    KurdishTTSError,
    VoiceHandler,
    VoiceRateLimiters,
)
from app.server import create_app


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.mam.voice")
    logger.addHandler(logging.NullHandler())
    return logger


def client_factory_for(handler):
    """Returns a client_factory producing an httpx.AsyncClient bound to a
    MockTransport that dispatches to `handler(request) -> httpx.Response`
    -- standing in for the real https://www.kurdishtts.com."""

    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    return factory


class AllowAllRateLimiter:
    async def allow(self, key: str) -> bool:
        return True


class DenyAllRateLimiter:
    async def allow(self, key: str) -> bool:
        return False


SPEAKER_CATALOG_BODY = {
    "speakers": [
        {"id": "en-us-1", "language": "english", "tier": "free"},
        {"id": "ckb-sorani-free-1", "dialect": "sorani", "tier": "free"},
        {"id": "ckb-sorani-pro-1", "dialect": "sorani", "tier": "pro"},
    ]
}


# ---- KurdishTTSClient ------------------------------------------------


@pytest.mark.asyncio
async def test_speech_to_text_returns_transcript_on_success():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "real-stt-key"
        assert request.url.params["dialect"] == "sorani"
        return httpx.Response(200, json={"transcript": "سڵاو"})

    client = KurdishTTSClient(
        stt_key="real-stt-key", tts_key="", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    transcript = await client.speech_to_text(b"fake-audio-bytes", "audio/webm")
    assert transcript == "سڵاو"


@pytest.mark.asyncio
async def test_speech_to_text_raises_on_upstream_error_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": "quota exceeded"})

    client = KurdishTTSClient(
        stt_key="k", tts_key="", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    with pytest.raises(KurdishTTSError):
        await client.speech_to_text(b"audio", "audio/webm")


@pytest.mark.asyncio
async def test_speech_to_text_without_key_raises_before_any_request():
    client = KurdishTTSClient(
        stt_key="",
        tts_key="",
        logger=make_test_logger(),
        client_factory=client_factory_for(lambda r: httpx.Response(200, json={"transcript": "x"})),
    )
    with pytest.raises(KurdishTTSError):
        await client.speech_to_text(b"audio", "audio/webm")


@pytest.mark.asyncio
async def test_resolve_sorani_speaker_picks_free_tier_sorani_voice():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "tts-key"
        return httpx.Response(200, json=SPEAKER_CATALOG_BODY)

    client = KurdishTTSClient(
        stt_key="", tts_key="tts-key", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    speaker_id = await client.resolve_sorani_speaker()
    assert speaker_id == "ckb-sorani-free-1"


@pytest.mark.asyncio
async def test_resolve_sorani_speaker_caches_after_first_success():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json=SPEAKER_CATALOG_BODY)

    client = KurdishTTSClient(
        stt_key="", tts_key="tts-key", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    first = await client.resolve_sorani_speaker()
    second = await client.resolve_sorani_speaker()
    assert first == second == "ckb-sorani-free-1"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_resolve_sorani_speaker_returns_none_when_catalog_lookup_fails():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    client = KurdishTTSClient(
        stt_key="", tts_key="tts-key", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    assert await client.resolve_sorani_speaker() is None


@pytest.mark.asyncio
async def test_resolve_sorani_speaker_returns_none_when_no_sorani_voice_listed():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"speakers": [{"id": "en-1", "language": "english", "tier": "free"}]})

    client = KurdishTTSClient(
        stt_key="", tts_key="tts-key", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    assert await client.resolve_sorani_speaker() is None


@pytest.mark.asyncio
async def test_resolve_sorani_speaker_uses_override_and_skips_network_entirely():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("override was set -- no catalog request should ever be made")

    client = KurdishTTSClient(
        stt_key="",
        tts_key="tts-key",
        logger=make_test_logger(),
        client_factory=client_factory_for(handler),
        sorani_speaker_id_override="confirmed-speaker-id",
    )
    assert await client.resolve_sorani_speaker() == "confirmed-speaker-id"


@pytest.mark.asyncio
async def test_resolve_sorani_speaker_falls_through_to_a_later_catalog_path():
    # The unverified-endpoint mitigation: the first candidate path 404s
    # (as it would if KurdishTTS's real catalog lives somewhere else),
    # and the SECOND candidate succeeds -- proving the fallback list
    # actually gets walked, not just the first entry.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/speakers":
            return httpx.Response(404)
        if request.url.path == "/api/tts/speakers":
            return httpx.Response(200, json=SPEAKER_CATALOG_BODY)
        raise AssertionError(f"unexpected path {request.url.path}")

    client = KurdishTTSClient(
        stt_key="", tts_key="tts-key", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    assert await client.resolve_sorani_speaker() == "ckb-sorani-free-1"


@pytest.mark.asyncio
async def test_text_to_speech_returns_audio_bytes_on_success():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/speakers":
            return httpx.Response(200, json=SPEAKER_CATALOG_BODY)
        assert request.url.path == "/api/tts-proxy"
        assert request.headers["x-api-key"] == "tts-key"
        body = json.loads(request.content)
        assert body["text"] == "بەخێربێیت"
        assert body["voice"] == "ckb-sorani-free-1"
        return httpx.Response(200, content=b"\x00fake-opus-audio", headers={"content-type": "audio/opus"})

    client = KurdishTTSClient(
        stt_key="", tts_key="tts-key", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    audio_bytes, content_type = await client.text_to_speech("بەخێربێیت")
    assert audio_bytes == b"\x00fake-opus-audio"
    assert content_type == "audio/opus"


@pytest.mark.asyncio
async def test_text_to_speech_fails_cleanly_when_no_speaker_available():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)  # catalog lookup fails -- no speaker resolvable

    client = KurdishTTSClient(
        stt_key="", tts_key="tts-key", logger=make_test_logger(), client_factory=client_factory_for(handler)
    )
    with pytest.raises(KurdishTTSError):
        await client.text_to_speech("hello")


@pytest.mark.asyncio
async def test_text_to_speech_never_leaks_key_in_raised_error_message():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/speakers":
            return httpx.Response(200, json=SPEAKER_CATALOG_BODY)
        return httpx.Response(402, json={"error": "quota exhausted"})

    client = KurdishTTSClient(
        stt_key="",
        tts_key="super-secret-tts-key",
        logger=make_test_logger(),
        client_factory=client_factory_for(handler),
    )
    with pytest.raises(KurdishTTSError) as exc_info:
        await client.text_to_speech("hello")
    assert "super-secret-tts-key" not in str(exc_info.value)


# ---- VoiceHandler (HTTP layer) ----------------------------------------


def make_client(handler: VoiceHandler) -> TestClient:
    from app.config import Config

    cfg = Config(port="8080", env="development")
    return TestClient(create_app(cfg, None, voice_handler=handler))


def test_voice_routes_not_registered_when_handler_is_none():
    from app.config import Config

    cfg = Config(port="8080", env="development")
    client = TestClient(create_app(cfg, None, voice_handler=None))
    assert client.get("/api/v1/mam/voice/config").status_code == 404
    assert client.post("/api/v1/mam/voice/stt", content=b"x").status_code == 404
    assert client.post("/api/v1/mam/voice/tts", json={"text": "hi"}).status_code == 404


def test_config_reports_capability_availability():
    kurdish_handler = KurdishTTSClient(stt_key="s", tts_key="", logger=make_test_logger())
    handler = VoiceHandler(
        client=kurdish_handler,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.get("/api/v1/mam/voice/config")
    assert resp.status_code == 200
    assert resp.json() == {"sttAvailable": True, "ttsAvailable": False}


def test_stt_returns_voice_unavailable_when_not_configured():
    kurdish_handler = KurdishTTSClient(stt_key="", tts_key="", logger=make_test_logger())
    handler = VoiceHandler(
        client=kurdish_handler,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/stt", content=b"some-audio-bytes")
    assert resp.status_code == 503
    assert resp.json()["error"] == "voice_unavailable"


def test_stt_returns_transcript_on_success():
    def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"transcript": "سڵاو، چۆنیت؟"})

    kurdish_client = KurdishTTSClient(
        stt_key="real-key", tts_key="", logger=make_test_logger(), client_factory=client_factory_for(upstream)
    )
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post(
        "/api/v1/mam/voice/stt", content=b"some-audio-bytes", headers={"content-type": "audio/webm"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"transcript": "سڵاو، چۆنیت؟"}
    # The key must never appear anywhere in what reaches the browser.
    assert "real-key" not in resp.text


def test_stt_rejects_empty_body():
    kurdish_client = KurdishTTSClient(stt_key="k", tts_key="", logger=make_test_logger())
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/stt", content=b"")
    assert resp.status_code == 400


def test_stt_rate_limited_returns_429():
    kurdish_client = KurdishTTSClient(stt_key="k", tts_key="", logger=make_test_logger())
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(DenyAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/stt", content=b"some-audio-bytes")
    assert resp.status_code == 429


def test_stt_maps_quota_exhausted_upstream_error_to_clean_voice_unavailable():
    def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "quota exhausted", "key_used": "real-key-should-never-leak"})

    kurdish_client = KurdishTTSClient(
        stt_key="real-key-should-never-leak",
        tts_key="",
        logger=make_test_logger(),
        client_factory=client_factory_for(upstream),
    )
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/stt", content=b"some-audio-bytes")
    assert resp.status_code == 503
    assert resp.json()["error"] == "voice_unavailable"
    assert "real-key-should-never-leak" not in resp.text


def test_tts_returns_voice_unavailable_when_not_configured():
    kurdish_client = KurdishTTSClient(stt_key="", tts_key="", logger=make_test_logger())
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/tts", json={"text": "سڵاو"})
    assert resp.status_code == 503


def test_tts_rejects_empty_text():
    kurdish_client = KurdishTTSClient(stt_key="", tts_key="k", logger=make_test_logger())
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/tts", json={"text": "   "})
    assert resp.status_code == 400


def test_tts_returns_audio_bytes_on_success():
    def upstream(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/speakers":
            return httpx.Response(200, json=SPEAKER_CATALOG_BODY)
        return httpx.Response(200, content=b"opus-bytes-here", headers={"content-type": "audio/opus"})

    kurdish_client = KurdishTTSClient(
        stt_key="", tts_key="real-tts-key", logger=make_test_logger(), client_factory=client_factory_for(upstream)
    )
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/tts", json={"text": "بەخێربێیت"})
    assert resp.status_code == 200
    assert resp.content == b"opus-bytes-here"
    assert resp.headers["content-type"] == "audio/opus"
    assert b"real-tts-key" not in resp.content


def test_tts_rate_limited_returns_429():
    kurdish_client = KurdishTTSClient(stt_key="", tts_key="k", logger=make_test_logger())
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), DenyAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/tts", json={"text": "hello"})
    assert resp.status_code == 429


def test_tts_upstream_failure_maps_to_clean_voice_unavailable_never_breaks_text_chat():
    def upstream(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/speakers":
            return httpx.Response(200, json=SPEAKER_CATALOG_BODY)
        return httpx.Response(500)

    kurdish_client = KurdishTTSClient(
        stt_key="", tts_key="k", logger=make_test_logger(), client_factory=client_factory_for(upstream)
    )
    handler = VoiceHandler(
        client=kurdish_client,
        rate_limiters=VoiceRateLimiters(AllowAllRateLimiter(), AllowAllRateLimiter()),
        logger=make_test_logger(),
    )
    client = make_client(handler)
    resp = client.post("/api/v1/mam/voice/tts", json={"text": "hello"})
    assert resp.status_code == 503
    assert resp.json()["error"] == "voice_unavailable"
