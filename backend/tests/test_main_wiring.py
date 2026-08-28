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

from app.config import Config
from app.main import build_email_otp_handlers
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


def test_production_missing_firebase_credential_registers_no_routes_at_all():
    cfg = _config(env="production", firebase_service_account_json="", resend_api_key="re_fake_key")

    handlers = build_email_otp_handlers(cfg)

    assert handlers == (None, None, None, None)
