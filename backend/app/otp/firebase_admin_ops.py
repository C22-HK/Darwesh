# The only component in the OTP package that talks to the Firebase
# Admin SDK: resolving an email or phone number to the Firebase UID that
# owns it, setting a new password and revoking sessions once a reset has
# been authorized, and -- for signup -- creating the actual Firebase
# Auth user plus their Firestore profile once email ownership has been
# proven by OTP. Mirrors app.auth.firebase_reset.FirebaseResetLinkGenerator's
# own uniquely-named-app pattern so the two (and this one) can coexist in
# the same process (and in the same pytest run) without colliding on
# Firebase Admin SDK's single-app-per-name rule.
from __future__ import annotations

import asyncio
import json
from typing import Protocol

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials
from firebase_admin import firestore as fb_firestore


class UidResolver(Protocol):
    """Resolves an identifier (email or phone, depending on which
    concrete resolver is used) to the Firebase UID that has it verified
    on their Auth record, or None if no account does. EmailUidResolver
    and PhoneUidResolver below are thin adapters over
    FirebaseAccountOps's two lookup methods; tests use a fake that
    implements this Protocol directly."""

    async def resolve(self, identifier: str) -> str | None: ...


class PasswordResetExecutor(Protocol):
    """Performs the actual, authoritative password change and session
    revocation once OtpService has already verified the OTP and bound a
    token to a specific uid. Never sees a plaintext OTP, and never
    receives anything from the browser directly -- only called by
    app.otp.handler.PasswordResetConfirmHandler with a uid it already
    resolved server-side."""

    async def set_password_and_revoke_sessions(self, uid: str, new_password: str) -> None: ...


class AccountAlreadyExists(Exception):
    """Raised by FirebaseAccountOps.create_account when the email or
    phone number is already attached to a different Firebase user.
    `field` is "email" or "phone" -- telling a signup applicant their
    email/phone is already registered is normal, expected UX (unlike
    revealing account existence during password reset, which stays
    generic elsewhere in this package)."""

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(f"an account already exists with this {field}")


class FirebaseAccountOps:
    """Real implementation of UidResolver (via the two adapters below),
    PasswordResetExecutor, and signup account creation -- backed by a
    real Firebase service account."""

    def __init__(self, service_account_json: str) -> None:
        """Same fail-fast philosophy as FirebaseResetLinkGenerator: refuses
        to construct rather than silently becoming a no-op that can't
        actually resolve accounts or reset passwords."""
        if not service_account_json:
            raise ValueError("FIREBASE_SERVICE_ACCOUNT_JSON is not set")
        try:
            parsed = json.loads(service_account_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: {exc}") from exc

        cred = credentials.Certificate(parsed)
        self._app = firebase_admin.initialize_app(cred, name=f"darwesh-otp-{id(self)}")
        self._db = fb_firestore.client(self._app)

    @property
    def firestore_client(self) -> fb_firestore.Client:
        """Exposes the same Firestore client this instance already holds,
        so app.otp.store.FirestoreChallengeStore can reuse it in
        production instead of opening a second client (see
        app.main.build_email_otp_handlers)."""
        return self._db

    async def resolve_uid_by_email(self, email: str) -> str | None:
        try:
            user = await asyncio.to_thread(fb_auth.get_user_by_email, email, app=self._app)
        except fb_auth.UserNotFoundError:
            return None
        return user.uid

    async def resolve_uid_by_phone(self, phone_e164: str) -> str | None:
        """Kept for the future Phone + Password login phase (not
        implemented yet -- see docs/EMAIL_OTP.md). Not used by the
        current email-OTP wiring, which resolves password-reset
        challenges by email."""
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

    async def create_account(self, *, email: str, phone_e164: str, password: str, display_name: str) -> str:
        """Creates the real Firebase Auth user for a just-verified signup.
        email_verified=True is set here deliberately -- OTP verification
        just proved ownership of this exact address, so this isn't a
        guess or a default, it's a fact this call is allowed to assert.
        Relies on the Admin SDK's own duplicate checks (atomic, no
        separate lookup-then-create race) rather than pre-checking with
        get_user_by_email/get_user_by_phone_number first."""
        try:
            user = await asyncio.to_thread(
                fb_auth.create_user,
                email=email,
                email_verified=True,
                phone_number=phone_e164,
                password=password,
                display_name=display_name,
                app=self._app,
            )
        except fb_auth.EmailAlreadyExistsError as exc:
            raise AccountAlreadyExists("email") from exc
        except fb_auth.PhoneNumberAlreadyExistsError as exc:
            raise AccountAlreadyExists("phone") from exc
        return user.uid

    async def delete_account(self, uid: str) -> None:
        """Rolls back a Firebase Auth account -- used ONLY by
        SignupCompleteHandler, and ONLY with a uid it just received back
        from this same call's create_account() a moment earlier, never a
        uid resolved by looking anything up. create_user() (what
        create_account calls) either fails outright or returns a
        genuinely fresh, server-generated uid that could not have
        collided with an existing account -- so a caller holding a uid
        from create_account's return value has by construction the one
        and only account that call created, and deleting it can never
        touch a pre-existing account. This is the compensating action
        for "Auth account created, but the required Firestore profile
        write failed" -- see docs/EMAIL_OTP.md."""
        await asyncio.to_thread(fb_auth.delete_user, uid, app=self._app)

    async def create_user_profile(
        self,
        uid: str,
        *,
        display_name: str,
        email: str,
        phone_e164: str,
        requested_role: str = "customer",
        company_id: str | None = None,
    ) -> None:
        """Writes users/{uid} via the Admin SDK -- bypasses firestore.rules
        entirely (as any Admin SDK write does), which is expected and
        correct here: this IS the trusted, server-authoritative account-
        creation path firestore.rules' client-facing `create` rule for
        `users/{uid}` (isOwner(uid) && role == 'customer') exists
        alongside, not in place of.

        `role` is always "customer" here regardless of requested_role --
        the same rule the old client-side signup flow relied on
        (firestore.rules: a user can never self-grant 'agent'/'admin').
        `requestedRole` is only ever a recorded signal an admin reviews
        in the Users & Roles tab before manually promoting the account;
        it is never trusted as an actual privilege grant."""

        def _write() -> None:
            self._db.collection("users").document(uid).set(
                {
                    "displayName": display_name,
                    "email": email,
                    "phone": phone_e164,
                    "role": "customer",
                    "requestedRole": requested_role,
                    "companyId": company_id,
                    "phoneVerified": True,
                    "phoneVerifiedAt": fb_firestore.SERVER_TIMESTAMP,
                    "emailVerified": True,
                    "createdAt": fb_firestore.SERVER_TIMESTAMP,
                }
            )

        await asyncio.to_thread(_write)

    async def ensure_company(self, company_id: str, company_name: str) -> None:
        """Creates companies/{company_id} the first time this name is
        used at signup; a later signup with the same (slugified) name
        just joins the existing one. Mirrors the create-if-not-exists
        semantics firestore.rules already grants a signed-in client
        (`allow create: if isSignedIn() && !exists(...)`) -- performed
        here via the Admin SDK instead, since the applicant isn't signed
        in yet at signup time (no Firebase user exists until
        create_account succeeds)."""

        def _write() -> None:
            ref = self._db.collection("companies").document(company_id)
            if not ref.get().exists:
                ref.set({"name": company_name, "createdAt": fb_firestore.SERVER_TIMESTAMP})

        await asyncio.to_thread(_write)

    async def mint_custom_token(self, uid: str) -> str:
        """A short-lived Firebase custom token the client exchanges via
        signInWithCustomToken() to establish its session right after
        signup -- create_user() above does not itself sign anyone in
        (unlike the client SDK's createUserWithEmailAndPassword), so this
        is what gives the newly created account a real, working session
        without the browser ever touching a password-verification call
        itself."""
        token_bytes = await asyncio.to_thread(fb_auth.create_custom_token, uid, app=self._app)
        return token_bytes.decode("utf-8")


class EmailUidResolver:
    """Adapts FirebaseAccountOps.resolve_uid_by_email to the generic
    UidResolver Protocol OtpService depends on."""

    def __init__(self, ops: FirebaseAccountOps) -> None:
        self._ops = ops

    async def resolve(self, identifier: str) -> str | None:
        return await self._ops.resolve_uid_by_email(identifier)


class PhoneUidResolver:
    """Adapts FirebaseAccountOps.resolve_uid_by_phone to the generic
    UidResolver Protocol. Not wired up by app.main today -- kept for the
    future Phone + Password login phase."""

    def __init__(self, ops: FirebaseAccountOps) -> None:
        self._ops = ops

    async def resolve(self, identifier: str) -> str | None:
        return await self._ops.resolve_uid_by_phone(identifier)
