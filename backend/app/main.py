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
from app.otp.email_handler import EmailOtpSendHandler, EmailOtpVerifyHandler, SignupCompleteHandler
from app.otp.email_sender import MockEmailSender, ResendOtpEmailSender
from app.otp.firebase_admin_ops import EmailUidResolver, FirebaseAccountOps
from app.otp.handler import PasswordResetConfirmHandler
from app.otp.service import OtpService
from app.otp.store import InMemoryChallengeStore
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


def build_email_otp_handlers(
    cfg: Config,
) -> (
    tuple[EmailOtpSendHandler, EmailOtpVerifyHandler, SignupCompleteHandler, PasswordResetConfirmHandler]
    | tuple[None, None, None, None]
):
    """Wires up the email-OTP signup + password-recovery endpoints.
    Requires FIREBASE_SERVICE_ACCOUNT_JSON and OTP_HMAC_SECRET -- same
    "route doesn't exist if unconfigured" rule as build_auth_handler
    above.

    Email delivery additionally needs RESEND_API_KEY and
    RESET_EMAIL_FROM to use the real Resend sender. Unlike the earlier
    WhatsApp-OTP phase's warn-and-continue-on-mock approach, this is a
    hard gate, not a warning: in a production environment, missing
    either of those means the routes are simply NOT registered at all --
    mock email delivery must never run in production. In development,
    missing them falls back to MockEmailSender (delivers nothing,
    records what it would have sent, used by tests)."""
    if not cfg.firebase_service_account_json or not cfg.otp_hmac_secret:
        logger.info(
            "Email OTP endpoints not configured, skipping "
            "(set FIREBASE_SERVICE_ACCOUNT_JSON and OTP_HMAC_SECRET to enable them)"
        )
        return None, None, None, None

    try:
        accounts = FirebaseAccountOps(cfg.firebase_service_account_json)
    except ValueError as exc:
        logger.error("Email OTP endpoints misconfigured, skipping", extra={"error": str(exc)})
        return None, None, None, None

    has_real_email_provider = bool(cfg.resend_api_key and cfg.reset_email_from)
    if cfg.is_production and not has_real_email_provider:
        logger.error(
            "Email OTP endpoints NOT started: APP_ENV=production requires a real email "
            "provider (RESEND_API_KEY and RESET_EMAIL_FROM) -- mock email delivery must "
            "never run in production. Set both to enable signup/password-recovery email."
        )
        return None, None, None, None

    if has_real_email_provider:
        try:
            sender = ResendOtpEmailSender(cfg.resend_api_key, cfg.reset_email_from)
        except ValueError as exc:
            logger.error("Email OTP endpoints misconfigured, skipping", extra={"error": str(exc)})
            return None, None, None, None
        logger.info("Email OTP endpoints enabled", extra={"provider": "resend"})
    else:
        sender = MockEmailSender()
        logger.info("Email OTP endpoints enabled", extra={"provider": "mock"})

    store = InMemoryChallengeStore()
    service = OtpService(
        store=store, sender=sender, uids=EmailUidResolver(accounts), otp_secret=cfg.otp_hmac_secret, logger=logger
    )

    # 5 sends per email / 15 per IP per 15 minutes -- generous for a real
    # user who mistypes or re-requests a code, tight enough to make
    # scripted abuse of real Resend send volume expensive. Verify gets
    # its own, looser IP limiter since the per-challenge attempt cap
    # (OtpService.max_attempts) already bounds guessing against any
    # single code. Signup completion gets its own limiter too --
    # account creation is its own abuse surface, independent of how many
    # codes were sent/verified.
    send_email_limiter = RateLimiter(limit=5, window_seconds=15 * 60)
    send_ip_limiter = RateLimiter(limit=15, window_seconds=15 * 60)
    verify_ip_limiter = RateLimiter(limit=30, window_seconds=15 * 60)
    complete_ip_limiter = RateLimiter(limit=10, window_seconds=15 * 60)

    return (
        EmailOtpSendHandler(
            service=service, ip_limiter=send_ip_limiter, email_limiter=send_email_limiter, logger=logger
        ),
        EmailOtpVerifyHandler(service=service, ip_limiter=verify_ip_limiter, logger=logger),
        SignupCompleteHandler(store=store, accounts=accounts, ip_limiter=complete_ip_limiter, logger=logger),
        PasswordResetConfirmHandler(store=store, firebase=accounts, logger=logger),
    )


def create_configured_app():
    cfg = load()
    logging.basicConfig(
        level=logging.DEBUG if not cfg.is_production else logging.INFO,
        format='{"level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}',
        stream=sys.stdout,
    )
    auth_handler = build_auth_handler(cfg)
    email_otp_send_handler, email_otp_verify_handler, signup_complete_handler, password_reset_confirm_handler = (
        build_email_otp_handlers(cfg)
    )
    return create_app(
        cfg,
        auth_handler,
        email_otp_send_handler,
        email_otp_verify_handler,
        signup_complete_handler,
        password_reset_confirm_handler,
    )


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
