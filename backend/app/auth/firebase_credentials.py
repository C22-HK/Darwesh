# Shared credential-selection logic for every Firebase Admin SDK client
# this backend constructs (FirebaseResetLinkGenerator, FirebaseAccountOps).
# Two ways to authenticate:
#
# - A real service-account JSON key (FIREBASE_SERVICE_ACCOUNT_JSON) --
#   used for local development, and still supported in production if
#   ever needed again.
# - Application Default Credentials (ADC) -- used in production on
#   Cloud Run when FIREBASE_SERVICE_ACCOUNT_JSON is NOT set. Cloud Run
#   automatically attaches the runtime service account's identity via
#   its metadata server; the Admin SDK picks that up with no downloaded
#   key file at all. See docs/EMAIL_OTP.md's "Firebase Admin
#   authentication" section for the exact IAM roles that identity needs.
#
# Fails fast (ValueError) if ADC genuinely isn't available in this
# environment, rather than letting the failure surface later at the
# first real request -- matches the existing "the backend claims to be
# ready but silently can't actually do its job" concern already stated
# in FirebaseResetLinkGenerator's docstring.
from __future__ import annotations

import json

from firebase_admin import credentials
from google.auth import exceptions as google_auth_exceptions


def build_firebase_credentials(service_account_json: str, project_id: str) -> tuple[credentials.Base, dict | None]:
    """Returns (credential, initialize_app options). `project_id` is
    only required (and only used) on the ADC path -- a service-account
    key already carries its own project_id, but ADC (e.g. Cloud Run's
    metadata server) doesn't reliably expose one the same way, so it's
    passed explicitly to avoid any ambiguity about which Firebase
    project a call is scoped to."""
    if service_account_json:
        try:
            parsed = json.loads(service_account_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: {exc}") from exc
        return credentials.Certificate(parsed), None

    if not project_id:
        raise ValueError(
            "FIREBASE_PROJECT_ID must be set when using Application Default Credentials "
            "(no FIREBASE_SERVICE_ACCOUNT_JSON was given)"
        )

    cred = credentials.ApplicationDefault()
    try:
        # ApplicationDefault() itself never fails -- it's lazy. Force
        # resolution now (google.auth.default() under the hood) so a
        # missing/misconfigured identity is caught here, at
        # construction, not on the first real Firestore/Auth call this
        # credential is used for.
        cred.get_credential()
    except google_auth_exceptions.DefaultCredentialsError as exc:
        raise ValueError(
            "No FIREBASE_SERVICE_ACCOUNT_JSON is set and Application Default Credentials "
            "are not available in this environment"
        ) from exc

    return cred, {"projectId": project_id}
