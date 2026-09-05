from app.auth.resend_email import reset_email_html


def test_reset_email_html_escapes_the_link():
    # The link is user-influenced in the sense that it embeds a
    # server-generated oobCode -- this test exists to make sure a value
    # containing HTML-special characters can never break out of the href
    # attribute into the surrounding markup.
    link = 'https://www.darweshgroup.com/reset-password.html?oobCode=abc"><script>alert(1)</script>'
    out = reset_email_html(link)

    assert "<script>alert(1)</script>" not in out
    assert "&#34;" in out or "&quot;" in out


def test_reset_email_html_contains_expected_content():
    out = reset_email_html("https://www.darweshgroup.com/reset-password.html?oobCode=xyz")

    for want in (
        "Darwesh Group",
        "Reset Password",
        "oobCode=xyz",
        "can only be used once",
        "safely ignore this email",
    ):
        assert want in out
