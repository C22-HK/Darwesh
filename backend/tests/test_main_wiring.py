# Exercises app.main.build_email_otp_handlers's wiring decisions
# directly -- until now these were only verified by reading the code,
# not by a test. Two production-only behaviors matter enough before a
# real deployment to prove rather than assume:
#
#   - APP_ENV=production with no real email provider configured must
#     NOT register the email-OTP routes at all (mock delivery must
#     never run in production).
#   - APP_ENV=production must select FirestoreChallengeStore, never
#     InMemoryChallengeStore (the whole point of the multi-instance
#     storage fix -- see docs/EMAIL_OTP.md's "Shared production
#     storage").
#
# Constructs a real FirebaseAccountOps with a syntactically valid but
# entirely fake, locally-generated service account key -- this never
# makes a network call (firebase_admin.initialize_app and
# firestore.client() are local object construction only), so no real
# Firebase project, credential, or connectivity is needed to prove
# these wiring decisions are correct.
from __future__ import annotations

import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.auth.reset import FirestoreRateLimiter, InMemoryRateLimiter
from app.config import Config
from app.main import build_auth_handler, build_email_otp_handlers
from app.otp.store import FirestoreChallengeStore, InMemoryChallengeStore


def _fake_service_account_json() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "test-project-fake",
            "private_key_id": "fake-key-id",
            "private_key": pem,
            "client_email": "fake@test-project-fake.iam.gserviceaccount.com",
            "client_id": "123456789",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
            "client_x509_cert_url": (
                "https://www.googleapis.com/robot/v1/metadata/x509/"
                "fake%40test-project-fake.iam.gserviceaccount.com"
            ),
        }
    )


_FAKE_SERVICE_ACCOUNT = _fake_service_account_json()


def _config(**overrides) -> Config:
    defaults = dict(
        port="8080",
        env="development",
        allowed_origins=[],
        firebase_service_account_json=_FAKE_SERVICE_ACCOUNT,
        otp_hmac_secret="test-hmac-secret",
        resend_api_key="",
        reset_email_from="",
    )
    defaults.update(overrides)
    return Config(**defaults)


def test_production_without_real_email_provider_registers_no_email_otp_routes():
    # The hard gate: APP_ENV=production plus a missing RESEND_API_KEY/
    # RESET_EMAIL_FROM must mean the routes don't exist at all -- never
    # a route that exists and silently falls back to mock delivery.
    cfg = _config(env="production")

    handlers = build_email_otp_handlers(cfg)

    assert handlers == (None, None, None, None)


def test_production_with_real_email_provider_selects_firestore_challenge_store():
    cfg = _config(
        env="production", resend_api_key="re_fake_key", reset_email_from="Darwesh Group <no-reply@x.com>"
    )

    send_handler, verify_handler, complete_handler, confirm_handler = build_email_otp_handlers(cfg)

    assert send_handler is not None
    assert isinstance(send_handler.service.store, FirestoreChallengeStore)
    # All four handlers must share the exact same store instance -- a
    # signup's /send, /verify, and /signup/complete (and password-reset's
    # /confirm) all need to see the same challenges/tokens.
    assert verify_handler.service.store is send_handler.service.store
    assert complete_handler.store is send_handler.service.store
    assert confirm_handler.store is send_handler.service.store


def test_production_with_real_email_provider_selects_firestore_rate_limiters():
    # INFRA-01 (INFRASTRUCTURE_REMEDIATION.md): production must use the
    # Firestore-backed rate limiter, never the in-memory one -- same
    # multi-instance reasoning as the challenge store above.
    cfg = _config(
        env="production", resend_api_key="re_fake_key", reset_email_from="Darwesh Group <no-reply@x.com>"
    )

    send_handler, verify_handler, complete_handler, _confirm_handler = build_email_otp_handlers(cfg)

    assert send_handler is not None
    assert isinstance(send_handler.ip_limiter, FirestoreRateLimiter)
    assert isinstance(send_handler.email_limiter, FirestoreRateLimiter)
    assert isinstance(verify_handler.ip_limiter, FirestoreRateLimiter)
    assert isinstance(complete_handler.ip_limiter, FirestoreRateLimiter)
    # Each limiter must be independently namespaced, even though several
    # key on the same value (the caller's IP) -- otherwise send/verify/
    # complete would silently share one counter.
    names = {
        send_handler.ip_limiter._name,
        send_handler.email_limiter._name,
        verify_handler.ip_limiter._name,
        complete_handler.ip_limiter._name,
    }
    assert len(names) == 4


def test_development_selects_in_memory_rate_limiters_even_with_a_real_looking_provider():
    cfg = _config(
        env="development", resend_api_key="re_fake_key", reset_email_from="Darwesh Group <no-reply@x.com>"
    )

    send_handler, *_ = build_email_otp_handlers(cfg)

    assert send_handler is not None
    assert isinstance(send_handler.ip_limiter, InMemoryRateLimiter)
    assert isinstance(send_handler.email_limiter, InMemoryRateLimiter)


def test_development_selects_in_memory_challenge_store_even_with_a_real_looking_provider():
    # Development never needs (or gets) the Firestore round-trip, even
    # if a real-looking email provider happens to be configured -- only
    # cfg.is_production decides the store, independent of the email
    # provider gate.
    cfg = _config(
        env="development", resend_api_key="re_fake_key", reset_email_from="Darwesh Group <no-reply@x.com>"
    )

    send_handler, *_ = build_email_otp_handlers(cfg)

    assert send_handler is not None
    assert isinstance(send_handler.service.store, InMemoryChallengeStore)


def test_production_with_no_json_key_and_no_firebase_project_id_registers_no_routes_at_all():
    # No JSON key AND no FIREBASE_PROJECT_ID -- build_firebase_credentials
    # refuses before even attempting Application Default Credentials
    # (there'd be no project to scope them to). Caught cleanly, routes
    # simply don't register -- same "route doesn't exist, not exists-
    # and-fails" contract as every other misconfiguration this backend
    # handles.
    cfg = _config(env="production", firebase_service_account_json="", resend_api_key="re_fake_key")

    handlers = build_email_otp_handlers(cfg)

    assert handlers == (None, None, None, None)


def test_production_with_adc_configured_but_no_real_adc_available_never_crashes_startup():
    # The critical regression case for the ADC switch: production, no
    # JSON key, a real FIREBASE_PROJECT_ID set (exactly the intended
    # Cloud Run configuration) -- but this test environment (like any
    # environment without a real GCP identity attached) has no actual
    # Application Default Credentials to find. This must degrade to a
    # clean, logged "not configured" outcome -- never an unhandled
    # exception that would crash the whole app at import time (app.main
    # constructs the ASGI app at module load, via
    # app = create_configured_app()).
    cfg = _config(
        env="production",
        firebase_service_account_json="",
        firebase_project_id="darwesh-group",
        resend_api_key="re_fake_key",
        reset_email_from="Darwesh Group <no-reply@x.com>",
    )

    handlers = build_email_otp_handlers(cfg)  # must not raise

    assert handlers == (None, None, None, None)


def test_password_reset_endpoint_production_with_adc_configured_but_unavailable_never_crashes_startup():
    # Same critical regression case as above, for the other Firebase-
    # Admin-authenticating wiring function -- build_auth_handler backs
    # the legacy link-based /api/v1/auth/forgot-password endpoint, and
    # went through the exact same JSON-key -> ADC-capable refactor.
    cfg = _config(
        env="production",
        firebase_service_account_json="",
        firebase_project_id="darwesh-group",
        resend_api_key="re_fake_key",
        reset_password_continue_url="https://www.darweshgroup.com/reset-password.html",
    )

    handler = build_auth_handler(cfg)  # must not raise

    assert handler is None


def test_password_reset_endpoint_still_works_with_a_service_account_key():
    # Regression check: the still-supported key-based path is unchanged.
    cfg = _config(
        env="production",
        resend_api_key="re_fake_key",
        reset_email_from="Darwesh Group <no-reply@x.com>",
        reset_password_continue_url="https://www.darweshgroup.com/reset-password.html",
    )

    handler = build_auth_handler(cfg)

    assert handler is not None


def test_password_reset_endpoint_production_selects_firestore_rate_limiter():
    # INFRA-01 (INFRASTRUCTURE_REMEDIATION.md): same multi-instance
    # reasoning as build_email_otp_handlers's limiters above -- this
    # endpoint's own limiter must also be Firestore-backed in production.
    cfg = _config(
        env="production",
        resend_api_key="re_fake_key",
        reset_email_from="Darwesh Group <no-reply@x.com>",
        reset_password_continue_url="https://www.darweshgroup.com/reset-password.html",
    )

    handler = build_auth_handler(cfg)

    assert handler is not None
    assert isinstance(handler.limiter, FirestoreRateLimiter)


def test_password_reset_endpoint_development_selects_in_memory_rate_limiter():
    cfg = _config(
        env="development",
        resend_api_key="re_fake_key",
        reset_email_from="Darwesh Group <no-reply@x.com>",
        reset_password_continue_url="https://www.darweshgroup.com/reset-password.html",
    )

    handler = build_auth_handler(cfg)

    assert handler is not None
    assert isinstance(handler.limiter, InMemoryRateLimiter)
