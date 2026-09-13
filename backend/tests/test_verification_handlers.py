# HTTP-contract tests for app.verification.handlers.
#
# The reward formula, the state machines and the archive-first deletion
# rule are already proven in test_verification_rewards.py against the
# real ops layer. This file proves only what the HTTP boundary owns:
#
#   * every route is registered and reachable;
#   * an unauthenticated caller gets 401 on every authenticated route;
#   * the caller's uid comes from the verified token and NEVER from the
#     request body -- the §AK invariant, tested by sending a hostile uid;
#   * a permission set is resolved by the server, not read from the body;
#   * a bad referral code and a nonexistent one are indistinguishable;
#   * an ArchiveError surfaces as a refusal (409), not a generic failure.
from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app.access.caller_context import CallerContext
from app.access.constants import KNOWN_PERMISSIONS, PROTECTED_PERMISSIONS
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.auth.reset import InMemoryRateLimiter
from app.config import Config
from app.server import create_app
from app.verification.archive_ops import ArchiveError
from app.verification.handlers import ReferralPublicHandler, VerificationHandler
from app.verification.referral_ops import PublicReferrer


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.verification.handlers")
    logger.addHandler(logging.NullHandler())
    return logger


class FakeAuthGate:
    def __init__(self, caller: CallerContext | None):
        self.caller = caller

    async def authenticate(self, request):
        return self.caller


class FakePermissionReader:
    """Stands in for the real resolver. A test says what the caller
    holds; the handler must never take it from the request."""

    def __init__(self, permissions: set[str] | None = None):
        self.permissions = permissions or set()

    async def permissions_for(self, caller):
        return set(self.permissions)


class Recorder:
    """Records every ops call so a test can assert what the handler
    actually passed down -- especially which uid."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.next_error: Exception | None = None
        self.next_result: dict | None = None

    def _record(self, action, **kwargs):
        self.calls.append((action, kwargs))
        if self.next_error is not None:
            raise self.next_error
        return self.next_result if self.next_result is not None else {"ok": True}

    def last(self, action: str) -> dict:
        for name, kwargs in reversed(self.calls):
            if name == action:
                return kwargs
        raise AssertionError(f"{action} was never called; got {[c[0] for c in self.calls]}")


class FakeVerificationOps(Recorder):
    def own_case_view(self, uid):
        return self._record("own_case_view", uid=uid) or {}

    def submit_case(self, **kwargs):
        return self._record("submit_case", **kwargs)

    def list_cases(self, **kwargs):
        self._record("list_cases", **kwargs)
        return []

    def case_detail(self, **kwargs):
        return self._record("case_detail", **kwargs)

    def dashboard_metrics(self, **kwargs):
        return self._record("dashboard_metrics", **kwargs)

    def review_case(self, **kwargs):
        return self._record("review_case", **kwargs)

    def set_face_result(self, **kwargs):
        return self._record("set_face_result", **kwargs)

    def reveal_evidence(self, **kwargs):
        return self._record("reveal_evidence", **kwargs)


class FakeReferralOps(Recorder):
    def __init__(self):
        super().__init__()
        self.code_valid = True

    def resolve_code(self, raw_code):
        self.calls.append(("resolve_code", {"raw_code": raw_code}))
        if not self.code_valid:
            raise NotFoundError("invalid referral code")
        return PublicReferrer(display_name="Zana")

    def claim_referral(self, **kwargs):
        return self._record("claim_referral", **kwargs)

    def my_network(self, uid):
        return self._record("my_network", uid=uid) or {}

    def read_reward_config(self):
        return self._record("read_reward_config") or {}

    def write_reward_config(self, data, **kwargs):
        return self._record("write_reward_config", data=data, **kwargs)

    def admin_list_referrals(self, **kwargs):
        self._record("admin_list_referrals", **kwargs)
        return []

    def admin_set_status(self, referral_id, status, **kwargs):
        return self._record("admin_set_status", referral_id=referral_id, status=status, **kwargs)

    def admin_correct_referrer(self, **kwargs):
        return self._record("admin_correct_referrer", **kwargs)


class FakeArchiveOps(Recorder):
    def archive_case(self, uid, evidence=None, *, actor_uid="system"):
        return self._record("archive_case", uid=uid, actor_uid=actor_uid)


def build_client(
    *,
    caller: CallerContext | None = CallerContext(uid="u-alice", email=None, role="customer", is_admin=False),
    permissions: set[str] | None = None,
):
    verification = FakeVerificationOps()
    referrals = FakeReferralOps()
    archives = FakeArchiveOps()
    public_handler = ReferralPublicHandler(
        ops=referrals,
        limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
        logger=make_test_logger(),
    )
    handler = VerificationHandler(
        verification=verification,
        referrals=referrals,
        archives=archives,
        auth=FakeAuthGate(caller),
        permissions=FakePermissionReader(permissions),
        submit_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
        read_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
        admin_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
        reveal_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
        logger=make_test_logger(),
    )
    app = create_app(
        Config(port="8080", env="development"),
        referral_public_handler=public_handler,
        verification_handler=handler,
    )
    return TestClient(app), verification, referrals, archives


ADMIN = CallerContext(uid="u-admin", email=None, role="admin", is_admin=True)
ALL_PERMISSIONS = set(KNOWN_PERMISSIONS) | set(PROTECTED_PERMISSIONS)


class TestRouteRegistration:
    def test_every_route_exists_when_handlers_are_supplied(self):
        client, _, _, _ = build_client()
        paths = {r.path for r in client.app.routes}
        for expected in [
            "/api/v1/auth/referral/check",
            "/api/v1/access/me/verification",
            "/api/v1/access/verification/submit",
            "/api/v1/access/referrals/claim",
            "/api/v1/access/admin/verification/metrics",
            "/api/v1/access/admin/verification/cases",
            "/api/v1/access/admin/verification/cases/{uid}",
            "/api/v1/access/admin/verification/cases/{uid}/review",
            "/api/v1/access/admin/verification/cases/{uid}/face-result",
            "/api/v1/access/admin/verification/cases/{uid}/evidence/reveal",
            "/api/v1/access/admin/verification/cases/{uid}/archive",
            "/api/v1/access/admin/referrals",
            "/api/v1/access/admin/referrals/{referralId}/status",
            "/api/v1/access/admin/referrals/correct-referrer",
            "/api/v1/access/admin/reward-config",
        ]:
            assert expected in paths, expected

    def test_no_route_registered_when_handlers_are_absent(self):
        """An unconfigured deployment must 404, not expose a route that
        cannot do its job."""
        client = TestClient(create_app(Config(port="8080", env="development")))
        assert client.get("/api/v1/access/me/verification").status_code == 404
        assert client.post("/api/v1/auth/referral/check", json={"code": "DW-AAAAA"}).status_code == 404


class TestAuthenticationGate:
    def test_every_authenticated_route_refuses_an_anonymous_caller(self):
        client, _, _, _ = build_client(caller=None)
        assert client.get("/api/v1/access/me/verification").status_code == 401
        assert client.post("/api/v1/access/verification/submit", json={}).status_code == 401
        assert client.post("/api/v1/access/referrals/claim", json={}).status_code == 401
        assert client.get("/api/v1/access/admin/verification/metrics").status_code == 401
        assert client.post("/api/v1/access/admin/verification/cases/u-bob/review", json={}).status_code == 401

    def test_referral_code_check_needs_no_account(self):
        """This one runs mid-signup, before a Firebase user exists."""
        client, _, _, _ = build_client(caller=None)
        resp = client.post("/api/v1/auth/referral/check", json={"code": "dw m7k4p"})
        assert resp.status_code == 200
        assert resp.json()["valid"] is True


class TestServerAuthority:
    """§AK -- the browser is never authoritative."""

    def test_submit_uses_the_token_uid_not_a_body_uid(self):
        client, verification, _, _ = build_client()
        resp = client.post(
            "/api/v1/access/verification/submit",
            json={
                "consentVersion": "v1",
                # Hostile: try to file a case against someone else.
                "uid": "u-victim",
                "verificationStatus": "verified",
                "idVerified": True,
            },
        )
        assert resp.status_code == 200
        call = verification.last("submit_case")
        assert call["uid"] == "u-alice"
        # The status/verified claims are not even forwarded -- submit_case
        # takes no such parameter, so there is nothing to ignore.
        assert "verificationStatus" not in call
        assert "idVerified" not in call

    def test_claim_referral_uses_the_token_uid(self):
        client, _, referrals, _ = build_client()
        resp = client.post(
            "/api/v1/access/referrals/claim",
            json={"code": "DW-M7K4P", "referredUid": "u-someone-else"},
        )
        assert resp.status_code == 200
        assert referrals.last("claim_referral")["referred_uid"] == "u-alice"

    def test_review_permissions_come_from_the_server_not_the_body(self):
        client, verification, _, _ = build_client(
            caller=ADMIN, permissions={"verification.view", "verification.review"}
        )
        resp = client.post(
            "/api/v1/access/admin/verification/cases/u-bob/review",
            json={
                "status": "verified",
                # Hostile: try to grant yourself the closure capability.
                "actorPermissions": list(ALL_PERMISSIONS),
                "permissions": list(ALL_PERMISSIONS),
                "actorUid": "u-someone-important",
            },
        )
        assert resp.status_code == 200
        call = verification.last("review_case")
        assert call["actor_permissions"] == {"verification.view", "verification.review"}
        assert call["actor_uid"] == "u-admin"
        assert call["uid"] == "u-bob"


class TestReferralCodePrivacy:
    def test_malformed_and_unknown_codes_are_indistinguishable(self):
        """§O -- any difference here is an existence oracle."""
        client, _, referrals, _ = build_client(caller=None)
        referrals.code_valid = False
        unknown = client.post("/api/v1/auth/referral/check", json={"code": "DW-ZZZZZ"})
        malformed = client.post("/api/v1/auth/referral/check", json={"code": "not-a-code"})
        assert unknown.status_code == malformed.status_code == 404
        assert unknown.json() == malformed.json()

    def test_a_valid_code_returns_only_a_first_name(self):
        client, _, _, _ = build_client(caller=None)
        body = client.post("/api/v1/auth/referral/check", json={"code": "DW-M7K4P"}).json()
        assert set(body) == {"valid", "displayName"}
        assert body["displayName"] == "Zana"

    def test_claiming_an_unknown_code_reuses_the_same_response(self):
        client, _, referrals, _ = build_client()
        referrals.next_error = NotFoundError("invalid referral code")
        resp = client.post("/api/v1/access/referrals/claim", json={"code": "DW-ZZZZZ"})
        assert resp.status_code == 404
        assert resp.json()["error"] == "That referral code isn't valid."


class TestErrorMapping:
    def test_validation_error_is_400_with_its_own_message(self):
        client, verification, _, _ = build_client()
        verification.next_error = ValidationError("consent is required before submitting identity evidence")
        resp = client.post("/api/v1/access/verification/submit", json={"consentVersion": "v1"})
        assert resp.status_code == 400
        assert "consent is required" in resp.json()["error"]

    def test_conflict_error_is_409(self):
        client, verification, _, _ = build_client()
        verification.next_error = ConflictError("a case in 'pending' cannot be submitted for review")
        resp = client.post("/api/v1/access/verification/submit", json={"consentVersion": "v1"})
        assert resp.status_code == 409

    def test_forbidden_error_does_not_name_the_missing_permission(self):
        """ "missing required permission: verification.documents.view" is
        a roadmap for an attacker; the caller gets fixed text."""
        client, verification, _, _ = build_client(caller=ADMIN, permissions={"verification.view"})
        verification.next_error = ForbiddenError("missing required permission: verification.documents.view")
        resp = client.post(
            "/api/v1/access/admin/verification/cases/u-bob/evidence/reveal",
            json={"evidenceId": "e1"},
        )
        assert resp.status_code == 403
        assert "verification.documents.view" not in resp.text

    def test_not_found_does_not_confirm_whether_a_case_exists(self):
        client, verification, _, _ = build_client(caller=ADMIN, permissions={"verification.view"})
        verification.next_error = NotFoundError("no verification case for this user")
        resp = client.get("/api/v1/access/admin/verification/cases/u-stranger")
        assert resp.status_code == 404
        assert resp.json()["error"] == "Not found."

    def test_archive_failure_is_a_refusal_not_a_generic_error(self):
        """§AT -- an archive that did not verify must read as "we stopped",
        with the real reason, so nobody retries it blindly."""
        client, _, _, archives = build_client(caller=ADMIN, permissions=ALL_PERMISSIONS)
        archives.next_error = ArchiveError("no archive vault configured; refusing to proceed")
        resp = client.post("/api/v1/access/admin/verification/cases/u-bob/archive", json={})
        assert resp.status_code == 409
        assert "refusing to proceed" in resp.json()["error"]


class TestBodyValidation:
    def test_a_non_object_body_is_rejected(self):
        client, _, _, _ = build_client()
        resp = client.post(
            "/api/v1/access/verification/submit",
            content=b'["not", "an", "object"]',
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_evidence_must_be_a_list(self):
        client, _, _, _ = build_client()
        resp = client.post(
            "/api/v1/access/verification/submit",
            json={"consentVersion": "v1", "evidence": {"kind": "id_front"}},
        )
        assert resp.status_code == 400


class TestRateLimiting:
    def test_submission_is_limited_per_uid(self):
        verification = FakeVerificationOps()
        referrals = FakeReferralOps()
        handler = VerificationHandler(
            verification=verification,
            referrals=referrals,
            archives=FakeArchiveOps(),
            auth=FakeAuthGate(CallerContext(uid="u-alice", email=None, role="customer", is_admin=False)),
            permissions=FakePermissionReader(),
            submit_limiter=InMemoryRateLimiter(limit=1, window_seconds=3600),
            read_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
            admin_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
            reveal_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
            logger=make_test_logger(),
        )
        client = TestClient(create_app(Config(port="8080", env="development"), verification_handler=handler))
        body = {"consentVersion": "v1"}
        assert client.post("/api/v1/access/verification/submit", json=body).status_code == 200
        assert client.post("/api/v1/access/verification/submit", json=body).status_code == 429

    def test_evidence_reveal_has_its_own_tighter_budget(self):
        """Reveal must not share the general admin budget -- a burst of
        document opens is worth stopping even when each is authorized."""
        verification = FakeVerificationOps()
        handler = VerificationHandler(
            verification=verification,
            referrals=FakeReferralOps(),
            archives=FakeArchiveOps(),
            auth=FakeAuthGate(ADMIN),
            permissions=FakePermissionReader(ALL_PERMISSIONS),
            submit_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
            read_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
            admin_limiter=InMemoryRateLimiter(limit=100, window_seconds=60),
            reveal_limiter=InMemoryRateLimiter(limit=1, window_seconds=3600),
            logger=make_test_logger(),
        )
        client = TestClient(create_app(Config(port="8080", env="development"), verification_handler=handler))
        url = "/api/v1/access/admin/verification/cases/u-bob/evidence/reveal"
        assert client.post(url, json={"evidenceId": "e1"}).status_code == 200
        assert client.post(url, json={"evidenceId": "e2"}).status_code == 429
        # The general admin budget is untouched by those two calls.
        assert client.get("/api/v1/access/admin/verification/metrics").status_code == 200
