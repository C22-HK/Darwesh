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
    reset_password_continue_url: str = ""  # e.g. https://www.darweshgroup.com/reset-password.html
    resend_api_key: str = ""
    reset_email_from: str = ""  # e.g. "Darwesh Group <no-reply@darweshgroup.com>"

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
        reset_password_continue_url=os.environ.get("RESET_PASSWORD_CONTINUE_URL", ""),
        resend_api_key=os.environ.get("RESEND_API_KEY", ""),
        reset_email_from=os.environ.get("RESET_EMAIL_FROM", ""),
    )
