# Constructs the Firebase Admin App + Firestore client this whole
# package's write path (organization_ops.py, permission_ops.py, audit.py)
# and ID-token verification (auth_context.py) run on. Same uniquely-
# named-app-per-instance pattern as app.otp.firebase_admin_ops.FirebaseAccountOps
# and app.auth.firebase_reset.FirebaseResetLinkGenerator -- lets all three
# coexist in the same process (and in the same pytest run) without
# colliding on the Admin SDK's single-app-per-name rule. Deliberately its
# own, separate Admin app rather than reusing FirebaseAccountOps's --
# access-management endpoints must be available independently of whether
# the (OTP-secret-gated) email-OTP endpoints happen to be configured.
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore

from app.auth.firebase_credentials import build_firebase_credentials, unique_app_name


def make_email_uid_resolver(app: firebase_admin.App) -> Callable[[str], Awaitable[str | None]]:
    """U1: email -> Firebase Auth uid (or None) for CompanyOps.lookup_agent_by_email.
    Same get_user_by_email call app.otp.firebase_admin_ops already relies
    on; bound to THIS package's own Admin app."""

    async def _resolve(email: str) -> str | None:
        try:
            user = await asyncio.to_thread(fb_auth.get_user_by_email, email, app=app)
        except fb_auth.UserNotFoundError:
            return None
        return user.uid

    return _resolve


class AccessFirebaseClients:
    def __init__(self, service_account_json: str = "", project_id: str = "") -> None:
        cred, options = build_firebase_credentials(service_account_json, project_id)
        self._app = firebase_admin.initialize_app(cred, options=options, name=unique_app_name("darwesh-access"))
        self._db = fb_firestore.client(self._app)

    @property
    def app(self) -> firebase_admin.App:
        return self._app

    @property
    def firestore_client(self) -> fb_firestore.Client:
        return self._db
