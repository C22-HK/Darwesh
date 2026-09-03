from __future__ import annotations

from app.mam.session import MAX_HISTORY_TURNS, MAX_SESSIONS, SESSION_TTL_SECONDS, SessionStore


def test_get_or_create_without_id_makes_a_new_session():
    store = SessionStore()
    session = store.get_or_create(None)
    assert session.session_id
    assert session.turns == []


def test_get_or_create_with_known_id_returns_same_session():
    store = SessionStore()
    first = store.get_or_create(None)
    again = store.get_or_create(first.session_id)
    assert again is first


def test_get_or_create_with_unknown_id_creates_a_fresh_session_at_that_id():
    store = SessionStore()
    session = store.get_or_create("client-guessed-id")
    assert session.session_id == "client-guessed-id"
    assert session.turns == []


def test_append_bounds_history_to_max_turns():
    store = SessionStore()
    session = store.get_or_create(None)
    for i in range(MAX_HISTORY_TURNS + 10):
        session.append("user", f"message {i}")
    assert len(session.turns) == MAX_HISTORY_TURNS
    # Oldest turns are dropped first -- the most recent turn survives.
    assert session.turns[-1].text == f"message {MAX_HISTORY_TURNS + 9}"


def test_expired_session_is_evicted_on_next_access(monkeypatch):
    store = SessionStore()
    session = store.get_or_create("expiring")

    fake_now = session.updated_at + SESSION_TTL_SECONDS + 1
    monkeypatch.setattr("app.mam.session.time.monotonic", lambda: fake_now)

    fresh = store.get_or_create("expiring")
    # A brand-new session was created at the same id, not the expired one.
    assert fresh.turns == []
    assert fresh is not session


def test_max_sessions_evicts_oldest_first(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr("app.mam.session.MAX_SESSIONS", 2)

    first = store.get_or_create("s1")
    monkeypatch.setattr("app.mam.session.time.monotonic", lambda: 1000.0)
    store.get_or_create("s2")
    monkeypatch.setattr("app.mam.session.time.monotonic", lambda: 2000.0)
    store.get_or_create("s3")

    assert "s1" not in store._sessions
    assert "s2" in store._sessions
    assert "s3" in store._sessions
    assert first.session_id == "s1"
