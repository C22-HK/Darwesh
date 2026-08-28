# The only component in the OTP package that talks to the Firebase
# Admin SDK: resolving a verified phone number to the Firebase UID that
# owns it, and -- once a reset has been authorized by OTP verification --
# setting a new password on that exact UID and revoking its existing
# sessions. Mirrors app.auth.firebase_reset.FirebaseResetLinkGenerator's
# own uniquely-named-app pattern so the two can coexist in the same
# process (and in the same pytest run) without colliding on Firebase
# Admin SDK's single-app-per-name rule.
from __future__ import annotations

import asyncio
import json
from typing import Protocol

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials


class UidResolver(Protocol):
    """Resolves a normalized phone number to the Firebase UID that has it
    as a verified phone_number on their Auth record, or None if no
    account does. Production implementation below calls
    firebase_admin.auth.get_user_by_phone_number; tests use a fake."""

    async def resolve(self, phone_e164: str) -> str | None: ...


class PasswordResetExecutor(Protocol):
    """Performs the actual, authoritative password change and session
    revocation once OtpService has already verified the OTP and bound a
    reset token to a specific uid. Never sees a plaintext OTP, and never
    receives anything from the browser directly -- only called by
    app.otp.handler.PasswordResetHandler with a uid it already resolved
    server-side."""

    async def set_password_and_revoke_sessions(self, uid: str, new_password: str) -> None: ...


class FirebasePhoneAuthManager:
    """Real implementation of both UidResolver and PasswordResetExecutor,
    backed by a real Firebase service account."""

    def __init__(self, service_account_json: str) -> None:
        """Same fail-fast philosophy as FirebaseResetLinkGenerator: refuses
        to construct rather than silently becoming a no-op that can't
        actually resolve phones or reset passwords."""
        if not service_account_json:
            raise ValueError("FIREBASE_SERVICE_ACCOUNT_JSON is not set")
        try:
            parsed = json.loads(service_account_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: {exc}") from exc

        cred = credentials.Certificate(parsed)
        self._app = firebase_admin.initialize_app(cred, name=f"darwesh-otp-{id(self)}")

    async def resolve(self, phone_e164: str) -> str | None:
        try:
            user = await asyncio.to_thread(fb_auth.get_user_by_phone_number, phone_e164, app=self._app)
        except fb_auth.UserNotFoundError:
            return None
        return user.uid

    async def set_password_and_revoke_sessions(self, uid: str, new_password: str) -> None:
        # The Admin SDK owns the actual password hashing/storage here --
        # this backend process never stores the password itself past
        # this one outbound call, and never stores it in Firestore.
        await asyncio.to_thread(fb_auth.update_user, uid, password=new_password, app=self._app)
        # Invalidates every previously issued ID/refresh token for this
        # UID. A session already open on a stolen device before the
        # reset cannot just keep going indefinitely after it -- the
        # client's next step is a fresh login, which mints a new,
        # legitimate session.
        await asyncio.to_thread(fb_auth.revoke_refresh_tokens, uid, app=self._app)
