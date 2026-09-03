# Vertex AI / Gemini adapter.
#
# INTENTIONALLY NOT WIRED TO A LIVE CALL YET. Per the explicit "do not
# implement provider-specific production behavior yet" / "the final
# provider decision will be made only after real benchmark results exist"
# instructions this phase was built under: this class has the real,
# correct constructor validation and implements the ChatProvider Protocol
# (base.py) with the right shape, but generate() raises
# ProviderNotConfiguredError rather than making a network call. Activating
# it later is a small, contained diff -- fill in the body of generate()
# using the google-genai SDK's Vertex AI mode (`genai.Client(vertexai=True,
# project=..., location=...)`), add `google-genai` to requirements.txt,
# and flip MAM_CHAT_PROVIDER=gemini -- nothing in orchestrator.py,
# tools.py, or policy.py needs to change.
#
# Why Vertex AI mode specifically (not the Gemini Developer API / AI
# Studio key path): this backend already runs on Cloud Run in the same
# GCP project as Firebase. Vertex AI mode authenticates via Application
# Default Credentials -- the Cloud Run runtime service account -- so
# there is no API key to put in Secret Manager for this provider at all,
# only an IAM role grant (see docs/MAM_V2_ARCHITECTURE.md's deployment
# section for the exact grant needed and why this repo cannot grant it
# itself). gemini_project_id/gemini_location/gemini_model_flash/
# gemini_model_pro all come from Config (empty by default) -- see
# config.py's own comment for why none of them have a default value.
from __future__ import annotations

from app.mam.providers.base import (
    ChatTurn,
    ModelTier,
    ProviderNotConfiguredError,
    ProviderResponse,
    ToolSpec,
)


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
        raise ProviderNotConfiguredError(
            f"Gemini adapter is a validated placeholder only (model would be "
            f"{self._model_for(tier)!r}) -- no live google-genai call is wired yet, pending "
            f"the Sorani benchmark result and the Vertex AI IAM grant. See docs/MAM_V2_ARCHITECTURE.md."
        )
