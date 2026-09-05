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

import firebase_admin
from firebase_admin import firestore as fb_firestore

from app.auth.firebase_credentials import build_firebase_credentials


class AccessFirebaseClients:
    def __init__(self, service_account_json: str = "", project_id: str = "") -> None:
        cred, options = build_firebase_credentials(service_account_json, project_id)
        self._app = firebase_admin.initialize_app(cred, options=options, name=f"darwesh-access-{id(self)}")
        self._db = fb_firestore.client(self._app)

    @property
    def app(self) -> firebase_admin.App:
        return self._app

    @property
    def firestore_client(self) -> fb_firestore.Client:
        return self._db
