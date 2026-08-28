# HTTP layer for the WhatsApp-OTP password-recovery flow. Three
# handlers, three endpoints (wired up in app/server.py):
#
#   POST /api/v1/auth/otp/send            {phoneNumber, purpose}
#   POST /api/v1/auth/otp/verify          {phoneNumber, purpose, code}   -> {resetToken}
#   POST /api/v1/auth/password-reset/confirm  {resetToken, newPassword}
#
# Only PASSWORD_RESET is accepted as `purpose` today -- see
# app/otp/service.py's Purpose enum for why SIGNUP already exists there
# but isn't reachable from here yet.
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

from app.auth.reset import RateLimiter
from app.otp.firebase_admin_ops import PasswordResetExecutor
from app.otp.phone import InvalidPhoneNumber, normalize_iraqi_phone
from app.otp.service import OtpService, Purpose, SendResult, VerifyResult
from app.otp.store import ChallengeStore

GENERIC_SEND_MESSAGE = "If this phone number is registered, a verification code has been sent via WhatsApp."
_MIN_PASSWORD_LENGTH = 8
_ACCEPTED_PURPOSES = {"PASSWORD_RESET": Purpose.PASSWORD_RESET}


async def _parse_json_body(request: Request) -> dict | None:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        if not isinstance(body, dict):
            return None
        return body
    except json.JSONDecodeError:
        return None


def _parse_purpose(raw: object) -> Purpose | None:
    if not isinstance(raw, str):
        return None
    return _ACCEPTED_PURPOSES.get(raw)


@dataclass
class OtpSendHandler:
    service: OtpService
    ip_limiter: RateLimiter
    phone_limiter: RateLimiter
    logger: logging.Logger

    async def send(self, request: Request) -> JSONResponse:
        body = await _parse_json_body(request)
        if body is None:
            return JSONResponse({"error": "Please provide a valid request body."}, status_code=400)

        purpose = _parse_purpose(body.get("purpose"))
        if purpose is None:
            return JSONResponse({"error": "Unsupported or missing purpose."}, status_code=400)

        try:
            phone = normalize_iraqi_phone(str(body.get("phoneNumber", "")))
        except InvalidPhoneNumber:
            return JSONResponse({"error": "That phone number doesn't look right."}, status_code=400)

        # Rate limit BEFORE resolving the phone or calling the WhatsApp
        # API -- both matter once a real provider is wired in (real
        # messages cost real money) and this is exactly the endpoint an
        # attacker would hammer to enumerate phones or exhaust a quota.
        client_ip = request.client.host if request.client else "unknown"
        if not self.ip_limiter.allow(client_ip):
            return JSONResponse(
                {"error": "Too many requests. Please wait a while and try again."}, status_code=429
            )
        if not self.phone_limiter.allow(phone):
            return JSONResponse(
                {"error": "Too many requests for this phone number. Please wait a while and try again."},
                status_code=429,
            )

        result = await self.service.send(phone, purpose)
        if result == SendResult.COOLDOWN:
            return JSONResponse(
                {"error": "A code was already sent recently. Please wait before requesting another."},
                status_code=429,
            )
        # SENT and NOOP return the identical response -- see
        # OtpService.send's docstring on why NOOP must be
        # indistinguishable from SENT to the caller.
        return JSONResponse({"message": GENERIC_SEND_MESSAGE}, status_code=200)


@dataclass
class OtpVerifyHandler:
    service: OtpService
    ip_limiter: RateLimiter
    logger: logging.Logger

    async def verify(self, request: Request) -> JSONResponse:
        body = await _parse_json_body(request)
        if body is None:
            return JSONResponse({"error": "Please provide a valid request body."}, status_code=400)

        purpose = _parse_purpose(body.get("purpose"))
        if purpose is None:
            return JSONResponse({"error": "Unsupported or missing purpose."}, status_code=400)

        try:
            phone = normalize_iraqi_phone(str(body.get("phoneNumber", "")))
        except InvalidPhoneNumber:
            return JSONResponse({"error": "That phone number doesn't look right."}, status_code=400)

        code_raw = body.get("code", "")
        if not isinstance(code_raw, str) or not code_raw:
            return JSONResponse({"error": "Please provide the verification code."}, status_code=400)

        client_ip = request.client.host if request.client else "unknown"
        if not self.ip_limiter.allow(client_ip):
            return JSONResponse(
                {"error": "Too many requests. Please wait a while and try again."}, status_code=429
            )

        result, reset_token = self.service.verify(phone, purpose, code_raw)
        if result == VerifyResult.TOO_MANY_ATTEMPTS:
            return JSONResponse(
                {"error": "Too many incorrect attempts. Please request a new code."}, status_code=429
            )
        if result != VerifyResult.OK:
            return JSONResponse({"error": "That code is incorrect or has expired."}, status_code=400)

        return JSONResponse({"message": "Verified.", "resetToken": reset_token}, status_code=200)


@dataclass
class PasswordResetConfirmHandler:
    """Consumes a resetToken minted by OtpVerifyHandler and sets the new
    password. The token IS the authorization: it already carries which
    Firebase UID it's bound to, resolved once at OTP-send time via
    get_user_by_phone_number, so this endpoint never accepts (and never
    needs) a phone number, UID, or Firebase Admin credential from the
    caller -- the browser only ever sees a phone number and an opaque
    token, never the mapping between them."""

    store: ChallengeStore
    firebase: PasswordResetExecutor
    logger: logging.Logger

    async def confirm(self, request: Request) -> JSONResponse:
        body = await _parse_json_body(request)
        if body is None:
            return JSONResponse({"error": "Please provide a valid request body."}, status_code=400)

        token = body.get("resetToken", "")
        new_password = body.get("newPassword", "")
        if not isinstance(token, str) or not token:
            return JSONResponse({"error": "Missing or invalid reset token."}, status_code=400)
        if not isinstance(new_password, str) or len(new_password) < _MIN_PASSWORD_LENGTH:
            return JSONResponse(
                {"error": f"Password must be at least {_MIN_PASSWORD_LENGTH} characters."}, status_code=400
            )

        entry = self.store.get_reset_token(token)
        _EXPIRED_MSG = "This reset link has expired or already been used. Please request a new code."
        if entry is None or entry.consumed or entry.expires_at < time.time():
            return JSONResponse({"error": _EXPIRED_MSG}, status_code=400)
        if entry.purpose != Purpose.PASSWORD_RESET.value:
            # Defense in depth: OtpVerifyHandler only ever mints a
            # resetToken for PASSWORD_RESET today (SIGNUP isn't accepted
            # at the HTTP layer yet), so this branch isn't reachable --
            # but it stops a future purpose's token from ever being
            # usable here by accident, rather than relying solely on
            # "nothing mints one yet."
            return JSONResponse({"error": _EXPIRED_MSG}, status_code=400)

        # Consume immediately, before calling Firebase -- a token can
        # authorize at most one reset attempt even if the Firebase call
        # below fails partway and the caller retries.
        self.store.consume_reset_token(token)

        try:
            await self.firebase.set_password_and_revoke_sessions(entry.uid, new_password)
        except Exception as exc:
            self.logger.error("password reset: firebase update failed", extra={"error": str(exc)})
            return JSONResponse(
                {"error": "Could not reset your password right now. Please try again."}, status_code=500
            )

        # Never log the uid in full or the password/token -- last 6
        # chars is enough to correlate log lines for one investigation
        # without printing an identifier that's otherwise unnecessary.
        self.logger.info("password reset: success", extra={"uid_suffix": entry.uid[-6:]})
        return JSONResponse(
            {"message": "Your password has been reset. Please log in with your new password."}, status_code=200
        )
