# HTTP-contract tests for app.access.handlers, via FastAPI's TestClient
# and fakes for AuthGate/OrganizationOps/PermissionOps -- the real
# authorization/business-rule behavior is already proven against a real
# Firestore emulator in test_access_organization_ops.py and
# test_access_permission_ops.py; this file only proves the HTTP-layer
# contract: auth gating, rate limiting, request validation, and that
# each app.access.errors.AccessOpsError maps to the right status code
# without leaking its internal message where that would be inappropriate.
from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app.access.caller_context import CallerContext
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.access.handlers import CompanyHandler, OrganizationHandler, PermissionAdminHandler
from app.auth.reset import InMemoryRateLimiter
from app.config import Config
from app.server import create_app


def make_test_logger() -> logging.Logger:
    logger = logging.getLogger("darwesh.test.access.handlers")
    logger.addHandler(logging.NullHandler())
    return logger


class FakeAuthGate:
    """Returns whatever CallerContext (or None) the test configured --
    never does a real token verification or Firestore read."""

    def __init__(self, caller: CallerContext | None):
        self.caller = caller

    async def authenticate(self, request):
        return self.caller


class FakeOrganizationOps:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.next_result = None
        self.next_error: Exception | None = None

    def _record(self, action: str, **kwargs):
        self.calls.append((action, kwargs))
        if self.next_error is not None:
            raise self.next_error
        return self.next_result

    async def create_organization(self, **kwargs):
        return self._record("create_organization", **kwargs) or "new-org-id"

    async def request_membership(self, **kwargs):
        self._record("request_membership", **kwargs)

    async def invite_member(self, **kwargs):
        self._record("invite_member", **kwargs)

    async def accept_invitation(self, **kwargs):
        self._record("accept_invitation", **kwargs)

    async def decline_invitation(self, **kwargs):
        self._record("decline_invitation", **kwargs)

    async def revoke_invitation(self, **kwargs):
        self._record("revoke_invitation", **kwargs)

    async def approve_membership(self, **kwargs):
        self._record("approve_membership", **kwargs)

    async def reject_membership(self, **kwargs):
        self._record("reject_membership", **kwargs)

    async def remove_member(self, **kwargs):
        self._record("remove_member", **kwargs)

    async def update_member_permissions(self, **kwargs):
        self._record("update_member_permissions", **kwargs)

    async def transfer_ownership(self, **kwargs):
        self._record("transfer_ownership", **kwargs)

    async def list_my_organizations(self, **kwargs):
        return self._record("list_my_organizations", **kwargs) or []

    async def set_active_organization(self, **kwargs):
        self._record("set_active_organization", **kwargs)


class FakeCompanyOps:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.next_result = None
        self.next_error: Exception | None = None

    def _record(self, action: str, **kwargs):
        self.calls.append((action, kwargs))
        if self.next_error is not None:
            raise self.next_error
        return self.next_result

    async def create_company(self, **kwargs):
        return self._record("create_company", **kwargs) or "new-company-id"

    async def request_membership(self, **kwargs):
        self._record("request_membership", **kwargs)

    async def invite_employee(self, **kwargs):
        self._record("invite_employee", **kwargs)

    async def accept_invitation(self, **kwargs):
        self._record("accept_invitation", **kwargs)

    async def decline_invitation(self, **kwargs):
        self._record("decline_invitation", **kwargs)

    async def revoke_invitation(self, **kwargs):
        self._record("revoke_invitation", **kwargs)

    async def approve_membership(self, **kwargs):
        self._record("approve_membership", **kwargs)

    async def reject_membership(self, **kwargs):
        self._record("reject_membership", **kwargs)

    async def remove_employee(self, **kwargs):
        self._record("remove_employee", **kwargs)

    async def list_my_companies(self, **kwargs):
        return self._record("list_my_companies", **kwargs) or []


class FakePermissionOps:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.next_result: dict | None = None
        self.next_error: Exception | None = None

    def _record(self, action: str, **kwargs):
        self.calls.append((action, kwargs))
        if self.next_error is not None:
            raise self.next_error
        return self.next_result

    async def set_role_defaults(self, **kwargs):
        self._record("set_role_defaults", **kwargs)

    async def set_user_overrides(self, **kwargs):
        self._record("set_user_overrides", **kwargs)

    async def get_effective_permissions(self, **kwargs):
        return self._record("get_effective_permissions", **kwargs) or {
            "uid": kwargs.get("uid"),
            "globalPermissions": {},
            "organization": None,
        }


ALICE = CallerContext(uid="alice", email="alice@example.com", role="agent", is_admin=False)
ADMIN = CallerContext(uid="admin-uid", email="admin@example.com", role="admin", is_admin=True)


def make_client(
    *, caller: CallerContext | None = ALICE, org_ops=None, perm_ops=None, generous_limits: bool = True
) -> tuple[TestClient, FakeOrganizationOps, FakePermissionOps]:
    org_ops = org_ops or FakeOrganizationOps()
    perm_ops = perm_ops or FakePermissionOps()
    auth = FakeAuthGate(caller)
    limit = 1000 if generous_limits else 0
    logger = make_test_logger()
    org_handler = OrganizationHandler(
        ops=org_ops,
        auth=auth,
        create_limiter=InMemoryRateLimiter(limit=limit, window_seconds=60),
        membership_limiter=InMemoryRateLimiter(limit=limit, window_seconds=60),
        ownership_transfer_limiter=InMemoryRateLimiter(limit=limit, window_seconds=60),
        logger=logger,
    )
    perm_handler = PermissionAdminHandler(
        ops=perm_ops,
        auth=auth,
        mutation_limiter=InMemoryRateLimiter(limit=limit, window_seconds=60),
        read_limiter=InMemoryRateLimiter(limit=limit, window_seconds=60),
        logger=logger,
    )
    cfg = Config(port="8080", env="development", allowed_origins=[])
    app = create_app(cfg, None, None, None, None, None, org_handler, perm_handler)
    return TestClient(app), org_ops, perm_ops


def make_company_client(
    *, caller: CallerContext | None = ALICE, company_ops=None, generous_limits: bool = True
) -> tuple[TestClient, FakeCompanyOps]:
    company_ops = company_ops or FakeCompanyOps()
    auth = FakeAuthGate(caller)
    limit = 1000 if generous_limits else 0
    logger = make_test_logger()
    company_handler = CompanyHandler(
        ops=company_ops,
        auth=auth,
        membership_limiter=InMemoryRateLimiter(limit=limit, window_seconds=60),
        logger=logger,
    )
    cfg = Config(port="8080", env="development", allowed_origins=[])
    app = create_app(cfg, None, None, None, None, None, None, None, company_handler)
    return TestClient(app), company_ops


# ---- authentication gating (applies to every endpoint) --------------------


def test_unauthenticated_create_organization_returns_401():
    client, _org_ops, _perm_ops = make_client(caller=None)
    resp = client.post("/api/v1/access/organizations", json={"type": "furniture_store", "name": "Store"})
    assert resp.status_code == 401


def test_unauthenticated_effective_permissions_returns_401():
    client, _org_ops, _perm_ops = make_client(caller=None)
    resp = client.get("/api/v1/access/me/permissions")
    assert resp.status_code == 401


# ---- rate limiting ----------------------------------------------------


def test_rate_limited_create_organization_returns_429():
    client, _org_ops, _perm_ops = make_client(generous_limits=False)
    resp = client.post("/api/v1/access/organizations", json={"type": "furniture_store", "name": "Store"})
    assert resp.status_code == 429


# ---- organization creation ----------------------------------------------


def test_create_organization_success_returns_201_and_org_id():
    client, org_ops, _perm_ops = make_client()
    resp = client.post("/api/v1/access/organizations", json={"type": "furniture_store", "name": "My Store"})
    assert resp.status_code == 201
    assert resp.json()["organizationId"] == "new-org-id"
    assert org_ops.calls[0][1]["caller_uid"] == "alice"


def test_create_organization_rejects_unknown_type_before_calling_ops():
    client, org_ops, _perm_ops = make_client()
    resp = client.post("/api/v1/access/organizations", json={"type": "real_estate_office", "name": "Office"})
    assert resp.status_code == 400
    assert org_ops.calls == []  # rejected at the handler layer, never reached ops


def test_create_organization_malformed_body_returns_400():
    client, _org_ops, _perm_ops = make_client()
    resp = client.post(
        "/api/v1/access/organizations", content=b"not json", headers={"Content-Type": "application/json"}
    )
    assert resp.status_code == 400


def test_create_organization_maps_validation_error_to_400_with_message():
    org_ops = FakeOrganizationOps()
    org_ops.next_error = ValidationError("'name' is required")
    client, _org_ops, _perm_ops = make_client(org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations", json={"type": "furniture_store", "name": "Store"})
    assert resp.status_code == 400
    assert resp.json()["error"] == "'name' is required"


def test_create_organization_maps_unexpected_exception_to_500_without_leaking_detail():
    org_ops = FakeOrganizationOps()
    org_ops.next_error = RuntimeError("Firestore: permission denied at /projects/secret-internal-path")
    client, _org_ops, _perm_ops = make_client(org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations", json={"type": "furniture_store", "name": "Store"})
    assert resp.status_code == 500
    assert "secret-internal-path" not in resp.text


# ---- membership actions: caller_is_admin/caller_uid passthrough ---------


def test_invite_member_passes_authenticated_uid_and_admin_flag_never_from_body():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ADMIN, org_ops=org_ops)
    resp = client.post(
        "/api/v1/access/organizations/org1/members/target-uid/invite",
        json={"caller_uid": "someone-else", "caller_is_admin": False},  # must be ignored
    )
    assert resp.status_code == 201
    call = org_ops.calls[0][1]
    assert call["caller_uid"] == "admin-uid"
    assert call["caller_is_admin"] is True
    assert call["target_uid"] == "target-uid"
    assert call["org_id"] == "org1"


def test_invite_member_returns_invited_status_not_active():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ADMIN, org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations/org1/members/target-uid/invite", json={})
    assert resp.json()["status"] == "invited"


def test_accept_invitation_uses_only_the_authenticated_callers_own_uid():
    # No target_uid in the route at all -- proves a caller can never
    # name someone else's invitation to accept.
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, org_ops=org_ops)
    resp = client.post(
        "/api/v1/access/organizations/org1/invitations/accept",
        json={"target_uid": "someone-else"},  # must be ignored -- no such param on this route
    )
    assert resp.status_code == 200
    call = org_ops.calls[0][1]
    assert call["caller_uid"] == "alice"
    assert "target_uid" not in call


def test_decline_invitation_uses_only_the_authenticated_callers_own_uid():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations/org1/invitations/decline", json={})
    assert resp.status_code == 200
    assert org_ops.calls[0][1]["caller_uid"] == "alice"


def test_revoke_invitation_passes_authenticated_uid_and_admin_flag():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ADMIN, org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations/org1/members/target-uid/revoke-invitation", json={})
    assert resp.status_code == 200
    call = org_ops.calls[0][1]
    assert call["caller_uid"] == "admin-uid"
    assert call["caller_is_admin"] is True
    assert call["target_uid"] == "target-uid"


def test_approve_membership_maps_forbidden_error_to_403_generic_message():
    org_ops = FakeOrganizationOps()
    org_ops.next_error = ForbiddenError("caller owns a totally different org, revealing internal state")
    client, _org_ops, _perm_ops = make_client(org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations/org1/members/target-uid/approve", json={})
    assert resp.status_code == 403
    assert "totally different org" not in resp.text


def test_reject_membership_maps_conflict_error_to_409_with_message():
    org_ops = FakeOrganizationOps()
    org_ops.next_error = ConflictError("no pending membership request exists for this user in this organization")
    client, _org_ops, _perm_ops = make_client(org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations/org1/members/target-uid/reject", json={})
    assert resp.status_code == 409


def test_remove_member_maps_not_found_error_to_404_generic_message():
    org_ops = FakeOrganizationOps()
    org_ops.next_error = NotFoundError("organization 'org1' internal id 8842 does not exist")
    client, _org_ops, _perm_ops = make_client(org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations/org1/members/target-uid/remove", json={})
    assert resp.status_code == 404
    assert "8842" not in resp.text


def test_set_member_permissions_forwards_permissions_field_untouched():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(org_ops=org_ops)
    resp = client.post(
        "/api/v1/access/organizations/org1/members/target-uid/permissions",
        json={"permissions": {"create_product": True}},
    )
    assert resp.status_code == 200
    assert org_ops.calls[0][1]["permissions"] == {"create_product": True}


# ---- ownership transfer ------------------------------------------------


def test_transfer_ownership_requires_new_owner_uid():
    client, org_ops, _perm_ops = make_client()
    resp = client.post("/api/v1/access/organizations/org1/transfer-ownership", json={})
    assert resp.status_code == 400
    assert org_ops.calls == []


def test_transfer_ownership_success():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(org_ops=org_ops)
    resp = client.post("/api/v1/access/organizations/org1/transfer-ownership", json={"newOwnerUid": "someone"})
    assert resp.status_code == 200
    assert org_ops.calls[0][1]["new_owner_uid"] == "someone"


def test_transfer_ownership_uses_its_own_stricter_rate_limiter():
    # membership_limiter stays generous, ownership_transfer_limiter is
    # exhausted -- proves the two are independently namespaced, not
    # sharing one counter.
    org_ops = FakeOrganizationOps()
    auth = FakeAuthGate(ALICE)
    logger = make_test_logger()
    org_handler = OrganizationHandler(
        ops=org_ops,
        auth=auth,
        create_limiter=InMemoryRateLimiter(limit=1000, window_seconds=60),
        membership_limiter=InMemoryRateLimiter(limit=1000, window_seconds=60),
        ownership_transfer_limiter=InMemoryRateLimiter(limit=0, window_seconds=60),
        logger=logger,
    )
    cfg = Config(port="8080", env="development", allowed_origins=[])
    app = create_app(cfg, None, None, None, None, None, org_handler, None)
    client = TestClient(app)

    ok_resp = client.post("/api/v1/access/organizations/org1/members/target-uid/invite", json={})
    limited_resp = client.post(
        "/api/v1/access/organizations/org1/transfer-ownership", json={"newOwnerUid": "someone"}
    )

    assert ok_resp.status_code == 201
    assert limited_resp.status_code == 429


# ---- multi-organization context (Phase 2.2) --------------------------


def test_list_my_organizations_returns_ops_result():
    org_ops = FakeOrganizationOps()
    org_ops.next_result = [
        {
            "organizationId": "org1",
            "name": "Store",
            "type": "furniture_store",
            "membershipStatus": "owner",
            "memberRole": None,
            "isOwner": True,
        }
    ]
    client, _org_ops, _perm_ops = make_client(caller=ALICE, org_ops=org_ops)
    resp = client.get("/api/v1/access/me/organizations")
    assert resp.status_code == 200
    assert resp.json()["organizations"][0]["organizationId"] == "org1"
    assert org_ops.calls[0][1]["uid"] == "alice"


def test_list_my_organizations_requires_auth():
    client, _org_ops, _perm_ops = make_client(caller=None)
    resp = client.get("/api/v1/access/me/organizations")
    assert resp.status_code == 401


def test_set_active_organization_passes_authenticated_uid_and_org_id():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, org_ops=org_ops)
    resp = client.post("/api/v1/access/me/active-organization", json={"organizationId": "org1"})
    assert resp.status_code == 200
    assert org_ops.calls[0][1] == {"uid": "alice", "organization_id": "org1"}
    assert resp.json()["activeOrganizationId"] == "org1"


def test_set_active_organization_accepts_null_to_clear():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, org_ops=org_ops)
    resp = client.post("/api/v1/access/me/active-organization", json={"organizationId": None})
    assert resp.status_code == 200
    assert org_ops.calls[0][1]["organization_id"] is None


def test_set_active_organization_rejects_non_string_org_id():
    org_ops = FakeOrganizationOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, org_ops=org_ops)
    resp = client.post("/api/v1/access/me/active-organization", json={"organizationId": 12345})
    assert resp.status_code == 400
    assert org_ops.calls == []


def test_set_active_organization_maps_validation_error_to_400():
    org_ops = FakeOrganizationOps()
    org_ops.next_error = ValidationError("you do not currently have active access to this organization")
    client, _org_ops, _perm_ops = make_client(caller=ALICE, org_ops=org_ops)
    resp = client.post("/api/v1/access/me/active-organization", json={"organizationId": "not-mine"})
    assert resp.status_code == 400


def test_set_active_organization_requires_auth():
    client, _org_ops, _perm_ops = make_client(caller=None)
    resp = client.post("/api/v1/access/me/active-organization", json={"organizationId": "org1"})
    assert resp.status_code == 401


# ---- real estate office (companies) membership -- Phase 3 ----------------


def test_unauthenticated_create_company_returns_401():
    client, _company_ops = make_company_client(caller=None)
    resp = client.post("/api/v1/access/companies", json={"name": "Acme Realty"})
    assert resp.status_code == 401


def test_create_company_success_returns_201_and_company_id():
    client, company_ops = make_company_client(caller=ALICE)
    resp = client.post("/api/v1/access/companies", json={"name": "Acme Realty"})
    assert resp.status_code == 201
    assert resp.json()["companyId"] == "new-company-id"
    assert company_ops.calls[0] == (
        "create_company",
        {
            "caller_uid": "alice",
            "name": "Acme Realty",
            "description": None,
            "city": None,
            "district": None,
            "address": None,
        },
    )


def test_create_company_malformed_body_returns_400():
    client, _company_ops = make_company_client(caller=ALICE)
    resp = client.post(
        "/api/v1/access/companies", content=b"not json", headers={"Content-Type": "application/json"}
    )
    assert resp.status_code == 400


def test_create_company_maps_validation_error_to_400():
    company_ops = FakeCompanyOps()
    company_ops.next_error = ValidationError("'name' is required")
    client, _company_ops = make_company_client(caller=ALICE, company_ops=company_ops)
    resp = client.post("/api/v1/access/companies", json={"name": ""})
    assert resp.status_code == 400
    assert resp.json()["error"] == "'name' is required"


def test_invite_employee_passes_authenticated_uid_and_admin_flag_never_from_body():
    client, company_ops = make_company_client(caller=ALICE)
    resp = client.post(
        "/api/v1/access/companies/company1/employees/target-uid/invite",
        json={"callerUid": "someone-else", "callerIsAdmin": True},
    )
    assert resp.status_code == 201
    call = company_ops.calls[0][1]
    assert call["caller_uid"] == "alice"
    assert call["caller_is_admin"] is False
    assert call["target_uid"] == "target-uid"


def test_company_accept_invitation_uses_only_the_authenticated_callers_own_uid():
    client, company_ops = make_company_client(caller=ALICE)
    resp = client.post("/api/v1/access/companies/company1/invitations/accept", json={})
    assert resp.status_code == 200
    assert company_ops.calls[0][1]["caller_uid"] == "alice"


def test_company_approve_membership_maps_forbidden_error_to_403_generic_message():
    company_ops = FakeCompanyOps()
    company_ops.next_error = ForbiddenError("only the office's owner or an admin may approve membership")
    client, _company_ops = make_company_client(caller=ALICE, company_ops=company_ops)
    resp = client.post("/api/v1/access/companies/company1/employees/target-uid/approve", json={})
    assert resp.status_code == 403
    assert resp.json()["error"] == "You do not have permission to perform this action."


def test_remove_employee_maps_not_found_error_to_404_generic_message():
    company_ops = FakeCompanyOps()
    company_ops.next_error = NotFoundError("no membership record exists for this user at this office")
    client, _company_ops = make_company_client(caller=ADMIN, company_ops=company_ops)
    resp = client.post("/api/v1/access/companies/company1/employees/target-uid/remove", json={})
    assert resp.status_code == 404


def test_list_my_companies_returns_ops_result():
    company_ops = FakeCompanyOps()
    company_ops.next_result = [
        {"companyId": "company1", "name": "Acme Realty", "membershipStatus": "owner", "isOwner": True}
    ]
    client, _company_ops = make_company_client(caller=ALICE, company_ops=company_ops)
    resp = client.get("/api/v1/access/me/companies")
    assert resp.status_code == 200
    assert resp.json()["companies"][0]["companyId"] == "company1"
    assert company_ops.calls[0][1]["uid"] == "alice"


def test_list_my_companies_requires_auth():
    client, _company_ops = make_company_client(caller=None)
    resp = client.get("/api/v1/access/me/companies")
    assert resp.status_code == 401


def test_company_membership_rate_limited_returns_429():
    client, _company_ops = make_company_client(caller=ALICE, generous_limits=False)
    resp = client.post("/api/v1/access/companies/company1/invitations/accept", json={})
    assert resp.status_code == 429


# ---- permission admin: role defaults / user overrides / effective read --


def test_set_role_defaults_requires_admin():
    client, _org_ops, perm_ops = make_client(caller=ALICE)  # not admin
    resp = client.post("/api/v1/access/role-defaults", json={"accountType": "office_employee", "permissions": {}})
    assert resp.status_code == 403
    assert perm_ops.calls == []


def test_set_role_defaults_by_admin_succeeds():
    client, _org_ops, perm_ops = make_client(caller=ADMIN)
    resp = client.post(
        "/api/v1/access/role-defaults",
        json={"accountType": "office_employee", "permissions": {"edit_office_listing": True}},
    )
    assert resp.status_code == 200
    assert perm_ops.calls[0][1]["account_type"] == "office_employee"
    assert perm_ops.calls[0][1]["caller_is_admin"] is True


def test_set_role_defaults_rejects_unrecognized_account_type_before_calling_ops():
    client, _org_ops, perm_ops = make_client(caller=ADMIN)
    resp = client.post("/api/v1/access/role-defaults", json={"accountType": "not_a_real_type", "permissions": {}})
    assert resp.status_code == 400
    assert perm_ops.calls == []


def test_set_user_overrides_requires_admin():
    client, _org_ops, perm_ops = make_client(caller=ALICE)
    resp = client.post(
        "/api/v1/access/users/target-uid/permission-overrides", json={"permissions": {"create_listing": True}}
    )
    assert resp.status_code == 403
    assert perm_ops.calls == []


def test_get_my_permissions_always_uses_the_authenticated_uid():
    perm_ops = FakePermissionOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, perm_ops=perm_ops)
    resp = client.get("/api/v1/access/me/permissions")
    assert resp.status_code == 200
    assert perm_ops.calls[0][1]["uid"] == "alice"


def test_get_my_permissions_returns_the_resolved_body():
    perm_ops = FakePermissionOps()
    perm_ops.next_result = {
        "uid": "alice",
        "accountType": "office_employee",
        "globalPermissions": {"edit_office_listing": True},
        "organization": None,
    }
    client, _org_ops, _perm_ops = make_client(caller=ALICE, perm_ops=perm_ops)
    resp = client.get("/api/v1/access/me/permissions")
    assert resp.json()["globalPermissions"] == {"edit_office_listing": True}
    assert resp.json()["organization"] is None


def test_get_my_permissions_forwards_organization_id_query_param():
    perm_ops = FakePermissionOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, perm_ops=perm_ops)
    resp = client.get("/api/v1/access/me/permissions?organizationId=org1")
    assert resp.status_code == 200
    assert perm_ops.calls[0][1]["organization_id"] == "org1"


def test_get_my_permissions_without_query_param_passes_none():
    perm_ops = FakePermissionOps()
    client, _org_ops, _perm_ops = make_client(caller=ALICE, perm_ops=perm_ops)
    client.get("/api/v1/access/me/permissions")
    assert perm_ops.calls[0][1]["organization_id"] is None
