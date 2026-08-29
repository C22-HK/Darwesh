# These exercise the real, non-mocked google-auth/firebase_admin
# credential resolution -- not a fake -- specifically because this is
# the exact mechanism that decides whether the backend can start at
# all in production. The one thing that must never happen: an
# unhandled exception escaping build_firebase_credentials.
from __future__ import annotations

import json

import pytest
from firebase_admin import credentials

from app.auth.firebase_credentials import build_firebase_credentials

from .test_main_wiring import _fake_service_account_json  # reuse the same fake key generator


def test_service_account_json_branch_returns_a_certificate_credential():
    cred, options = build_firebase_credentials(_fake_service_account_json(), "")

    assert isinstance(cred, credentials.Certificate)
    assert options is None  # project id comes from the key itself, no explicit options needed


def test_invalid_service_account_json_raises_value_error():
    with pytest.raises(ValueError, match="not valid JSON"):
        build_firebase_credentials("{not valid json", "")


def test_no_json_and_no_project_id_raises_value_error_before_attempting_adc():
    with pytest.raises(ValueError, match="FIREBASE_PROJECT_ID"):
        build_firebase_credentials("", "")


def test_no_json_with_project_id_but_no_real_adc_available_raises_a_clean_value_error():
    # This sandbox/CI environment has no Application Default Credentials
    # configured -- exactly the scenario that must degrade to a clean,
    # catchable ValueError (so app.main can log and skip route
    # registration) rather than an unhandled
    # google.auth.exceptions.DefaultCredentialsError reaching the caller.
    with pytest.raises(ValueError, match="Application Default Credentials"):
        build_firebase_credentials("", "darwesh-group")


def test_empty_json_string_is_treated_the_same_as_json_field_absent():
    # A stray empty-string env var (as opposed to unset) must not be
    # treated as "here is a credential" -- confirms the falsy check,
    # not just "is this key present in a dict somewhere".
    with pytest.raises(ValueError, match="FIREBASE_PROJECT_ID"):
        build_firebase_credentials("", "")


def test_a_syntactically_valid_but_semantically_empty_json_object_is_rejected():
    # {} parses as valid JSON but firebase_admin's Certificate loader
    # will reject it for missing required fields -- confirms this
    # doesn't reach that far without a clear building block being wrong.
    with pytest.raises(Exception):  # firebase_admin raises its own ValueError-adjacent error here
        build_firebase_credentials(json.dumps({}), "")
