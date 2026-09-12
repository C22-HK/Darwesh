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

from app.access.auth_context import FirebaseIdTokenVerifier
from app.access.caller_context import AuthGate
from app.access.company_ops import CompanyOps
from app.access.firebase_clients import AccessFirebaseClients, make_email_uid_resolver
from app.access.handlers import CompanyHandler, OrganizationHandler, PermissionAdminHandler
from app.access.organization_ops import OrganizationOps
from app.access.permission_ops import PermissionOps
from app.access.professional_ops import ProfessionalOps
from app.auth.firebase_reset import FirebaseResetLinkGenerator
from app.auth.resend_email import ResendEmailSender
from app.auth.reset import FirestoreRateLimiter, Handler, InMemoryRateLimiter
from app.config import Config, load
from app.mam.firebase_clients import MamFirebaseClients
from app.mam.orchestrator import Orchestrator
from app.mam.providers.base import ChatProvider
from app.mam.rate_limit import build_mam_rate_limiters
from app.mam.routes import MamHandler
from app.mam.session import SessionStore
from app.mam.tools import Tools
from app.mam.voice import KurdishTTSClient, VoiceHandler, build_voice_rate_limiters
from app.otp.email_handler import EmailOtpSendHandler, EmailOtpVerifyHandler, SignupCompleteHandler
from app.otp.email_sender import MockEmailSender, ResendOtpEmailSender
from app.otp.firebase_admin_ops import EmailUidResolver, FirebaseAccountOps
from app.otp.handler import PasswordResetConfirmHandler
from app.otp.service import OtpService
from app.otp.store import FirestoreChallengeStore, InMemoryChallengeStore
from app.server import create_app
from app.verification.archive_ops import ArchiveOps
from app.verification.handlers import PermissionReader, ReferralPublicHandler, VerificationHandler
from app.verification.referral_ops import ReferralOps
from app.verification.verification_ops import VerificationOps

logger = logging.getLogger("darwesh")


def _has_firebase_credential(cfg: Config) -> bool:
    """True if there's something to even attempt authenticating
    Firebase Admin with -- either a real service-account key, or (in
    production only) Application Default Credentials, which Cloud Run
    provides automatically via its attached runtime service account.
    Development never attempts ADC on its own (a developer without a
    key configured gets the same clean "not configured, skipping" it
    always has, rather than a confusing local ADC lookup)."""
    return bool(cfg.firebase_service_account_json) or cfg.is_production


def build_auth_handler(cfg: Config) -> Handler | None:
    """Wires up the password-reset endpoint only when every required
    setting is present -- see app.server.create_app's docstring for why a
    missing config means "route doesn't exist" rather than "route exists
    and fails at request time."""
    if not _has_firebase_credential(cfg) or not cfg.resend_api_key:
        logger.info(
            "password-reset endpoint not configured, skipping (set FIREBASE_SERVICE_ACCOUNT_JSON -- or "
            "deploy with APP_ENV=production to use Application Default Credentials -- and RESEND_API_KEY "
            "to enable it)"
        )
        return None

    try:
        links = FirebaseResetLinkGenerator(
            cfg.firebase_service_account_json, cfg.reset_password_continue_url, cfg.firebase_project_id
        )
        emails = ResendEmailSender(cfg.resend_api_key, cfg.reset_email_from)
    except ValueError as exc:
        logger.error("password-reset endpoint misconfigured, skipping", extra={"error": str(exc)})
        return None

    logger.info("password-reset endpoint enabled")
    # 5 requests per 15 minutes per IP -- generous enough for a real
    # user who mistypes their email or re-checks their inbox, tight
    # enough to make scripted abuse expensive. Revisit if real usage
    # patterns say otherwise.
    #
    # Firestore-backed in production -- Cloud Run (and most real hosts)
    # scale to more than one instance, and an in-memory limiter's
    # effective limit would then silently multiply by however many
    # instances happen to be running (INFRA-01,
    # INFRASTRUCTURE_REMEDIATION.md). links already holds a Firestore
    # client (see FirebaseResetLinkGenerator.firestore_client), so this
    # reuses it rather than opening a second one.
    limiter = (
        FirestoreRateLimiter(
            links.firestore_client, name="forgot_password_ip", limit=5, window_seconds=15 * 60, logger=logger
        )
        if cfg.is_production
        else InMemoryRateLimiter(limit=5, window_seconds=15 * 60)
    )
    return Handler(
        links=links,
        emails=emails,
        limiter=limiter,
        logger=logger,
    )


def build_email_otp_handlers(
    cfg: Config,
) -> (
    tuple[EmailOtpSendHandler, EmailOtpVerifyHandler, SignupCompleteHandler, PasswordResetConfirmHandler]
    | tuple[None, None, None, None]
):
    """Wires up the email-OTP signup + password-recovery endpoints.
    Requires OTP_HMAC_SECRET plus a way to authenticate Firebase Admin
    -- either FIREBASE_SERVICE_ACCOUNT_JSON, or (production only)
    Application Default Credentials -- same "route doesn't exist if
    unconfigured" rule as build_auth_handler above.

    Email delivery additionally needs RESEND_API_KEY and
    RESET_EMAIL_FROM to use the real Resend sender. Unlike the earlier
    WhatsApp-OTP phase's warn-and-continue-on-mock approach, this is a
    hard gate, not a warning: in a production environment, missing
    either of those means the routes are simply NOT registered at all --
    mock email delivery must never run in production. In development,
    missing them falls back to MockEmailSender (delivers nothing,
    records what it would have sent, used by tests)."""
    if not _has_firebase_credential(cfg) or not cfg.otp_hmac_secret:
        logger.info(
            "Email OTP endpoints not configured, skipping (set FIREBASE_SERVICE_ACCOUNT_JSON -- or "
            "deploy with APP_ENV=production to use Application Default Credentials -- and "
            "OTP_HMAC_SECRET to enable them)"
        )
        return None, None, None, None

    try:
        accounts = FirebaseAccountOps(cfg.firebase_service_account_json, cfg.firebase_project_id)
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

    # Cloud Run (and most real hosts) scale to more than one instance --
    # InMemoryChallengeStore's state would then be invisible across them
    # (a /send hitting one instance and /verify hitting another would see
    # no matching challenge at all), so production always uses the
    # Firestore-backed store instead, sharing the same client
    # FirebaseAccountOps already holds. Development/tests keep the
    # simpler in-memory store -- no Firestore round-trips needed there.
    store = (
        FirestoreChallengeStore(accounts.firestore_client, logger=logger)
        if cfg.is_production
        else InMemoryChallengeStore()
    )
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
    #
    # Firestore-backed in production, same reasoning (and the same
    # shared client, accounts.firestore_client) as `store` just above --
    # see build_auth_handler's limiter comment and INFRA-01
    # (INFRASTRUCTURE_REMEDIATION.md). Each gets its own `name` so their
    # counters never collide with each other even though several key on
    # the same value (the caller's IP).
    if cfg.is_production:
        db = accounts.firestore_client
        send_email_limiter = FirestoreRateLimiter(
            db, name="email_otp_send_email", limit=5, window_seconds=15 * 60, logger=logger
        )
        send_ip_limiter = FirestoreRateLimiter(
            db, name="email_otp_send_ip", limit=15, window_seconds=15 * 60, logger=logger
        )
        verify_ip_limiter = FirestoreRateLimiter(
            db, name="email_otp_verify_ip", limit=30, window_seconds=15 * 60, logger=logger
        )
        complete_ip_limiter = FirestoreRateLimiter(
            db, name="email_otp_complete_ip", limit=10, window_seconds=15 * 60, logger=logger
        )
    else:
        send_email_limiter = InMemoryRateLimiter(limit=5, window_seconds=15 * 60)
        send_ip_limiter = InMemoryRateLimiter(limit=15, window_seconds=15 * 60)
        verify_ip_limiter = InMemoryRateLimiter(limit=30, window_seconds=15 * 60)
        complete_ip_limiter = InMemoryRateLimiter(limit=10, window_seconds=15 * 60)

    return (
        EmailOtpSendHandler(
            service=service, ip_limiter=send_ip_limiter, email_limiter=send_email_limiter, logger=logger
        ),
        EmailOtpVerifyHandler(service=service, ip_limiter=verify_ip_limiter, logger=logger),
        SignupCompleteHandler(store=store, accounts=accounts, ip_limiter=complete_ip_limiter, logger=logger),
        PasswordResetConfirmHandler(store=store, firebase=accounts, logger=logger),
    )


def build_access_handlers(
    cfg: Config,
) -> tuple[OrganizationHandler | None, PermissionAdminHandler | None, CompanyHandler | None]:
    """Wires up the Profile Architecture Phase 2 access-management
    endpoints (organization membership/ownership, role defaults, user
    permission overrides, effective-permissions read). Requires only a
    way to authenticate Firebase Admin -- same
    FIREBASE_SERVICE_ACCOUNT_JSON-or-ADC gate as every other Firebase-
    backed feature -- deliberately independent of OTP_HMAC_SECRET/
    RESEND_API_KEY/RESET_EMAIL_FROM, since these endpoints act on an
    already-signed-in user's Firebase ID token and send no email at all;
    they must be available even when the email-OTP signup flow isn't."""
    if not _has_firebase_credential(cfg):
        logger.info(
            "Access-management endpoints not configured, skipping (set FIREBASE_SERVICE_ACCOUNT_JSON -- or "
            "deploy with APP_ENV=production to use Application Default Credentials -- to enable them)"
        )
        return None, None, None

    try:
        clients = AccessFirebaseClients(cfg.firebase_service_account_json, cfg.firebase_project_id)
    except ValueError as exc:
        logger.error("Access-management endpoints misconfigured, skipping", extra={"error": str(exc)})
        return None, None, None

    db = clients.firestore_client
    auth_gate = AuthGate(FirebaseIdTokenVerifier(clients.app, logger=logger), db, logger=logger)
    org_ops = OrganizationOps(db, logger=logger)
    perm_ops = PermissionOps(db, logger=logger)
    company_ops = CompanyOps(db, logger=logger, resolve_email_uid=make_email_uid_resolver(clients.app))

    # Firestore-backed in production (multi-instance Cloud Run, same
    # INFRA-01 reasoning as every other rate limiter in this backend),
    # in-memory in development/tests. Limits are deliberately generous
    # for the read endpoint and tighter for the most sensitive mutation
    # (ownership transfer) -- see handlers.py's OrganizationHandler
    # docstring for why each action family gets its own independently-
    # namespaced limiter rather than sharing one counter.
    if cfg.is_production:
        create_limiter = FirestoreRateLimiter(
            db, name="access_org_create", limit=5, window_seconds=60 * 60, logger=logger
        )
        membership_limiter = FirestoreRateLimiter(
            db, name="access_membership", limit=30, window_seconds=60 * 60, logger=logger
        )
        ownership_transfer_limiter = FirestoreRateLimiter(
            db, name="access_ownership_transfer", limit=5, window_seconds=60 * 60, logger=logger
        )
        mutation_limiter = FirestoreRateLimiter(
            db, name="access_permission_mutation", limit=60, window_seconds=60 * 60, logger=logger
        )
        read_limiter = FirestoreRateLimiter(
            db, name="access_permission_read", limit=120, window_seconds=60 * 60, logger=logger
        )
    else:
        create_limiter = InMemoryRateLimiter(limit=5, window_seconds=60 * 60)
        membership_limiter = InMemoryRateLimiter(limit=30, window_seconds=60 * 60)
        ownership_transfer_limiter = InMemoryRateLimiter(limit=5, window_seconds=60 * 60)
        mutation_limiter = InMemoryRateLimiter(limit=60, window_seconds=60 * 60)
        read_limiter = InMemoryRateLimiter(limit=120, window_seconds=60 * 60)

    logger.info("Access-management endpoints enabled")
    return (
        OrganizationHandler(
            ops=org_ops,
            auth=auth_gate,
            create_limiter=create_limiter,
            membership_limiter=membership_limiter,
            ownership_transfer_limiter=ownership_transfer_limiter,
            logger=logger,
        ),
        PermissionAdminHandler(
            ops=perm_ops,
            auth=auth_gate,
            mutation_limiter=mutation_limiter,
            read_limiter=read_limiter,
            logger=logger,
            # Admin Panel Phase 2: same org_ops/company_ops instances
            # OrganizationHandler/CompanyHandler already use below -- one
            # OrganizationOps/CompanyOps per app, not a second instance.
            org_ops=org_ops,
            company_ops=company_ops,
            professional_ops=ProfessionalOps(db, logger=logger),
        ),
        # Phase 3: reuses the SAME membership_limiter instance as
        # OrganizationHandler above (one shared per-uid counter across
        # both organization and company membership actions) rather than
        # a new limiter category -- matches the explicit "reuse the
        # existing rate-limit architecture" instruction.
        CompanyHandler(ops=company_ops, auth=auth_gate, membership_limiter=membership_limiter, logger=logger),
    )


def build_verification_handlers(
    cfg: Config,
) -> tuple[ReferralPublicHandler | None, VerificationHandler | None]:
    """Wires up the Verification, Referral and Reward endpoints.

    Gated on the SAME Firebase Admin credential check as every other
    Firestore-backed feature -- and on nothing else. In particular it is
    NOT gated on a storage bucket or an archive key: a deployment
    without those still gets identity review, referral qualification and
    reward computation, and the two actions that genuinely need storage
    (revealing one evidence object, running the archive pipeline) each
    fail with their own honest message instead (§BI). Silently hiding
    the whole feature because one optional binding is missing would be
    the worse failure -- it would look like the feature was never built.
    """
    if not _has_firebase_credential(cfg):
        logger.info(
            "Verification endpoints not configured, skipping (set FIREBASE_SERVICE_ACCOUNT_JSON -- or "
            "deploy with APP_ENV=production to use Application Default Credentials -- to enable them)"
        )
        return None, None

    try:
        clients = AccessFirebaseClients(cfg.firebase_service_account_json, cfg.firebase_project_id)
    except ValueError as exc:
        logger.error("Verification endpoints misconfigured, skipping", extra={"error": str(exc)})
        return None, None

    db = clients.firestore_client
    auth_gate = AuthGate(FirebaseIdTokenVerifier(clients.app, logger=logger), db, logger=logger)

    evidence_bucket = None
    archive_vault = None
    if cfg.verification_evidence_bucket or cfg.verification_archive_bucket:
        from firebase_admin import storage as fb_storage

        if cfg.verification_evidence_bucket:
            evidence_bucket = fb_storage.bucket(cfg.verification_evidence_bucket, app=clients.app)
        if cfg.verification_archive_bucket:
            archive_vault = fb_storage.bucket(cfg.verification_archive_bucket, app=clients.app)
    else:
        logger.info(
            "Verification evidence/archive storage not configured; document reveal and archiving "
            "will report themselves unavailable (set VERIFICATION_EVIDENCE_BUCKET / "
            "VERIFICATION_ARCHIVE_BUCKET to enable them)"
        )

    referral_ops = ReferralOps(db)
    verification_ops = VerificationOps(db, bucket=evidence_bucket, referral_ops=referral_ops)
    archive_ops = ArchiveOps(db, vault=archive_vault, live_bucket=evidence_bucket)

    # Same FirestoreRateLimiter-in-production/InMemory-in-development
    # split as build_access_handlers, with its own namespaces so a burst
    # of verification traffic cannot exhaust an unrelated counter.
    # Submission is the tightest self-service limit (resubmitting an ID
    # a dozen times an hour is not a real user), and evidence reveal is
    # the tightest of all.
    if cfg.is_production:
        submit_limiter = FirestoreRateLimiter(
            db, name="verification_submit", limit=10, window_seconds=60 * 60, logger=logger
        )
        read_limiter = FirestoreRateLimiter(
            db, name="verification_read", limit=240, window_seconds=60 * 60, logger=logger
        )
        admin_limiter = FirestoreRateLimiter(
            db, name="verification_admin", limit=200, window_seconds=60 * 60, logger=logger
        )
        reveal_limiter = FirestoreRateLimiter(
            db, name="verification_reveal", limit=40, window_seconds=60 * 60, logger=logger
        )
        code_check_limiter = FirestoreRateLimiter(
            db, name="referral_code_check", limit=30, window_seconds=60 * 60, logger=logger
        )
    else:
        submit_limiter = InMemoryRateLimiter(limit=10, window_seconds=60 * 60)
        read_limiter = InMemoryRateLimiter(limit=240, window_seconds=60 * 60)
        admin_limiter = InMemoryRateLimiter(limit=200, window_seconds=60 * 60)
        reveal_limiter = InMemoryRateLimiter(limit=40, window_seconds=60 * 60)
        code_check_limiter = InMemoryRateLimiter(limit=30, window_seconds=60 * 60)

    logger.info("Verification, referral and reward endpoints enabled")
    return (
        ReferralPublicHandler(ops=referral_ops, limiter=code_check_limiter, logger=logger),
        VerificationHandler(
            verification=verification_ops,
            referrals=referral_ops,
            archives=archive_ops,
            auth=auth_gate,
            permissions=PermissionReader(db),
            submit_limiter=submit_limiter,
            read_limiter=read_limiter,
            admin_limiter=admin_limiter,
            reveal_limiter=reveal_limiter,
            logger=logger,
        ),
    )


def build_mam_provider(cfg: Config) -> ChatProvider | None:
    """Constructs the configured MAM chat provider adapter, or None (safe
    default: deterministic-fallback-only, see intent_resolver.py). Every
    adapter's constructor validates its own required settings and raises
    ValueError if incomplete -- caught here the same way build_auth_handler
    treats a misconfigured dependency: log and fall back, never crash
    startup over an optional feature. No adapter makes a live call yet
    (see each providers/*.py module docstring) -- this only decides WHICH
    validated placeholder, if any, orchestrator.py holds."""
    provider_name = cfg.mam_chat_provider.strip().lower()
    if not provider_name:
        return None
    try:
        if provider_name == "gemini":
            from app.mam.providers.gemini import GeminiProvider

            return GeminiProvider(
                project_id=cfg.gemini_project_id,
                location=cfg.gemini_location,
                model_flash=cfg.gemini_model_flash,
                model_pro=cfg.gemini_model_pro,
            )
        if provider_name == "openai":
            from app.mam.providers.openai import OpenAIProvider

            return OpenAIProvider(api_key=cfg.openai_api_key)
        if provider_name == "anthropic":
            from app.mam.providers.anthropic import AnthropicProvider

            return AnthropicProvider(api_key=cfg.anthropic_api_key)
        logger.error("MAM_CHAT_PROVIDER=%r is not a recognized provider -- ignoring", provider_name)
        return None
    except ValueError as exc:
        logger.error(
            "MAM chat provider misconfigured, falling back to deterministic-only", extra={"error": str(exc)}
        )
        return None


def build_mam_handler(cfg: Config) -> MamHandler | None:
    """Wires up POST /api/v1/mam/chat. Gated on the same Firebase Admin
    credential check as every other Firebase-backed feature in this file
    (_has_firebase_credential) -- unlike the OTP/access endpoints, MAM's
    OWN chat semantics are explicitly public (a visitor never needs to
    sign in to talk to MAM), but its deterministic tools (search_properties,
    get_market_summary, etc. -- app.mam.tools.Tools) still read real data
    from Firestore, so there is no meaningful MAM endpoint to register at
    all without a Firestore client to back it. mam_chat_provider/the
    Gemini/OpenAI/Anthropic secrets are independently optional on top of
    that -- see build_mam_provider above; their absence only means MAM
    never reasons beyond intent_resolver's deterministic patterns, not
    that the route doesn't exist."""
    if not _has_firebase_credential(cfg):
        logger.info(
            "MAM endpoint not configured, skipping (set FIREBASE_SERVICE_ACCOUNT_JSON -- or deploy with "
            "APP_ENV=production to use Application Default Credentials -- to enable it)"
        )
        return None

    try:
        clients = MamFirebaseClients(cfg.firebase_service_account_json, cfg.firebase_project_id)
    except ValueError as exc:
        logger.error("MAM endpoint misconfigured, skipping", extra={"error": str(exc)})
        return None

    db = clients.firestore_client
    auth_gate = AuthGate(FirebaseIdTokenVerifier(clients.app, logger=logger), db, logger=logger)
    provider = build_mam_provider(cfg)
    orchestrator = Orchestrator(
        tools=Tools(db=db, logger=logger),
        sessions=SessionStore(),
        provider=provider,
        logger=logger,
    )
    rate_limiters = build_mam_rate_limiters(db=db, is_production=cfg.is_production)

    logger.info("MAM endpoint enabled", extra={"provider": provider.__class__.__name__ if provider else "none"})
    return MamHandler(orchestrator=orchestrator, auth=auth_gate, rate_limiters=rate_limiters, logger=logger)


def build_voice_handler(cfg: Config) -> VoiceHandler | None:
    """Wires up the KurdishTTS Sorani voice proxy (POST /api/v1/mam/voice/
    stt, /tts, GET /config). Unlike build_mam_handler, this needs NO
    Firebase credential -- neither route touches Firestore, they only
    forward to KurdishTTS with a server-side key. Registered only when at
    least one of KURDISHTTS_STT_KEY/KURDISHTTS_TTS_KEY is set; if only one
    is, the OTHER capability's route still exists but its handler method
    returns a clean voice_unavailable response rather than 404 -- see
    VoiceHandler.stt_available/tts_available. Both keys stay entirely
    within KurdishTTSClient (app.mam.voice) -- never logged here or
    anywhere else."""
    if not cfg.kurdishtts_stt_key and not cfg.kurdishtts_tts_key:
        logger.info("MAM voice (KurdishTTS) not configured, skipping (set KURDISHTTS_STT_KEY/KURDISHTTS_TTS_KEY)")
        return None

    # No Firebase Admin credential is available/needed for rate limiting
    # in-memory-only deployments (mirrors build_mam_rate_limiters' own
    # is_production switch) -- Firestore-backed limiting is used whenever
    # a Firebase credential happens to already be configured for MAM,
    # falling back to in-memory otherwise so this feature never depends
    # on Firebase being set up at all.
    db = None
    if _has_firebase_credential(cfg):
        try:
            db = MamFirebaseClients(cfg.firebase_service_account_json, cfg.firebase_project_id).firestore_client
        except ValueError:
            db = None
    rate_limiters = build_voice_rate_limiters(db=db, is_production=cfg.is_production and db is not None)

    client = KurdishTTSClient(
        stt_key=cfg.kurdishtts_stt_key,
        tts_key=cfg.kurdishtts_tts_key,
        logger=logger,
        sorani_speaker_id_override=cfg.kurdishtts_sorani_speaker_id,
    )
    logger.info(
        "MAM voice (KurdishTTS) enabled",
        extra={"stt": bool(cfg.kurdishtts_stt_key), "tts": bool(cfg.kurdishtts_tts_key)},
    )
    return VoiceHandler(client=client, rate_limiters=rate_limiters, logger=logger)


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
    organization_handler, permission_admin_handler, company_handler = build_access_handlers(cfg)
    mam_handler = build_mam_handler(cfg)
    voice_handler = build_voice_handler(cfg)
    referral_public_handler, verification_handler = build_verification_handlers(cfg)
    return create_app(
        cfg,
        auth_handler,
        email_otp_send_handler,
        email_otp_verify_handler,
        signup_complete_handler,
        password_reset_confirm_handler,
        organization_handler,
        permission_admin_handler,
        company_handler,
        mam_handler,
        voice_handler,
        referral_public_handler,
        verification_handler,
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
