# Original Darwesh Group branded HTML for the two OTP emails (signup
# verification and password reset). Table-based layout with inline CSS,
# same technique app.auth.resend_email.reset_email_html already uses --
# not because it's 2005, but because that's still what reliably renders
# consistently across Gmail, Outlook, and mobile mail clients, none of
# which fully support modern CSS in email. Reuses this project's own
# established brand colors (from resend_email.py's existing template)
# for visual consistency across every email Darwesh Group sends -- the
# CyberShield UX concept (a card, a heading, a big code, an expiry note,
# a security warning) is followed at the level of "what sections does
# the email have", not copied as markup, styling, or wording.
from __future__ import annotations

import html

_BRAND_DARK = "#041627"
_BRAND_BG = "#f1f4f9"
_BRAND_CODE_BG = "#f1f4f9"
_BRAND_TEXT = "#181c20"
_BRAND_MUTED = "#44474c"
_BRAND_FAINT = "#9aa1ab"
_BRAND_WARN = "#775a19"


def _code_block(code: str) -> str:
    # Each digit visually separated via generous letter-spacing on a
    # monospace font, rather than six separate table cells -- renders
    # correctly across desktop, mobile, and dark-mode email clients
    # without depending on flex/grid support, which most clients lack.
    safe_code = html.escape(code)
    return f"""
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 24px;">
        <tr><td align="center" style="background-color:{_BRAND_CODE_BG}; border-radius:12px; padding:22px 12px;">
          <span style="font-family:'Courier New', Courier, monospace; font-size:34px; font-weight:700; letter-spacing:10px; color:{_BRAND_DARK};">{safe_code}</span>
        </td></tr>
      </table>"""


_EXPIRY_NOTE = f"""<p style="margin:0 0 16px; color:{_BRAND_MUTED}; font-size:13px; line-height:20px;">This code expires in <strong>10 minutes</strong>.</p>"""
_IGNORE_NOTE = f"""<p style="margin:0 0 12px; color:{_BRAND_FAINT}; font-size:12.5px; line-height:19px;">If you didn't request this, you can safely ignore this email.</p>"""
_SECURITY_NOTE = f"""<p style="margin:0; color:{_BRAND_WARN}; font-size:12.5px; line-height:19px;">For your security, never share this code with anyone -- Darwesh Group staff will never ask you for it.</p>"""


def _base_email(preheader: str, heading: str, body_html: str) -> str:
    safe_preheader = html.escape(preheader, quote=False)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0; padding:0; background-color:{_BRAND_BG}; font-family:Arial, Helvetica, sans-serif;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">{safe_preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{_BRAND_BG}; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#ffffff; border-radius:16px; overflow:hidden;">
        <tr><td style="background-color:{_BRAND_DARK}; padding:28px 32px;">
          <span style="color:#ffffff; font-size:20px; font-weight:700; letter-spacing:0.3px;">Darwesh Group</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px; color:{_BRAND_TEXT}; font-size:20px;">{html.escape(heading, quote=False)}</h1>
          {body_html}
        </td></tr>
        <tr><td style="padding:20px 32px; background-color:#f7f9ff; border-top:1px solid #e5e8ee;">
          <p style="margin:0; color:{_BRAND_FAINT}; font-size:11.5px; line-height:17px;">
            &copy; Darwesh Group. All rights reserved.<br/>
            www.darweshgroup.com &middot; This is an automated security email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def render_signup_verify_email(code: str) -> tuple[str, str]:
    """Returns (subject, html_body)."""
    body = f"""
      <p style="margin:0 0 20px; color:{_BRAND_MUTED}; font-size:14px; line-height:22px;">
        Use the code below to complete your Darwesh Group signup:
      </p>
      {_code_block(code)}
      {_EXPIRY_NOTE}
      {_IGNORE_NOTE}
      {_SECURITY_NOTE}
    """
    return "Verify your Darwesh Group account", _base_email(
        "Your Darwesh Group verification code", "Verify it's you", body
    )


def render_password_reset_email(code: str) -> tuple[str, str]:
    """Returns (subject, html_body). Distinct wording from the signup
    email throughout -- a user should never wonder which action this
    code is for."""
    body = f"""
      <p style="margin:0 0 20px; color:{_BRAND_MUTED}; font-size:14px; line-height:22px;">
        Use the code below to reset your Darwesh Group password:
      </p>
      {_code_block(code)}
      {_EXPIRY_NOTE}
      {_IGNORE_NOTE}
      {_SECURITY_NOTE}
    """
    return "Reset your Darwesh Group password", _base_email(
        "Your Darwesh Group password reset code", "Reset your password", body
    )
