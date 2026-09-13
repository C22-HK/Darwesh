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

import itertools
import json

from firebase_admin import credentials
from google.auth import exceptions as google_auth_exceptions

# Monotonic, process-wide sequence behind unique_app_name(). A plain
# counter rather than id(): see that function's docstring.
_app_name_seq = itertools.count()


def unique_app_name(prefix: str) -> str:
    """Returns a name for firebase_admin.initialize_app() that is unique
    for the lifetime of this process.

    Every Admin-SDK-backed client in this backend deliberately gets its
    own named app (rather than the '[DEFAULT]' one) so that several can
    coexist in the same process -- and, more sharply, in the same pytest
    run -- without tripping the SDK's single-app-per-name rule.

    These names used to be built from id(self), which is NOT safe for
    this: id() is a memory address, and it is only unique among objects
    that are alive at the same moment. firebase_admin keeps every
    initialized app in a process-global registry that nothing here ever
    deletes from, so an app's registry entry outlives the Python wrapper
    whose address named it. Once that wrapper is collected, CPython is
    free to hand the same address to the next instance -- which then
    computes a name already taken by the registry and dies with
    "Firebase app named ... already exists". That is a real failure that
    was intermittently reddening CI: construct, drop, construct again is
    exactly what a test suite does, and it reproduces within a handful of
    iterations.

    A counter has no such reuse: it is never handed out twice, whether or
    not the previous holder is still alive. next() on an itertools.count
    is a single C-level operation, so concurrent callers cannot observe
    the same value either."""
    return f"{prefix}-{next(_app_name_seq)}"


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
