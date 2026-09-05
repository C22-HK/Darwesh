# Proves app.access.company_ops.CompanyOps against a REAL Firestore
# emulator -- same rationale as test_access_organization_ops.py (this
# module deliberately mirrors its structure and helper shape closely,
# since CompanyOps is a scoped-down parallel of OrganizationOps for the
# legacy `companies` collection, see company_ops.py's header for what's
# intentionally narrower and why).
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_access_company_ops.py
from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest

from app.access.company_ops import CompanyOps
from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError

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
    return CompanyOps(db)


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


async def _seed_user(db, uid: str) -> None:
    db.collection("users").document(uid).set({"role": "customer", "createdAt": time.time()})


async def _invite_and_accept(
    ops, *, company_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool = False
) -> None:
    await ops.invite_employee(
        company_id=company_id, target_uid=target_uid, caller_uid=caller_uid, caller_is_admin=caller_is_admin
    )
    await ops.accept_invitation(company_id=company_id, caller_uid=target_uid)


def _audit_entries(db, *, target_organization_id: str | None = None) -> list[dict]:
    query = db.collection("accessAuditLog")
    if target_organization_id:
        query = query.where("targetOrganizationId", "==", target_organization_id)
    return [d.to_dict() for d in query.stream()]


# ---- create_company -------------------------------------------------------


async def test_create_company_sets_caller_as_owner_and_writes_audit_entry(db, ops):
    owner = _uid("owner")
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")

    company = db.collection("companies").document(company_id).get()
    assert company.exists
    assert company.get("ownerId") == owner
    assert company.get("verified") is False

    entries = _audit_entries(db, target_organization_id=company_id)
    assert any(e["action"] == "company_created" and e["adminUid"] == owner for e in entries)


async def test_create_company_rejects_empty_name(ops):
    with pytest.raises(ValidationError):
        await ops.create_company(caller_uid=_uid("owner"), name="   ")


async def test_create_company_never_lets_the_caller_set_someone_elses_ownerid(db, ops):
    # There is no ownerId parameter at all on create_company -- it is
    # always derived from caller_uid, structurally, not merely validated.
    owner = _uid("owner")
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    company = db.collection("companies").document(company_id).get()
    assert company.get("ownerId") == owner


# ---- membership: request / invite / approve / reject / remove -------------


async def test_request_membership_creates_pending_record(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")

    await ops.request_membership(company_id=company_id, caller_uid=employee)

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert record.exists
    assert record.get("status") == "pending"
    assert record.get("uid") == employee


async def test_owner_cannot_request_membership_in_own_company(ops):
    owner = _uid("owner")
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    with pytest.raises(ValidationError):
        await ops.request_membership(company_id=company_id, caller_uid=owner)


async def test_request_membership_twice_conflicts(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.request_membership(company_id=company_id, caller_uid=employee)
    with pytest.raises(ConflictError):
        await ops.request_membership(company_id=company_id, caller_uid=employee)


async def test_approve_membership_by_owner_activates_it(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.request_membership(company_id=company_id, caller_uid=employee)

    await ops.approve_membership(
        company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False
    )

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert record.get("status") == "active"


async def test_approve_membership_by_non_owner_non_admin_is_forbidden(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    stranger = _uid("stranger")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.request_membership(company_id=company_id, caller_uid=employee)

    with pytest.raises(ForbiddenError):
        await ops.approve_membership(
            company_id=company_id, target_uid=employee, caller_uid=stranger, caller_is_admin=False
        )


async def test_reject_membership_deletes_pending_record(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.request_membership(company_id=company_id, caller_uid=employee)

    await ops.reject_membership(
        company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False
    )

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert not record.exists


async def test_invite_employee_by_owner_creates_invited_record(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")

    await ops.invite_employee(company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert record.get("status") == "invited"


async def test_invite_employee_by_non_owner_non_admin_is_forbidden(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    stranger = _uid("stranger")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")

    with pytest.raises(ForbiddenError):
        await ops.invite_employee(
            company_id=company_id, target_uid=employee, caller_uid=stranger, caller_is_admin=False
        )


async def test_invite_employee_rejects_a_uid_with_no_real_user_profile(ops):
    owner = _uid("owner")
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    with pytest.raises(NotFoundError):
        await ops.invite_employee(
            company_id=company_id, target_uid=_uid("ghost"), caller_uid=owner, caller_is_admin=False
        )


async def test_invite_employee_cannot_target_the_owner(db, ops):
    owner = _uid("owner")
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    with pytest.raises(ValidationError):
        await ops.invite_employee(company_id=company_id, target_uid=owner, caller_uid=owner, caller_is_admin=False)


async def test_accept_invitation_only_the_invited_target_can_accept(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    stranger = _uid("stranger")
    await _seed_user(db, employee)
    await _seed_user(db, stranger)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.invite_employee(company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    with pytest.raises(NotFoundError):
        await ops.accept_invitation(company_id=company_id, caller_uid=stranger)

    await ops.accept_invitation(company_id=company_id, caller_uid=employee)
    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert record.get("status") == "active"


async def test_decline_invitation_deletes_the_record(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.invite_employee(company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.decline_invitation(company_id=company_id, caller_uid=employee)

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert not record.exists


async def test_revoke_invitation_by_owner_removes_it(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.invite_employee(company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.revoke_invitation(
        company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False
    )

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert not record.exists


async def test_remove_employee_by_owner_deletes_active_record(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await _invite_and_accept(ops, company_id=company_id, target_uid=employee, caller_uid=owner)

    await ops.remove_employee(company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert not record.exists


async def test_remove_employee_by_admin_works_even_without_ownerid_match(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await _invite_and_accept(ops, company_id=company_id, target_uid=employee, caller_uid=owner)

    await ops.remove_employee(
        company_id=company_id, target_uid=employee, caller_uid=_uid("admin"), caller_is_admin=True
    )

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert not record.exists


# ---- legacy ownerless companies (no ownerId field at all) ------------------
#
# These exist for real: admin.html's existing "Add Agent" flow creates a
# company doc with no ownerId (see firestore.rules' Phase 3 comment), and
# any pre-Phase-3 test/demo data was created the same way. Every
# membership method must handle "ownerId field is entirely absent" --
# not merely "ownerId is null" -- since the Firestore Python client's
# DocumentSnapshot.get() raises KeyError for a genuinely missing field
# (only google.cloud.firestore_v1.base_document.DocumentSnapshot.get,
# confirmed against the installed SDK source). This is exactly the
# scenario the user's "old test companies without ownerId must fail
# safely, and can still be managed by a trusted admin flow" requirement
# describes -- these tests are the direct verification of that.


def _seed_legacy_company(db, *, name: str = "Legacy Office") -> str:
    """A company doc with NO ownerId field at all, written directly
    (bypassing CompanyOps.create_company, which always sets ownerId) --
    the same shape admin.html's live "Add Agent" flow and any pre-
    Phase-3 test data produce."""
    ref = db.collection("companies").document()
    ref.set({"name": name, "createdAt": time.time()})
    return ref.id


async def test_admin_can_invite_an_employee_to_a_legacy_ownerless_company(db, ops):
    company_id = _seed_legacy_company(db)
    employee = _uid("employee")
    await _seed_user(db, employee)

    await ops.invite_employee(
        company_id=company_id, target_uid=employee, caller_uid=_uid("admin"), caller_is_admin=True
    )

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert record.get("status") == "invited"


async def test_admin_can_approve_membership_at_a_legacy_ownerless_company(db, ops):
    company_id = _seed_legacy_company(db)
    employee = _uid("employee")
    await _seed_user(db, employee)
    await ops.request_membership(company_id=company_id, caller_uid=employee)

    await ops.approve_membership(
        company_id=company_id, target_uid=employee, caller_uid=_uid("admin"), caller_is_admin=True
    )

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert record.get("status") == "active"


async def test_admin_can_remove_an_employee_from_a_legacy_ownerless_company(db, ops):
    company_id = _seed_legacy_company(db)
    employee = _uid("employee")
    await _seed_user(db, employee)
    await ops.invite_employee(
        company_id=company_id, target_uid=employee, caller_uid=_uid("admin"), caller_is_admin=True
    )
    await ops.accept_invitation(company_id=company_id, caller_uid=employee)

    await ops.remove_employee(
        company_id=company_id, target_uid=employee, caller_uid=_uid("admin"), caller_is_admin=True
    )

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert not record.exists


async def test_non_admin_stranger_is_forbidden_not_crashed_on_a_legacy_ownerless_company(db, ops):
    # The load-bearing "fails safely, cannot be claimed by an arbitrary
    # user" proof: a legacy company with no ownerId must raise
    # ForbiddenError (a clean, expected denial) for a random signed-in
    # caller -- never an unhandled exception, and never a silent grant.
    company_id = _seed_legacy_company(db)
    employee = _uid("employee")
    stranger = _uid("stranger")
    await _seed_user(db, employee)

    with pytest.raises(ForbiddenError):
        await ops.invite_employee(
            company_id=company_id, target_uid=employee, caller_uid=stranger, caller_is_admin=False
        )


async def test_request_membership_at_a_legacy_ownerless_company_does_not_crash(db, ops):
    company_id = _seed_legacy_company(db)
    employee = _uid("employee")
    await _seed_user(db, employee)

    await ops.request_membership(company_id=company_id, caller_uid=employee)

    record = db.collection("companies").document(company_id).collection("employees").document(employee).get()
    assert record.get("status") == "pending"


# ---- list_my_companies -----------------------------------------------------


async def test_list_my_companies_includes_owned_and_active_and_pending_and_invited(db, ops):
    owner = _uid("owner")
    active_employee = _uid("active")
    pending_employee = _uid("pending")
    invited_employee = _uid("invited")
    for u in (active_employee, pending_employee, invited_employee):
        await _seed_user(db, u)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await _invite_and_accept(ops, company_id=company_id, target_uid=active_employee, caller_uid=owner)
    await ops.request_membership(company_id=company_id, caller_uid=pending_employee)
    await ops.invite_employee(
        company_id=company_id, target_uid=invited_employee, caller_uid=owner, caller_is_admin=False
    )

    owner_result = await ops.list_my_companies(uid=owner)
    assert [r["companyId"] for r in owner_result] == [company_id]
    assert owner_result[0]["isOwner"] is True
    assert owner_result[0]["membershipStatus"] == "owner"

    active_result = await ops.list_my_companies(uid=active_employee)
    assert active_result[0]["membershipStatus"] == "active"
    assert active_result[0]["isOwner"] is False

    pending_result = await ops.list_my_companies(uid=pending_employee)
    assert pending_result[0]["membershipStatus"] == "pending"

    invited_result = await ops.list_my_companies(uid=invited_employee)
    assert invited_result[0]["membershipStatus"] == "invited"


async def test_list_my_companies_removed_membership_is_absent(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await _invite_and_accept(ops, company_id=company_id, target_uid=employee, caller_uid=owner)
    await ops.remove_employee(company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    result = await ops.list_my_companies(uid=employee)
    assert result == []


async def test_list_my_companies_empty_for_a_user_with_no_relationships(ops):
    result = await ops.list_my_companies(uid=_uid("nobody"))
    assert result == []


async def test_list_my_companies_never_returns_an_organizations_membership_doc(db, ops):
    # Structural proof that the `employees` subcollection name keeps
    # company membership queries from ever crossing into
    # organizations/{orgId}/members -- even for the SAME uid holding both
    # kinds of membership simultaneously.
    from app.access.organization_ops import OrganizationOps

    org_ops = OrganizationOps(db)
    person = _uid("person")
    await _seed_user(db, person)
    org_owner = _uid("org-owner")
    org_id = await org_ops.create_organization(caller_uid=org_owner, org_type="furniture_store", name="Store")
    await org_ops.invite_member(org_id=org_id, target_uid=person, caller_uid=org_owner, caller_is_admin=False)
    await org_ops.accept_invitation(org_id=org_id, caller_uid=person)

    result = await ops.list_my_companies(uid=person)
    assert result == []


# ---- races ------------------------------------------------------------------


async def test_concurrent_approve_and_reject_only_one_wins(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    company_id = await ops.create_company(caller_uid=owner, name="Acme Realty")
    await ops.request_membership(company_id=company_id, caller_uid=employee)

    results = await asyncio.gather(
        ops.approve_membership(
            company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False
        ),
        ops.reject_membership(company_id=company_id, target_uid=employee, caller_uid=owner, caller_is_admin=False),
        return_exceptions=True,
    )

    successes = [r for r in results if r is None]
    failures = [r for r in results if isinstance(r, Exception)]
    assert len(successes) == 1
    assert len(failures) == 1
    assert isinstance(failures[0], (ConflictError, NotFoundError))
