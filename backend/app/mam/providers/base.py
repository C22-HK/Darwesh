# The ONE seam between MAM's business logic and any specific AI vendor.
#
# Nothing outside this file and the individual provider adapters
# (gemini.py, openai.py, anthropic.py) may import a provider SDK, know a
# provider's request/response shape, or branch on which provider is
# active. app.mam.orchestrator, app.mam.tools, app.mam.policy,
# app.mam.session, and app.mam.routes all talk only to the ChatProvider
# Protocol below -- exactly the same "Protocol + fake for tests, real
# adapter for production" shape this backend already uses everywhere else
# (ResetLinkGenerator, EmailSender, RateLimiter, IdTokenVerifier). Swapping
# Gemini for OpenAI or Anthropic in production is changing which adapter
# app.main constructs, never touching orchestrator.py/tools.py/policy.py.
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol


class ModelTier(str, Enum):
    """A capability tier, not a model name. The orchestrator picks a tier
    (FAST for navigation/simple lookups/tool orchestration, REASONING only
    where it provides a measurable benefit -- per the explicit model-
    routing requirement); each provider adapter maps that tier to its own
    concrete model id. Nothing outside a provider adapter ever sees a raw
    model string."""

    FAST = "fast"
    REASONING = "reasoning"


@dataclass(frozen=True)
class ToolSpec:
    """A single tool's declaration, in a provider-neutral shape (plain
    JSON Schema for parameters -- every major provider's function-calling
    API accepts this same shape, just wrapped differently on the wire).
    Built once from app.mam.tools.TOOL_REGISTRY, translated to each
    provider's own wire format inside that provider's adapter only."""

    name: str
    description: str
    parameters_schema: dict[str, Any]


@dataclass(frozen=True)
class ChatTurn:
    """One message in the conversation, in the minimal shape every
    provider's chat API can represent. role is "user" | "assistant" |
    "tool". A tool-role turn carries tool_name/tool_call_id/content (the
    tool's own structured output, already authorized and fetched by
    app.mam.tools -- never anything the model wrote itself)."""

    role: str
    content: str
    tool_name: str | None = None
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ToolCallRequest:
    """The model asking to invoke one tool. call_id is provider-assigned
    and must be echoed back on the matching ChatTurn(role="tool",
    tool_call_id=...) so multi-tool-call turns stay correctly paired."""

    call_id: str
    tool_name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ProviderResponse:
    """What the orchestrator gets back from a single model turn. Exactly
    one of `tool_calls` (non-empty) or `text` (the model's final answer)
    is meaningful per turn -- a model turn either asks for tools or
    answers, never silently both in a way this shape would need to
    represent as anything more complex."""

    text: str | None
    tool_calls: list[ToolCallRequest] = field(default_factory=list)
    finish_reason: str = "stop"  # "stop" | "tool_calls" | "length" | "error"


class ProviderNotConfiguredError(Exception):
    """Raised by a provider adapter's generate() when it has no live
    credential/SDK wired -- see each adapter's own module docstring for
    why this phase deliberately ships them in this state. The orchestrator
    catches this ONE exception type (never a provider-specific one) and
    falls back to app.mam.intent_resolver's deterministic path, per the
    explicit Fallback Mode requirement."""


class ChatProvider(Protocol):
    """The complete surface area any AI vendor adapter must implement.
    Deliberately small: one method, plain dataclasses in and out, no
    streaming-specific type leaking through (an adapter that supports
    streaming exposes it via `stream_generate` as an additional method
    tried first by the orchestrator with generate() as the fallback --
    optional, not part of this minimal contract, so a placeholder adapter
    with no streaming support is still a fully valid ChatProvider)."""

    async def generate(
        self,
        *,
        system_instruction: str,
        history: list[ChatTurn],
        tools: list[ToolSpec],
        tier: ModelTier,
        max_output_tokens: int,
    ) -> ProviderResponse: ...
