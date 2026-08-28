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
from app.otp.firebase_admin_ops import FirebasePhoneAuthManager
from app.otp.handler import OtpSendHandler, OtpVerifyHandler, PasswordResetConfirmHandler
from app.otp.service import OtpService
from app.otp.store import InMemoryChallengeStore
from app.otp.whatsapp import MockWhatsAppSender
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


def build_otp_handlers(
    cfg: Config,
) -> tuple[OtpSendHandler, OtpVerifyHandler, PasswordResetConfirmHandler] | tuple[None, None, None]:
    """Wires up the WhatsApp-OTP password-recovery endpoints only when
    both FIREBASE_SERVICE_ACCOUNT_JSON and OTP_HMAC_SECRET are set --
    same "route doesn't exist" philosophy as build_auth_handler above.
    WHATSAPP_PROVIDER controls delivery: unset/"mock" (the default) uses
    MockWhatsAppSender, which delivers nothing anywhere -- every other
    part of the flow (rate limiting, hashing, expiry, single-use
    enforcement, Firebase UID resolution, session revocation) is real
    regardless of which provider is selected."""
    if not cfg.firebase_service_account_json or not cfg.otp_hmac_secret:
        logger.info(
            "WhatsApp OTP endpoints not configured, skipping "
            "(set FIREBASE_SERVICE_ACCOUNT_JSON and OTP_HMAC_SECRET to enable them)"
        )
        return None, None, None

    try:
        firebase = FirebasePhoneAuthManager(cfg.firebase_service_account_json)
    except ValueError as exc:
        logger.error("WhatsApp OTP endpoints misconfigured, skipping", extra={"error": str(exc)})
        return None, None, None

    if cfg.whatsapp_provider != "mock":
        # No real provider is implemented yet (see docs/WHATSAPP_OTP.md) --
        # this branch exists so a typo'd or aspirational env var fails
        # loudly at startup instead of silently falling back to mock in
        # what looks like a production configuration.
        logger.error(
            "WHATSAPP_PROVIDER=%s is not a supported provider yet -- WhatsApp OTP endpoints not started",
            cfg.whatsapp_provider,
        )
        return None, None, None

    sender = MockWhatsAppSender()
    if cfg.is_production:
        logger.warning(
            "WhatsApp OTP endpoints are starting with the MOCK provider in a PRODUCTION "
            "environment -- no WhatsApp message will actually be delivered. Phone-based "
            "password recovery is NOT live until a real WHATSAPP_PROVIDER is configured. "
            "See docs/WHATSAPP_OTP.md."
        )

    store = InMemoryChallengeStore()
    service = OtpService(store=store, sender=sender, uids=firebase, otp_secret=cfg.otp_hmac_secret, logger=logger)

    # 5 sends per phone / 15 per IP per 15 minutes -- generous for a real
    # user who fat-fingers their phone or re-requests a code, tight
    # enough to make scripted abuse of a (future) real WhatsApp send
    # expensive. Verify gets its own, looser IP limiter since the
    # per-challenge attempt cap (OtpService.max_attempts) already bounds
    # guessing against any single code.
    send_phone_limiter = RateLimiter(limit=5, window_seconds=15 * 60)
    send_ip_limiter = RateLimiter(limit=15, window_seconds=15 * 60)
    verify_ip_limiter = RateLimiter(limit=30, window_seconds=15 * 60)

    logger.info("WhatsApp OTP endpoints enabled", extra={"provider": cfg.whatsapp_provider})
    return (
        OtpSendHandler(
            service=service, ip_limiter=send_ip_limiter, phone_limiter=send_phone_limiter, logger=logger
        ),
        OtpVerifyHandler(service=service, ip_limiter=verify_ip_limiter, logger=logger),
        PasswordResetConfirmHandler(store=store, firebase=firebase, logger=logger),
    )


def create_configured_app():
    cfg = load()
    logging.basicConfig(
        level=logging.DEBUG if not cfg.is_production else logging.INFO,
        format='{"level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}',
        stream=sys.stdout,
    )
    auth_handler = build_auth_handler(cfg)
    otp_send_handler, otp_verify_handler, password_reset_confirm_handler = build_otp_handlers(cfg)
    return create_app(cfg, auth_handler, otp_send_handler, otp_verify_handler, password_reset_confirm_handler)


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
