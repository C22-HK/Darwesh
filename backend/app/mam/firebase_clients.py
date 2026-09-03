# Constructs the Firebase Admin App + Firestore client MAM's tools (real
# listing/project/professional/favorites reads) and optional caller
# identification (routes.py's AuthGate) run on. Same uniquely-named-app-
# per-instance pattern as app.access.firebase_clients.AccessFirebaseClients
# -- its own, separate Admin app rather than reusing another feature's, so
# MAM stays independently available regardless of which other Firebase-
# backed features happen to be configured.
from __future__ import annotations

import firebase_admin
from firebase_admin import firestore as fb_firestore

from app.auth.firebase_credentials import build_firebase_credentials


class MamFirebaseClients:
    def __init__(self, service_account_json: str = "", project_id: str = "") -> None:
        cred, options = build_firebase_credentials(service_account_json, project_id)
        self._app = firebase_admin.initialize_app(cred, options=options, name=f"darwesh-mam-{id(self)}")
        self._db = fb_firestore.client(self._app)

    @property
    def app(self) -> firebase_admin.App:
        return self._app

    @property
    def firestore_client(self) -> fb_firestore.Client:
        return self._db
