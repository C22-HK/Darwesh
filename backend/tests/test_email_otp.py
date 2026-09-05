from __future__ import annotations

import asyncio
import logging
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth.reset import InMemoryRateLimiter, RateLimiter
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
from app.otp.store import InMemoryChallengeStore, ResetToken


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

    def __init__(
        self,
        existing_emails: set[str] | None = None,
        existing_phones: set[str] | None = None,
        existing_companies: set[str] | None = None,
    ):
        self.existing_emails = existing_emails or set()
        self.existing_phones = existing_phones or set()
        # BL-04: companies that already exist BEFORE this signup runs --
        # lets a test prove the "typing an existing company's name never
        # auto-grants trusted membership" invariant without a real
        # Firestore emulator.
        self.existing_companies = existing_companies or set()
        self.created: list[dict] = []
        self.profiles_written: list[dict] = []
        self.companies_ensured: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self._next_uid = 1
        self.mint_calls: list[str] = []
        self.fail_profile_write = False
        self.fail_mint = False
        self.fail_delete = False

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

    async def create_user_profile(
        self,
        uid: str,
        *,
        display_name: str,
        email: str,
        phone_e164: str,
        requested_role: str = "customer",
        company_id: str | None = None,
        requested_company_id: str | None = None,
        requested_company_name: str | None = None,
        account_type: str | None = None,
    ) -> None:
        if self.fail_profile_write:
            raise RuntimeError("firestore down")
        self.profiles_written.append(
            {
                "uid": uid,
                "display_name": display_name,
                "email": email,
                "phone_e164": phone_e164,
                "requested_role": requested_role,
                "company_id": company_id,
                "requested_company_id": requested_company_id,
                "requested_company_name": requested_company_name,
                "account_type": account_type,
            }
        )

    async def company_exists(self, company_id: str) -> bool:
        return company_id in self.existing_companies

    async def ensure_company(self, company_id: str, company_name: str) -> None:
        self.companies_ensured.append((company_id, company_name))
        self.existing_companies.add(company_id)

    async def delete_account(self, uid: str) -> None:
        # Real FirebaseAccountOps.delete_account is only ever called by
        # SignupCompleteHandler with a uid it just got back from THIS
        # request's own create_account -- this fake mirrors that: it
        # only knows how to delete something create_account itself
        # created, and asserts that invariant directly rather than
        # trusting the caller.
        matches = [rec for rec in self.created if rec["uid"] == uid]
        assert matches, f"delete_account called with a uid this fake never created: {uid}"
        self.deleted.append(uid)
        if self.fail_delete:
            raise RuntimeError("could not delete account")
        # Mirrors real Firebase Auth: deleting a user frees its email and
        # phone number for a future signup to claim.
        self.existing_emails.discard(matches[0]["email"])
        self.existing_phones.discard(matches[0]["phone_e164"])

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
    challenge = await store.get_challenge(f"{Purpose.SIGNUP_EMAIL_VERIFY.value}:{EMAIL_A}")
    assert challenge is not None
    assert challenge.uid is None  # no account exists yet


async def test_password_reset_noops_for_unregistered_email():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({}))

    result = await service.send(EMAIL_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.NOOP
    assert sender.sent == []
    assert await store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{EMAIL_A}") is None


async def test_password_reset_sends_for_registered_email_and_binds_uid():
    sender = FakeEmailSender()
    service, store = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))

    result = await service.send(EMAIL_A, Purpose.PASSWORD_RESET)

    assert result == SendResult.SENT
    challenge = await store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{EMAIL_A}")
    assert challenge.uid == "uid-a"


# ---------- OTP security properties (generic engine, exercised via email identifiers) ----------


async def test_signup_otp_success():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)

    result, token = await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert result == VerifyResult.OK
    assert token is not None


async def test_incorrect_signup_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)

    result, token = await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, "000000")

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_expired_signup_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, otp_ttl_seconds=0.03)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)
    time.sleep(0.04)

    result, token = await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_consumed_signup_otp_cannot_be_reused():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)

    first, first_token = await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)
    second, second_token = await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert first == VerifyResult.OK and first_token is not None
    assert second == VerifyResult.INVALID_OR_EXPIRED and second_token is None


async def test_resend_cooldown_works():
    service, store = make_service(resend_cooldown_seconds=60)

    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    first_hash = (await store.get_challenge(f"{Purpose.SIGNUP_EMAIL_VERIFY.value}:{EMAIL_A}")).otp_hash

    result = await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)

    assert result == SendResult.COOLDOWN
    assert (await store.get_challenge(f"{Purpose.SIGNUP_EMAIL_VERIFY.value}:{EMAIL_A}")).otp_hash == first_hash


async def test_attempt_limit_works():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, max_attempts=3)
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    code = _sent_code(sender, EMAIL_A)

    results = [(await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, "000000"))[0] for _ in range(3)]
    final_result, final_token = await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, code)

    assert results[-1] == VerifyResult.TOO_MANY_ATTEMPTS
    assert final_result == VerifyResult.TOO_MANY_ATTEMPTS
    assert final_token is None


async def test_rate_limiting_works():
    limiter = InMemoryRateLimiter(1, 60)
    assert await limiter.allow(EMAIL_A) is True
    assert await limiter.allow(EMAIL_A) is False
    assert await limiter.allow(EMAIL_B) is True  # tracked independently


async def test_signup_otp_cannot_authorize_password_reset():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY)
    signup_code = _sent_code(sender, EMAIL_A)

    result, token = await service.verify(EMAIL_A, Purpose.PASSWORD_RESET, signup_code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_password_reset_otp_cannot_activate_signup():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    reset_code = _sent_code(sender, EMAIL_A)

    result, token = await service.verify(EMAIL_A, Purpose.SIGNUP_EMAIL_VERIFY, reset_code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_password_reset_otp_success():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, EMAIL_A)

    result, token = await service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)

    assert result == VerifyResult.OK
    assert token is not None


async def test_wrong_password_reset_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)

    result, token = await service.verify(EMAIL_A, Purpose.PASSWORD_RESET, "999999")

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_expired_reset_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}), otp_ttl_seconds=0.03)
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, EMAIL_A)
    time.sleep(0.04)

    result, token = await service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)

    assert result == VerifyResult.INVALID_OR_EXPIRED
    assert token is None


async def test_reused_reset_otp_rejected():
    sender = FakeEmailSender()
    service, _ = make_service(sender=sender, uids=FakeEmailUidResolver({EMAIL_A: "uid-a"}))
    await service.send(EMAIL_A, Purpose.PASSWORD_RESET)
    code = _sent_code(sender, EMAIL_A)

    first, _ = await service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)
    second, _ = await service.verify(EMAIL_A, Purpose.PASSWORD_RESET, code)

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
    assert await store.get_challenge(f"{Purpose.PASSWORD_RESET.value}:{EMAIL_A}") is None


# ---------- HTTP layer ----------


def make_app(
    service: OtpService,
    store: InMemoryChallengeStore,
    firebase_executor: FakeFirebaseExecutor | None = None,
    account_ops: FakeAccountOps | None = None,
    send_ip_limiter: RateLimiter | None = None,
    send_email_limiter: RateLimiter | None = None,
    verify_ip_limiter: RateLimiter | None = None,
    complete_ip_limiter: RateLimiter | None = None,
) -> FastAPI:
    logger = make_test_logger()
    send_handler = EmailOtpSendHandler(
        service=service,
        ip_limiter=send_ip_limiter or InMemoryRateLimiter(1000, 60),
        email_limiter=send_email_limiter or InMemoryRateLimiter(1000, 60),
        logger=logger,
    )
    verify_handler = EmailOtpVerifyHandler(
        service=service, ip_limiter=verify_ip_limiter or InMemoryRateLimiter(1000, 60), logger=logger
    )
    complete_handler = SignupCompleteHandler(
        store=store,
        accounts=account_ops or FakeAccountOps(),
        ip_limiter=complete_ip_limiter or InMemoryRateLimiter(1000, 60),
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
    return app


def make_client(*args, **kwargs) -> TestClient:
    return TestClient(make_app(*args, **kwargs))


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
        service,
        store,
        send_email_limiter=InMemoryRateLimiter(1, 60),
        send_ip_limiter=InMemoryRateLimiter(1000, 60),
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
    # requestedRole/companyName omitted entirely -> defaults to a plain
    # customer signup, no company touched.
    assert ops.profiles_written[0]["requested_role"] == "customer"
    assert ops.profiles_written[0]["company_id"] is None
    assert ops.companies_ensured == []


def test_signup_complete_as_agent_records_requested_role_and_creates_company():
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
            "requestedRole": "agent",
            "companyName": "Darwesh Group",
        },
    )

    assert resp.status_code == 200
    # role is ALWAYS "customer" at creation -- requestedRole is only ever
    # a recorded signal an admin reviews, never a real grant (matches
    # firestore.rules: a client can never self-promote to agent/admin).
    assert ops.profiles_written[0]["requested_role"] == "agent"
    assert ops.profiles_written[0]["company_id"] == "darwesh-group"
    assert ops.profiles_written[0]["requested_company_id"] is None
    assert ops.profiles_written[0]["requested_company_name"] is None
    assert ops.companies_ensured == [("darwesh-group", "Darwesh Group")]


def test_signup_complete_accepts_a_valid_professional_account_type():
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
            "accountType": "professional_engineer",
        },
    )

    assert resp.status_code == 200
    # role stays "customer" regardless of accountType -- accountType is a
    # UI-routing hint recorded on the profile, never a role/permission
    # grant (matches firestore.rules' isValidSelfAccountType() precedent).
    assert ops.profiles_written[0]["account_type"] == "professional_engineer"
    assert ops.profiles_written[0]["requested_role"] == "customer"


@pytest.mark.parametrize(
    "bad_account_type",
    ["not_a_real_type", "office_employee_typo", "", "ADMIN", 123],
)
def test_signup_complete_rejects_an_unrecognized_account_type(bad_account_type):
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
            "accountType": bad_account_type,
        },
    )

    assert resp.status_code == 400
    # Rejected before ever reaching Firebase -- no account, no profile.
    assert ops.created == []
    assert ops.profiles_written == []


def test_signup_complete_rejects_self_selected_admin_account_type():
    # The one value that IS a real, storable accountType (an admin's own
    # profile may legitimately carry it) but must never be reachable via
    # public self-signup -- is_valid_public_account_type() deliberately
    # excludes it (app/access/constants.py).
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
            "accountType": "admin",
        },
    )

    assert resp.status_code == 400
    assert ops.created == []


def test_signup_complete_omitting_account_type_writes_no_account_type_field():
    # Backward compatibility: a caller that never sends accountType at
    # all (the pre-Phase-2 frontend shape) must produce the exact same
    # profile document shape as before -- no accountType key written,
    # not even null.
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
    assert ops.profiles_written[0]["account_type"] is None


@pytest.mark.parametrize(
    "typed_name",
    ["Darwesh Group", "darwesh group", "Darwesh-Group", "Darwesh_Group", "  Darwesh   Group  "],
)
def test_signup_complete_as_agent_with_existing_company_name_never_auto_grants_membership(typed_name):
    # BL-04 fix: typing a name that normalizes to an ALREADY-EXISTING
    # company's slug must never auto-assign that company's trusted
    # companyId -- only a brand-new company name is safe to auto-trust.
    # Every name variant below slugifies to the same "darwesh-group",
    # proving collision-prone normalization alone can't grant membership.
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps(existing_companies={"darwesh-group"})
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
            "requestedRole": "agent",
            "companyName": typed_name,
        },
    )

    assert resp.status_code == 200
    # The trusted companyId must stay unset -- this signup only RECORDED a
    # request to join, never an actual grant of company-scoped access.
    assert ops.profiles_written[0]["company_id"] is None
    assert ops.profiles_written[0]["requested_company_id"] == "darwesh-group"
    assert ops.profiles_written[0]["requested_company_name"] == typed_name.strip()
    # The existing company doc is never touched (no write attempted).
    assert ops.companies_ensured == []


def test_signup_complete_as_agent_without_company_name_rejected():
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
            "requestedRole": "agent",
            "companyName": "",
        },
    )

    assert resp.status_code == 400
    assert ops.created == []  # never even reaches account creation


def test_signup_complete_as_agent_with_oversized_company_name_rejected():
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
            "requestedRole": "agent",
            "companyName": "x" * 201,
        },
    )

    assert resp.status_code == 400
    assert ops.created == []
    assert ops.companies_ensured == []


def test_signup_complete_rejects_invalid_requested_role():
    # A client asking for "admin" (or anything other than the two real
    # options) is rejected outright, never silently downgraded to
    # "customer" -- a typo or a probing request should fail loudly, not
    # quietly succeed with different data than what was asked for.
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
            "requestedRole": "admin",
        },
    )

    assert resp.status_code == 400
    assert ops.created == []


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


def test_signup_complete_rejects_duplicate_email_for_agent_signup_too():
    # Duplicate-account protection is the same create_account() call
    # regardless of requestedRole -- confirmed directly rather than
    # assumed from the customer-path test above.
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
            "requestedRole": "agent",
            "companyName": "Darwesh Group",
        },
    )

    assert resp.status_code == 409
    assert "email" in resp.json()["error"]
    assert ops.companies_ensured == []  # never reaches the company step either


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


def _complete_signup(client: TestClient, verify_token: str, **overrides) -> httpx.Response:
    payload = {
        "verifyToken": verify_token,
        "fullName": "Ahmed Darwesh",
        "phoneNumber": "0750 123 4567",
        "password": "a-strong-password-123",
    }
    payload.update(overrides)
    return client.post("/api/v1/auth/signup/complete", json=payload)


def _get_verify_token(client: TestClient, sender: FakeEmailSender, email: str) -> str:
    client.post("/api/v1/auth/email-otp/send", json={"email": email, "purpose": "SIGNUP_EMAIL_VERIFY"})
    code = _sent_code(sender, email)
    verify_resp = client.post(
        "/api/v1/auth/email-otp/verify", json={"email": email, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code}
    )
    return verify_resp.json()["verifyToken"]


# ---------- Signup completion: orphan-account rollback (scenarios A-F) ----------


def test_A_profile_write_failure_after_successful_auth_creation_does_not_return_200():
    # Scenario A: Auth account creation succeeds, Firestore profile
    # creation fails. The old behavior (superseded) returned 200 with a
    # working customToken despite no profile existing -- an orphan by
    # design. The new behavior must never claim success for a
    # half-provisioned account.
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    ops.fail_profile_write = True
    client = make_client(service, store, account_ops=ops)
    verify_token = _get_verify_token(client, sender, EMAIL_A)

    resp = _complete_signup(client, verify_token)

    assert resp.status_code == 500
    assert "customToken" not in resp.json()
    assert len(ops.created) == 1  # the Auth account WAS created...
    assert ops.profiles_written == []  # ...but no profile exists


def test_B_rollback_succeeds_and_leaves_no_trace_of_the_orphan_account():
    # Scenario B: rollback succeeds -- delete_account is called with
    # exactly the uid create_account produced for this request, and
    # afterward that email/phone are free again (the account is truly
    # gone, not just marked deleted).
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    ops.fail_profile_write = True
    client = make_client(service, store, account_ops=ops)
    verify_token = _get_verify_token(client, sender, EMAIL_A)

    resp = _complete_signup(client, verify_token)

    assert resp.status_code == 500
    created_uid = ops.created[0]["uid"]
    assert ops.deleted == [created_uid]
    assert EMAIL_A not in ops.existing_emails
    assert PHONE_A not in ops.existing_phones


def test_C_rollback_itself_failing_still_returns_a_safe_generic_error_and_never_crashes():
    # Scenario C: both profile write AND the compensating rollback fail.
    # There is no third fallback -- the account is now a genuine orphan
    # that needs manual reconciliation -- but the request must still
    # fail cleanly (never an unhandled exception reaching the client),
    # and must never claim success.
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    ops.fail_profile_write = True
    ops.fail_delete = True
    client = make_client(service, store, account_ops=ops)
    verify_token = _get_verify_token(client, sender, EMAIL_A)

    resp = _complete_signup(client, verify_token)

    assert resp.status_code == 500
    assert "customToken" not in resp.json()
    created_uid = ops.created[0]["uid"]
    assert ops.deleted == [created_uid]  # rollback was attempted
    assert EMAIL_A in ops.existing_emails  # ...but did not actually free the email -- still orphaned


def test_D_rollback_never_touches_a_pre_existing_account():
    # Scenario D: a pre-existing account (e.g. EMAIL_B, created outside
    # this request entirely -- standing in for any real, already-
    # registered user) must never be deleted as a side effect of some
    # other signup's rollback. FakeAccountOps.delete_account itself
    # asserts it's only ever called with a uid it created, but this
    # test additionally proves the pre-existing account survives
    # untouched, end to end.
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    ops.created.append(
        {
            "uid": "pre-existing-uid",
            "email": EMAIL_B,
            "phone_e164": PHONE_B,
            "password": "irrelevant",
            "display_name": "Existing User",
        }
    )
    ops.existing_emails.add(EMAIL_B)
    ops.existing_phones.add(PHONE_B)
    ops.fail_profile_write = True
    client = make_client(service, store, account_ops=ops)
    verify_token = _get_verify_token(client, sender, EMAIL_A)  # a DIFFERENT email than the pre-existing account

    resp = _complete_signup(client, verify_token)

    assert resp.status_code == 500
    assert "pre-existing-uid" not in ops.deleted
    assert EMAIL_B in ops.existing_emails  # the pre-existing account is untouched
    assert PHONE_B in ops.existing_phones


def test_E_simultaneous_signup_completion_with_the_same_verify_token_creates_only_one_account():
    # Scenario E: two requests racing to complete the same signup with
    # the same verifyToken (a double-submitted form, a client retry
    # overlapping the original request, or a replay attempt) -- issued
    # as genuinely concurrent requests through the real ASGI stack (not
    # just two sequential calls), exercising the atomic
    # try_consume_reset_token this fix relies on. Exactly one must
    # succeed; the other must see the same generic "expired or already
    # used" response as any invalid token, never reach account creation.
    async def run():
        sender = FakeEmailSender()
        service, store = make_service(sender=sender)
        ops = FakeAccountOps()
        app = make_app(service, store, account_ops=ops)

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            await client.post(
                "/api/v1/auth/email-otp/send", json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY"}
            )
            code = _sent_code(sender, EMAIL_A)
            verify_resp = await client.post(
                "/api/v1/auth/email-otp/verify",
                json={"email": EMAIL_A, "purpose": "SIGNUP_EMAIL_VERIFY", "code": code},
            )
            verify_token = verify_resp.json()["verifyToken"]

            payload = {
                "verifyToken": verify_token,
                "fullName": "Ahmed Darwesh",
                "phoneNumber": "0750 123 4567",
                "password": "a-strong-password-123",
            }
            responses = await asyncio.gather(
                client.post("/api/v1/auth/signup/complete", json=payload),
                client.post("/api/v1/auth/signup/complete", json=payload),
            )
        return responses, ops

    responses, ops = asyncio.run(run())

    statuses = sorted(r.status_code for r in responses)
    assert statuses == [200, 400]
    assert len(ops.created) == 1


def test_E_store_level_atomic_consume_never_lets_a_second_caller_win():
    # The property test_E above depends on: two calls to
    # try_consume_reset_token for the same token, however they're
    # scheduled, can never both return a usable entry -- verified
    # directly at the store layer, deterministically, rather than
    # relying on the ASGI stack happening to interleave two requests.
    service, store = make_service()

    async def run():
        await store.create_reset_token(
            "tok",
            ResetToken(
                uid=None,
                identifier=EMAIL_A,
                purpose=Purpose.SIGNUP_EMAIL_VERIFY.value,
                created_at=0,
                expires_at=1e12,
            ),
        )
        return await asyncio.gather(store.try_consume_reset_token("tok"), store.try_consume_reset_token("tok"))

    results = asyncio.run(run())
    winners = [r for r in results if r is not None]
    assert len(winners) == 1


def test_F_retry_with_a_fresh_token_after_a_successful_rollback_completes_cleanly():
    # Scenario F: after a first signup attempt fails and successfully
    # rolls back (scenario B), the applicant redoes the OTP flow (a new
    # send/verify -- the old verifyToken is already consumed and cannot
    # be reused, by design) and retries signup/complete. Since the
    # rollback freed the email/phone, this must succeed cleanly with
    # exactly one final account -- not a 409, not a second orphan.
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    ops.fail_profile_write = True
    client = make_client(service, store, account_ops=ops)

    first_token = _get_verify_token(client, sender, EMAIL_A)
    first_resp = _complete_signup(client, first_token)
    assert first_resp.status_code == 500
    assert len(ops.created) == 1 and len(ops.deleted) == 1  # created then rolled back

    # Retry: profile writes now succeed (simulating the transient
    # Firestore issue having cleared), fresh token required.
    ops.fail_profile_write = False
    second_token = _get_verify_token(client, sender, EMAIL_A)
    second_resp = _complete_signup(client, second_token)

    assert second_resp.status_code == 200
    assert "customToken" in second_resp.json()
    assert len(ops.created) == 2  # first (rolled back) + second (kept)
    assert len(ops.profiles_written) == 1  # only the surviving account has a profile
    assert ops.deleted == [ops.created[0]["uid"]]  # only the FIRST (failed) account was ever deleted


def test_F_retry_after_partial_failure_with_orphan_still_present_gets_a_clean_conflict_not_a_duplicate():
    # The other half of "retry-safe where practical": if rollback itself
    # had failed (scenario C) and the orphan is still there, a retry
    # must never silently create a second account for the same email --
    # it should get the same clear, existing 409 "already exists"
    # behavior a genuine duplicate signup gets, which is itself the
    # signal for a human to go reconcile the logged uid.
    sender = FakeEmailSender()
    service, store = make_service(sender=sender)
    ops = FakeAccountOps()
    ops.fail_profile_write = True
    ops.fail_delete = True
    client = make_client(service, store, account_ops=ops)

    first_token = _get_verify_token(client, sender, EMAIL_A)
    first_resp = _complete_signup(client, first_token)
    assert first_resp.status_code == 500  # rollback failed -- orphan remains

    second_token = _get_verify_token(client, sender, EMAIL_A)
    second_resp = _complete_signup(client, second_token)

    assert second_resp.status_code == 409
    assert "email" in second_resp.json()["error"]
    assert len(ops.created) == 1  # never a second account for the same email


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
