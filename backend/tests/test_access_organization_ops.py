# Proves app.access.organization_ops.OrganizationOps against a REAL
# Firestore emulator -- transactional read-then-write behavior, cross-
# tenant isolation, and atomic audit-log pairing can't be meaningfully
# proven against a fake/mock. Skipped automatically when no emulator is
# reachable, same convention as test_ratelimiter_firestore_emulator.py:
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_access_organization_ops.py
from __future__ import annotations

import os
import time
import uuid

import pytest

from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.access.organization_ops import OrganizationOps

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
    return OrganizationOps(db)


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


async def _seed_user(db, uid: str) -> None:
    db.collection("users").document(uid).set({"role": "customer", "createdAt": time.time()})


def _audit_entries(db, *, target_organization_id: str | None = None) -> list[dict]:
    query = db.collection("accessAuditLog")
    if target_organization_id:
        query = query.where("targetOrganizationId", "==", target_organization_id)
    return [d.to_dict() for d in query.stream()]


# ---- create_organization ------------------------------------------------


async def test_create_organization_sets_caller_as_owner_and_writes_audit_entry(db, ops):
    owner = _uid("owner")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="My Store")

    org = db.collection("organizations").document(org_id).get()
    assert org.exists
    assert org.get("ownerId") == owner
    assert org.get("type") == "furniture_store"
    assert org.get("verified") is False

    entries = _audit_entries(db, target_organization_id=org_id)
    assert any(e["action"] == "organization_created" and e["adminUid"] == owner for e in entries)


async def test_create_organization_rejects_unknown_type(ops):
    with pytest.raises(ValidationError):
        await ops.create_organization(caller_uid=_uid("owner"), org_type="real_estate_office", name="Office")


async def test_create_organization_rejects_empty_name(ops):
    with pytest.raises(ValidationError):
        await ops.create_organization(caller_uid=_uid("owner"), org_type="furniture_store", name="   ")


# ---- request / invite / approve / reject membership ----------------------


async def test_owner_cannot_request_membership_in_their_own_organization(db, ops):
    owner = _uid("owner")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    with pytest.raises(ValidationError):
        await ops.request_membership(org_id=org_id, caller_uid=owner)


async def test_request_membership_creates_a_pending_record(db, ops):
    owner = _uid("owner")
    applicant = _uid("applicant")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    await ops.request_membership(org_id=org_id, caller_uid=applicant)

    member = db.collection("organizations").document(org_id).collection("members").document(applicant).get()
    assert member.exists
    assert member.get("status") == "pending"


async def test_request_membership_twice_conflicts(db, ops):
    owner = _uid("owner")
    applicant = _uid("applicant")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.request_membership(org_id=org_id, caller_uid=applicant)
    with pytest.raises(ConflictError):
        await ops.request_membership(org_id=org_id, caller_uid=applicant)


async def test_request_membership_against_nonexistent_org_not_found(ops):
    with pytest.raises(NotFoundError):
        await ops.request_membership(org_id="does-not-exist-" + uuid.uuid4().hex, caller_uid=_uid("applicant"))


async def test_invite_member_creates_active_membership_immediately(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.exists
    assert member.get("status") == "active"


async def test_invite_member_by_non_owner_non_admin_is_forbidden(db, ops):
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    with pytest.raises(ForbiddenError):
        await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=outsider, caller_is_admin=False)


async def test_invite_member_requires_a_real_user_profile(db, ops):
    owner = _uid("owner")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    with pytest.raises(NotFoundError):
        await ops.invite_member(
            org_id=org_id, target_uid=_uid("ghost"), caller_uid=owner, caller_is_admin=False
        )


async def test_admin_can_invite_a_member_even_without_being_the_owner(db, ops):
    owner = _uid("owner")
    admin = _uid("admin")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=admin, caller_is_admin=True)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.exists and member.get("status") == "active"


async def test_approve_membership_activates_a_pending_request(db, ops):
    owner = _uid("owner")
    applicant = _uid("applicant")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.request_membership(org_id=org_id, caller_uid=applicant)

    await ops.approve_membership(org_id=org_id, target_uid=applicant, caller_uid=owner, caller_is_admin=False)

    member = db.collection("organizations").document(org_id).collection("members").document(applicant).get()
    assert member.get("status") == "active"


async def test_approve_membership_by_non_owner_non_admin_is_forbidden(db, ops):
    owner = _uid("owner")
    applicant = _uid("applicant")
    outsider = _uid("outsider")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.request_membership(org_id=org_id, caller_uid=applicant)

    with pytest.raises(ForbiddenError):
        await ops.approve_membership(
            org_id=org_id, target_uid=applicant, caller_uid=outsider, caller_is_admin=False
        )


async def test_approve_membership_with_no_pending_request_conflicts(db, ops):
    owner = _uid("owner")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    with pytest.raises(ConflictError):
        await ops.approve_membership(
            org_id=org_id, target_uid=_uid("nobody"), caller_uid=owner, caller_is_admin=False
        )


async def test_reject_membership_deletes_the_pending_request(db, ops):
    owner = _uid("owner")
    applicant = _uid("applicant")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.request_membership(org_id=org_id, caller_uid=applicant)

    await ops.reject_membership(org_id=org_id, target_uid=applicant, caller_uid=owner, caller_is_admin=False)

    member = db.collection("organizations").document(org_id).collection("members").document(applicant).get()
    assert not member.exists


async def test_applicant_can_request_again_after_rejection(db, ops):
    owner = _uid("owner")
    applicant = _uid("applicant")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.request_membership(org_id=org_id, caller_uid=applicant)
    await ops.reject_membership(org_id=org_id, target_uid=applicant, caller_uid=owner, caller_is_admin=False)

    await ops.request_membership(org_id=org_id, caller_uid=applicant)  # must not raise

    member = db.collection("organizations").document(org_id).collection("members").document(applicant).get()
    assert member.get("status") == "pending"


async def test_remove_member_deletes_an_active_membership(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.remove_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert not member.exists


# ---- cross-tenant isolation ------------------------------------------------


async def test_owner_of_org_a_cannot_approve_membership_in_org_b(db, ops):
    owner_a = _uid("owner-a")
    owner_b = _uid("owner-b")
    applicant = _uid("applicant")
    org_a = await ops.create_organization(caller_uid=owner_a, org_type="furniture_store", name="Store A")
    org_b = await ops.create_organization(caller_uid=owner_b, org_type="furniture_store", name="Store B")
    await ops.request_membership(org_id=org_b, caller_uid=applicant)

    with pytest.raises(ForbiddenError):
        await ops.approve_membership(org_id=org_b, target_uid=applicant, caller_uid=owner_a, caller_is_admin=False)

    # org_a is untouched/irrelevant -- this call must not have silently
    # succeeded against the wrong org either.
    assert db.collection("organizations").document(org_a).get().exists


async def test_member_permissions_change_rejects_protected_key(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    with pytest.raises(ValidationError):
        await ops.update_member_permissions(
            org_id=org_id,
            target_uid=employee,
            caller_uid=owner,
            caller_is_admin=False,
            permissions={"admin_access": True},
        )


async def test_member_permissions_change_accepts_known_keys(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.update_member_permissions(
        org_id=org_id,
        target_uid=employee,
        caller_uid=owner,
        caller_is_admin=False,
        permissions={"create_product": True},
    )

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.get("permissions") == {"create_product": True}


# ---- ownership transfer: heavily protected --------------------------------


async def test_transfer_ownership_by_owner_to_an_active_member_succeeds(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.transfer_ownership(org_id=org_id, new_owner_uid=employee, caller_uid=owner, caller_is_admin=False)

    org = db.collection("organizations").document(org_id).get()
    assert org.get("ownerId") == employee
    # the new owner no longer has (or needs) a members doc
    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert not member.exists


async def test_transfer_ownership_to_a_non_member_by_non_admin_owner_rejected(db, ops):
    owner = _uid("owner")
    stranger = _uid("stranger")
    await _seed_user(db, stranger)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    with pytest.raises(ValidationError):
        await ops.transfer_ownership(
            org_id=org_id, new_owner_uid=stranger, caller_uid=owner, caller_is_admin=False
        )


async def test_transfer_ownership_by_non_owner_non_admin_forbidden(db, ops):
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    with pytest.raises(ForbiddenError):
        await ops.transfer_ownership(
            org_id=org_id, new_owner_uid=employee, caller_uid=outsider, caller_is_admin=False
        )


async def test_admin_can_transfer_ownership_to_any_real_user_without_prior_membership(db, ops):
    owner = _uid("owner")
    admin = _uid("admin")
    stranger = _uid("stranger")
    await _seed_user(db, stranger)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    await ops.transfer_ownership(org_id=org_id, new_owner_uid=stranger, caller_uid=admin, caller_is_admin=True)

    assert db.collection("organizations").document(org_id).get().get("ownerId") == stranger


async def test_transfer_ownership_to_self_rejected_for_non_admin(db, ops):
    owner = _uid("owner")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    with pytest.raises(ValidationError):
        await ops.transfer_ownership(org_id=org_id, new_owner_uid=owner, caller_uid=owner, caller_is_admin=False)


async def test_transfer_ownership_writes_an_audit_entry(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.transfer_ownership(org_id=org_id, new_owner_uid=employee, caller_uid=owner, caller_is_admin=False)

    entries = _audit_entries(db, target_organization_id=org_id)
    transfer_entries = [e for e in entries if e["action"] == "organization_ownership_transferred"]
    assert len(transfer_entries) == 1
    assert transfer_entries[0]["previousValue"] == owner
    assert transfer_entries[0]["newValue"] == employee


# ---- a rejected/failed mutation must never leave a fraudulent success ----


async def test_a_rejected_transfer_leaves_no_audit_entry_at_all(db, ops):
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    before = len(_audit_entries(db, target_organization_id=org_id))
    with pytest.raises(ForbiddenError):
        await ops.transfer_ownership(
            org_id=org_id, new_owner_uid=employee, caller_uid=outsider, caller_is_admin=False
        )
    after = len(_audit_entries(db, target_organization_id=org_id))

    assert after == before  # the aborted transaction wrote nothing -- not even a "denied" record
    assert db.collection("organizations").document(org_id).get().get("ownerId") == owner  # unchanged
