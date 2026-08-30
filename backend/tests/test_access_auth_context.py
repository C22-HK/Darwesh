# Tests app.access.auth_context: bearer-token extraction (pure), and
# FirebaseIdTokenVerifier's failure-mode mapping (every Admin SDK
# exception -> None, never raised past this layer), using a mocked
# fb_auth.verify_id_token -- no real Firebase project or network call
# needed, same "local object construction only" spirit as
# test_main_wiring.py's fake service account key.
from __future__ import annotations

import logging
from unittest.mock import patch

from fastapi import Request
from firebase_admin import auth as fb_auth

from app.access.auth_context import AuthenticatedCaller, FirebaseIdTokenVerifier, extract_bearer_token


def _make_request(headers: dict[str, str]) -> Request:
    raw_headers = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    scope = {"type": "http", "headers": raw_headers, "method": "GET", "path": "/"}
    return Request(scope)


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.access.auth")
    logger.addHandler(logging.NullHandler())
    return logger


def test_extract_bearer_token_reads_authorization_header():
    request = _make_request({"Authorization": "Bearer abc123"})
    assert extract_bearer_token(request) == "abc123"


def test_extract_bearer_token_missing_header_returns_none():
    request = _make_request({})
    assert extract_bearer_token(request) is None


def test_extract_bearer_token_wrong_scheme_returns_none():
    request = _make_request({"Authorization": "Basic abc123"})
    assert extract_bearer_token(request) is None


def test_extract_bearer_token_empty_token_returns_none():
    request = _make_request({"Authorization": "Bearer "})
    assert extract_bearer_token(request) is None


async def test_verify_empty_token_returns_none_without_calling_firebase():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token") as mocked:
        result = await verifier.verify("")
    assert result is None
    mocked.assert_not_called()


async def test_verify_valid_token_returns_authenticated_caller():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token", return_value={"uid": "user-123", "email": "a@example.com"}):
        result = await verifier.verify("a-real-looking-token")
    assert result == AuthenticatedCaller(uid="user-123", email="a@example.com")


async def test_verify_token_with_no_email_claim_still_succeeds():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token", return_value={"uid": "user-123"}):
        result = await verifier.verify("token")
    assert result == AuthenticatedCaller(uid="user-123", email=None)


async def test_verify_expired_token_returns_none():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token", side_effect=fb_auth.ExpiredIdTokenError("expired", cause=None)):
        result = await verifier.verify("token")
    assert result is None


async def test_verify_invalid_token_returns_none():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token", side_effect=fb_auth.InvalidIdTokenError("bad token")):
        result = await verifier.verify("token")
    assert result is None


async def test_verify_revoked_token_returns_none():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token", side_effect=fb_auth.RevokedIdTokenError("revoked")):
        result = await verifier.verify("token")
    assert result is None


async def test_verify_disabled_user_returns_none():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token", side_effect=fb_auth.UserDisabledError("disabled")):
        result = await verifier.verify("token")
    assert result is None


async def test_verify_certificate_fetch_error_returns_none_not_raises():
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(
        fb_auth, "verify_id_token", side_effect=fb_auth.CertificateFetchError("net down", cause=None)
    ):
        result = await verifier.verify("token")
    assert result is None


async def test_verify_decoded_token_without_uid_returns_none():
    # Defense in depth: verify_id_token is documented to always include
    # a uid in a successfully verified token, but this must never crash
    # or fabricate an identity if that assumption is ever violated.
    verifier = FirebaseIdTokenVerifier(app=object(), logger=make_test_logger())
    with patch.object(fb_auth, "verify_id_token", return_value={"email": "a@example.com"}):
        result = await verifier.verify("token")
    assert result is None
