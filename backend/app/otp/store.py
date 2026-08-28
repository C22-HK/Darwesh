# Storage for OTP challenges and the short-lived reset/verify tokens
# issued after a successful verification. Nothing here ever stores a
# plaintext OTP (see app/otp/codes.py -- only its HMAC output is
# stored). Two implementations:
#
# - InMemoryChallengeStore: process-local, used in development and by
#   the test suite. Correct only for a single backend instance/worker.
# - FirestoreChallengeStore: shared across every instance/worker via
#   Firestore, used in production (see app.main.build_email_otp_handlers).
#   Nothing here is ever reachable from a Firestore client read/write --
#   see firestore.rules' explicit deny-all block for the
#   otpChallenges/otpResetTokens collections this writes to; only the
#   backend's own Admin SDK credential (which bypasses rules entirely,
#   as any Admin SDK access does) can reach these documents at all.
#
# Both implementations satisfy the same async ChallengeStore Protocol --
# async even for the in-memory case, because OtpService (and everything
# above it) can't know at compile time which implementation it's been
# handed, and Firestore's Admin SDK client is fundamentally a blocking
# API (wrapped in asyncio.to_thread by FirestoreChallengeStore below) --
# a single shared interface has to be async to accommodate that.
from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from typing import Protocol

from firebase_admin import firestore as fb_firestore
from google.api_core import exceptions as google_api_exceptions


@dataclass
class Challenge:
    identifier: str  # normalized phone or email this challenge was sent to
    purpose: str
    otp_hash: str
    # Firebase UID this challenge is bound to, resolved once at send time --
    # None for a purpose that doesn't require an existing account yet
    # (SIGNUP_EMAIL_VERIFY: there's deliberately no account until AFTER
    # verification succeeds). Purposes that DO require one (PASSWORD_RESET)
    # always have this set by the time a Challenge exists at all -- see
    # OtpService.send.
    uid: str | None
    created_at: float
    expires_at: float
    max_attempts: int
    attempts: int = 0
    consumed: bool = False


@dataclass
class ResetToken:
    # None for SIGNUP_EMAIL_VERIFY (no account exists yet); always set for
    # PASSWORD_RESET (see Challenge.uid).
    uid: str | None
    identifier: str
    purpose: str
    created_at: float
    expires_at: float
    consumed: bool = False


class ChallengeStore(Protocol):
    """Everything OtpService needs from storage."""

    async def create_challenge(self, key: str, challenge: Challenge) -> None: ...
    async def get_challenge(self, key: str) -> Challenge | None: ...
    async def record_failed_attempt(self, key: str) -> Challenge | None: ...
    async def consume_challenge(self, key: str) -> None: ...
    async def create_reset_token(self, token: str, entry: ResetToken) -> None: ...
    async def get_reset_token(self, token: str) -> ResetToken | None: ...
    async def try_consume_reset_token(self, token: str) -> ResetToken | None: ...


class InMemoryChallengeStore:
    """Process-local storage, guarded by a lock and opportunistically
    pruned of expired entries on every access -- the exact same tradeoff
    already accepted by app.auth.reset.RateLimiter (see its docstring):
    correct for a single backend instance. Used in development; in
    production this is swapped for FirestoreChallengeStore below (see
    app.main.build_email_otp_handlers) precisely because a real
    deployment can and does run more than one instance/worker, where
    this class's state would silently be invisible across them --
    a signup's /send hitting one instance and /verify hitting another
    would see no matching challenge at all."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._challenges: dict[str, Challenge] = {}
        self._reset_tokens: dict[str, ResetToken] = {}

    def _prune_locked(self) -> None:
        now = time.time()
        for store in (self._challenges, self._reset_tokens):
            for key in [k for k, v in store.items() if v.expires_at < now]:
                del store[key]

    async def create_challenge(self, key: str, challenge: Challenge) -> None:
        with self._lock:
            self._prune_locked()
            self._challenges[key] = challenge

    async def get_challenge(self, key: str) -> Challenge | None:
        with self._lock:
            self._prune_locked()
            return self._challenges.get(key)

    async def record_failed_attempt(self, key: str) -> Challenge | None:
        with self._lock:
            self._prune_locked()
            challenge = self._challenges.get(key)
            if challenge is None:
                return None
            challenge.attempts += 1
            return challenge

    async def consume_challenge(self, key: str) -> None:
        with self._lock:
            challenge = self._challenges.get(key)
            if challenge is not None:
                challenge.consumed = True

    async def create_reset_token(self, token: str, entry: ResetToken) -> None:
        with self._lock:
            self._prune_locked()
            self._reset_tokens[token] = entry

    async def get_reset_token(self, token: str) -> ResetToken | None:
        with self._lock:
            self._prune_locked()
            return self._reset_tokens.get(token)

    async def try_consume_reset_token(self, token: str) -> ResetToken | None:
        """Atomically checks-and-marks a token consumed in one operation
        -- both the "is this still valid" check and the "mark it used"
        write happen under the same lock acquisition, so two concurrent
        callers with the same token (e.g. a double-submitted signup/
        password-reset completion) can never both see it as valid. Only
        the caller that wins this race gets the entry back; the other
        gets None, identical to an unknown/expired/already-used token --
        see app.otp.email_handler.SignupCompleteHandler and
        app.otp.handler.PasswordResetConfirmHandler, which both rely on
        this to guarantee a token authorizes at most one completed
        operation even under real concurrency, not just under a single
        request's own sequential logic."""
        with self._lock:
            self._prune_locked()
            entry = self._reset_tokens.get(token)
            if entry is None or entry.consumed or entry.expires_at < time.time():
                return None
            entry.consumed = True
            return entry


_CHALLENGES_COLLECTION = "otpChallenges"
_RESET_TOKENS_COLLECTION = "otpResetTokens"


def _challenge_to_dict(challenge: Challenge) -> dict:
    return {
        "identifier": challenge.identifier,
        "purpose": challenge.purpose,
        "otpHash": challenge.otp_hash,
        "uid": challenge.uid,
        "createdAt": challenge.created_at,
        "expiresAt": challenge.expires_at,
        "maxAttempts": challenge.max_attempts,
        "attempts": challenge.attempts,
        "consumed": challenge.consumed,
    }


def _challenge_from_dict(data: dict) -> Challenge:
    return Challenge(
        identifier=data["identifier"],
        purpose=data["purpose"],
        otp_hash=data["otpHash"],
        uid=data.get("uid"),
        created_at=data["createdAt"],
        expires_at=data["expiresAt"],
        max_attempts=data["maxAttempts"],
        attempts=data["attempts"],
        consumed=data["consumed"],
    )


def _reset_token_to_dict(entry: ResetToken) -> dict:
    return {
        "uid": entry.uid,
        "identifier": entry.identifier,
        "purpose": entry.purpose,
        "createdAt": entry.created_at,
        "expiresAt": entry.expires_at,
        "consumed": entry.consumed,
    }


def _reset_token_from_dict(data: dict) -> ResetToken:
    return ResetToken(
        uid=data.get("uid"),
        identifier=data["identifier"],
        purpose=data["purpose"],
        created_at=data["createdAt"],
        expires_at=data["expiresAt"],
        consumed=data["consumed"],
    )


class FirestoreChallengeStore:
    """Shared OTP storage backed by Firestore, via the Admin SDK (never
    the client SDK, never reachable by firestore.rules' normal
    client-facing checks) -- correct across any number of backend
    instances/workers, unlike InMemoryChallengeStore. Takes an already-
    constructed `google.cloud.firestore.Client` (e.g.
    FirebaseAccountOps.firestore_client) rather than building its own,
    so the whole process shares one Firestore client instead of opening
    a second one.

    Expiration: application logic (OtpService) already checks
    `expires_at` on every read regardless of which store is in use, so
    correctness never depends on Firestore actually deleting expired
    documents -- but for storage hygiene, configure a native Firestore
    TTL policy on the `expiresAt` field for both collections in Console
    or via `gcloud firestore fields ttls update` (see docs/EMAIL_OTP.md)
    -- this can't be done from application code, it's a per-field
    Firestore configuration.

    Concurrency: create_challenge/consume_challenge/create_reset_token
    are simple sets, safe under Firestore's own last-write-wins
    semantics for this use case (each key is only ever meaningfully
    written by the request that owns it at that moment).
    record_failed_attempt and try_consume_reset_token are the two
    operations concurrent requests could genuinely race on (two wrong
    guesses, or two completions of the same signup/password-reset
    token, arriving at the same instant on two different instances) --
    both run inside a Firestore transaction so the read-check-write is
    atomic even across instances, which is the exact case
    InMemoryChallengeStore's in-process lock could never cover on its
    own. Under extreme contention on that same document
    (verified against a real Firestore emulator: ~10 fully concurrent
    guesses against one challenge with zero backoff -- far more than
    max_attempts ever allows in practice) the client library's own
    retry budget can still be exhausted; record_failed_attempt treats
    that the same as "no such challenge" (see below) rather than
    letting it surface as a 500, since OtpService.verify already
    treats a None result as INVALID_OR_EXPIRED -- a safe, generic
    outcome, not a crash.
    """

    def __init__(self, db, logger: logging.Logger | None = None) -> None:
        self._db = db
        self._logger = logger or logging.getLogger("darwesh.otp.firestore_store")

    async def create_challenge(self, key: str, challenge: Challenge) -> None:
        await asyncio.to_thread(
            self._db.collection(_CHALLENGES_COLLECTION).document(key).set, _challenge_to_dict(challenge)
        )

    async def get_challenge(self, key: str) -> Challenge | None:
        def _read() -> Challenge | None:
            snap = self._db.collection(_CHALLENGES_COLLECTION).document(key).get()
            return _challenge_from_dict(snap.to_dict()) if snap.exists else None

        return await asyncio.to_thread(_read)

    async def record_failed_attempt(self, key: str) -> Challenge | None:
        def _increment() -> Challenge | None:
            ref = self._db.collection(_CHALLENGES_COLLECTION).document(key)
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn):
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    return None
                data = snap.to_dict()
                data["attempts"] = data["attempts"] + 1
                txn.set(ref, data)
                return _challenge_from_dict(data)

            try:
                return _txn(transaction)
            except (google_api_exceptions.Aborted, ValueError) as exc:
                # Transaction commit exhausted its retries under
                # contention -- degrade the same way "no such challenge"
                # does (None -> OtpService.verify returns
                # INVALID_OR_EXPIRED) rather than raising into the HTTP
                # layer as an unhandled 500. Logged at error level since,
                # unlike a genuinely missing challenge, this means a real
                # request was denied fairly by infra contention rather
                # than a wrong code, and repeated occurrences are worth
                # someone's attention.
                self._logger.error(
                    "otp store: record_failed_attempt transaction failed", extra={"error": str(exc)}
                )
                return None

        return await asyncio.to_thread(_increment)

    async def consume_challenge(self, key: str) -> None:
        await asyncio.to_thread(
            self._db.collection(_CHALLENGES_COLLECTION).document(key).update, {"consumed": True}
        )

    async def create_reset_token(self, token: str, entry: ResetToken) -> None:
        await asyncio.to_thread(
            self._db.collection(_RESET_TOKENS_COLLECTION).document(token).set, _reset_token_to_dict(entry)
        )

    async def get_reset_token(self, token: str) -> ResetToken | None:
        def _read() -> ResetToken | None:
            snap = self._db.collection(_RESET_TOKENS_COLLECTION).document(token).get()
            return _reset_token_from_dict(snap.to_dict()) if snap.exists else None

        return await asyncio.to_thread(_read)

    async def try_consume_reset_token(self, token: str) -> ResetToken | None:
        """Atomic check-and-mark-consumed, same contract as
        InMemoryChallengeStore.try_consume_reset_token -- run inside a
        Firestore transaction so two concurrent completions of the same
        token (on the same or different instances) can never both win,
        same reasoning as record_failed_attempt above. Degrades the same
        way on retry-budget exhaustion: caught, logged, treated as "did
        not consume" (None) rather than raised."""

        def _consume() -> ResetToken | None:
            ref = self._db.collection(_RESET_TOKENS_COLLECTION).document(token)
            transaction = self._db.transaction()

            @fb_firestore.transactional
            def _txn(txn):
                snap = ref.get(transaction=txn)
                if not snap.exists:
                    return None
                data = snap.to_dict()
                if data["consumed"] or data["expiresAt"] < time.time():
                    return None
                data["consumed"] = True
                txn.set(ref, data)
                return _reset_token_from_dict(data)

            try:
                return _txn(transaction)
            except (google_api_exceptions.Aborted, ValueError) as exc:
                self._logger.error(
                    "otp store: try_consume_reset_token transaction failed", extra={"error": str(exc)}
                )
                return None

        return await asyncio.to_thread(_consume)
