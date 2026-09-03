# Bounded, short-lived conversation memory (section 13). Deliberately NOT
# a general-purpose chat history store: a session holds only what the
# next turn needs to resolve a follow-up ("only 3 bedrooms", "compare the
# first two"), capped at MAX_HISTORY_TURNS turns, and is never persisted
# beyond that -- no unlimited raw conversation log is kept anywhere by
# this module.
#
# Retention (documented here, the single source of truth for this
# behavior): SessionStore below is process-local, in-memory, evicted by a
# fixed TTL AND a fixed max-session count. A session surviving a Cloud Run
# instance restart or scale-to-zero is NOT a guarantee this store makes --
# acceptable for MAM's actual need (a few minutes of "what did we just
# talk about"), unlike the OTP/rate-limit stores elsewhere in this
# backend, which correctness-depend on surviving across instances and are
# Firestore-backed for exactly that reason. A future phase that needs
# cross-instance session continuity should extend this the same way
# app.otp.store.FirestoreChallengeStore extends InMemoryChallengeStore --
# not something this phase's scope requires.
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field

MAX_HISTORY_TURNS = 12
SESSION_TTL_SECONDS = 30 * 60  # 30 minutes of inactivity
MAX_SESSIONS = 5000  # process-wide cap; oldest evicted first once exceeded


@dataclass
class SessionTurn:
    role: str  # "user" | "assistant"
    text: str


@dataclass
class SessionState:
    session_id: str
    turns: list[SessionTurn] = field(default_factory=list)
    last_result_ids: list[str] = field(default_factory=list)  # the last search's listing ids, for "compare the first two"
    updated_at: float = field(default_factory=time.monotonic)

    def append(self, role: str, text: str) -> None:
        self.turns.append(SessionTurn(role=role, text=text))
        if len(self.turns) > MAX_HISTORY_TURNS:
            self.turns = self.turns[-MAX_HISTORY_TURNS:]
        self.updated_at = time.monotonic()


class SessionStore:
    """Process-local, thread-safe. See module docstring for the retention
    tradeoff this makes on purpose."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, SessionState] = {}

    def get_or_create(self, session_id: str | None) -> SessionState:
        with self._lock:
            self._evict_expired_locked()
            if session_id and session_id in self._sessions:
                return self._sessions[session_id]
            new_id = session_id or uuid.uuid4().hex
            state = SessionState(session_id=new_id)
            if len(self._sessions) >= MAX_SESSIONS:
                oldest_id = min(self._sessions, key=lambda k: self._sessions[k].updated_at)
                del self._sessions[oldest_id]
            self._sessions[new_id] = state
            return state

    def _evict_expired_locked(self) -> None:
        now = time.monotonic()
        expired = [k for k, v in self._sessions.items() if now - v.updated_at > SESSION_TTL_SECONDS]
        for k in expired:
            del self._sessions[k]
