# Verifies the Firebase ID token every Phase 2 access-management endpoint
# requires. Nothing in this backend needed bearer-token authentication
# before this package -- the OTP/signup flow proves identity via a
# server-issued verifyToken, and password-reset via a resetToken -- but
# every endpoint here acts on behalf of an ALREADY-signed-in user (an
# admin managing permissions, an org owner managing members), so the
# caller's own Firebase session is the credential, exactly like every
# firestore.rules check already trusts request.auth.uid, never a
# client-supplied uid in the request body.
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

from fastapi import Request
from firebase_admin import App
from firebase_admin import auth as fb_auth


@dataclass(frozen=True)
class AuthenticatedCaller:
    """The one thing every Phase 2 endpoint is allowed to trust about who
    is calling: a Firebase-issued, cryptographically verified uid. Never
    constructed from anything the client sent in a request body -- only
    from a successfully verified ID token."""

    uid: str
    email: str | None = None


class IdTokenVerifier(Protocol):
    """Verifies a Firebase ID token and returns the caller it identifies,
    or None if the token is missing, malformed, expired, revoked, or
    belongs to a disabled account. Same fakeable-Protocol shape as every
    other Firebase-backed dependency in this codebase (UidResolver,
    ResetLinkGenerator, EmailSender, RateLimiter) -- tests use a fake,
    production uses FirebaseIdTokenVerifier below."""

    async def verify(self, id_token: str) -> AuthenticatedCaller | None: ...


class FirebaseIdTokenVerifier:
    """Real implementation, backed by the Firebase Admin SDK. Verifies
    the token's signature, issuer, audience (must match this exact
    Firebase project -- verify_id_token does this internally against the
    App's own project id, so a token minted for a different Firebase
    project is rejected the same as a forged one), and expiry, and
    additionally checks the token hasn't been revoked (check_revoked=True
    -- an extra Admin SDK call, but the correct choice here: these are
    security/access-control-mutating endpoints, not a low-stakes read,
    so paying for an explicit revocation check is worth it) and that the
    account isn't disabled (verify_id_token raises for a disabled user
    automatically once check_revoked=True forces the extra user lookup)."""

    def __init__(self, app: App, logger: logging.Logger | None = None) -> None:
        self._app = app
        self._logger = logger or logging.getLogger("darwesh.access.auth")

    async def verify(self, id_token: str) -> AuthenticatedCaller | None:
        if not id_token:
            return None

        def _verify() -> dict | None:
            try:
                return fb_auth.verify_id_token(id_token, app=self._app, check_revoked=True)
            except fb_auth.RevokedIdTokenError:
                self._logger.info("id token rejected: revoked")
                return None
            except fb_auth.UserDisabledError:
                self._logger.info("id token rejected: user disabled")
                return None
            except fb_auth.ExpiredIdTokenError:
                return None
            except fb_auth.InvalidIdTokenError:
                return None
            except fb_auth.CertificateFetchError as exc:
                # Transient (couldn't fetch Google's signing certs) -- log
                # with enough to diagnose, but never leak the token or any
                # credential; treat exactly like any other verification
                # failure to the caller (401), not a 500 that would hint
                # at server-side trouble.
                self._logger.error(
                    "id token verification failed: certificate fetch error", extra={"error": str(exc)}
                )
                return None

        decoded = await asyncio.to_thread(_verify)
        if decoded is None:
            return None
        uid = decoded.get("uid")
        if not isinstance(uid, str) or not uid:
            return None
        email = decoded.get("email")
        return AuthenticatedCaller(uid=uid, email=email if isinstance(email, str) else None)


def extract_bearer_token(request: Request) -> str | None:
    """Pulls the raw token out of `Authorization: Bearer <token>`. Never
    falls back to any other source (a query param, a cookie, a body
    field) -- a single, unambiguous place a caller's identity can come
    from. Returns None for a missing header, a non-Bearer scheme, or an
    empty token, all treated identically by callers (a clean 401, not a
    distinguishable error that would help an attacker narrow down why
    their request failed)."""
    header = request.headers.get("Authorization") or request.headers.get("authorization")
    if not header:
        return None
    parts = header.split(" ", 1)
    if len(parts) != 2 or parts[0] != "Bearer":
        return None
    token = parts[1].strip()
    return token or None
