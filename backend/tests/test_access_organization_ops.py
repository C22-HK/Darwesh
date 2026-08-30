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


async def _invite_and_accept(ops, *, org_id: str, target_uid: str, caller_uid: str, caller_is_admin: bool = False) -> None:
    """Test-only convenience: the real, full two-step Phase 2.1 flow --
    invite (owner/admin), then accept (target, always self-uid) -- used
    wherever a test needs an already-ACTIVE member as setup for
    something else (remove_member, update_member_permissions,
    transfer_ownership), not to re-test invite_member/accept_invitation
    themselves."""
    await ops.invite_member(org_id=org_id, target_uid=target_uid, caller_uid=caller_uid, caller_is_admin=caller_is_admin)
    await ops.accept_invitation(org_id=org_id, caller_uid=target_uid)


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


async def test_invite_member_creates_an_invited_record_not_yet_active(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.exists
    assert member.get("status") == "invited"
    assert member.get("invitedBy") == owner
    assert member.get("expiresAt") is not None


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
    assert member.exists and member.get("status") == "invited"


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
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

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
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

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
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

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
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

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
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

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
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

    await ops.transfer_ownership(org_id=org_id, new_owner_uid=employee, caller_uid=owner, caller_is_admin=False)

    entries = _audit_entries(db, target_organization_id=org_id)
    transfer_entries = [e for e in entries if e["action"] == "organization_ownership_transferred"]
    assert len(transfer_entries) == 1
    assert transfer_entries[0]["previousValue"] == owner
    assert transfer_entries[0]["newValue"] == employee


# ---- a rejected/failed mutation must never leave a fraudulent success ----


async def test_a_rejected_transfer_never_leaves_a_fraudulent_success_entry(db, ops):
    # Phase 2.1 revision: a rejected ownership-transfer attempt now
    # DOES produce a "denied" audit entry (see the denied-attempt-audit
    # tests below) -- what must remain true, and is what this test
    # actually proves, is that the aborted mutation TRANSACTION itself
    # commits nothing (no "success" entry, no ownerId change), and that
    # any denied entry that does appear is clearly marked result='denied',
    # never 'success'.
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

    with pytest.raises(ForbiddenError):
        await ops.transfer_ownership(
            org_id=org_id, new_owner_uid=employee, caller_uid=outsider, caller_is_admin=False
        )

    entries = _audit_entries(db, target_organization_id=org_id)
    transfer_related = [e for e in entries if e["action"] == "organization_ownership_transferred"]
    assert transfer_related == []  # no success entry for the rejected mutation
    denied = [e for e in entries if e["action"] == "ownership_transfer_denied"]
    assert all(e["result"] == "denied" for e in denied)
    assert db.collection("organizations").document(org_id).get().get("ownerId") == owner  # unchanged


# ---- invite -> accept flow (Phase 2.1) ------------------------------------


async def test_accept_invitation_activates_membership(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.accept_invitation(org_id=org_id, caller_uid=employee)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.get("status") == "active"
    assert member.get("acceptedAt") is not None


async def test_accept_invitation_writes_audit_entry(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.accept_invitation(org_id=org_id, caller_uid=employee)

    entries = _audit_entries(db, target_organization_id=org_id)
    accepted = [e for e in entries if e["action"] == "invitation_accepted"]
    assert len(accepted) == 1
    assert accepted[0]["adminUid"] == employee


async def test_a_different_uid_cannot_accept_someone_elses_invitation(db, ops):
    # There is no target_uid parameter on accept_invitation at all --
    # this proves that calling it as a DIFFERENT uid (one with no
    # invitation of their own in this org) simply finds nothing to
    # accept, structurally never someone else's.
    owner = _uid("owner")
    employee = _uid("employee")
    impostor = _uid("impostor")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    with pytest.raises(NotFoundError):
        await ops.accept_invitation(org_id=org_id, caller_uid=impostor)

    # the real invitation is untouched
    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.get("status") == "invited"


async def test_accept_invitation_with_no_invite_at_all_not_found(db, ops):
    owner = _uid("owner")
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    with pytest.raises(NotFoundError):
        await ops.accept_invitation(org_id=org_id, caller_uid=_uid("nobody"))


async def test_decline_invitation_deletes_the_record(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.decline_invitation(org_id=org_id, caller_uid=employee)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert not member.exists


async def test_revoke_invitation_by_owner_deletes_the_record(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    await ops.revoke_invitation(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert not member.exists


async def test_revoke_invitation_by_non_owner_non_admin_forbidden(db, ops):
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    with pytest.raises(ForbiddenError):
        await ops.revoke_invitation(org_id=org_id, target_uid=employee, caller_uid=outsider, caller_is_admin=False)

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.get("status") == "invited"  # untouched


async def test_revoked_invitation_can_never_be_accepted(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)
    await ops.revoke_invitation(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    with pytest.raises(NotFoundError):
        await ops.accept_invitation(org_id=org_id, caller_uid=employee)


async def test_declined_invitation_can_never_be_accepted(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)
    await ops.decline_invitation(org_id=org_id, caller_uid=employee)

    with pytest.raises(NotFoundError):
        await ops.accept_invitation(org_id=org_id, caller_uid=employee)


async def test_expired_invitation_cannot_be_accepted(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)
    # Simulate time passing -- directly backdate expiresAt (bypassing
    # the ops layer, which has no "set an arbitrary expiry" write path
    # on purpose) rather than actually sleeping past INVITATION_EXPIRY_DAYS.
    from datetime import UTC, datetime, timedelta

    db.collection("organizations").document(org_id).collection("members").document(employee).update(
        {"expiresAt": datetime.now(UTC) - timedelta(days=1)}
    )

    with pytest.raises(ConflictError):
        await ops.accept_invitation(org_id=org_id, caller_uid=employee)

    # still 'invited', not silently activated nor deleted -- the owner
    # can see it and reinvite, or the target can notice and ask again.
    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    assert member.get("status") == "invited"


async def test_accept_and_revoke_race_only_one_wins_and_neither_leaves_a_broken_state(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False)

    import asyncio

    results = await asyncio.gather(
        ops.accept_invitation(org_id=org_id, caller_uid=employee),
        ops.revoke_invitation(org_id=org_id, target_uid=employee, caller_uid=owner, caller_is_admin=False),
        return_exceptions=True,
    )

    # Exactly one of the two must have succeeded (returned None) and the
    # other must have failed cleanly (a raised exception, not a silent
    # inconsistency) -- Firestore's transaction semantics make this
    # deterministic, not a 50/50 flake: whichever transaction commits
    # first, the other re-reads the now-changed/deleted doc and its own
    # precondition fails.
    succeeded = [r for r in results if r is None]
    failed = [r for r in results if isinstance(r, BaseException)]
    assert len(succeeded) == 1
    assert len(failed) == 1

    member = db.collection("organizations").document(org_id).collection("members").document(employee).get()
    if not member.exists:
        # revoke won -- no leftover 'invited' OR 'active' doc
        assert isinstance(failed[0], (NotFoundError, ConflictError))
    else:
        # accept won -- must be cleanly active, never a half-updated state
        assert member.get("status") == "active"


async def test_invitation_in_org_a_does_not_leak_into_org_b(db, ops):
    owner_a = _uid("owner-a")
    owner_b = _uid("owner-b")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_a = await ops.create_organization(caller_uid=owner_a, org_type="furniture_store", name="Store A")
    org_b = await ops.create_organization(caller_uid=owner_b, org_type="furniture_store", name="Store B")
    await ops.invite_member(org_id=org_a, target_uid=employee, caller_uid=owner_a, caller_is_admin=False)

    # employee was invited to org_a only -- accepting in org_b must fail
    with pytest.raises(NotFoundError):
        await ops.accept_invitation(org_id=org_b, caller_uid=employee)

    member_b = db.collection("organizations").document(org_b).collection("members").document(employee).get()
    assert not member_b.exists


# ---- denied-attempt audit visibility (Phase 2.1) --------------------------


async def test_forbidden_invite_attempt_writes_a_denied_audit_entry(db, ops):
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    with pytest.raises(ForbiddenError):
        await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=outsider, caller_is_admin=False)

    entries = _audit_entries(db, target_organization_id=org_id)
    denied = [e for e in entries if e["action"] == "member_invite_denied"]
    assert len(denied) == 1
    assert denied[0]["result"] == "denied"
    assert denied[0]["adminUid"] == outsider
    assert denied[0]["reasonCode"] == "forbidden_not_owner_or_admin"


async def test_protected_permission_escalation_attempt_writes_a_denied_audit_entry(db, ops):
    owner = _uid("owner")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

    with pytest.raises(ValidationError):
        await ops.update_member_permissions(
            org_id=org_id,
            target_uid=employee,
            caller_uid=owner,
            caller_is_admin=False,
            permissions={"suspend_users": True},
        )

    entries = _audit_entries(db, target_organization_id=org_id)
    denied = [e for e in entries if e["reasonCode"] == "protected_permission_escalation_attempt"]
    assert len(denied) == 1
    assert denied[0]["result"] == "denied"


async def test_unauthorized_ownership_transfer_writes_a_denied_audit_entry(db, ops):
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")
    await _invite_and_accept(ops, org_id=org_id, target_uid=employee, caller_uid=owner)

    with pytest.raises(ForbiddenError):
        await ops.transfer_ownership(
            org_id=org_id, new_owner_uid=employee, caller_uid=outsider, caller_is_admin=False
        )

    entries = _audit_entries(db, target_organization_id=org_id)
    denied = [e for e in entries if e["action"] == "ownership_transfer_denied"]
    assert len(denied) == 1
    assert denied[0]["reasonCode"] == "forbidden_not_owner_or_admin"


async def test_denied_audit_entries_never_contain_secrets_or_tokens(db, ops):
    owner = _uid("owner")
    outsider = _uid("outsider")
    employee = _uid("employee")
    await _seed_user(db, employee)
    org_id = await ops.create_organization(caller_uid=owner, org_type="furniture_store", name="Store")

    with pytest.raises(ForbiddenError):
        await ops.invite_member(org_id=org_id, target_uid=employee, caller_uid=outsider, caller_is_admin=False)

    entries = _audit_entries(db, target_organization_id=org_id)
    denied = [e for e in entries if e["result"] == "denied"]
    assert denied
    blob = repr(denied)
    for forbidden_word in ("Authorization", "Bearer ", "idToken", "password", "otp", "OTP"):
        assert forbidden_word not in blob


async def test_ordinary_not_found_does_not_create_audit_noise(db, ops):
    # A benign NotFoundError (no such org) must NOT produce a denied
    # audit entry -- only the specific security-relevant categories do.
    with pytest.raises(NotFoundError):
        await ops.request_membership(org_id="does-not-exist-" + uuid.uuid4().hex, caller_uid=_uid("applicant"))

    entries = [d.to_dict() for d in db.collection("accessAuditLog").stream()]
    assert not any(e.get("action") == "request_membership_denied" for e in entries)
