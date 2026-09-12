import pytest

from app.auth.firebase_reset import FirebaseResetLinkGenerator, extract_oob_code

from .test_main_wiring import _fake_service_account_json


def test_extract_oob_code_parses_real_firebase_link_format():
    # This is the actual link shape Firebase generates (observed in
    # production) -- routes through the project's firebaseapp.com
    # authDomain first, which is what this whole extraction step exists
    # to avoid exposing to the visitor.
    # apiKey here is a placeholder, not the real project key -- this test
    # only exercises URL/query-string parsing (extract_oob_code), which
    # doesn't read or care about the apiKey value at all; a real key was
    # never needed here and duplicating it was flagged by GitHub secret
    # scanning as an unnecessary hardcoded copy (see
    # BUSINESS_LOGIC_REMEDIATION.md's credential-remediation section).
    raw_link = (
        "https://darwesh-group.firebaseapp.com/__/auth/action?"
        "apiKey=FAKE-TEST-API-KEY-NOT-A-REAL-CREDENTIAL&mode=resetPassword&"
        "oobCode=85icZixsIrOUaSTdEjxDStVT8cu5DrY6QogRfpAyV5UAAAGgPzO7rw&"
        "continueUrl=https://www.darweshgroup.com/reset-password.html&lang=en"
    )

    code = extract_oob_code(raw_link)

    assert code == "85icZixsIrOUaSTdEjxDStVT8cu5DrY6QogRfpAyV5UAAAGgPzO7rw"


def test_extract_oob_code_missing_code_returns_error():
    with pytest.raises(ValueError):
        extract_oob_code("https://darwesh-group.firebaseapp.com/__/auth/action?mode=resetPassword")


def test_extract_oob_code_malformed_url_returns_error():
    with pytest.raises(ValueError):
        extract_oob_code("://not a url")


def test_constructs_successfully_with_a_service_account_key():
    # Regression check: the ADC-aware refactor must not change the
    # existing, still-supported service-account-key path at all.
    generator = FirebaseResetLinkGenerator(_fake_service_account_json(), "https://www.darweshgroup.com/reset")
    assert generator is not None


def test_missing_continue_url_raises_before_touching_credentials_at_all():
    with pytest.raises(ValueError, match="RESET_PASSWORD_CONTINUE_URL"):
        FirebaseResetLinkGenerator(_fake_service_account_json(), "")


def test_no_key_and_no_project_id_raises_a_clean_value_error():
    with pytest.raises(ValueError, match="FIREBASE_PROJECT_ID"):
        FirebaseResetLinkGenerator("", "https://www.darweshgroup.com/reset")


def test_no_key_with_project_id_but_no_real_adc_raises_a_clean_value_error():
    # No Application Default Credentials exist in this test environment
    # -- must degrade to a catchable ValueError, never an unhandled
    # google.auth exception.
    with pytest.raises(ValueError, match="Application Default Credentials"):
        FirebaseResetLinkGenerator("", "https://www.darweshgroup.com/reset", "darwesh-group")
