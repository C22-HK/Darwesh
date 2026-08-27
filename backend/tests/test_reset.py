from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.reset import GENERIC_RESPONSE_MESSAGE, ErrUserNotFound, Handler, RateLimiter


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test")
    logger.addHandler(logging.NullHandler())
    return logger


class FakeLinks:
    def __init__(self, links_by_email=None, errors_by_email=None):
        self.links_by_email = links_by_email or {}
        self.errors_by_email = errors_by_email or {}
        self.calls: list[str] = []

    async def generate_reset_link(self, email: str) -> str:
        self.calls.append(email)
        if email in self.errors_by_email:
            raise self.errors_by_email[email]
        if email in self.links_by_email:
            return self.links_by_email[email]
        raise ErrUserNotFound()


class FakeEmails:
    def __init__(self, error: Exception | None = None):
        self.sent: list[str] = []
        self.error = error

    async def send_reset_email(self, to_email: str, reset_link: str) -> None:
        if self.error:
            raise self.error
        self.sent.append(f"{to_email}|{reset_link}")


def new_test_client(links, emails, limiter: RateLimiter | None = None) -> TestClient:
    handler = Handler(
        links=links,
        emails=emails,
        limiter=limiter or RateLimiter(1000, 60),  # effectively unlimited unless a test says otherwise
        logger=make_test_logger(),
    )
    app = FastAPI()
    app.add_api_route("/api/v1/auth/forgot-password", handler.forgot_password, methods=["POST"])
    return TestClient(app)


def response_message(resp) -> str:
    body = resp.json()
    return body.get("message") or body.get("error")


def test_forgot_password_registered_email_sends_link_and_returns_generic_message():
    links = FakeLinks(
        links_by_email={"real@example.com": "https://www.darweshgroup.com/reset-password.html?oobCode=abc123"}
    )
    emails = FakeEmails()
    client = new_test_client(links, emails)

    resp = client.post("/api/v1/auth/forgot-password", json={"email": "real@example.com"})

    assert resp.status_code == 200
    assert len(emails.sent) == 1
    assert "real@example.com" in emails.sent[0]
    assert "oobCode=abc123" in emails.sent[0]


def test_forgot_password_unregistered_email_returns_identical_response_and_sends_no_email():
    links = FakeLinks()  # no entries -- every email is "not found"
    emails = FakeEmails()
    client = new_test_client(links, emails)

    reg_resp = client.post("/api/v1/auth/forgot-password", json={"email": "real@example.com"})
    unreg_resp = client.post("/api/v1/auth/forgot-password", json={"email": "doesnotexist@example.com"})

    assert reg_resp.status_code == 200
    assert unreg_resp.status_code == 200
    assert response_message(reg_resp) == response_message(unreg_resp)
    assert len(emails.sent) == 0


def test_forgot_password_invalid_email_format_returns_distinct_validation_error():
    # This one IS allowed to differ from the generic message -- a
    # malformed email address is a format problem, not an
    # account-existence signal, so telling the user is fine and helpful.
    links = FakeLinks()
    emails = FakeEmails()
    client = new_test_client(links, emails)

    resp = client.post("/api/v1/auth/forgot-password", json={"email": "not-an-email"})

    assert resp.status_code == 400
    assert len(links.calls) == 0


def test_forgot_password_generator_failure_still_returns_generic_success_message():
    links = FakeLinks(errors_by_email={"real@example.com": RuntimeError("firebase is down")})
    emails = FakeEmails()
    client = new_test_client(links, emails)

    resp = client.post("/api/v1/auth/forgot-password", json={"email": "real@example.com"})

    assert resp.status_code == 200
    assert response_message(resp) == GENERIC_RESPONSE_MESSAGE
    assert len(emails.sent) == 0


def test_forgot_password_rate_limit_blocks_burst():
    links = FakeLinks(links_by_email={"real@example.com": "https://example.com/reset"})
    emails = FakeEmails()
    client = new_test_client(links, emails, limiter=RateLimiter(2, 60))

    first = client.post("/api/v1/auth/forgot-password", json={"email": "real@example.com"})
    second = client.post("/api/v1/auth/forgot-password", json={"email": "real@example.com"})
    third = client.post("/api/v1/auth/forgot-password", json={"email": "real@example.com"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429
    assert len(emails.sent) == 2


def test_rate_limiter_allows_again_after_window_expires():
    import time

    rl = RateLimiter(1, 0.03)
    assert rl.allow("1.2.3.4") is True
    assert rl.allow("1.2.3.4") is False
    time.sleep(0.04)
    assert rl.allow("1.2.3.4") is True


def test_rate_limiter_tracks_keys_independently():
    rl = RateLimiter(1, 60)
    assert rl.allow("1.1.1.1") is True
    assert rl.allow("2.2.2.2") is True
    assert rl.allow("1.1.1.1") is False
