# FirebaseResetLinkGenerator is the real, production ResetLinkGenerator --
# it calls the Firebase Admin SDK, the only thing that can legitimately
# mint one of these links (this is exactly the "generate the link
# server-side with the Admin SDK" requirement from the original spec).
from __future__ import annotations

import asyncio
import json
from urllib.parse import parse_qs, urlencode, urlparse

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials

from app.auth.reset import ErrUserNotFound


class FirebaseResetLinkGenerator:
    """Needs a real service account JSON to do anything -- see __init__."""

    def __init__(self, service_account_json: str, continue_url: str) -> None:
        """Builds a real client from a service account JSON (the contents
        of the key file downloaded from Firebase Console -> Project
        Settings -> Service Accounts -> Generate new private key). Raises
        ValueError if the JSON is invalid -- this constructor does not
        silently degrade to a no-op the way error-monitor.js's empty-DSN
        check does, because "the backend claims to be ready but silently
        can't actually reset anyone's password" is a much worse failure
        mode than refusing to start."""
        if not service_account_json:
            raise ValueError("FIREBASE_SERVICE_ACCOUNT_JSON is not set")
        if not continue_url:
            raise ValueError("RESET_PASSWORD_CONTINUE_URL is not set")

        try:
            parsed = json.loads(service_account_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: {exc}") from exc

        cred = credentials.Certificate(parsed)
        # A unique app name (rather than the '[DEFAULT]' app) avoids
        # colliding with any other firebase_admin app this process
        # initializes -- e.g. under pytest, where more than one Handler
        # gets built across test cases.
        self._app = firebase_admin.initialize_app(cred, name=f"darwesh-reset-{id(self)}")
        self._continue_url = continue_url

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
