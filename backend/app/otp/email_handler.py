# HTTP layer for the email-OTP signup and password-recovery flow. Three
# handlers here plus PasswordResetConfirmHandler (reused unchanged from
# app.otp.handler -- it was already channel-agnostic, see that module's
# header comment), four endpoints total (wired up in app/server.py):
#
#   POST /api/v1/auth/email-otp/send       {email, purpose}
#   POST /api/v1/auth/email-otp/verify     {email, purpose, code}  -> {verifyToken | resetToken}
#   POST /api/v1/auth/signup/complete      {verifyToken, fullName, phoneNumber, password,
#                                            requestedRole?, companyName?}
#   POST /api/v1/auth/password-reset/confirm  {resetToken, newPassword}   (app.otp.handler)
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

from app.auth.reset import RateLimiter
from app.otp.email_address import InvalidEmailAddress, normalize_email
from app.otp.firebase_admin_ops import AccountAlreadyExists, FirebaseAccountOps
from app.otp.phone import InvalidPhoneNumber, normalize_iraqi_phone
from app.otp.service import OtpService, Purpose, SendResult, VerifyResult
from app.otp.store import ChallengeStore

GENERIC_SEND_MESSAGE = "If this email is registered, a verification code has been sent."
_MIN_PASSWORD_LENGTH = 8
_MIN_NAME_LENGTH = 2
_MAX_COMPANY_NAME_LENGTH = 200
_ACCEPTED_PURPOSES = {"SIGNUP_EMAIL_VERIFY": Purpose.SIGNUP_EMAIL_VERIFY, "PASSWORD_RESET": Purpose.PASSWORD_RESET}
# The only two values a signup applicant may request -- never trusted as
# an actual role grant (see FirebaseAccountOps.create_user_profile),
# just a recorded signal an admin reviews before manually promoting the
# account. Any other value is rejected outright rather than silently
# coerced to "customer", so a client typo or a probing request never
# passes quietly.
_VALID_REQUESTED_ROLES = {"customer", "agent"}


def _slugify_company(name: str) -> str:
    """Turns a typed company name into a stable document id -- "Darwesh
    Group" -> "darwesh-group" -- so two signups with the same name land
    on the same companies/{id} doc without a manual Firestore edit."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "company"


async def _parse_json_body(request: Request) -> dict | None:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        return body if isinstance(body, dict) else None
    except json.JSONDecodeError:
        return None


def _parse_purpose(raw: object) -> Purpose | None:
    return _ACCEPTED_PURPOSES.get(raw) if isinstance(raw, str) else None


@dataclass
class EmailOtpSendHandler:
    service: OtpService
    ip_limiter: RateLimiter
    email_limiter: RateLimiter
    logger: logging.Logger

    async def send(self, request: Request) -> JSONResponse:
        body = await _parse_json_body(request)
        if body is None:
            return JSONResponse({"error": "Please provide a valid request body."}, status_code=400)

        purpose = _parse_purpose(body.get("purpose"))
        if purpose is None:
            return JSONResponse({"error": "Unsupported or missing purpose."}, status_code=400)

        try:
            email = normalize_email(str(body.get("email", "")))
        except InvalidEmailAddress:
            return JSONResponse({"error": "That email address doesn't look right."}, status_code=400)

        # Rate limit BEFORE resolving the account or calling the email
        # provider -- both matter once real Resend traffic is flowing
        # (real emails cost real send-volume) and this is exactly the
        # endpoint an attacker would hammer to enumerate accounts or
        # exhaust a quota.
        client_ip = request.client.host if request.client else "unknown"
        if not self.ip_limiter.allow(client_ip):
            return JSONResponse(
                {"error": "Too many requests. Please wait a while and try again."}, status_code=429
            )
        if not self.email_limiter.allow(email):
            return JSONResponse(
                {"error": "Too many requests for this email address. Please wait a while and try again."},
                status_code=429,
            )

        result = await self.service.send(email, purpose)
        if result == SendResult.COOLDOWN:
            return JSONResponse(
                {"error": "A code was already sent recently. Please wait before requesting another."},
                status_code=429,
            )
        # SENT and NOOP return the identical response -- see
        # OtpService.send's docstring on why NOOP must be
        # indistinguishable from SENT to the caller for PASSWORD_RESET.
        return JSONResponse({"message": GENERIC_SEND_MESSAGE}, status_code=200)


@dataclass
class EmailOtpVerifyHandler:
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
            email = normalize_email(str(body.get("email", "")))
        except InvalidEmailAddress:
            return JSONResponse({"error": "That email address doesn't look right."}, status_code=400)

        code = body.get("code", "")
        if not isinstance(code, str) or not code:
            return JSONResponse({"error": "Please provide the verification code."}, status_code=400)

        client_ip = request.client.host if request.client else "unknown"
        if not self.ip_limiter.allow(client_ip):
            return JSONResponse(
                {"error": "Too many requests. Please wait a while and try again."}, status_code=429
            )

        result, token = await self.service.verify(email, purpose, code)
        if result == VerifyResult.TOO_MANY_ATTEMPTS:
            return JSONResponse(
                {"error": "Too many incorrect attempts. Please request a new code."}, status_code=429
            )
        if result != VerifyResult.OK:
            return JSONResponse({"error": "That code is incorrect or has expired."}, status_code=400)

        # Same underlying token either way -- named differently per
        # purpose so each frontend flow (signup vs. forgot password)
        # gets the field name it actually expects.
        token_field = "verifyToken" if purpose == Purpose.SIGNUP_EMAIL_VERIFY else "resetToken"
        return JSONResponse({"message": "Verified.", token_field: token}, status_code=200)


@dataclass
class SignupCompleteHandler:
    """Consumes a verifyToken minted by EmailOtpVerifyHandler for
    SIGNUP_EMAIL_VERIFY and actually creates the Firebase account. The
    email is never taken from the request body -- only from the token
    the backend already bound to a verified address at OTP-verify time,
    so a client can never claim to have verified a different email than
    the one it actually proved ownership of."""

    store: ChallengeStore
    accounts: FirebaseAccountOps
    ip_limiter: RateLimiter
    logger: logging.Logger

    async def complete(self, request: Request) -> JSONResponse:
        body = await _parse_json_body(request)
        if body is None:
            return JSONResponse({"error": "Please provide a valid request body."}, status_code=400)

        client_ip = request.client.host if request.client else "unknown"
        if not self.ip_limiter.allow(client_ip):
            return JSONResponse(
                {"error": "Too many requests. Please wait a while and try again."}, status_code=429
            )

        token = body.get("verifyToken", "")
        full_name = body.get("fullName", "")
        password = body.get("password", "")
        phone_raw = body.get("phoneNumber", "")
        requested_role = body.get("requestedRole", "customer")
        company_name = body.get("companyName", "")

        if not isinstance(token, str) or not token:
            return JSONResponse({"error": "Missing or invalid verification token."}, status_code=400)
        if not isinstance(full_name, str) or len(full_name.strip()) < _MIN_NAME_LENGTH:
            return JSONResponse({"error": "Please provide your full name."}, status_code=400)
        if not isinstance(password, str) or len(password) < _MIN_PASSWORD_LENGTH:
            return JSONResponse(
                {"error": f"Password must be at least {_MIN_PASSWORD_LENGTH} characters."}, status_code=400
            )
        try:
            phone_e164 = normalize_iraqi_phone(str(phone_raw))
        except InvalidPhoneNumber:
            return JSONResponse({"error": "That phone number doesn't look right."}, status_code=400)
        if not isinstance(requested_role, str) or requested_role not in _VALID_REQUESTED_ROLES:
            return JSONResponse({"error": "Invalid requested role."}, status_code=400)
        company_id = None
        if requested_role == "agent":
            if not isinstance(company_name, str) or not company_name.strip():
                return JSONResponse(
                    {"error": "Please provide the company or agency you work for."}, status_code=400
                )
            if len(company_name.strip()) > _MAX_COMPANY_NAME_LENGTH:
                return JSONResponse(
                    {"error": f"Company name must be at most {_MAX_COMPANY_NAME_LENGTH} characters."},
                    status_code=400,
                )
            company_id = _slugify_company(company_name)

        # try_consume_reset_token atomically checks-and-marks the token
        # consumed in one store operation -- two concurrent requests
        # completing the same signup (a double-submitted form, a client
        # retry racing the original request, or a replay attempt) can
        # never both pass this check. Only the caller that wins may
        # proceed to create_account below; the loser sees exactly the
        # same response as an unknown/expired/already-used token, never
        # reaching Firebase at all.
        entry = await self.store.try_consume_reset_token(token)
        expired_msg = "This verification code has expired or already been used. Please start over."
        if entry is None:
            return JSONResponse({"error": expired_msg}, status_code=400)
        if entry.purpose != Purpose.SIGNUP_EMAIL_VERIFY.value:
            # Defense in depth: EmailOtpVerifyHandler only ever mints a
            # verifyToken for SIGNUP_EMAIL_VERIFY at this endpoint's call
            # site, so this branch isn't reachable today -- but it stops
            # a PASSWORD_RESET token from ever activating a signup by
            # accident, rather than relying solely on "nothing mints one
            # for the wrong purpose yet". The token is already consumed
            # above regardless of this check, so there's no reuse risk
            # either way.
            return JSONResponse({"error": expired_msg}, status_code=400)
        email = entry.identifier

        try:
            uid = await self.accounts.create_account(
                email=email, phone_e164=phone_e164, password=password, display_name=full_name.strip()
            )
        except AccountAlreadyExists as exc:
            # Normal, expected signup UX -- unlike password-reset
            # enumeration, telling a signup applicant their own email or
            # phone is already registered isn't a sensitive disclosure.
            # Nothing was created by this request, so there's nothing to
            # roll back.
            return JSONResponse({"error": f"An account with this {exc.field} already exists."}, status_code=409)
        except Exception as exc:
            self.logger.error("signup complete: account creation failed", extra={"error": str(exc)})
            return JSONResponse(
                {"error": "Could not create your account right now. Please try again."}, status_code=500
            )

        # From here on, `uid` is a genuinely fresh account create_account
        # just created for this request (Firebase Admin SDK's create_user
        # either fails outright or returns a brand-new, server-generated
        # uid -- there is no partial-success, no pre-existing account it
        # could refer to). If provisioning the required Firestore
        # profile fails, this is exactly the "orphan Auth account" case
        # to avoid: attempt a compensating rollback (delete the account
        # THIS request created, never any other) rather than silently
        # leaving a half-provisioned account behind.
        try:
            if company_id:
                await self.accounts.ensure_company(company_id, company_name.strip())
            await self.accounts.create_user_profile(
                uid,
                display_name=full_name.strip(),
                email=email,
                phone_e164=phone_e164,
                requested_role=requested_role,
                company_id=company_id,
            )
        except Exception as exc:
            self.logger.error(
                "signup complete: profile provisioning failed, rolling back auth account",
                extra={"error": str(exc), "uid_suffix": uid[-6:]},
            )
            try:
                await self.accounts.delete_account(uid)
            except Exception as rollback_exc:
                # Best-effort compensating action, not a distributed
                # transaction -- Firebase Auth and Firestore have no
                # shared transaction to roll back atomically. If the
                # rollback itself fails, the account is now a genuine
                # orphan (Auth account, no profile) that a retry with a
                # fresh verifyToken will correctly report as a 409
                # "already exists" against, rather than silently
                # duplicating -- but it does need a human to reconcile,
                # hence error level with enough to find it (never the
                # password, OTP, verifyToken, or any credential).
                self.logger.error(
                    "signup complete: rollback of orphaned auth account FAILED -- manual reconciliation required",
                    extra={"rollback_error": str(rollback_exc), "uid_suffix": uid[-6:]},
                )
            else:
                self.logger.info(
                    "signup complete: auth account rolled back after profile provisioning failure",
                    extra={"uid_suffix": uid[-6:]},
                )
            return JSONResponse(
                {"error": "Could not complete your signup right now. Please try again."}, status_code=500
            )

        try:
            custom_token = await self.accounts.mint_custom_token(uid)
        except Exception as exc:
            self.logger.error("signup complete: custom token minting failed", extra={"error": str(exc)})
            return JSONResponse(
                {"message": "Account created. Please log in.", "requiresLogin": True}, status_code=200
            )

        self.logger.info("signup complete: account created", extra={"uid_suffix": uid[-6:]})
        return JSONResponse(
            {"message": "Account created.", "customToken": custom_token, "uid": uid}, status_code=200
        )
