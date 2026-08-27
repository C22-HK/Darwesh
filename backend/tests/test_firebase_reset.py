import pytest

from app.auth.firebase_reset import extract_oob_code


def test_extract_oob_code_parses_real_firebase_link_format():
    # This is the actual link shape Firebase generates (observed in
    # production) -- routes through the project's firebaseapp.com
    # authDomain first, which is what this whole extraction step exists
    # to avoid exposing to the visitor.
    raw_link = (
        "https://darwesh-group.firebaseapp.com/__/auth/action?"
        "apiKey=AIzaSyBZQTkwRZNZL-HmNBx_i33QoSpSjIMin_8&mode=resetPassword&"
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
