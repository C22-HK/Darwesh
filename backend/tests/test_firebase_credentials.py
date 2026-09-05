# These exercise the real, non-mocked google-auth/firebase_admin
# credential resolution -- not a fake -- specifically because this is
# the exact mechanism that decides whether the backend can start at
# all in production. The one thing that must never happen: an
# unhandled exception escaping build_firebase_credentials.
from __future__ import annotations

import gc
import json

import pytest
from firebase_admin import credentials

from app.auth.firebase_credentials import build_firebase_credentials, unique_app_name
from app.otp.firebase_admin_ops import FirebaseAccountOps

# _fake_service_account_json generates a fresh fake key; _FAKE_SERVICE_ACCOUNT
# is one generated once at import, reused where the loop below needs many
# constructions without paying for RSA keygen each time.
from .test_main_wiring import _FAKE_SERVICE_ACCOUNT, _fake_service_account_json


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


def test_unique_app_name_never_hands_out_the_same_name_twice():
    names = [unique_app_name("darwesh-test") for _ in range(500)]

    assert len(set(names)) == len(names)
    assert all(n.startswith("darwesh-test-") for n in names)


def test_repeatedly_constructing_and_dropping_a_client_does_not_collide_on_the_app_name():
    # Regression test for an intermittent CI failure. These app names
    # were once built from id(self), which is only unique among objects
    # alive at the same time -- but firebase_admin's app registry is
    # process-global and nothing here ever deletes from it, so an entry
    # outlives the object whose address named it. Construct, drop,
    # construct again (exactly what a test suite does) and CPython
    # eventually reuses the address, producing a name the registry
    # already holds and a "Firebase app named ... already exists"
    # ValueError.
    #
    # Deliberately does NOT delete the apps it creates: leaving them in
    # the registry is precisely the condition that makes a reused
    # address collide, so cleaning up here would hide the bug this test
    # exists to catch.
    seen_addresses = set()
    reused_at_least_once = False

    for _ in range(60):
        ops = FirebaseAccountOps(_FAKE_SERVICE_ACCOUNT, "test-project-fake")
        address = id(ops)
        if address in seen_addresses:
            reused_at_least_once = True
        seen_addresses.add(address)
        del ops
        gc.collect()

    # Guards the test itself: if CPython never recycled an address, the
    # loop above never exercised the failure condition and passing would
    # mean nothing.
    assert reused_at_least_once, "no address was reused -- the collision condition was never reached"
