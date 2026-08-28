from __future__ import annotations

import logging
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.reset import RateLimiter
from app.otp.email_address import InvalidEmailAddress, normalize_email
from app.otp.email_handler import (
    GENERIC_SEND_MESSAGE,
    EmailOtpSendHandler,
    EmailOtpVerifyHandler,
    SignupCompleteHandler,
)
from app.otp.firebase_admin_ops import AccountAlreadyExists
from app.otp.handler import PasswordResetConfirmHandler
from app.otp.service import OtpService, Purpose, SendResult, VerifyResult
from app.otp.store import InMemoryChallengeStore


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.email_otp")
    logger.addHandler(logging.NullHandler())
    return logger


class FakeEmailSender:
    def __init__(self, fail: bool = False):
        self.sent: list[tuple[str, str, str]] = []  # (identifier, code, purpose)
        self.fail = fail

    async def send_otp(self, identifier: str, code: str, purpose: Purpose) -> None:
        if self.fail:
            raise RuntimeError("resend is down")
        self.sent.append((identifier, code, purpose.value))


class FakeEmailUidResolver:
    """email -> uid map, standing in for get_user_by_email -- used only
    for PASSWORD_RESET (SIGNUP_EMAIL_VERIFY never calls this)."""

    def __init__(self, uids_by_email: dict[str, str] | None = None, raise_error: bool = False):
        self.uids_by_email = uids_by_email or {}
        self.raise_error = raise_error
        self.calls: list[str] = []

    async def resolve(self, identifier: str) -> str | None:
        self.calls.append(identifier)
        if self.raise_error:
            raise RuntimeError("firebase is unreachable")
        return self.uids_by_email.get(identifier)


class FakeFirebaseExecutor:
    """Records password resets and session revocations by uid, standing
    in for FirebaseAccountOps's write side."""

    def __init__(self, fail: bool = False):
        self.password_updates: list[tuple[str, str]] = []
        self.revocations: list[str] = []
        self.fail = fail

    async def set_password_and_revoke_sessions(self, uid: str, new_password: str) -> None:
        if self.fail:
            raise RuntimeError("firebase down")
        self.password_updates.append((uid, new_password))
        self.revocations.append(uid)


class FakeAccountOps:
    """Standing in for FirebaseAccountOps's account-creation side, used
    by SignupCompleteHandler."""

    def __init__(self, existing_emails: set[str] | None = None, existing_phones: set[str] | None = None):
        self.existing_emails = existing_emails or set()
        self.existing_phones = existing_phones or set()
        self.created: list[dict] = []
        self.profiles_written: list[dict] = []
        self._next_uid = 1
        self.mint_calls: list[str] = []
        self.fail_profile_write = False
        self.fail_mint = False

    async def create_account(self, *, email: str, phone_e164: str, password: str, display_name: str) -> str:
        if email in self.existing_emails:
            raise AccountAlreadyExists("email")
        if phone_e164 in self.existing_phones:
            raise AccountAlreadyExists("phone")
        uid = f"uid-{self._next_uid}"
        self._next_uid += 1
        self.existing_emails.add(email)
        self.existing_phones.add(phone_e164)
        self.created.append(
            {
                "uid": uid,
                "email": email,
                "phone_e164": phone_e164,
                "password": password,
                "display_name": display_name,
            }
        )
        return uid

    async def create_user_profile(self, uid: str, *, display_name: str, email: str, phone_e164: str) -> None:
        if self.fail_profile_write:
            raise RuntimeError("firestore down")
        self.profiles_written.append(
            {"uid": uid, "display_name": display_name, "email": email, "phone_e164": phone_e164}
        )

    async def mint_custom_token(self, uid: str) -> str:
        self.mint_calls.append(uid)
        if self.fail_mint:
            raise RuntimeError("token minting failed")
        return f"custom-token-for-{uid}"


def make_service(
    sender=None, uids=None, otp_secret="test-secret", **overrides
) -> tuple[OtpService, InMemoryChallengeStore]:
    store = InMemoryChallengeStore()
    service = OtpService(
        store=store,
        sender=sender or FakeEmailSender(),
        uids=uids or FakeEmailUidResolver(),
        otp_secret=otp_secret,
        logger=make_test_logger(),
        **overrides,
    )
    return service, store


EMAIL_A = "alice@example.com"
EMAIL_B = "bob@example.com"
PHONE_A = "+9647501234567"
PHONE_B = "+9647519876543"


def _sent_code(sender: FakeEmailSender, email: str) -> str:
    # Latest match, not first -- a test that sends for two different
    # purposes to the same address (e.g. signup then password reset)
    # must not accidentally pick up the earlier purpose's code.
    for addr, code, _purpose in reversed(sender.sent):
        if addr == email:
            return code
    raise AssertionError("no code sent to this email")


# ---------- app/otp/email_address.py ----------


@pytest.mark.parametrize("raw", [" Alice@Example.com ", "alice@example.com", "ALICE@EXAMPLE.COM"])
def test_normalize_email_lowercases_and_trims(raw):
    assert normalize_email(raw) == EMAIL_A


@pytest.mark.parametrize("raw", ["not-an-email", "missing-at.example.com", "", "a@b"])
def test_normalize_email_rejects_malformed_input(raw):
    with pytest.raises(InvalidEmailAddress):
        normalize_email(raw)


# ---------- Purpose-specific send behavior (the core design decision) ----------


async def test_signup_verify_sends_even_with_no_existing_account():
    sender = FakeEmailSender()
    resolver = FakeEmailUidResolver({})  # nobody registered
    service, store = make_service(sender=sender, uids=resolver)

    result = await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)

    assert result == SendResult.SENT
    assert len(sender.sent) == 1
    assert resolver.calls == []  # never even consulted for signup
    challenge = store.get_challenge(f"{Purpose.SIGNUP_EMAIL_VERIFY.value}:{EMAIL_A}")
    assert challenge is not None
    assert challenge.uid is None  # no account exists yet


async def test_password_reset_noops_for_unregistered_email():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({}))

    result = await service.send(EMAIL_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.NOOP
    assert sender.sent == []
    assert store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{EMAIL_A}") is None


async def test_password_reset_sends_for_registered_email_and_binds_uid():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))

    result = await service.send(EMAIL_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.SENT
    challenge = store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{EMAIL_A}")
    assert challenge.uid == "uid-a"


# ---------- OTP security properties (generic engine, exercised via email identifiers) ----------


async def test_signup_otp_success():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)

    result, token = service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert result == VerifyResult.OK
    assert token is not None


async def test_incorrect_signup_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)

    result, token = service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, "000000")

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_expired_signup_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, otp_ttl_seconds=0.03)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)
    time.sleep(0.04)

    result, token = service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_consumed_signup_otp_cannot_be_reused():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)

    first, first_token = service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)
    second, second_token = service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert first == VerifyResult.OK and first_token is not None
    assert second == VerifyResult.INVALID_OR_EXPIRED and second_token is None


async def test_resend_cooldown_works():
    service, store = make_service(resend_cooldown_seconds=60)

    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    first_hash = store.get_challenge(f"{Purpose.SIGNUP_EMAIL_VERIFY.value}:{EMAIL_A}").otp_hash

    result = await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)

    assert result == SendResult.COOLDOWN
    assert store.get_challenge(f"{Purpose.SIGNUP_EMAIL_VERIFY.value}:{EMAIL_A}").otp_hash == first_hash


async def test_attempt_limit_works():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, max_attempts=3)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)

    results = [service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, "000000")[0] for _ in range(3)]
    final_result, final_token = service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert results[-1] == VerifyResult.TOO_MANY_ATTEMPTS
    assert final_result == VerifyResult.TOO_MANY_ATTEMPTS
    assert final_token is None


def test_rate_limiting_works():
    limiter = RateLimiter(1, 60)
    assert limiter.allow(EMAIL_A) is True
    assert limiter.allow(EMAIL_A) is False
    assert limiter.allow(EMAIL_B) is True  # tracked independently


async def test_signup_otp_cannot_authorize_password_reset():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    signup_code = _sent_code(sender, EMAIL_A)

    result, token = service.verify(EMAIL_A, Purpose.PASSWORD_RESET, signup_code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_password_reset_otp_cannot_activate_signup():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    reset_code = _sent_code(sender, EMAIL_A)

    result, token = service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, reset_code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_password_reset_otp_success():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, EMAIL_A)

    result, token = service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)

    assert result == VerifyResult.OK
    assert token is not None


async def test_wrong_password_reset_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)

    result, token = service.verify(EMAIL_A, Purpose.PASSWORD_RESET, "999999")

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_expired_reset_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}), otp_ttl_seconds=0.03)
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, EMAIL_A)
    time.sleep(0.04)

    result, token = service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_reused_reset_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, EMAIL_A)

    first, _ = service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)
    second, _ = service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)

    assert first == VerifyResult.OK
    assert second == VerifyResult.INVALID_OR_EXPIRED


async def test_provider_failure_does_not_leak_account_existence():
    # A resolver failure (transient Firebase outage) degrades to NOOP,
    # not a raised exception -- the HTTP layer's response stays generic
    # either way (see the HTTP-layer test below).
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver(raise_error=True))

    result = await service.send(EMAIL_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.NOOP
    assert sender.sent == []
    assert store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{EMAIL_A}") is None


# ---------- HTTP layer ----------


def make_client(
    service: OtpService,
    store: InMemoryChallengeStore,
    firebase_executor: FakeFirebaseExecutor | None = None,
    account_ops: FakeAccountOps | None = None,
    send_ip_limiter: RateLimiter | None = None,
    send_email_limiter: RateLimiter | None = None,
    verify_ip_limiter: RateLimiter | None = None,
    complete_ip_limiter: RateLimiter | None = None,
) -> TestClient:
    logger = make_test_logger()
    send_handler = EmailOtpSendHandler(
        service=service,
        ip_limiter=send_ip_limiter or RateLimiter(1000, 60),
        email_limiter=send_email_limiter or RateLimiter(1000, 60),
        logger=logger,
    )
    verify_handler = EmailOtpVerifyHandler(
        service=service, ip_limiter=verify_ip_limiter or RateLimiter(1000, 60), logger=logger
    )
    complete_handler = SignupCompleteHandler(
        store=store,
        accounts=account_ops or FakeAccountOps(),
        ip_limiter=complete_ip_limiter or RateLimiter(1000, 60),
        logger=logger,
    )
    confirm_handler = PasswordResetConfirmHandler(
        store=store, firebase=firebase_executor or FakeFirebaseExecutor(), logger=logger
    )

    app = FastAPI()
    app.add_api_route("/api/v1/auth/email-otp/send", send_handler.send, methods=["POST"])
    app.add_api_route("/api/v1/auth/email-otp/verify", verify_handler.verify, methods=["POST"])
    app.add_api_route("/api/v1/auth/signup/complete", complete_handler.complete, methods=["POST"])
    app.add_api_route("/api/v1/auth/password-reset/confirm", confirm_handler.confirm, methods=["POST"])
    return TestClient(app)


def test_http_send_returns_identical_response_regardless_of_account_existence():
    service, store = make_service(uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    client = make_client(service, store)

    reg = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    unreg = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_B, "purpose": "PASSWORD_RESET"})

    assert reg.status_code == 200 and unreg.status_code == 200
    assert reg.json() == unreg.json() == {"message": GENERIC_SEND_MESSAGE}


def test_http_send_returns_generic_response_even_when_resolver_errors():
    service, store = make_service(uids=FakeEmailUidResolver(raise_error=True))
    client = make_client(service, store)

    resp = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})

    assert resp.status_code == 200
    assert resp.json() == {"message": GENERIC_SEND_MESSAGE}


def test_http_send_rejects_malformed_email():
    service, store = make_service()
    client = make_client(service, store)

    resp = client.post(
        "/api/v1/auth/email-otp/send", json={"email": "not-an-email", "purpose": "SIGNUP_EMAIL_VERIFY"}
    )

    assert resp.status_code == 400


def test_http_send_rejects_missing_purpose():
    service, store = make_service()
    client = make_client(service, store)

    resp = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A})

    assert resp.status_code == 400


def test_http_send_rate_limits_by_email_and_by_ip_independently():
    service, store = make_service()
    client = make_client(
        service, store, send_email_limiter=RateLimiter(1, 60), send_ip_limiter=RateLimiter(1000, 60)
    )

    first = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    second = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    other_email = client.post(
        "/api/v1/auth/email-otp/send", json={"email": EMAIL_B, "purpose": "SIGNUP_EMAIL_VERIFY"}
    )

    assert first.status_code == 200
    assert second.status_code == 429
    assert other_email.status_code == 200


def test_verify_response_uses_verifytoken_field_for_signup_and_resettoken_for_password_reset():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    client = make_client(service, store)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    signup_code = _sent_code(sender, EMAIL_A)
    signup_resp = client.post(
        "/api/v1/auth/email-otp/verify",
        json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": signup_code},
    )
    assert "verifyToken" in signup_resp.json()
    assert "resetToken" not in signup_resp.json()

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    reset_code = _sent_code(sender, EMAIL_A)
    reset_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET", "code": reset_code}
    )
    assert "resetToken" in reset_resp.json()
    assert "verifyToken" not in reset_resp.json()


# ---------- Signup completion ----------


def test_signup_complete_creates_account_and_returns_custom_token():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    client = make_client(service, store, account_ops=ops)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code}
    )
    verify_token = verify_resp.json()["verifyToken"]

    resp = client.post(
        "/api/v1/auth/signup/complete",
        json={
            "verifyToken": verify_token,
            "fullName": "Ahmed Darwesh",
            "phoneNumber": "0750 123 4567",
            "password": "a-strong-password-123",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["customToken"] == f"custom-token-for-{body['uid']}"
    assert ops.created[0]["email"] == EMAIL_A
    assert ops.created[0]["phone_e164"] == PHONE_A  # normalized
    assert ops.profiles_written[0]["email"] == EMAIL_A


def test_signup_complete_email_is_bound_to_the_verified_token_not_client_supplied():
    # The request body has no email field at all -- SignupCompleteHandler
    # must derive it entirely from the verifyToken, so a client can never
    # claim to have verified an address it didn't actually prove.
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    client = make_client(service, store, account_ops=ops)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code}
    )
    verify_token = verify_resp.json()["verifyToken"]

    client.post(
        "/api/v1/auth/signup/complete",
        json={
            "verifyToken": verify_token,
            "fullName": "Ahmed Darwesh",
            "phoneNumber": "0750 123 4567",
            "password": "a-strong-password-123",
        },
    )

    assert ops.created[0]["email"] == EMAIL_A  # exactly the verified address, nothing else was accepted


def test_signup_complete_rejects_password_reset_token():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    ops = FakeAccountOps()
    client = make_client(service, store, account_ops=ops)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET", "code": code}
    )
    reset_token = verify_resp.json()["resetToken"]

    resp = client.post(
        "/api/v1/auth/signup/complete",
        json={
            "verifyToken": reset_token,
            "fullName": "Ahmed Darwesh",
            "phoneNumber": "0750 123 4567",
            "password": "a-strong-password-123",
        },
    )

    assert resp.status_code == 400
    assert ops.created == []


def test_signup_complete_rejects_duplicate_email():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps(existing_emails={EMAIL_A})
    client = make_client(service, store, account_ops=ops)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code}
    )
    verify_token = verify_resp.json()["verifyToken"]

    resp = client.post(
        "/api/v1/auth/signup/complete",
        json={
            "verifyToken": verify_token,
            "fullName": "Ahmed Darwesh",
            "phoneNumber": "0750 123 4567",
            "password": "a-strong-password-123",
        },
    )

    assert resp.status_code == 409
    assert "email" in resp.json()["error"]


def test_signup_complete_rejects_duplicate_phone():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps(existing_phones={PHONE_A})
    client = make_client(service, store, account_ops=ops)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code}
    )
    verify_token = verify_resp.json()["verifyToken"]

    resp = client.post(
        "/api/v1/auth/signup/complete",
        json={
            "verifyToken": verify_token,
            "fullName": "Ahmed Darwesh",
            "phoneNumber": "0750 123 4567",
            "password": "a-strong-password-123",
        },
    )

    assert resp.status_code == 409
    assert "phone" in resp.json()["error"]


def test_signup_complete_verify_token_is_single_use():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    client = make_client(service, store, account_ops=ops)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code}
    )
    verify_token = verify_resp.json()["verifyToken"]

    payload = {
        "verifyToken": verify_token,
        "fullName": "Ahmed Darwesh",
        "phoneNumber": "0750 123 4567",
        "password": "a-strong-password-123",
    }
    first = client.post("/api/v1/auth/signup/complete", json=payload)
    second = client.post("/api/v1/auth/signup/complete", json=payload)

    assert first.status_code == 200
    assert second.status_code == 400
    assert len(ops.created) == 1


def test_signup_complete_survives_profile_write_failure_without_losing_the_auth_account():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    ops.fail_profile_write = True
    client = make_client(service, store, account_ops=ops)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code}
    )
    verify_token = verify_resp.json()["verifyToken"]

    resp = client.post(
        "/api/v1/auth/signup/complete",
        json={
            "verifyToken": verify_token,
            "fullName": "Ahmed Darwesh",
            "phoneNumber": "0750 123 4567",
            "password": "a-strong-password-123",
        },
    )

    # The Auth account was still created and a token still issued -- the
    # user isn't blocked by a Firestore hiccup, even though their profile
    # doc needs reconciling (logged server-side).
    assert resp.status_code == 200
    assert "customToken" in resp.json()
    assert len(ops.created) == 1


# ---------- Password reset: existing tests generalized to email ----------


def test_full_password_reset_flow_end_to_end():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    send_resp = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    assert send_resp.status_code == 200
    code = _sent_code(sender, EMAIL_A)

    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET", "code": code}
    )
    reset_token = verify_resp.json()["resetToken"]

    confirm_resp = client.post(
        "/api/v1/auth/password-reset/confirm",
        json={"resetToken": reset_token, "newPassword": "a-strong-new-password-123"},
    )

    assert confirm_resp.status_code == 200
    assert firebase.password_updates == [("uid-a", "a-strong-new-password-123")]
    assert firebase.revocations == ["uid-a"]  # old sessions revoked


def test_user_a_verification_can_never_produce_a_reset_token_bound_to_user_b():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a", EMAIL_B: "uid-b"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_B, "purpose": "PASSWORD_RESET"})
    code_a = _sent_code(sender, EMAIL_A)

    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET", "code": code_a}
    )
    reset_token = verify_resp.json()["resetToken"]

    client.post(
        "/api/v1/auth/password-reset/confirm", json={"resetToken": reset_token, "newPassword": "new-password-123"}
    )

    assert firebase.password_updates == [("uid-a", "new-password-123")]
    assert "uid-b" not in [uid for uid, _ in firebase.password_updates]


def test_old_reset_token_cannot_be_reused():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET", "code": code}
    )
    reset_token = verify_resp.json()["resetToken"]

    first = client.post(
        "/api/v1/auth/password-reset/confirm", json={"resetToken": reset_token, "newPassword": "first-password-1"}
    )
    second = client.post(
        "/api/v1/auth/password-reset/confirm", json={"resetToken": reset_token, "newPassword": "second-password-2"}
    )

    assert first.status_code == 200
    assert second.status_code == 400
    assert firebase.password_updates == [("uid-a", "first-password-1")]


def test_reset_token_expires():
    sender = FakeEmailSender()
    service, store = make_service(
        sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}), reset_token_ttl_seconds=0.03
    )
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    code = _sent_code(sender, EMAIL_A)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET", "code": code}
    )
    reset_token = verify_resp.json()["resetToken"]
    time.sleep(0.04)

    resp = client.post(
        "/api/v1/auth/password-reset/confirm", json={"resetToken": reset_token, "newPassword": "new-password-123"}
    )

    assert resp.status_code == 400
    assert firebase.password_updates == []


def test_firebase_password_change_only_for_the_correct_uid():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a", EMAIL_B: "uid-b"}))
    firebase = FakeFirebaseExecutor()
    client = make_client(service, store, firebase_executor=firebase)

    for email in (EMAIL_A, EMAIL_B):
        client.post("/api/v1/auth/email-otp/send", json={"email": email, "purpose": "PASSWORD_RESET"})

    code_b = _sent_code(sender, EMAIL_B)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": EMAIL_B, "purpose": "PASSWORD_RESET", "code": code_b}
    )
    reset_token = verify_resp.json()["resetToken"]

    client.post(
        "/api/v1/auth/password-reset/confirm", json={"resetToken": reset_token, "newPassword": "new-password-123"}
    )

    assert firebase.password_updates == [("uid-b", "new-password-123")]


def test_account_enumeration_protection_works_end_to_end():
    # Registered vs. unregistered email must produce byte-identical
    # /send responses -- asserted directly, not just "looks right".
    service, store = make_service(uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    client = make_client(service, store)

    reg = client.post("/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "PASSWORD_RESET"})
    unreg = client.post(
        "/api/v1/auth/email-otp/send", json={"email": "nobody@example.com", "purpose": "PASSWORD_RESET"}
    )

    assert reg.status_code == unreg.status_code == 200
    assert reg.text == unreg.text
