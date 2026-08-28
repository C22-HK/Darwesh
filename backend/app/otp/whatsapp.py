# WhatsApp message delivery, behind a small Protocol so OTP logic never
# depends on a specific provider's SDK/REST shape. See
# docs/WHATSAPP_OTP.md for what's required to add a real provider
# (Meta Cloud API / Twilio / etc.) -- deliberately not implemented here
# without a chosen provider and real credentials to build and test
# against; inventing an untested integration against a guessed API shape
# would be worse than not having one.
#
# Superseded: the product requirement moved to email OTP
# (docs/EMAIL_OTP.md, app/otp/email_sender.py). Nothing here is wired
# into app.main anymore and no WhatsApp provider was ever activated in
# production. Left in place as a reusable component if phone-channel
# OTP is ever revisited.
from __future__ import annotations

from typing import Protocol


class WhatsAppSender(Protocol):
    async def send_otp_message(self, phone_e164: str, code: str) -> None: ...


class MockWhatsAppSender:
    """Local/test-only stand-in. Delivers nothing anywhere -- records
    what it *would* have sent in memory so tests can assert on it
    without any real credentials. app.main only builds one of these when
    WHATSAPP_PROVIDER is unset or explicitly "mock" (the default), and
    logs a loud warning on startup if that happens while APP_ENV is
    "production" -- see app/main.py's build_otp_service. This is exactly
    the "mock provider for local testing, clearly mark production phone
    recovery as not enabled" state the real WhatsApp integration hasn't
    reached yet."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send_otp_message(self, phone_e164: str, code: str) -> None:
        # Deliberately not logged at any level, even here -- this stand-in
        # should behave identically to how the real provider integration
        # must behave with respect to what ends up in logs (see
        # OtpService.send, which never logs the code either).
        self.sent.append((phone_e164, code))
