# FirebaseResetLinkGenerator is the real, production ResetLinkGenerator --
# it calls the Firebase Admin SDK, the only thing that can legitimately
# mint one of these links (this is exactly the "generate the link
# server-side with the Admin SDK" requirement from the original spec).
from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlencode, urlparse

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore

from app.auth.firebase_credentials import build_firebase_credentials
from app.auth.reset import ErrUserNotFound


class FirebaseResetLinkGenerator:
    """Needs real Firebase Admin credentials to do anything -- see
    __init__ -- either a service-account JSON key or, in production,
    Application Default Credentials."""

    def __init__(self, service_account_json: str, continue_url: str, project_id: str = "") -> None:
        """Builds a real client from a service account JSON (the contents
        of the key file downloaded from Firebase Console -> Project
        Settings -> Service Accounts -> Generate new private key), or --
        when service_account_json is empty -- from Application Default
        Credentials (see app.auth.firebase_credentials), which is what
        Cloud Run provides automatically via its attached runtime
        service account, needing no downloaded key at all. Raises
        ValueError if neither produces a usable credential -- this
        constructor does not silently degrade to a no-op the way
        error-monitor.js's empty-DSN check does, because "the backend
        claims to be ready but silently can't actually reset anyone's
        password" is a much worse failure mode than refusing to start."""
        if not continue_url:
            raise ValueError("RESET_PASSWORD_CONTINUE_URL is not set")

        cred, options = build_firebase_credentials(service_account_json, project_id)
        # A unique app name (rather than the '[DEFAULT]' app) avoids
        # colliding with any other firebase_admin app this process
        # initializes -- e.g. under pytest, where more than one Handler
        # gets built across test cases.
        self._app = firebase_admin.initialize_app(cred, options=options, name=f"darwesh-reset-{id(self)}")
        self._continue_url = continue_url
        self._db = fb_firestore.client(self._app)

    @property
    def firestore_client(self) -> fb_firestore.Client:
        """Exposes the same Firestore client this instance already
        holds, so app.auth.reset.FirestoreRateLimiter can reuse it in
        production instead of opening a second one (see
        app.main.build_auth_handler) -- same pattern as
        app.otp.firebase_admin_ops.FirebaseAccountOps.firestore_client."""
        return self._db

    async def generate_reset_link(self, email: str) -> str:
        # generate_password_reset_link is a blocking network call; run it
        # off the event loop so it doesn't stall every other in-flight
        # request on this process.
        try:
            raw_link = await asyncio.to_thread(
                fb_auth.generate_password_reset_link,
                email,
                action_code_settings=fb_auth.ActionCodeSettings(url=self._continue_url),
                app=self._app,
            )
        except fb_auth.UserNotFoundError as exc:
            raise ErrUserNotFound from exc

        # The link Firebase generates always routes through
        # <project>.firebaseapp.com/__/auth/action first, which is
        # exactly the domain that turned out to be unreachable on some
        # networks (the reason this project's own reset-password.html
        # was built in the first place -- see its code comments). That's
        # fine for oobCode extraction (a plain query param), but we build
        # the actual link we email from scratch, pointed straight at our
        # own page, so the visitor's browser never has to load anything
        # from firebaseapp.com at all.
        try:
            oob_code = extract_oob_code(raw_link)
        except ValueError as exc:
            raise ValueError(f"firebase returned a reset link in an unexpected format: {exc}") from exc

        direct = urlparse(self._continue_url)
        query = parse_qs(direct.query)
        query["mode"] = ["resetPassword"]
        query["oobCode"] = [oob_code]
        return direct._replace(query=urlencode(query, doseq=True)).geturl()


def extract_oob_code(raw_link: str) -> str:
    parsed = urlparse(raw_link)
    code = parse_qs(parsed.query).get("oobCode", [""])[0]
    if not code:
        raise ValueError("no oobCode present in the generated link")
    return code
