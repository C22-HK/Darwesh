# Establishes who is calling, end to end: verifies the bearer token
# (auth_context.IdTokenVerifier), then reads that uid's OWN role straight
# from Firestore -- the exact same "signed-in && exists(users/{uid}) ?
# role : null" shape firestore.rules' myRole() uses, kept in lockstep on
# purpose so "is this caller an admin" can never drift between what the
# rules layer would decide and what this backend decides. Never trusts a
# client-supplied uid, role, or admin claim from the request body -- the
# uid comes only from the verified token, and the role comes only from
# this backend's own Firestore read of that uid's own document.
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from fastapi import Request

from app.access.auth_context import IdTokenVerifier, extract_bearer_token


@dataclass(frozen=True)
class CallerContext:
    uid: str
    email: str | None
    role: str | None
    is_admin: bool


class AuthGate:
    def __init__(self, verifier: IdTokenVerifier, db, logger: logging.Logger | None = None) -> None:
        self._verifier = verifier
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.access.auth")

    async def authenticate(self, request: Request) -> CallerContext | None:
        """Returns None for ANY authentication failure -- missing header,
        invalid/expired/revoked token, disabled account -- callers must
        treat every None identically (a clean 401), never distinguish
        which case occurred in the response."""
        token = extract_bearer_token(request)
        if token is None:
            return None
        caller = await self._verifier.verify(token)
        if caller is None:
            return None
        role = await asyncio.to_thread(self._read_role, caller.uid)
        return CallerContext(uid=caller.uid, email=caller.email, role=role, is_admin=role == "admin")

    def _read_role(self, uid: str) -> str | None:
        snap = self._db.collection("users").document(uid).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        role = data.get("role")
        return role if isinstance(role, str) else None
