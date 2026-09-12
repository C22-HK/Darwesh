# Anthropic (Claude) adapter -- evaluation-only, same "validated
# placeholder, no live call" state as gemini.py and openai.py. See
# gemini.py's module docstring for the shared reasoning. Like OpenAI,
# activating this always means a real API key (config.py's
# anthropic_api_key, from Secret Manager via Cloud Run), never hardcoded,
# never sent to a browser.
from __future__ import annotations

from app.mam.providers.base import (
    ChatTurn,
    ModelTier,
    ProviderNotConfiguredError,
    ProviderResponse,
    ToolSpec,
)


class AnthropicProvider:
    """Structurally implements app.mam.providers.base.ChatProvider."""

    def __init__(
        self, *, api_key: str, model_flash: str = "claude-haiku-4-5", model_reasoning: str = "claude-sonnet-4-6"
    ) -> None:
        if not api_key:
            raise ValueError("AnthropicProvider requires an api_key -- see config.py's anthropic_api_key.")
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
            f"Anthropic adapter is a validated placeholder only (model would be "
            f"{self._model_for(tier)!r}) -- no live anthropic SDK call is wired yet, pending the "
            f"Sorani benchmark result. See docs/MAM_V2_ARCHITECTURE.md."
        )
