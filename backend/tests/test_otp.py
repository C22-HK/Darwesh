from __future__ import annotations

import logging
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.reset import RateLimiter
from app.otp.handler import (
    GENERIC_SEND_MESSAGE,
    OtpSendHandler,
    OtpVerifyHandler,
    PasswordResetConfirmHandler,
)
from app.otp.phone import InvalidPhoneNumber, normalize_iraqi_phone
from app.otp.service import OtpService, Purpose, SendResult, VerifyResult
from app.otp.store import InMemoryChallengeStore


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.otp")
    logger.addHandler(logging.NullHandler())
    return logger


class FakeSender:
    def __init__(self, fail: bool = False):
        self.sent: list[tuple[str, str]] = []
        self.fail = fail

    async def send_otp_message(self, phone_e164: str, code: str) -> None:
        if self.fail:
            raise RuntimeError("provider down")
        self.sent.append((phone_e164, code))


class FakeUidResolver:
    """phone -> uid map, standing in for get_user_by_phone_number."""

    def __init__(self, uids_by_phone: dict[str, str] | None = None, raise_error: bool = False):
        self.uids_by_phone = uids_by_phone or {}
        self.raise_error = raise_error
        self.calls: list[str] = []

    async def resolve(self, phone_e164: str) -> str | None:
        self.calls.append(phone_e164)
        if self.raise_error:
            raise RuntimeError("firebase is unreachable")
        return self.uids_by_phone.get(phone_e164)


class FakeFirebaseExecutor:
    """Records password resets and session revocations by uid, standing
    in for FirebasePhoneAuthManager's write side."""

    def __init__(self, fail: bool = False):
        self.password_updates: list[tuple[str, str]] = []
        self.revocations: list[str] = []
        self.fail = fail

    async def set_password_and_revoke_sessions(self, uid: str, new_password: str) -> None:
        if self.fail:
            raise RuntimeError("firebase down")
        self.password_updates.append((uid, new_password))
        self.revocations.append(uid)


def make_service(
    sender=None, uids=None, otp_secret="test-secret", **overrides
) -> tuple[OtpService, InMemoryChallengeStore]:
    store = InMemoryChallengeStore()
    service = OtpService(
        store=store,
        sender=sender or FakeSender(),
        uids=uids or FakeUidResolver(),
        otp_secret=otp_secret,
        logger=make_test_logger(),
        **overrides,
    )
    return service, store


PHONE_A = "+9647501234567"
PHONE_B = "+9647519876543"


# ---------- app/otp/phone.py ----------


@pytest.mark.parametrize(
    "raw",
    [
        "0750 123 4567",
        "07501234567",
        "964750 1234567",
        "+964750 123 4567",
        "00964750-123-4567",
        "(0750) 123-4567",
    ],
)
def test_normalize_iraqi_phone_accepts_common_formats(raw):
    assert normalize_iraqi_phone(raw) == PHONE_A


@pytest.mark.parametrize("raw", ["12345", "+1 555 123 4567", "0123456789", "", "+964123456789"])
def test_normalize_iraqi_phone_rejects_unrecognizable_numbers(raw):
    with pytest.raises(InvalidPhoneNumber):
        normalize_iraqi_phone(raw)


# ---------- OtpService: send ----------


@pytest.mark.asyncio
async def test_send_noop_for_unregistered_phone_creates_no_challenge_and_contacts_no_provider():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver({}))

    result = await service.send(PHONE_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.NOOP
    assert sender.sent == []
    assert store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_A}") is None


@pytest.mark.asyncio
async def test_send_degrades_to_noop_when_uid_resolution_itself_fails():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver(raise_error=True))

    result = await service.send(PHONE_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.NOOP  # never a raised exception reaching the HTTP layer
    assert sender.sent == []
    assert store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_A}") is None


@pytest.mark.asyncio
async def test_send_for_registered_phone_creates_hashed_challenge_and_sends_via_provider():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))

    result = await service.send(PHONE_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.SENT
    assert len(sender.sent) == 1
    sent_phone, sent_code = sender.sent[0]
    assert sent_phone == PHONE_A
    assert len(sent_code) == 6 and sent_code.isdigit()

    challenge = store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_A}")
    assert challenge is not None
    assert challenge.uid == "uid-a"
    assert challenge.otp_hash != sent_code  # never stored in plaintext


@pytest.mark.asyncio
async def test_send_provider_failure_still_reports_sent_not_leaked_to_caller():
    sender = FakeSender(fail=True)
    service, _ = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))

    result = await service.send(PHONE_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.SENT  # a challenge was created; delivery failure is swallowed, not surfaced


@pytest.mark.asyncio
async def test_resend_within_cooldown_is_blocked_and_does_not_replace_the_pending_code():
    service, store = make_service(uids=FakeUidResolver({PHONE_A: "uid-a"}), resend_cooldown_seconds=60)

    await service.send(PHONE_A, Purpose.PASSWORD_RESET)
    first_hash = store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_A}").otp_hash

    result = await service.send(PHONE_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.COOLDOWN
    assert store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_A}").otp_hash == first_hash


@pytest.mark.asyncio
async def test_resend_after_cooldown_expires_replaces_the_previous_code():
    service, store = make_service(uids=FakeUidResolver({PHONE_A: "uid-a"}), resend_cooldown_seconds=0.03)

    await service.send(PHONE_A, Purpose.PASSWORD_RESET)
    first_hash = store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_A}").otp_hash
    time.sleep(0.04)

    result = await service.send(PHONE_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.SENT
    new_hash = store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_A}").otp_hash
    assert new_hash != first_hash  # old code invalidated by the new one


# ---------- OtpService: verify ----------


def _sent_code(sender: FakeSender, phone: str) -> str:
    for p, code in sender.sent:
        if p == phone:
            return code
    raise AssertionError("no code sent to this phone")


@pytest.mark.asyncio
async def test_verify_correct_code_returns_ok_and_a_reset_token():
    sender = FakeSender()
    service, _ = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))
    await service.send(PHONE_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, PHONE_A)

    result, token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, code)

    assert result == VerifyResult.OK
    assert token is not None and len(token) > 20


@pytest.mark.asyncio
async def test_verify_wrong_code_is_rejected_generically():
    sender = FakeSender()
    service, _ = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))
    await service.send(PHONE_A, Purpose.PASSWORD_RESET)

    result, token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, "000000")

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


@pytest.mark.asyncio
async def test_verify_with_no_challenge_at_all_is_rejected_identically_to_wrong_code():
    service, _ = make_service(uids=FakeUidResolver({PHONE_A: "uid-a"}))

    result, token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, "123456")

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


@pytest.mark.asyncio
async def test_verify_expired_code_is_rejected():
    sender = FakeSender()
    service, _ = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}), otp_ttl_seconds=0.03)
    await service.send(PHONE_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, PHONE_A)
    time.sleep(0.04)

    result, token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


@pytest.mark.asyncio
async def test_verify_reused_code_is_rejected_the_second_time():
    sender = FakeSender()
    service, _ = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))
    await service.send(PHONE_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, PHONE_A)

    first, first_token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, code)
    second, second_token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, code)

    assert first == VerifyResult.OK and first_token is not None
    assert second == VerifyResult.INVALID_OR_EXPIRED and second_token is None


@pytest.mark.asyncio
async def test_verify_exceeding_max_attempts_locks_out_even_the_correct_code():
    sender = FakeSender()
    service, _ = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}), max_attempts=3)
    await service.send(PHONE_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, PHONE_A)

    results = [service.verify(PHONE_A, Purpose.PASSWORD_RESET, "000000")[0] for _ in range(3)]
    final_result, final_token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, code)

    assert results[-1] == VerifyResult.TOO_MANY_ATTEMPTS
    assert final_result == VerifyResult.TOO_MANY_ATTEMPTS
    assert final_token is None


@pytest.mark.asyncio
async def test_purpose_binding_a_challenge_for_one_purpose_cannot_verify_under_another():
    sender = FakeSender()
    service, _ = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))
    await service.send(PHONE_A, Purpose.SIGNUP)
    signup_code = _sent_code(sender, PHONE_A)

    result, token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, signup_code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


@pytest.mark.asyncio
async def test_user_a_verification_can_never_produce_a_reset_token_bound_to_user_b():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a", PHONE_B: "uid-b"}))
    await service.send(PHONE_A, Purpose.PASSWORD_RESET)
    code_a = _sent_code(sender, PHONE_A)

    result, token = service.verify(PHONE_A, Purpose.PASSWORD_RESET, code_a)

    assert result == VerifyResult.OK
    entry = store.get_reset_token(token)
    assert entry.uid == "uid-a"
    assert entry.uid != "uid-b"
    # Phone B never requested or verified anything -- no token exists
    # that could possibly resolve to uid-b.
    assert store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{PHONE_B}") is None


# ---------- HTTP layer ----------


def make_client(
    service: OtpService,
    store: InMemoryChallengeStore,
    firebase_executor: FakeFirebaseExecutor | None = None,
    send_ip_limiter: RateLimiter | None = None,
    send_phone_limiter: RateLimiter | None = None,
    verify_ip_limiter: RateLimiter | None = None,
) -> TestClient:
    logger = make_test_logger()
    send_handler = OtpSendHandler(
        service=service,
        ip_limiter=send_ip_limiter or RateLimiter(1000, 60),
        phone_limiter=send_phone_limiter or RateLimiter(1000, 60),
        logger=logger,
    )
    verify_handler = OtpVerifyHandler(
        service=service, ip_limiter=verify_ip_limiter or RateLimiter(1000, 60), logger=logger
    )
    confirm_handler = PasswordResetConfirmHandler(
        store=store, firebase=firebase_executor or FakeFirebaseExecutor(), logger=logger
    )

    app = FastAPI()
    app.add_api_route("/api/v1/auth/otp/send", send_handler.send, methods=["POST"])
    app.add_api_route("/api/v1/auth/otp/verify", verify_handler.verify, methods=["POST"])
    app.add_api_route("/api/v1/auth/password-reset/confirm", confirm_handler.confirm, methods=["POST"])
    return TestClient(app)


def test_http_send_returns_identical_response_for_registered_and_unregistered_phone():
    service, store = make_service(uids=FakeUidResolver({PHONE_A: "uid-a"}))
    client = make_client(service, store)

    reg = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})
    unreg = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_B, "purpose": "PASSWORD_RESET"})

    assert reg.status_code == 200 and unreg.status_code == 200
    assert reg.json() == unreg.json() == {"message": GENERIC_SEND_MESSAGE}


def test_http_send_returns_the_same_generic_response_even_if_uid_resolution_errors():
    # A transient Firebase outage must never surface as a 500 (which
    # would itself be a distinguishing signal, and would needlessly
    # alarm a real user for a passing glitch) -- it degrades exactly
    # like "no such account" does.
    service, store = make_service(uids=FakeUidResolver(raise_error=True))
    client = make_client(service, store)

    resp = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})

    assert resp.status_code == 200
    assert resp.json() == {"message": GENERIC_SEND_MESSAGE}


def test_http_send_rejects_unsupported_purpose():
    service, store = make_service()
    client = make_client(service, store)

    resp = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "SIGNUP"})

    assert resp.status_code == 400


def test_http_send_rejects_malformed_phone():
    service, store = make_service()
    client = make_client(service, store)

    resp = client.post("/api/v1/auth/otp/send", json={"phoneNumber": "not-a-phone", "purpose": "PASSWORD_RESET"})

    assert resp.status_code == 400


def test_http_send_rate_limits_by_ip_and_by_phone_independently():
    service, store = make_service(uids=FakeUidResolver({PHONE_A: "uid-a", PHONE_B: "uid-b"}))
    client = make_client(
        service, store, send_phone_limiter=RateLimiter(1, 60), send_ip_limiter=RateLimiter(1000, 60)
    )

    first = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})
    second = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})
    other_phone = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_B, "purpose": "PASSWORD_RESET"})

    assert first.status_code == 200
    assert second.status_code == 429  # same phone, blocked
    assert other_phone.status_code == 200  # different phone, independently tracked


def test_full_password_reset_flow_end_to_end():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    send_resp = client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})
    assert send_resp.status_code == 200
    code = _sent_code(sender, PHONE_A)

    verify_resp = client.post(
        "/api/v1/auth/otp/verify", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET", "code": code}
    )
    assert verify_resp.status_code == 200
    reset_token = verify_resp.json()["resetToken"]

    confirm_resp = client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"resetToken": reset_token, "newPassword": "a-strong-new-password-123"},
    )

    assert confirm_resp.status_code == 200
    assert firebase.password_updates == [("uid-a", "a-strong-new-password-123")]
    assert firebase.revocations == ["uid-a"]  # sessions revoked after reset


def test_reset_token_cannot_be_reused_for_a_second_password_change():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})
    code = _sent_code(sender, PHONE_A)
    verify_resp = client.post(
        "/api/v1/auth/otp/verify", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET", "code": code}
    )
    reset_token = verify_resp.json()["resetToken"]

    first = client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"resetToken": reset_token, "newPassword": "first-password-123"},
    )
    second = client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"resetToken": reset_token, "newPassword": "second-password-456"},
    )

    assert first.status_code == 200
    assert second.status_code == 400
    assert firebase.password_updates == [("uid-a", "first-password-123")]


def test_reset_confirm_rejects_unknown_or_forged_token():
    service, store = make_service()
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    resp = client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"resetToken": "totally-made-up-token", "newPassword": "whatever-password-123"},
    )

    assert resp.status_code == 400
    assert firebase.password_updates == []


def test_reset_confirm_rejects_password_below_minimum_length():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})
    code = _sent_code(sender, PHONE_A)
    verify_resp = client.post(
        "/api/v1/auth/otp/verify", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET", "code": code}
    )
    reset_token = verify_resp.json()["resetToken"]

    resp = client.post(
        "/api/v1/auth/password-reset/confirm", json={"resetToken": reset_token, "newPassword": "short"}
    )

    assert resp.status_code == 400
    assert firebase.password_updates == []


def test_verify_a_cannot_be_replayed_to_reset_b_even_when_both_have_pending_challenges():
    sender = FakeSender()
    service, store = make_service(sender=sender, uids=FakeUidResolver({PHONE_A: "uid-a", PHONE_B: "uid-b"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET"})
    client.post("/api/v1/auth/otp/send", json={"phoneNumber": PHONE_B, "purpose": "PASSWORD_RESET"})
    code_a = _sent_code(sender, PHONE_A)

    # Verifying A's own code, with A's own phone number, is the only way
    # to obtain a token -- and that token can only ever act on uid-a.
    verify_resp = client.post(
        "/api/v1/auth/otp/verify", json={"phoneNumber": PHONE_A, "purpose": "PASSWORD_RESET", "code": code_a}
    )
    reset_token = verify_resp.json()["resetToken"]

    client.post(
        "/api/v1/auth/password-reset/confirm", json={"resetToken": reset_token, "newPassword": "new-password-123"}
    )

    assert firebase.password_updates == [("uid-a", "new-password-123")]
    assert "uid-b" not in [uid for uid, _ in firebase.password_updates]
