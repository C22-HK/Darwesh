# ResendEmailSender sends the branded password-reset email via the Resend
# API (https://resend.com). Chosen as the example provider in
# docs/BACKEND_MILESTONES.md; swapping to SendGrid/Postmark/etc. later
# only means writing a new class that satisfies the EmailSender protocol
# (app/auth/reset.py) -- nothing else in this package needs to change.
from __future__ import annotations

import html

import httpx

_RESEND_URL = "https://api.resend.com/emails"
_TIMEOUT_SECONDS = 10.0


class ResendEmailSender:
    def __init__(self, api_key: str, from_header: str) -> None:
        """Validates its inputs the same way FirebaseResetLinkGenerator
        does -- refuses to start rather than silently pretending emails
        are being sent."""
        if not api_key:
            raise ValueError("RESEND_API_KEY is not set")
        if not from_header:
            raise ValueError("RESET_EMAIL_FROM is not set")
        self._api_key = api_key
        self._from_header = from_header

    async def send_reset_email(self, to_email: str, reset_link: str) -> None:
        payload = {
            "from": self._from_header,
            "to": [to_email],
            "subject": "Reset your Darwesh Group password",
            "html": reset_email_html(reset_link),
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            try:
                response = await client.post(_RESEND_URL, json=payload, headers=headers)
            except httpx.HTTPError as exc:
                raise RuntimeError(f"sending email: {exc}") from exc

        if response.status_code >= 300:
            # Deliberately not including the response body in the error
            # -- it could echo back the recipient address or other
            # request details, and this error only ever reaches
            # server-side logs (see app/auth/reset.py's handler, which
            # never surfaces send failures to the HTTP caller), so
            # there's no debugging benefit worth the risk of it ending up
            # somewhere it shouldn't.
            raise RuntimeError(f"email provider returned status {response.status_code}")


def reset_email_html(reset_link: str) -> str:
    """Renders the branded email body. Uses inline CSS and table-based
    layout -- not because it's 2005, but because that's still what
    reliably renders consistently across Gmail, Outlook, and mobile mail
    clients, none of which fully support modern CSS in email."""
    safe_link = html.escape(reset_link, quote=True)
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f1f4f9; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f4f9; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#ffffff; border-radius:16px; overflow:hidden;">
        <tr><td style="background-color:#041627; padding:28px 32px;">
          <span style="color:#ffffff; font-size:20px; font-weight:700;">Darwesh Group</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px; color:#181c20; font-size:20px;">Reset your password</h1>
          <p style="margin:0 0 20px; color:#44474c; font-size:14px; line-height:22px;">Hello,</p>
          <p style="margin:0 0 24px; color:#44474c; font-size:14px; line-height:22px;">
            We received a request to reset the password for your Darwesh Group account.
            Click the secure button below to choose a new password.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px; background-color:#041627;">
            <a href="{safe_link}" style="display:inline-block; padding:14px 28px; color:#ffffff; font-size:14px; font-weight:700; text-decoration:none; border-radius:8px;">Reset Password</a>
          </td></tr></table>
          <p style="margin:28px 0 0; color:#775a19; font-size:12.5px; line-height:19px;">
            For your security, this link is temporary and can only be used once.
          </p>
          <p style="margin:12px 0 0; color:#9aa1ab; font-size:12.5px; line-height:19px;">
            If you didn't request a password reset, you can safely ignore this email. Your account will remain secure.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px; background-color:#f7f9ff; border-top:1px solid #e5e8ee;">
          <p style="margin:0; color:#9aa1ab; font-size:11.5px; line-height:17px;">
            &copy; Darwesh Group. All rights reserved.<br/>
            www.darweshgroup.com &middot; This is an automated security email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""
