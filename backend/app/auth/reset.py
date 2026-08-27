# Implements the password-reset email endpoint. The orchestration logic
# here (validation, rate limiting, enumeration-safety) is deliberately
# decoupled from the real Firebase Admin SDK and email API calls behind
# two small protocols -- that's what makes it possible to unit-test the
# parts that matter (does this leak whether an email is registered? does
# the rate limiter actually block a burst?) without needing real
# credentials for either external service.
from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Protocol

from fastapi import Request
from fastapi.responses import JSONResponse


class ErrUserNotFound(Exception):
    """Raised by a ResetLinkGenerator when no account exists for the given
    email. Handler.forgot_password treats this identically to success in
    its HTTP response -- the one thing this whole module exists to get
    right is never letting an attacker learn which emails are registered
    by watching how this endpoint responds."""


class ResetLinkGenerator(Protocol):
    """Produces a real, Firebase-issued, single-use, expiring password-
    reset link for an email address. The production implementation
    (FirebaseResetLinkGenerator, in firebase_reset.py) calls the Firebase
    Admin SDK; tests use a fake."""

    async def generate_reset_link(self, email: str) -> str: ...


class EmailSender(Protocol):
    """Delivers the branded reset email. The production implementation
    (ResendEmailSender, in resend_email.py) calls the Resend API; tests
    use a fake."""

    async def send_reset_email(self, to_email: str, reset_link: str) -> None: ...


GENERIC_RESPONSE_MESSAGE = (
    "If an account exists with this email address, we've sent instructions to reset your password."
)

# Not a full RFC 5322 parser (Go's net/mail.ParseAddress is a lot more
# permissive than this) -- but the endpoint only needs to tell "clearly
# not an email" from "plausibly an email", and this is enough for that
# without pulling in a whole email-validation dependency.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RateLimiter:
    """Simple in-memory fixed-window limiter, keyed by client IP.
    Deliberately not backed by Redis: at this project's current traffic
    (see docs/ARCHITECTURE_AUDIT.md), a single instance's own memory is
    sufficient, and adding Redis before there's a real multi-instance
    deployment to coordinate would be exactly the kind of unjustified
    complexity this project has been avoiding all along. If traffic ever
    grows enough to run multiple instances, this is the component to
    swap for a Redis-backed one -- kept small and self-contained
    specifically so that swap is easy later."""

    def __init__(self, limit: int, window_seconds: float) -> None:
        self._lock = threading.Lock()
        self._requests: dict[str, list[float]] = {}
        self._limit = limit
        self._window = window_seconds

    def allow(self, key: str) -> bool:
        """Reports whether a new request from this key should proceed.
        Also opportunistically prunes old entries for this key so the
        dict doesn't grow unbounded over the life of the process."""
        with self._lock:
            now = time.monotonic()
            cutoff = now - self._window
            kept = [t for t in self._requests.get(key, []) if t > cutoff]

            if len(kept) >= self._limit:
                self._requests[key] = kept
                return False

            kept.append(now)
            self._requests[key] = kept
            return True


@dataclass
class Handler:
    """Wires the two collaborators together with real validation, rate
    limiting, and enumeration-safe responses."""

    links: ResetLinkGenerator
    emails: EmailSender
    limiter: RateLimiter
    logger: logging.Logger

    async def forgot_password(self, request: Request) -> JSONResponse:
        """Handles POST /api/v1/auth/forgot-password."""
        try:
            raw = await request.body()
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict):
                raise ValueError("request body is not a JSON object")
            email_raw = body.get("email", "")
            if not isinstance(email_raw, str):
                raise ValueError("email field is not a string")
        except (json.JSONDecodeError, ValueError):
            return JSONResponse({"error": "Please provide a valid request body."}, status_code=400)

        email = email_raw.strip().lower()
        if not _EMAIL_RE.match(email):
            return JSONResponse({"error": "That email address doesn't look right."}, status_code=400)

        # Rate limit BEFORE touching Firebase or the email API -- both
        # cost real money per call once real credentials are wired in,
        # and this is the endpoint most likely to be hammered by an
        # attacker enumerating emails or just abusing a free "send me
        # mail" button.
        client_ip = request.client.host if request.client else "unknown"
        if not self.limiter.allow(client_ip):
            return JSONResponse(
                {"error": "Too many requests. Please wait a while and try again."}, status_code=429
            )

        try:
            link = await self.links.generate_reset_link(email)
        except ErrUserNotFound:
            # Deliberately do nothing else -- fall through to the same
            # generic response as the success case below. This one
            # branch is the entire reason this endpoint exists instead
            # of just calling Firebase's client SDK directly from the
            # browser: it lets the server, not the client, decide what
            # the visitor sees, so "no such user" can never be
            # distinguished from "email sent" by anyone watching the
            # response.
            pass
        except Exception as exc:
            self.logger.error("failed to generate password reset link", extra={"error": str(exc)})
            # Still return the generic message -- a transient failure on
            # our end shouldn't teach an attacker anything either, and a
            # real user who hits this can always just try again.
        else:
            try:
                await self.emails.send_reset_email(email, link)
            except Exception as exc:
                # The reset link itself is never logged -- it's a live,
                # single-use credential. Only the fact that sending
                # failed is worth recording.
                self.logger.error("failed to send password reset email", extra={"error": str(exc)})

        return JSONResponse({"message": GENERIC_RESPONSE_MESSAGE}, status_code=200)
