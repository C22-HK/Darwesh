# Implements the password-reset email endpoint. The orchestration logic
# here (validation, rate limiting, enumeration-safety) is deliberately
# decoupled from the real Firebase Admin SDK and email API calls behind
# two small protocols -- that's what makes it possible to unit-test the
# parts that matter (does this leak whether an email is registered? does
# the rate limiter actually block a burst?) without needing real
# credentials for either external service.
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Protocol

from fastapi import Request
from fastapi.responses import JSONResponse
from firebase_admin import firestore as fb_firestore
from google.api_core import exceptions as google_api_exceptions


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


class RateLimiter(Protocol):
    """Rate limiter interface, keyed by an arbitrary string (client IP,
    email address -- whatever the caller wants to bound). Two
    implementations, same shape as app.otp.store.ChallengeStore:

    - InMemoryRateLimiter: process-local, used in development and by
      the test suite. Correct only for a single backend instance.
    - FirestoreRateLimiter: shared across every instance via Firestore,
      used in production (see app.main.build_auth_handler and
      app.main.build_email_otp_handlers). A real deployment (Cloud Run
      included) can and does run more than one instance -- an
      in-memory limiter's effective limit then silently multiplies by
      however many instances happen to be running, which defeats the
      whole point of a rate limit. See INFRASTRUCTURE_SECURITY_REVIEW.md
      / INFRASTRUCTURE_REMEDIATION.md's INFRA-01.

    async even for the in-memory case, for the same reason
    app.otp.store.ChallengeStore is: a caller can't know at compile
    time which implementation it's been handed, and the Firestore-
    backed one is fundamentally async (its Admin SDK client is
    blocking, wrapped in asyncio.to_thread)."""

    async def allow(self, key: str) -> bool: ...


class InMemoryRateLimiter:
    """Simple in-memory fixed-window limiter, keyed by an arbitrary
    string. Correct only for a single backend instance/worker -- see
    FirestoreRateLimiter below, used instead in production."""

    def __init__(self, limit: int, window_seconds: float) -> None:
        self._lock = threading.Lock()
        self._requests: dict[str, list[float]] = {}
        self._limit = limit
        self._window = window_seconds

    async def allow(self, key: str) -> bool:
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


_RATE_LIMITS_COLLECTION = "rateLimits"


class FirestoreRateLimiter:
    """Shared fixed-window limiter backed by Firestore, via the Admin
    SDK (never the client SDK -- see firestore.rules' deny-all block
    for the rateLimits collection this writes to, same reasoning as
    app.otp.store.FirestoreChallengeStore's). Correct across any number
    of backend instances/workers, unlike InMemoryRateLimiter.

    `name` namespaces this limiter's keys from every other
    FirestoreRateLimiter sharing the same collection -- e.g. the
    email-OTP send endpoint's IP limiter and its verify endpoint's IP
    limiter both key on the caller's IP address, but must never share a
    counter with each other. Pass a short, stable, unique string per
    call site.

    Uses wall-clock time (time.time()), not time.monotonic() --
    monotonic time has no defined relationship across separate
    processes/instances, only within one.

    Concurrency: the read-check-append-write is a single Firestore
    transaction, the same pattern as
    app.otp.store.FirestoreChallengeStore.record_failed_attempt, so two
    concurrent requests for the same key on different instances can
    never both slip past a limit that's already at capacity. On
    transaction-retry-budget exhaustion under extreme contention this
    fails CLOSED (denies the request) rather than open -- unlike
    ChallengeStore's failure mode (which safely denies just one
    operation), silently letting an unbounded burst through on infra
    contention would defeat this component's entire purpose.

    Failure modes beyond contention: any Firestore-side error (a
    transient outage, a deadline exceeded, a network blip between this
    instance and Firestore, a retry budget exhausted below the API-call
    layer -- not just a lost transaction race) is caught via the broad
    google.api_core.exceptions.GoogleAPIError base class (covers both
    GoogleAPICallError, an actual error response, and RetryError, retries
    exhausted before one was ever received -- two different exception
    families under google-api-core, not just Aborted). A narrower catch
    would let those escape this function uncaught, propagate out of the
    awaiting HTTP handler,
    and surface as an unhandled 500 instead of the same clean "denied,
    logged" outcome contention already gets. Either way this endpoint
    doesn't proceed to the real work (sending an email, resolving a
    UID) on a failed check -- there is no path where a Firestore outage
    here accidentally lets more requests through than intended, only a
    path where it makes the endpoint unavailable rather than silently
    over-permissive, which is the safer of the two failure directions
    for a rate limiter to have.

    Storage hygiene: each document also carries an `updatedAt` field
    suitable for a native Firestore TTL policy (see
    app.otp.store.FirestoreChallengeStore's docstring for how to
    configure one) -- correctness never depends on Firestore actually
    expiring these documents, since the read-side pruning below already
    ignores stale timestamps regardless."""

    def __init__(
        self, db, name: str, limit: int, window_seconds: float, logger: logging.Logger | None = None
    ) -> None:
        self._db = db
        self._name = name
        self._limit = limit
        self._window = window_seconds
        self._logger = logger or logging.getLogger("darwesh.ratelimit.firestore")

    async def allow(self, key: str) -> bool:
        def _op() -> bool:
            ref = self._db.collection(_RATE_LIMITS_COLLECTION).document(f"{self._name}__{key}")
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn):
                snap = ref.get(transaction=txn)
                now = time.time()
                cutoff = now - self._window
                existing = snap.to_dict().get("timestamps", []) if snap.exists else []
                kept = [t for t in existing if t > cutoff]

                if len(kept) >= self._limit:
                    txn.set(ref, {"timestamps": kept, "updatedAt": now})
                    return False

                kept.append(now)
                txn.set(ref, {"timestamps": kept, "updatedAt": now})
                return True

            try:
                return _txn(transaction)
            except (google_api_exceptions.GoogleAPIError, ValueError) as exc:
                self._logger.error(
                    "rate limiter: transaction failed, failing closed",
                    extra={"error": str(exc), "limiter": self._name},
                )
                return False

        return await asyncio.to_thread(_op)


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
        if not await self.limiter.allow(client_ip):
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
