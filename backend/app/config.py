# Centralizes environment-based configuration. Nothing in this module
# reads a config file or hardcodes a value that should differ between
# environments -- every setting comes from an env var, with a safe
# default for local development only.
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Config:
    # Port the HTTP server listens on. Cloud Run and most PaaS platforms
    # inject PORT automatically; 8080 is the conventional local default.
    port: str

    # Identifies the running environment ("development" or "production"),
    # used to decide things like log verbosity. Never used for a security
    # decision on its own (e.g. "skip auth if development") -- that would
    # be a real vulnerability if this var were ever misconfigured in
    # production.
    env: str

    # CORS allowlist for browser requests to this API. Starts empty (no
    # cross-origin browser access permitted) until a real frontend
    # integration needs it -- an open CORS policy is a common way APIs
    # accidentally expose themselves to any website.
    allowed_origins: list[str] = field(default_factory=list)

    # The four settings below back the password-reset email endpoint
    # (milestone 3). All empty by default -- see app.main, which only
    # registers that route when every one of them is actually set, rather
    # than registering a route that would silently misbehave.
    firebase_service_account_json: str = ""  # full JSON key contents, not a file path -- see .env.example
    # Only used when firebase_service_account_json is empty -- i.e. in
    # production on Cloud Run, authenticating via Application Default
    # Credentials instead of a downloaded key (see
    # app.auth.firebase_credentials). Not a secret -- this project's own
    # Firebase project id is already public in js/firebase-init.js.
    firebase_project_id: str = ""
    reset_password_continue_url: str = ""  # e.g. https://www.darweshgroup.com/reset-password.html
    resend_api_key: str = ""
    reset_email_from: str = ""  # e.g. "Darwesh Group <no-reply@darweshgroup.com>"

    # --- Email OTP: signup verification + password recovery ---
    # OTP_HMAC_SECRET plus FIREBASE_SERVICE_ACCOUNT_JSON (above) must both
    # be set for the /api/v1/auth/email-otp/*, /api/v1/auth/signup/complete,
    # and /api/v1/auth/password-reset/confirm routes to exist at all -- see
    # app.main.build_email_otp_handlers. A missing secret must never fall
    # back to hashing OTPs with an empty/default key, so this has no
    # default. resend_api_key/reset_email_from (above -- already used by
    # the legacy link-based forgot-password endpoint) double as the email-
    # OTP sender's credentials too, since it's the same Resend account:
    # when both are set, real Resend delivery is used; otherwise
    # MockEmailSender is used in development, and the email-OTP routes
    # simply don't register at all in production (mock email delivery
    # must never run in production -- see build_email_otp_handlers).
    otp_hmac_secret: str = ""

    # --- MAM Intelligence V2 ---
    # Every field below is optional and empty by default. The /api/v1/mam/*
    # routes register unconditionally (same reasoning as /healthz -- their
    # deterministic-only fallback path, app.mam.intent_resolver, needs no
    # credential at all), but the LLM-backed reasoning tier only activates
    # once mam_chat_provider names a configured provider. An unset or
    # unrecognized value means "no live model" -- MAM still works for
    # navigation/simple lookups, it just never claims to reason.
    #
    # mam_chat_provider selects which app.mam.providers adapter the
    # orchestrator constructs: "gemini" | "openai" | "anthropic" | ""
    # (empty = deterministic-fallback-only, the safe default). This is the
    # ONLY place a provider choice is wired in -- see app.mam.providers.base
    # for why nothing else in the mam package imports a provider SDK
    # directly.
    mam_chat_provider: str = ""

    # Gemini/Vertex AI. Deliberately no API-key field: the intended
    # production path authenticates via the Cloud Run service account's
    # Application Default Credentials against Vertex AI (no secret to
    # store at all), matching this backend's existing ADC pattern for
    # Firebase Admin in production. gemini_project_id/location are not
    # secrets -- see .env.example for why the Firebase project id is
    # already public -- but have no default, since "which GCP project/
    # region to bill" must never silently fall back to a guess.
    gemini_project_id: str = ""
    gemini_location: str = ""
    gemini_model_flash: str = ""
    gemini_model_pro: str = ""

    # OpenAI/Anthropic direct-API adapters (evaluation-only today, per
    # app.mam.providers.openai/anthropic's own docstrings -- neither makes
    # a live call yet). Real secrets, sourced from Google Secret Manager
    # via Cloud Run's secret-injection env vars in production, same as
    # every other credential in this file -- never hardcoded, never
    # logged.
    openai_api_key: str = ""
    anthropic_api_key: str = ""

    # --- KurdishTTS: Sorani voice layer for MAM (STT + TTS proxy) ---
    # Both keys are server-side only -- see app.mam.voice, which never
    # forwards either to the browser and never logs them. Each gates its
    # OWN capability independently (see app.main.build_voice_handler):
    # kurdishtts_stt_key controls whether MAM can transcribe Sorani speech,
    # kurdishtts_tts_key whether it can speak Sorani replies aloud. Either
    # or both may be unset -- MAM's text chat and non-Sorani voice never
    # depend on this being configured at all.
    kurdishtts_stt_key: str = ""
    kurdishtts_tts_key: str = ""
    # Optional. Not a secret -- a plain speaker/voice id KurdishTTS itself
    # assigns. When set, app.mam.voice skips its own catalog-lookup
    # fallback entirely and uses this id directly for every Sorani TTS
    # call -- the safer long-term answer once the real id has been
    # confirmed against KurdishTTS's current docs (its catalog endpoint's
    # exact path could not be independently verified while this was
    # built). Leave unset to fall back to that best-effort lookup.
    kurdishtts_sorani_speaker_id: str = ""

    @property
    def is_production(self) -> bool:
        return self.env == "production"


def _split_non_empty(csv: str) -> list[str]:
    if not csv:
        return []
    return [part for part in csv.split(",") if part]


def load() -> Config:
    """Reads configuration from environment variables. Returns sane,
    safe-by-default values for anything unset -- a missing env var should
    never silently widen what the server permits (e.g. allowed_origins
    defaults to none, not "*")."""
    return Config(
        port=os.environ.get("PORT", "8080"),
        env=os.environ.get("APP_ENV", "development"),
        allowed_origins=_split_non_empty(os.environ.get("ALLOWED_ORIGINS", "")),
        firebase_service_account_json=os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", ""),
        firebase_project_id=os.environ.get("FIREBASE_PROJECT_ID", ""),
        reset_password_continue_url=os.environ.get("RESET_PASSWORD_CONTINUE_URL", ""),
        resend_api_key=os.environ.get("RESEND_API_KEY", ""),
        reset_email_from=os.environ.get("RESET_EMAIL_FROM", ""),
        otp_hmac_secret=os.environ.get("OTP_HMAC_SECRET", ""),
        mam_chat_provider=os.environ.get("MAM_CHAT_PROVIDER", ""),
        gemini_project_id=os.environ.get("GEMINI_PROJECT_ID", ""),
        gemini_location=os.environ.get("GEMINI_LOCATION", ""),
        gemini_model_flash=os.environ.get("GEMINI_MODEL_FLASH", ""),
        gemini_model_pro=os.environ.get("GEMINI_MODEL_PRO", ""),
        openai_api_key=os.environ.get("OPENAI_API_KEY", ""),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        kurdishtts_stt_key=os.environ.get("KURDISHTTS_STT_KEY", ""),
        kurdishtts_tts_key=os.environ.get("KURDISHTTS_TTS_KEY", ""),
        kurdishtts_sorani_speaker_id=os.environ.get("KURDISHTTS_SORANI_SPEAKER_ID", ""),
    )
