from __future__ import annotations

from app.otp.email_templates import render_password_reset_email, render_signup_verify_email

CODE = "160708"


def _assert_mobile_friendly_and_branded(html_body: str) -> None:
    assert '<meta name="viewport" content="width=device-width, initial-scale=1.0">' in html_body
    assert "Darwesh Group" in html_body
    assert "max-width:480px" in html_body  # single-column card, not a fixed desktop-width layout
    assert "<!DOCTYPE html>" in html_body


def _assert_common_security_content(html_body: str, code: str) -> None:
    assert code in html_body
    assert "10 minutes" in html_body
    assert "never share this code" in html_body.lower()
    assert "safely ignore this email" in html_body.lower()


def test_signup_verify_email_renders_expected_content():
    subject, html_body = render_signup_verify_email(CODE)

    assert subject == "Verify your Darwesh Group account"
    assert "Verify it's you" in html_body
    _assert_mobile_friendly_and_branded(html_body)
    _assert_common_security_content(html_body, CODE)
    assert "signup" in html_body.lower()


def test_password_reset_email_renders_expected_content():
    subject, html_body = render_password_reset_email(CODE)

    assert subject == "Reset your Darwesh Group password"
    assert "Reset your password" in html_body
    _assert_mobile_friendly_and_branded(html_body)
    _assert_common_security_content(html_body, CODE)
    assert "reset your darwesh group password" in html_body.lower()


def test_signup_and_reset_emails_have_distinct_wording():
    _, signup_html = render_signup_verify_email(CODE)
    _, reset_html = render_password_reset_email(CODE)

    assert signup_html != reset_html
    assert "complete your Darwesh Group signup" in signup_html
    assert "complete your Darwesh Group signup" not in reset_html
    assert "reset your darwesh group password" in reset_html.lower()


def test_code_is_html_escaped_defensively():
    # The code is always a 6-digit numeric string in practice (see
    # app/otp/codes.py) so this can't be exploited today, but the
    # renderer escapes it anyway rather than trusting that invariant
    # silently -- a template shouldn't be one refactor away from
    # becoming injectable.
    _, html_body = render_signup_verify_email("<script>1</script>")
    assert "<script>" not in html_body
    assert "&lt;script&gt;" in html_body


def test_no_external_or_sensitive_information_embedded():
    for renderer in (render_signup_verify_email, render_password_reset_email):
        _, html_body = renderer(CODE)
        assert "api_key" not in html_body.lower()
        assert "resend" not in html_body.lower()
        assert "firebase" not in html_body.lower()
        assert "cybershield" not in html_body.lower()
