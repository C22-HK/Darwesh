# Proves app.access.permission_ops.PermissionOps against a REAL Firestore
# emulator. Skipped automatically when no emulator is reachable, same
# convention as test_ratelimiter_firestore_emulator.py:
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_access_permission_ops.py
from __future__ import annotations

import os
import uuid

import pytest

from app.access.errors import ForbiddenError, NotFoundError, ValidationError
from app.access.permission_ops import PermissionOps

pytestmark = pytest.mark.skipif(
    not os.environ.get("FIRESTORE_EMULATOR_HOST"),
    reason="requires a local Firestore emulator (set FIRESTORE_EMULATOR_HOST)",
)


@pytest.fixture(scope="module")
def db():
    from google.cloud import firestore

    return firestore.Client(project="demo-darwesh")


@pytest.fixture()
def ops(db):
    return PermissionOps(db)


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _account_type(canonical: str) -> str:
    # set_role_defaults validates against the real, closed
    # ALL_ACCOUNT_TYPES allowlist (mirroring firestore.rules'
    # isValidSelfAccountType() -- see constants.py's module docstring on
    # why these two must match byte-for-byte) -- tests must use a real
    # canonical value, never an arbitrary/randomized one. Each test
    # fully overwrites the doc it needs, so sharing a canonical id
    # across tests within one emulator session is safe.
    return canonical


# ---- set_role_defaults -----------------------------------------------


async def test_set_role_defaults_by_admin_succeeds_and_is_readable(db, ops):
    account_type = _account_type("office_employee")
    await ops.set_role_defaults(
        account_type=account_type,
        permissions={"edit_office_listing": True},
        caller_uid=_uid("admin"),
        caller_is_admin=True,
    )
    doc = db.collection("rolePermissionDefaults").document(account_type).get()
    assert doc.exists
    assert doc.get("permissions") == {"edit_office_listing": True}


async def test_set_role_defaults_by_non_admin_forbidden(ops):
    with pytest.raises(ForbiddenError):
        await ops.set_role_defaults(
            account_type=_account_type("office_employee"),
            permissions={"edit_office_listing": True},
            caller_uid=_uid("not-admin"),
            caller_is_admin=False,
        )


async def test_set_role_defaults_rejects_protected_permission(ops):
    with pytest.raises(ValidationError):
        await ops.set_role_defaults(
            account_type=_account_type("office_owner"),
            permissions={"manage_roles": True},
            caller_uid=_uid("admin"),
            caller_is_admin=True,
        )


async def test_set_role_defaults_rejects_unrecognized_account_type(ops):
    with pytest.raises(ValidationError):
        await ops.set_role_defaults(
            account_type="not_a_real_account_type",
            permissions={"create_listing": True},
            caller_uid=_uid("admin"),
            caller_is_admin=True,
        )


async def test_set_role_defaults_writes_audit_entry_with_previous_and_new_value(db, ops):
    account_type = _account_type("office_employee")
    admin = _uid("admin")
    await ops.set_role_defaults(
        account_type=account_type,
        permissions={"edit_office_listing": True},
        caller_uid=admin,
        caller_is_admin=True,
    )
    await ops.set_role_defaults(
        account_type=account_type,
        permissions={"edit_office_listing": False},
        caller_uid=admin,
        caller_is_admin=True,
    )

    entries = [
        d.to_dict()
        for d in db.collection("accessAuditLog").where("targetId", "==", account_type).stream()
        if d.to_dict().get("action") == "role_defaults_changed" and d.to_dict().get("adminUid") == admin
    ]
    assert len(entries) == 2
    second = next(e for e in entries if e["newValue"] == {"edit_office_listing": False})
    assert second["previousValue"] == {"edit_office_listing": True}


# ---- set_user_overrides ------------------------------------------------


async def test_set_user_overrides_by_admin_succeeds(db, ops):
    target = _uid("target")
    db.collection("users").document(target).set({"role": "customer"})

    await ops.set_user_overrides(
        target_uid=target, permissions={"create_listing": True}, caller_uid=_uid("admin"), caller_is_admin=True
    )

    user = db.collection("users").document(target).get()
    assert user.get("permissionOverrides") == {"create_listing": True}


async def test_set_user_overrides_by_non_admin_forbidden(db, ops):
    target = _uid("target")
    db.collection("users").document(target).set({"role": "customer"})
    with pytest.raises(ForbiddenError):
        await ops.set_user_overrides(
            target_uid=target,
            permissions={"create_listing": True},
            caller_uid=_uid("not-admin"),
            caller_is_admin=False,
        )


async def test_set_user_overrides_rejects_protected_permission(db, ops):
    target = _uid("target")
    db.collection("users").document(target).set({"role": "customer"})
    with pytest.raises(ValidationError):
        await ops.set_user_overrides(
            target_uid=target,
            permissions={"verify_profiles": True},
            caller_uid=_uid("admin"),
            caller_is_admin=True,
        )


async def test_set_user_overrides_for_nonexistent_user_not_found(ops):
    with pytest.raises(NotFoundError):
        await ops.set_user_overrides(
            target_uid=_uid("ghost"),
            permissions={"create_listing": True},
            caller_uid=_uid("admin"),
            caller_is_admin=True,
        )


# ---- get_effective_permissions -----------------------------------------


async def test_get_effective_permissions_for_nonexistent_user_fails_closed(ops):
    result = await ops.get_effective_permissions(uid=_uid("ghost"))
    assert result["globalPermissions"] == {}
    assert result["accountType"] is None


async def test_get_effective_permissions_with_no_account_type_fails_closed(db, ops):
    uid = _uid("no-account-type")
    db.collection("users").document(uid).set({"role": "customer"})
    result = await ops.get_effective_permissions(uid=uid)
    assert result["globalPermissions"] == {}


async def test_get_effective_permissions_resolves_defaults_plus_overrides(db, ops):
    account_type = _account_type("office_employee")
    uid = _uid("employee")
    await ops.set_role_defaults(
        account_type=account_type,
        permissions={"edit_office_listing": True, "manage_office_employees": False},
        caller_uid=_uid("admin"),
        caller_is_admin=True,
    )
    db.collection("users").document(uid).set(
        {"role": "agent", "accountType": account_type, "permissionOverrides": {"manage_office_employees": True}}
    )

    result = await ops.get_effective_permissions(uid=uid)

    assert result["accountType"] == account_type
    assert result["globalPermissions"] == {"edit_office_listing": True, "manage_office_employees": True}


async def test_get_effective_permissions_never_resolves_a_protected_key(db, ops):
    account_type = _account_type("office_owner")
    uid = _uid("owner")
    await ops.set_role_defaults(
        account_type=account_type, permissions={}, caller_uid=_uid("admin"), caller_is_admin=True
    )
    # Force a protected key directly into Firestore (bypassing
    # set_user_overrides's own validation) to prove the READ side is
    # independently defensive too, not only the write side.
    db.collection("users").document(uid).set(
        {"role": "agent", "accountType": account_type, "permissionOverrides": {"admin_access": True}}
    )

    result = await ops.get_effective_permissions(uid=uid)

    assert result["globalPermissions"] == {}


# ---- get_effective_permissions with organization_id (Phase 2.1) ---------


async def test_org_context_none_when_no_organization_id_given(db, ops):
    uid = _uid("user")
    db.collection("users").document(uid).set({"role": "customer"})
    result = await ops.get_effective_permissions(uid=uid)
    assert result["organization"] is None


async def test_org_context_owner_gets_global_permissions_as_effective(db, ops):
    account_type = _account_type("org_owner_furniture_store")
    uid = _uid("owner")
    org_id = _uid("org")
    await ops.set_role_defaults(
        account_type=account_type,
        permissions={"create_product": True},
        caller_uid=_uid("admin"),
        caller_is_admin=True,
    )
    db.collection("users").document(uid).set({"role": "customer", "accountType": account_type})
    db.collection("organizations").document(org_id).set(
        {"ownerId": uid, "type": "furniture_store", "name": "Store"}
    )

    result = await ops.get_effective_permissions(uid=uid, organization_id=org_id)

    assert result["organization"]["membershipStatus"] == "owner"
    assert result["organization"]["effectivePermissions"] == {"create_product": True}


async def test_org_context_active_member_gets_union_of_global_and_org_scoped(db, ops):
    uid = _uid("employee")
    org_id = _uid("org")
    owner = _uid("owner")
    db.collection("users").document(uid).set({"role": "customer"})  # no accountType at all
    db.collection("organizations").document(org_id).set(
        {"ownerId": owner, "type": "furniture_store", "name": "Store"}
    )
    db.collection("organizations").document(org_id).collection("members").document(uid).set(
        {"role": "employee", "status": "active", "permissions": {"create_product": True}}
    )

    result = await ops.get_effective_permissions(uid=uid, organization_id=org_id)

    assert result["organization"]["membershipStatus"] == "active"
    assert result["organization"]["organizationPermissions"] == {"create_product": True}
    assert result["organization"]["effectivePermissions"] == {"create_product": True}


async def test_org_context_pending_membership_grants_nothing(db, ops):
    uid = _uid("applicant")
    org_id = _uid("org")
    owner = _uid("owner")
    db.collection("users").document(uid).set({"role": "customer"})
    db.collection("organizations").document(org_id).set(
        {"ownerId": owner, "type": "furniture_store", "name": "Store"}
    )
    db.collection("organizations").document(org_id).collection("members").document(uid).set(
        {"role": "employee", "status": "pending", "permissions": {"create_product": True}}
    )

    result = await ops.get_effective_permissions(uid=uid, organization_id=org_id)

    assert result["organization"]["membershipStatus"] == "pending"
    assert result["organization"]["effectivePermissions"] == {}


async def test_org_context_invited_membership_grants_nothing(db, ops):
    uid = _uid("invitee")
    org_id = _uid("org")
    owner = _uid("owner")
    db.collection("users").document(uid).set({"role": "customer"})
    db.collection("organizations").document(org_id).set(
        {"ownerId": owner, "type": "furniture_store", "name": "Store"}
    )
    db.collection("organizations").document(org_id).collection("members").document(uid).set(
        {"role": "employee", "status": "invited", "permissions": {"create_product": True}}
    )

    result = await ops.get_effective_permissions(uid=uid, organization_id=org_id)

    assert result["organization"]["membershipStatus"] == "invited"
    assert result["organization"]["effectivePermissions"] == {}


async def test_org_context_removed_membership_no_doc_grants_nothing(db, ops):
    uid = _uid("removed")
    org_id = _uid("org")
    owner = _uid("owner")
    db.collection("users").document(uid).set({"role": "customer"})
    db.collection("organizations").document(org_id).set(
        {"ownerId": owner, "type": "furniture_store", "name": "Store"}
    )
    # no member doc at all -- removal deletes it outright (organization_ops.py)

    result = await ops.get_effective_permissions(uid=uid, organization_id=org_id)

    assert result["organization"]["membershipStatus"] == "none"
    assert result["organization"]["effectivePermissions"] == {}


async def test_org_context_nonexistent_org_is_none_not_an_error(db, ops):
    uid = _uid("user")
    db.collection("users").document(uid).set({"role": "customer"})
    result = await ops.get_effective_permissions(uid=uid, organization_id="does-not-exist-" + uuid.uuid4().hex)
    assert result["organization"]["membershipStatus"] == "none"
    assert result["organization"]["effectivePermissions"] == {}


async def test_org_a_membership_does_not_leak_into_org_b_context(db, ops):
    uid = _uid("employee")
    org_a = _uid("org-a")
    org_b = _uid("org-b")
    owner_a = _uid("owner-a")
    owner_b = _uid("owner-b")
    db.collection("users").document(uid).set({"role": "customer"})
    db.collection("organizations").document(org_a).set(
        {"ownerId": owner_a, "type": "furniture_store", "name": "A"}
    )
    db.collection("organizations").document(org_b).set(
        {"ownerId": owner_b, "type": "furniture_store", "name": "B"}
    )
    db.collection("organizations").document(org_a).collection("members").document(uid).set(
        {"role": "employee", "status": "active", "permissions": {"create_product": True}}
    )
    # uid has no membership record in org_b at all

    result = await ops.get_effective_permissions(uid=uid, organization_id=org_b)

    assert result["organization"]["membershipStatus"] == "none"
    assert result["organization"]["effectivePermissions"] == {}


async def test_org_context_never_resolves_a_protected_key_even_if_force_seeded(db, ops):
    uid = _uid("employee")
    org_id = _uid("org")
    owner = _uid("owner")
    db.collection("users").document(uid).set({"role": "customer"})
    db.collection("organizations").document(org_id).set(
        {"ownerId": owner, "type": "furniture_store", "name": "Store"}
    )
    db.collection("organizations").document(org_id).collection("members").document(uid).set(
        {"role": "employee", "status": "active", "permissions": {"admin_access": True, "create_product": True}}
    )

    result = await ops.get_effective_permissions(uid=uid, organization_id=org_id)

    assert result["organization"]["effectivePermissions"] == {"create_product": True}
    assert "admin_access" not in result["organization"]["effectivePermissions"]


# ---- denied-attempt audit visibility (Phase 2.1) -------------------------


def _audit_entries(db, *, target_id: str) -> list[dict]:
    return [d.to_dict() for d in db.collection("accessAuditLog").where("targetId", "==", target_id).stream()]


async def test_set_role_defaults_by_non_admin_writes_denied_audit_entry(db, ops):
    account_type = _account_type("office_employee")
    caller = _uid("not-admin")
    with pytest.raises(ForbiddenError):
        await ops.set_role_defaults(
            account_type=account_type,
            permissions={"create_listing": True},
            caller_uid=caller,
            caller_is_admin=False,
        )
    entries = [e for e in _audit_entries(db, target_id=account_type) if e["adminUid"] == caller]
    assert len(entries) == 1
    assert entries[0]["result"] == "denied"
    assert entries[0]["reasonCode"] == "forbidden_not_admin"


async def test_set_role_defaults_protected_key_writes_denied_audit_entry(db, ops):
    account_type = _account_type("office_owner")
    admin = _uid("admin")
    with pytest.raises(ValidationError):
        await ops.set_role_defaults(
            account_type=account_type,
            permissions={"manage_platform_security": True},
            caller_uid=admin,
            caller_is_admin=True,
        )
    entries = [e for e in _audit_entries(db, target_id=account_type) if e["adminUid"] == admin]
    denied = [e for e in entries if e["reasonCode"] == "protected_permission_escalation_attempt"]
    assert len(denied) == 1


async def test_set_user_overrides_by_non_admin_writes_denied_audit_entry(db, ops):
    target = _uid("target")
    caller = _uid("not-admin")
    db.collection("users").document(target).set({"role": "customer"})
    with pytest.raises(ForbiddenError):
        await ops.set_user_overrides(
            target_uid=target, permissions={"create_listing": True}, caller_uid=caller, caller_is_admin=False
        )
    entries = [e for e in _audit_entries(db, target_id=target) if e["adminUid"] == caller]
    assert len(entries) == 1
    assert entries[0]["result"] == "denied"


async def test_denied_permission_audit_entries_never_contain_secrets(db, ops):
    account_type = _account_type("office_owner")
    caller = _uid("not-admin")
    with pytest.raises(ForbiddenError):
        await ops.set_role_defaults(
            account_type=account_type, permissions={}, caller_uid=caller, caller_is_admin=False
        )
    entries = [e for e in _audit_entries(db, target_id=account_type) if e["adminUid"] == caller]
    blob = repr(entries)
    for forbidden_word in ("Authorization", "Bearer ", "idToken", "password", "otp", "OTP"):
        assert forbidden_word not in blob


# ---- list_service_requests (U5, launch-readiness) ---------------------
# The Admin-SDK-only path BOTH admin.html's central Requests inbox AND
# account.html's "My Requests" tab use -- firestore.rules' own read rule
# (isAdmin() || own customerUid || owning provider) genuinely cannot
# service either an unfiltered/cross-provider client collectionGroup
# query, or (reliably) even a customerUid-filtered one, from the client
# (see tests/firestore/customer_and_admin_requests_view.test.mjs); this
# method is the only way either view can exist. Scoping (admin sees all,
# anyone else sees only their own) happens HERE, in Python, from
# caller_uid/caller_is_admin -- never from anything a caller can set.


async def test_list_service_requests_admin_sees_every_provider_newest_first(db, ops):
    p1, p2 = _uid("provider"), _uid("provider")
    c1 = _uid("customer")
    admin_uid = _uid("admin")
    db.collection("serviceProviders").document(p1).set(
        {
            "serviceType": "engineer",
            "providerType": "individual",
            "ownerId": p1,
            "displayName": "Eng One",
            "verified": False,
        }
    )
    db.collection("serviceProviders").document(p2).set(
        {
            "serviceType": "cleaning",
            "providerType": "individual",
            "ownerId": p2,
            "displayName": "Clean Two",
            "verified": False,
        }
    )
    db.collection("users").document(c1).set({"role": "customer", "displayName": "Cust One"})
    db.collection("serviceProviders").document(p1).collection("requests").document("r1").set(
        {"customerUid": c1, "status": "pending", "message": "quote please", "createdAt": 1}
    )
    db.collection("serviceProviders").document(p2).collection("requests").document("r2").set(
        {"customerUid": c1, "status": "accepted", "message": "book a slot", "createdAt": 2}
    )
    results = await ops.list_service_requests(caller_uid=admin_uid, caller_is_admin=True)
    ours = [r for r in results if r["providerId"] in (p1, p2)]
    assert len(ours) == 2
    assert ours[0]["requestId"] == "r2"  # newest (createdAt=2) first
    assert ours[0]["providerName"] == "Clean Two"
    assert ours[0]["customerName"] == "Cust One"
    assert ours[1]["requestId"] == "r1"
    assert ours[1]["providerName"] == "Eng One"


async def test_list_service_requests_admin_status_filter(db, ops):
    p1 = _uid("provider")
    admin_uid = _uid("admin")
    db.collection("serviceProviders").document(p1).set(
        {
            "serviceType": "designer",
            "providerType": "individual",
            "ownerId": p1,
            "displayName": "D",
            "verified": False,
        }
    )
    db.collection("serviceProviders").document(p1).collection("requests").document("rp").set(
        {"customerUid": _uid("customer"), "status": "pending", "message": "m", "createdAt": 1}
    )
    db.collection("serviceProviders").document(p1).collection("requests").document("rc").set(
        {"customerUid": _uid("customer"), "status": "completed", "message": "m", "createdAt": 2}
    )
    results = await ops.list_service_requests(caller_uid=admin_uid, caller_is_admin=True, status="pending")
    assert all(r["status"] == "pending" for r in results)
    assert any(r["requestId"] == "rp" for r in results)
    assert not any(r["requestId"] == "rc" for r in results)


async def test_list_service_requests_rejects_an_invalid_status(ops):
    with pytest.raises(ValidationError):
        await ops.list_service_requests(caller_uid=_uid("admin"), caller_is_admin=True, status="not-a-real-status")


async def test_list_service_requests_non_admin_sees_only_their_own_requests(db, ops):
    p1, p2 = _uid("provider"), _uid("provider")
    customer_a, customer_b = _uid("customer"), _uid("customer")
    db.collection("serviceProviders").document(p1).set(
        {
            "serviceType": "lawyer",
            "providerType": "individual",
            "ownerId": p1,
            "displayName": "L1",
            "verified": False,
        }
    )
    db.collection("serviceProviders").document(p2).set(
        {
            "serviceType": "maintenance",
            "providerType": "individual",
            "ownerId": p2,
            "displayName": "M1",
            "verified": False,
        }
    )
    db.collection("serviceProviders").document(p1).collection("requests").document("ra1").set(
        {"customerUid": customer_a, "status": "pending", "message": "mine 1", "createdAt": 1}
    )
    db.collection("serviceProviders").document(p2).collection("requests").document("ra2").set(
        {"customerUid": customer_a, "status": "completed", "message": "mine 2", "createdAt": 2}
    )
    db.collection("serviceProviders").document(p1).collection("requests").document("rb1").set(
        {"customerUid": customer_b, "status": "pending", "message": "not mine", "createdAt": 3}
    )
    results = await ops.list_service_requests(caller_uid=customer_a, caller_is_admin=False)
    ids = {r["requestId"] for r in results}
    assert ids == {"ra1", "ra2"}
    assert all(r["customerUid"] == customer_a for r in results)


async def test_list_service_requests_non_admin_cannot_widen_scope_via_any_argument(db, ops):
    """The handler layer never forwards a client-supplied customer_uid at
    all -- this proves the ops method itself has no parameter a non-admin
    caller could use to see someone else's requests even if a future
    handler bug tried to pass one through."""
    import inspect

    sig = inspect.signature(ops.list_service_requests)
    assert "customer_uid" not in sig.parameters
