# KurdishTTS Sorani voice proxy for MAM -- STT (speech to text) and TTS
# (text to speech), both server-side only. This module is the ONLY place
# either KURDISHTTS_STT_KEY or KURDISHTTS_TTS_KEY is read, sent, or
# touched; both come from app.config (env vars, never hardcoded), are
# attached to the outbound request to KurdishTTS as the `x-api-key`
# header, and are never logged, never included in a response to the
# browser, and never echoed back in an error message. The flow this
# backs, end to end: browser mic -> POST /api/v1/mam/voice/stt (this
# module) -> KurdishTTS -> transcript -> the SAME POST /api/v1/mam/chat
# every other turn already uses (app.mam.routes, app.mam.orchestrator,
# app.mam.session) -> a Sorani reply -> POST /api/v1/mam/voice/tts (this
# module) -> KurdishTTS -> audio -> browser playback. Nothing here
# creates a second MAM assistant, a second session store, or a second
# action system -- it only ever produces/consumes plain text on one side
# and opaque audio bytes on the other.
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response

from app.auth.reset import RateLimiter

KURDISHTTS_BASE_URL = "https://www.kurdishtts.com"
_TIMEOUT_SECONDS = 20.0

# Cost/abuse bounds -- independent of and in addition to the rate
# limiters below. An utterance or a reply far past these sizes is not a
# realistic voice turn; rejecting it before it reaches KurdishTTS is both
# a cost control (section 23: "keep responses reasonably concise in voice
# mode") and a defense against someone using this proxy to tunnel large
# payloads through a paid third-party API on the backend's dime.
_MAX_AUDIO_BYTES = 8 * 1024 * 1024  # ~8MB: generous for a short spoken utterance
_MAX_TTS_TEXT_LENGTH = 800

_BAD_AUDIO = JSONResponse({"error": "Please provide a short audio recording."}, status_code=400)
_BAD_TEXT = JSONResponse({"error": "Please provide text to speak."}, status_code=400)
_RATE_LIMITED = JSONResponse({"error": "Too many requests. Please wait a moment and try again."}, status_code=429)
# Deliberately generic on every failure path (upstream error, quota
# exhausted, network hiccup, catalog lookup failure) -- see module
# docstring: never logs/leaks the key, and never distinguishes "quota
# exceeded" from "KurdishTTS is down" to the browser, since neither is
# actionable by the visitor and both must degrade the same honest way
# (section: "never fake a successful voice state").
_VOICE_UNAVAILABLE = JSONResponse(
    {"error": "voice_unavailable", "message": "Voice is temporarily unavailable. You can keep chatting by text."},
    status_code=503,
)


class KurdishTTSError(Exception):
    """Raised for any upstream KurdishTTS failure. The message is safe to
    log -- it never contains the API key or a raw upstream response body
    (which could itself echo request details)."""


def _default_client_factory() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=_TIMEOUT_SECONDS)


@dataclass
class KurdishTTSClient:
    """Thin async wrapper around the KurdishTTS proxy endpoints. Opens a
    fresh httpx.AsyncClient per outbound call via client_factory (same
    short-lived-client pattern as app.auth.resend_email.ResendEmailSender)
    rather than holding one for the life of the process -- this app has
    no shutdown hook to close a long-lived client cleanly. Tests override
    client_factory to return a client bound to an httpx.MockTransport, so
    no test in this repo makes a live call to a third-party paid API."""

    stt_key: str
    tts_key: str
    logger: logging.Logger
    client_factory: Callable[[], httpx.AsyncClient] = field(default=_default_client_factory)
    _cached_sorani_speaker_id: str | None = field(default=None, init=False, repr=False)
    _speaker_lookup_attempted: bool = field(default=False, init=False, repr=False)

    async def speech_to_text(self, audio_bytes: bytes, content_type: str, *, dialect: str = "sorani") -> str:
        if not self.stt_key:
            raise KurdishTTSError("STT not configured")
        try:
            async with self.client_factory() as http:
                response = await http.post(
                    f"{KURDISHTTS_BASE_URL}/api/stt-proxy",
                    headers={"x-api-key": self.stt_key, "Content-Type": content_type or "application/octet-stream"},
                    params={"dialect": dialect},
                    content=audio_bytes,
                )
        except httpx.HTTPError as exc:
            raise KurdishTTSError(f"stt request failed: {exc}") from exc
        if response.status_code >= 300:
            raise KurdishTTSError(f"stt upstream returned status {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise KurdishTTSError("stt upstream returned a non-JSON response") from exc
        transcript = body.get("transcript") if isinstance(body, dict) else None
        if not isinstance(transcript, str):
            raise KurdishTTSError("stt upstream response had no transcript field")
        return transcript

    async def resolve_sorani_speaker(self) -> str | None:
        """Looks up a free-tier Sorani speaker from KurdishTTS's own
        public catalog rather than a hardcoded/invented voice id (per the
        explicit "query the public speaker catalog" instruction). Cached
        for the life of this client -- the catalog does not need to be
        re-fetched on every TTS call. A failed/unrecognized lookup
        resolves to None, never a guess: text_to_speech() then reports
        voice_unavailable rather than sending a made-up speaker id
        upstream."""
        if self._cached_sorani_speaker_id is not None:
            return self._cached_sorani_speaker_id
        if self._speaker_lookup_attempted:
            return None
        self._speaker_lookup_attempted = True
        if not self.tts_key:
            return None
        try:
            async with self.client_factory() as http:
                response = await http.get(f"{KURDISHTTS_BASE_URL}/api/speakers", headers={"x-api-key": self.tts_key})
            if response.status_code >= 300:
                raise KurdishTTSError(f"speaker catalog returned status {response.status_code}")
            body = response.json()
        except (httpx.HTTPError, ValueError, KurdishTTSError) as exc:
            self.logger.warning("kurdishtts: speaker catalog lookup failed", extra={"error": str(exc)})
            return None
        speakers = body if isinstance(body, list) else body.get("speakers") if isinstance(body, dict) else None
        if not isinstance(speakers, list):
            return None
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            locale = str(speaker.get("dialect") or speaker.get("language") or speaker.get("locale") or "").lower()
            tier = str(speaker.get("tier") or speaker.get("plan") or "").lower()
            is_free = speaker.get("free") is True or tier in ("", "free")
            if ("sorani" in locale or "ckb" in locale) and is_free:
                speaker_id = speaker.get("id") or speaker.get("voiceId") or speaker.get("speakerId")
                if isinstance(speaker_id, str) and speaker_id:
                    self._cached_sorani_speaker_id = speaker_id
                    return speaker_id
        self.logger.warning("kurdishtts: no free-tier Sorani speaker found in catalog")
        return None

    async def text_to_speech(self, text: str, *, fmt: str = "opus") -> tuple[bytes, str]:
        if not self.tts_key:
            raise KurdishTTSError("TTS not configured")
        speaker_id = await self.resolve_sorani_speaker()
        if not speaker_id:
            raise KurdishTTSError("no Sorani speaker available")
        try:
            async with self.client_factory() as http:
                response = await http.post(
                    f"{KURDISHTTS_BASE_URL}/api/tts-proxy",
                    headers={"x-api-key": self.tts_key},
                    json={"text": text, "voice": speaker_id, "dialect": "sorani", "format": fmt},
                )
        except httpx.HTTPError as exc:
            raise KurdishTTSError(f"tts request failed: {exc}") from exc
        if response.status_code >= 300:
            raise KurdishTTSError(f"tts upstream returned status {response.status_code}")
        content_type = response.headers.get("content-type", "")
        if content_type.startswith("audio/"):
            return response.content, content_type
        # Some proxies return JSON with a base64 payload or a short-lived
        # URL instead of raw audio bytes -- handled without guessing
        # which shape a given deployment uses.
        try:
            body = response.json()
        except ValueError as exc:
            raise KurdishTTSError("tts upstream returned an unrecognized response") from exc
        audio_url = body.get("audioUrl") or body.get("url") if isinstance(body, dict) else None
        if isinstance(audio_url, str) and audio_url:
            try:
                async with self.client_factory() as http:
                    audio_response = await http.get(audio_url)
            except httpx.HTTPError as exc:
                raise KurdishTTSError(f"tts audio fetch failed: {exc}") from exc
            if audio_response.status_code >= 300:
                raise KurdishTTSError(f"tts audio fetch returned status {audio_response.status_code}")
            return audio_response.content, audio_response.headers.get("content-type", "audio/ogg")
        raise KurdishTTSError("tts upstream response had no audio")


@dataclass
class VoiceRateLimiters:
    stt_ip_limiter: RateLimiter
    tts_ip_limiter: RateLimiter

    async def allow_stt(self, client_ip: str) -> bool:
        return await self.stt_ip_limiter.allow(client_ip)

    async def allow_tts(self, client_ip: str) -> bool:
        return await self.tts_ip_limiter.allow(client_ip)


def build_voice_rate_limiters(*, db, is_production: bool) -> VoiceRateLimiters:
    """Tighter than MAM chat's own limits (app.mam.rate_limit) on purpose
    -- each request here calls a metered, paid third-party API, unlike a
    plain chat turn. 15 requests / 5 minutes per IP for each of STT and
    TTS: enough for a real back-and-forth voice conversation, tight
    enough that a scripted loop can't run up a free-tier quota quickly."""
    from app.auth.reset import FirestoreRateLimiter, InMemoryRateLimiter

    if is_production:
        return VoiceRateLimiters(
            stt_ip_limiter=FirestoreRateLimiter(db, name="mam_voice_stt_ip", limit=15, window_seconds=5 * 60),
            tts_ip_limiter=FirestoreRateLimiter(db, name="mam_voice_tts_ip", limit=15, window_seconds=5 * 60),
        )
    return VoiceRateLimiters(
        stt_ip_limiter=InMemoryRateLimiter(limit=15, window_seconds=5 * 60),
        tts_ip_limiter=InMemoryRateLimiter(limit=15, window_seconds=5 * 60),
    )


@dataclass
class VoiceHandler:
    """HTTP layer for the three voice routes. Each of stt_available/
    tts_available reflects whether ITS OWN key was configured -- the two
    capabilities are independent (see app.main.build_voice_handler), so a
    deployment can enable Sorani TTS without STT or vice versa. Every
    response this handler ever produces is one of: a transcript string, a
    generic voice_unavailable error, a 429, a 400 -- never the client, the
    key, or a raw upstream body."""

    client: KurdishTTSClient
    rate_limiters: VoiceRateLimiters
    logger: logging.Logger

    @property
    def stt_available(self) -> bool:
        return bool(self.client.stt_key)

    @property
    def tts_available(self) -> bool:
        return bool(self.client.tts_key)

    async def config(self, request: Request) -> JSONResponse:
        return JSONResponse({"sttAvailable": self.stt_available, "ttsAvailable": self.tts_available})

    async def stt(self, request: Request) -> JSONResponse:
        if not self.stt_available:
            return _VOICE_UNAVAILABLE
        client_ip = request.client.host if request.client else "unknown"
        if not await self.rate_limiters.allow_stt(client_ip):
            return _RATE_LIMITED

        audio_bytes = await request.body()
        if not audio_bytes or len(audio_bytes) > _MAX_AUDIO_BYTES:
            return _BAD_AUDIO
        content_type = request.headers.get("content-type", "audio/webm")

        try:
            transcript = await self.client.speech_to_text(audio_bytes, content_type, dialect="sorani")
        except KurdishTTSError as exc:
            self.logger.warning("mam voice: stt failed", extra={"error": str(exc)})
            return _VOICE_UNAVAILABLE

        return JSONResponse({"transcript": transcript})

    async def tts(self, request: Request) -> Response:
        if not self.tts_available:
            return _VOICE_UNAVAILABLE
        client_ip = request.client.host if request.client else "unknown"
        if not await self.rate_limiters.allow_tts(client_ip):
            return _RATE_LIMITED

        body = await _parse_json_body(request)
        text = body.get("text") if isinstance(body, dict) else None
        if not isinstance(text, str) or not text.strip():
            return _BAD_TEXT
        text = text.strip()[:_MAX_TTS_TEXT_LENGTH]

        try:
            audio_bytes, content_type = await self.client.text_to_speech(text, fmt="opus")
        except KurdishTTSError as exc:
            self.logger.warning("mam voice: tts failed", extra={"error": str(exc)})
            return _VOICE_UNAVAILABLE

        return Response(content=audio_bytes, media_type=content_type or "audio/ogg")


async def _parse_json_body(request: Request) -> dict[str, Any] | None:
    import json

    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        return body if isinstance(body, dict) else None
    except json.JSONDecodeError:
        return None
