# Server-side-only storage for OTP challenges and the short-lived reset
# tokens issued after a successful verification. Nothing here is ever
# reachable from Firestore client reads/writes (there is no Firestore
# collection involved at all -- this lives entirely in the backend
# process), and nothing here ever stores a plaintext OTP (see
# app/otp/codes.py -- only its HMAC output is stored).
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Protocol


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
    """Everything OtpService needs from storage. InMemoryChallengeStore
    (below) is the only implementation -- tests use it directly rather
    than a separate fake, since it has no external dependencies to fake
    away (see its own docstring for why in-memory is the right choice
    for what's actually deployed today)."""

    def create_challenge(self, key: str, challenge: Challenge) -> None: ...
    def get_challenge(self, key: str) -> Challenge | None: ...
    def record_failed_attempt(self, key: str) -> Challenge | None: ...
    def consume_challenge(self, key: str) -> None: ...
    def create_reset_token(self, token: str, entry: ResetToken) -> None: ...
    def get_reset_token(self, token: str) -> ResetToken | None: ...
    def consume_reset_token(self, token: str) -> None: ...


class InMemoryChallengeStore:
    """Process-local storage, guarded by a lock and opportunistically
    pruned of expired entries on every access -- the exact same tradeoff
    already accepted by app.auth.reset.RateLimiter (see its docstring):
    correct for a single backend instance, which is what's actually
    deployed today (nothing is deployed at all yet -- see
    docs/BACKEND_MILESTONES.md, milestone 2). If this backend is ever
    scaled to more than one instance, this is the component to swap for
    a shared store (e.g. Firestore via the Admin SDK, or Redis) --
    together with RateLimiter, which has the identical limitation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._challenges: dict[str, Challenge] = {}
        self._reset_tokens: dict[str, ResetToken] = {}

    def _prune_locked(self) -> None:
        now = time.time()
        for store in (self._challenges, self._reset_tokens):
            for key in [k for k, v in store.items() if v.expires_at < now]:
                del store[key]

    def create_challenge(self, key: str, challenge: Challenge) -> None:
        with self._lock:
            self._prune_locked()
            self._challenges[key] = challenge

    def get_challenge(self, key: str) -> Challenge | None:
        with self._lock:
            self._prune_locked()
            return self._challenges.get(key)

    def record_failed_attempt(self, key: str) -> Challenge | None:
        with self._lock:
            self._prune_locked()
            challenge = self._challenges.get(key)
            if challenge is None:
                return None
            challenge.attempts += 1
            return challenge

    def consume_challenge(self, key: str) -> None:
        with self._lock:
            challenge = self._challenges.get(key)
            if challenge is not None:
                challenge.consumed = True

    def create_reset_token(self, token: str, entry: ResetToken) -> None:
        with self._lock:
            self._prune_locked()
            self._reset_tokens[token] = entry

    def get_reset_token(self, token: str) -> ResetToken | None:
        with self._lock:
            self._prune_locked()
            return self._reset_tokens.get(token)

    def consume_reset_token(self, token: str) -> None:
        with self._lock:
            entry = self._reset_tokens.get(token)
            if entry is not None:
                entry.consumed = True
