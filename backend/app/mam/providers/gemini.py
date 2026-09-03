# Vertex AI / Gemini adapter -- REAL implementation.
#
# Authenticates via Application Default Credentials only: the Cloud Run
# runtime service account (verified production identity:
# darwesh-backend-run@darwesh-group.iam.gserviceaccount.com, granted
# roles/aiplatform.user on the darwesh-group project). No API key, no
# Google AI Studio key, no service-account JSON key, nothing this
# process could leak to a browser -- `genai.Client(vertexai=True,
# project=..., location=...)` below never receives a `credentials` or
# `api_key` argument, so the google-genai SDK falls back to
# `google.auth.default()`, which on Cloud Run resolves to the attached
# runtime service account automatically. Locally (no ADC configured),
# that resolution fails at first real call, not at import time -- see
# generate()'s error handling.
#
# Model IDs and location (verified against current Vertex AI
# documentation, not inferred from stale docs -- see
# docs/MAM_V2_ARCHITECTURE.md's provider section for the sourcing):
#   - FAST tier: gemini-3.7-flash (GA, released 2026-08-13; supports the
#     global endpoint, which is Google's recommended production config
#     for it -- no regional data-residency commitment either way for
#     this model, so global carries no functional downside here).
#   - REASONING tier: gemini-3.1-pro-preview (Google's current most
#     capable reasoning model; PREVIEW status, not GA -- this is stated
#     honestly, not claimed as GA. It is available on the global
#     endpoint ONLY, which is the deciding reason GEMINI_LOCATION should
#     be "global" for both tiers rather than "me-central1" -- Cloud Run
#     staying in me-central1 while Vertex AI calls route to the global
#     endpoint is a normal, supported cross-region pattern, not a
#     misconfiguration.
#   - These are RECOMMENDED values for GEMINI_MODEL_FLASH/
#     GEMINI_MODEL_PRO/GEMINI_LOCATION -- this file does not hardcode
#     them; they are supplied via Config (env vars) exactly as before,
#     because a model catalog changes over time and must never require a
#     code change to update (gemini-2.5-* retires 2026-10-20; whichever
#     model is current at deploy time is an operational decision, not a
#     source change).
#
# Gemini's role in this architecture (see docs/MAM_V2_ARCHITECTURE.md):
# it understands natural language, reasons about the request, and may
# ask to call one of the Darwesh tools declared in `tools` -- it never
# receives write access, never decides authorization, and never
# produces a property price/availability/verification/Estate
# ID/history/professional-credential claim on its own; every such fact
# still comes only from a real app.mam.tools.dispatch() call, gated by
# app.mam.policy exactly as for the deterministic path. This file has
# no knowledge of `caller`/authorization at all -- it only ever sees
# already-authorized ChatTurn(role="tool", ...) results the orchestrator
# fed back to it (see orchestrator.py's tool-call loop), the same
# untrusted-data boundary every tool result already crosses via
# policy.wrap_untrusted() before it ever reaches this adapter.
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from google.genai import Client
from google.genai.errors import APIError
from google.genai.types import (
    AutomaticFunctionCallingConfig,
    Content,
    FunctionDeclaration,
    GenerateContentConfig,
    Part,
    Tool,
)

from app.mam.providers.base import ChatTurn, ModelTier, ProviderResponse, ToolCallRequest, ToolSpec

logger = logging.getLogger("darwesh.mam.providers.gemini")

# Bounded so a hung/slow Vertex AI call can never leave a chat request
# pending indefinitely -- matches the frontend's own 20s request budget
# (js/mam-api.js REQUEST_TIMEOUT_MS) so a timeout here and a timeout
# there mean the same thing to a visitor. This wraps a SINGLE API call;
# it is not a retry budget -- generate() never retries on its own
# (see module docstring: "no infinite retry, no duplicate provider
# calls" -- a failure here propagates once, orchestrator.py degrades).
_REQUEST_TIMEOUT_SECONDS = 20.0


class GeminiProvider:
    """Structurally implements app.mam.providers.base.ChatProvider --
    same duck-typed Protocol-conformance convention as every other
    pluggable dependency in this backend (FirebaseIdTokenVerifier,
    ResendEmailSender, etc. never inherit from their Protocol either)."""

    def __init__(self, *, project_id: str, location: str, model_flash: str, model_pro: str) -> None:
        if not project_id or not location or not model_flash or not model_pro:
            raise ValueError(
                "GeminiProvider requires project_id, location, model_flash, and model_pro -- "
                "see config.py's gemini_* fields. This constructor is intentionally strict: a "
                "half-configured Gemini adapter must fail at startup, not at the first real chat request."
            )
        self._project_id = project_id
        self._location = location
        self._model_flash = model_flash
        self._model_pro = model_pro
        # Constructed once per adapter instance (app.main builds exactly
        # one), reused for every request -- the SDK client is safe to
        # share across concurrent async calls. No `api_key`/`credentials`
        # argument: this is the ADC-only path the module docstring
        # describes, deliberately never given a way to authenticate any
        # other way.
        self._client = Client(vertexai=True, project=project_id, location=location)

    def _model_for(self, tier: ModelTier) -> str:
        return self._model_pro if tier is ModelTier.REASONING else self._model_flash

    async def generate(
        self,
        *,
        system_instruction: str,
        history: list[ChatTurn],
        tools: list[ToolSpec],
        tier: ModelTier,
        max_output_tokens: int,
    ) -> ProviderResponse:
        model = self._model_for(tier)
        contents = _history_to_contents(history)
        config = GenerateContentConfig(
            system_instruction=system_instruction,
            max_output_tokens=max_output_tokens,
            tools=[_tool_spec_to_gemini_tool(tools)] if tools else None,
            # We dispatch tool calls ourselves (through the authorized,
            # policy-checked app.mam.tools.dispatch() path in
            # orchestrator.py) -- the SDK must never auto-invoke anything
            # on our behalf, even though the FunctionDeclaration-based
            # tools passed here wouldn't trigger that path anyway.
            automatic_function_calling=AutomaticFunctionCallingConfig(disable=True),
        )

        try:
            response = await asyncio.wait_for(
                self._client.aio.models.generate_content(model=model, contents=contents, config=config),
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            raise TimeoutError(f"Gemini ({model}) did not respond within {_REQUEST_TIMEOUT_SECONDS}s") from exc
        except APIError as exc:
            # Never forward the SDK's own exception text (may include
            # request internals) past this log line -- orchestrator.py's
            # handle_turn already logs the exception and returns a fixed,
            # safe degraded message; it never includes str(exc) in what
            # reaches the browser. Re-raising a plain RuntimeError here
            # keeps that guarantee even if this method's caller changes.
            logger.error("mam: gemini API error", extra={"model": model, "status": getattr(exc, "code", None)})
            raise RuntimeError("Gemini API call failed") from exc

        return _parse_response(response)


def _history_to_contents(history: list[ChatTurn]) -> list[Content]:
    contents: list[Content] = []
    for turn in history:
        if turn.role == "user":
            contents.append(Content(role="user", parts=[Part.from_text(text=turn.content)]))
        elif turn.role == "assistant":
            if turn.tool_calls:
                contents.append(
                    Content(
                        role="model",
                        parts=[
                            Part.from_function_call(name=tc.tool_name, args=tc.arguments)
                            for tc in turn.tool_calls
                        ],
                    )
                )
            else:
                contents.append(Content(role="model", parts=[Part.from_text(text=turn.content)]))
        elif turn.role == "tool":
            contents.append(
                Content(
                    role="tool",
                    parts=[Part.from_function_response(name=turn.tool_name or "", response=_decode_tool_content(turn.content))],
                )
            )
        # An unrecognized role is silently skipped rather than raising --
        # this module is never the place that invents a validation error
        # for a value only this codebase's own orchestrator ever
        # produces; a new role added there without a matching case here
        # would surface as a missing turn in the model's context, easy to
        # notice in the Sorani benchmark's own output, not a crash.
    return contents


def _decode_tool_content(content: str) -> dict[str, Any]:
    try:
        decoded = json.loads(content) if content else {}
    except (ValueError, TypeError):
        decoded = {"result": content}
    return decoded if isinstance(decoded, dict) else {"result": decoded}


def _tool_spec_to_gemini_tool(tools: list[ToolSpec]) -> Tool:
    return Tool(
        function_declarations=[
            FunctionDeclaration(name=t.name, description=t.description, parameters_json_schema=t.parameters_schema)
            for t in tools
        ]
    )


def _parse_response(response: Any) -> ProviderResponse:
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    content = getattr(candidates[0], "content", None)
    parts = getattr(content, "parts", None) or []
    finish_reason_raw = getattr(candidates[0], "finish_reason", None)
    finish_reason = str(finish_reason_raw.value if hasattr(finish_reason_raw, "value") else finish_reason_raw or "stop").lower()

    tool_calls: list[ToolCallRequest] = []
    text_parts: list[str] = []
    for part in parts:
        function_call = getattr(part, "function_call", None)
        if function_call is not None and getattr(function_call, "name", None):
            tool_calls.append(
                ToolCallRequest(
                    call_id=getattr(function_call, "id", None) or f"{function_call.name}-{len(tool_calls)}",
                    tool_name=function_call.name,
                    arguments=dict(getattr(function_call, "args", None) or {}),
                )
            )
        elif getattr(part, "text", None):
            text_parts.append(part.text)

    if not tool_calls and not text_parts:
        raise RuntimeError("Gemini returned an empty response (no text, no tool call)")

    return ProviderResponse(
        text="\n".join(text_parts) if text_parts else None,
        tool_calls=tool_calls,
        finish_reason="tool_calls" if tool_calls else ("length" if finish_reason == "max_tokens" else "stop"),
    )
