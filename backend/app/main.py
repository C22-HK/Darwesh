# Darwesh backend -- API server foundation.
#
# This is milestone 1 plus milestone 3: a real, working server with health
# checks, structured logging, CORS, and the password-reset email endpoint
# (registered only when it's fully configured). Deliberately does NOT yet
# connect to PostgreSQL or Redis -- those are separate milestones, each
# needing its own real, provisioned instance and credentials before
# there's anything honest to wire up. See docs/BACKEND_MILESTONES.md for
# what comes next and why it's sequenced this way.
from __future__ import annotations

import logging
import sys

import uvicorn

from app.auth.firebase_reset import FirebaseResetLinkGenerator
from app.auth.resend_email import ResendEmailSender
from app.auth.reset import Handler, RateLimiter
from app.config import Config, load
from app.server import create_app

logger = logging.getLogger("darwesh")


def build_auth_handler(cfg: Config) -> Handler | None:
    """Wires up the password-reset endpoint only when every required
    setting is present -- see app.server.create_app's docstring for why a
    missing config means "route doesn't exist" rather than "route exists
    and fails at request time."""
    if not cfg.firebase_service_account_json or not cfg.resend_api_key:
        logger.info(
            "password-reset endpoint not configured, skipping "
            "(set FIREBASE_SERVICE_ACCOUNT_JSON and RESEND_API_KEY to enable it)"
        )
        return None

    try:
        links = FirebaseResetLinkGenerator(cfg.firebase_service_account_json, cfg.reset_password_continue_url)
        emails = ResendEmailSender(cfg.resend_api_key, cfg.reset_email_from)
    except ValueError as exc:
        logger.error("password-reset endpoint misconfigured, skipping", extra={"error": str(exc)})
        return None

    logger.info("password-reset endpoint enabled")
    return Handler(
        links=links,
        emails=emails,
        # 5 requests per 15 minutes per IP -- generous enough for a real
        # user who mistypes their email or re-checks their inbox, tight
        # enough to make scripted abuse expensive. Revisit if real usage
        # patterns say otherwise.
        limiter=RateLimiter(limit=5, window_seconds=15 * 60),
        logger=logger,
    )


def create_configured_app():
    cfg = load()
    logging.basicConfig(
        level=logging.DEBUG if not cfg.is_production else logging.INFO,
        format='{"level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}',
        stream=sys.stdout,
    )
    auth_handler = build_auth_handler(cfg)
    return create_app(cfg, auth_handler)


# Module-level so `uvicorn app.main:app` (the production entrypoint, e.g.
# in the Dockerfile) can import it directly without re-running __main__.
app = create_configured_app()


def main() -> None:
    cfg = load()
    logger.info("server starting", extra={"port": cfg.port, "env": cfg.env})
    # Uvicorn handles SIGINT/SIGTERM (what Docker, Cloud Run, and systemd
    # all send to ask a process to stop) natively -- finishing in-flight
    # requests before exiting needs no hand-rolled graceful-shutdown code
    # here, unlike Go's net/http.Server.
    uvicorn.run(app, host="0.0.0.0", port=int(cfg.port), timeout_graceful_shutdown=10)


if __name__ == "__main__":
    main()
