# OpenAI adapter -- evaluation-only, same "validated placeholder, no live
# call" state as gemini.py and anthropic.py. See gemini.py's module
# docstring for the shared reasoning; the one difference here is that
# OpenAI has no Application-Default-Credentials path -- activating this
# adapter always means a real API key, sourced from Google Secret Manager
# (config.py's openai_api_key, populated from the OPENAI_API_KEY env var
# Cloud Run injects from a Secret Manager secret), never hardcoded or
# logged. That key is never exposed to a browser -- this adapter only
# ever runs inside this backend process.
from __future__ import annotations

from app.mam.providers.base import (
    ChatTurn,
    ModelTier,
    ProviderNotConfiguredError,
    ProviderResponse,
    ToolSpec,
)


class OpenAIProvider:
    """Structurally implements app.mam.providers.base.ChatProvider."""

    def __init__(self, *, api_key: str, model_flash: str = "gpt-5-nano", model_reasoning: str = "gpt-5") -> None:
        if not api_key:
            raise ValueError("OpenAIProvider requires an api_key -- see config.py's openai_api_key.")
        self._api_key = api_key
        self._model_flash = model_flash
        self._model_reasoning = model_reasoning

    def _model_for(self, tier: ModelTier) -> str:
        return self._model_reasoning if tier is ModelTier.REASONING else self._model_flash

    async def generate(
        self,
        *,
        system_instruction: str,
        history: list[ChatTurn],
        tools: list[ToolSpec],
        tier: ModelTier,
        max_output_tokens: int,
    ) -> ProviderResponse:
        raise ProviderNotConfiguredError(
            f"OpenAI adapter is a validated placeholder only (model would be "
            f"{self._model_for(tier)!r}) -- no live openai SDK call is wired yet, pending the "
            f"Sorani benchmark result. See docs/MAM_V2_ARCHITECTURE.md."
        )
