# Email delivery for OTP codes, behind app.otp.service.OtpSender so OTP
# logic never depends on a specific provider's SDK/REST shape. Mirrors
# app.auth.resend_email.ResendEmailSender's own validation and error-
# hiding pattern deliberately -- same provider, same account, just a
# different template shape (a 6-digit code embedded in HTML rather than
# a clickable link), so a fresh small class follows the existing one's
# proven pattern rather than forcing an awkward shared interface between
# two genuinely different email shapes.
from __future__ import annotations

import httpx

from app.otp.email_templates import render_password_reset_email, render_signup_verify_email
from app.otp.service import Purpose

_RESEND_URL = "https://api.resend.com/emails"
_TIMEOUT_SECONDS = 10.0


class MockEmailSender:
    """Local/test-only stand-in -- delivers nothing anywhere. Records
    what it would have sent in memory so tests can assert on it without
    any real credentials. app.main.build_email_otp_handlers only builds
    one of these when RESEND_API_KEY/RESET_EMAIL_FROM aren't both set,
    and -- unlike the earlier WhatsApp-OTP phase's warn-and-continue
    approach -- refuses to start the email-OTP routes at all rather than
    running this in APP_ENV=production. Mock email delivery must never
    run in production."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str]] = []  # (identifier, code, purpose)

    async def send_otp(self, identifier: str, code: str, purpose: Purpose) -> None:
        # Deliberately not logged at any level, even here -- this stand-in
        # behaves identically to the real sender with respect to what
        # ends up in logs (see OtpService.send, which never logs the
        # code either).
        self.sent.append((identifier, code, purpose.value))


class ResendOtpEmailSender:
    """Real implementation, backed by the Resend API
    (https://resend.com) -- the same provider and account
    app.auth.resend_email.ResendEmailSender already uses for the
    link-based password-reset email, just a different template
    per purpose."""

    def __init__(self, api_key: str, from_header: str) -> None:
        if not api_key:
            raise ValueError("RESEND_API_KEY is not set")
        if not from_header:
            raise ValueError("RESET_EMAIL_FROM is not set")
        self._api_key = api_key
        self._from_header = from_header

    async def send_otp(self, identifier: str, code: str, purpose: Purpose) -> None:
        subject, html_body = (
            render_signup_verify_email(code)
            if purpose == Purpose.SIGNUP_EMAIL_VERIFY
            else render_password_reset_email(code)
        )
        payload = {"from": self._from_header, "to": [identifier], "subject": subject, "html": html_body}
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            try:
                response = await client.post(_RESEND_URL, json=payload, headers=headers)
            except httpx.HTTPError as exc:
                raise RuntimeError(f"sending OTP email: {exc}") from exc

        if response.status_code >= 300:
            # Deliberately not including the response body -- it could
            # echo back the recipient address, and this error only ever
            # reaches server-side logs (OtpService.send never surfaces a
            # delivery failure to the HTTP caller), so there's no
            # debugging benefit worth that risk.
            raise RuntimeError(f"email provider returned status {response.status_code}")
