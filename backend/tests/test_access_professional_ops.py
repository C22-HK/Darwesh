# Proves app.access.professional_ops.ProfessionalOps against a REAL
# Firestore emulator -- same rationale as test_access_organization_ops.py.
# ProfessionalOps has no create_provider method (serviceProviders creation
# is an existing, working, rules-enforced direct-client path -- see
# firestore.rules:1180-1198 and professional_ops.py's header), so these
# tests seed a serviceProviders document directly rather than through ops.
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_access_professional_ops.py
from __future__ import annotations

import os
import time
import uuid

import pytest

from app.access.errors import ForbiddenError, NotFoundError, ValidationError
from app.access.professional_ops import ProfessionalOps

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
    return ProfessionalOps(db)


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _seed_provider(db, *, owner_uid: str, service_type: str = "engineer") -> str:
    provider_ref = db.collection("serviceProviders").document(owner_uid)
    provider_ref.set(
        {
            "serviceType": service_type,
            "providerType": "individual",
            "ownerId": owner_uid,
            "displayName": "Test Professional",
            "verified": False,
            "createdAt": time.time(),
            "updatedAt": time.time(),
        }
    )
    return provider_ref.id


def _audit_entries(db, *, target_id: str) -> list[dict]:
    return [d.to_dict() for d in db.collection("accessAuditLog").where("targetId", "==", target_id).stream()]


# ---- set_status -----------------------------------------------------------


async def test_set_status_requires_admin_no_self_verification(db, ops):
    owner = _uid("engineer")
    provider_id = _seed_provider(db, owner_uid=owner)

    with pytest.raises(ForbiddenError):
        await ops.set_status(
            provider_id=provider_id, new_status="active", reason=None, caller_uid=owner, caller_is_admin=False
        )

    provider = db.collection("serviceProviders").document(provider_id).get()
    assert provider.get("status") is None  # the professional's own attempt never wrote anything


async def test_set_status_admin_approve_writes_status_and_audit(db, ops):
    owner = _uid("engineer")
    admin = _uid("admin")
    provider_id = _seed_provider(db, owner_uid=owner)

    await ops.set_status(
        provider_id=provider_id, new_status="active", reason=None, caller_uid=admin, caller_is_admin=True
    )

    provider = db.collection("serviceProviders").document(provider_id).get()
    assert provider.get("status") == "active"
    assert provider.get("statusUpdatedBy") == admin

    entries = _audit_entries(db, target_id=provider_id)
    assert any(
        e["action"] == "provider_status_changed" and e["adminUid"] == admin and e["newValue"] == "active"
        for e in entries
    )


async def test_set_status_reject_requires_reason(db, ops):
    owner = _uid("engineer")
    admin = _uid("admin")
    provider_id = _seed_provider(db, owner_uid=owner)

    with pytest.raises(ValidationError):
        await ops.set_status(
            provider_id=provider_id, new_status="rejected", reason=None, caller_uid=admin, caller_is_admin=True
        )


async def test_set_status_reject_with_reason_records_it(db, ops):
    owner = _uid("engineer")
    admin = _uid("admin")
    provider_id = _seed_provider(db, owner_uid=owner)

    await ops.set_status(
        provider_id=provider_id,
        new_status="rejected",
        reason="License number could not be confirmed.",
        caller_uid=admin,
        caller_is_admin=True,
    )

    provider = db.collection("serviceProviders").document(provider_id).get()
    assert provider.get("status") == "rejected"
    assert provider.get("rejectionReason") == "License number could not be confirmed."


async def test_set_status_rejects_unknown_status(db, ops):
    owner = _uid("engineer")
    admin = _uid("admin")
    provider_id = _seed_provider(db, owner_uid=owner)
    with pytest.raises(ValidationError):
        await ops.set_status(
            provider_id=provider_id, new_status="banned", reason=None, caller_uid=admin, caller_is_admin=True
        )


async def test_set_status_missing_provider_raises_not_found(ops):
    with pytest.raises(NotFoundError):
        await ops.set_status(
            provider_id=_uid("missing"),
            new_status="active",
            reason=None,
            caller_uid=_uid("admin"),
            caller_is_admin=True,
        )


# ---- set_verified -----------------------------------------------------


async def test_set_verified_requires_admin_and_blocks_self_verification(db, ops):
    """The core security requirement this whole module exists for:
    'do not let professionals approve or verify themselves' -- proven
    here structurally (caller_is_admin=False is rejected even when the
    caller IS the provider's own owner)."""
    owner = _uid("engineer")
    provider_id = _seed_provider(db, owner_uid=owner)

    with pytest.raises(ForbiddenError):
        await ops.set_verified(provider_id=provider_id, verified=True, caller_uid=owner, caller_is_admin=False)

    provider = db.collection("serviceProviders").document(provider_id).get()
    assert provider.get("verified") is False


async def test_set_verified_admin_writes_flag_and_audit(db, ops):
    owner = _uid("engineer")
    admin = _uid("admin")
    provider_id = _seed_provider(db, owner_uid=owner)

    await ops.set_verified(provider_id=provider_id, verified=True, caller_uid=admin, caller_is_admin=True)

    provider = db.collection("serviceProviders").document(provider_id).get()
    assert provider.get("verified") is True

    entries = _audit_entries(db, target_id=provider_id)
    assert any(e["action"] == "provider_verified" and e["adminUid"] == admin and e["newValue"] is True for e in entries)


async def test_set_verified_missing_provider_raises_not_found(ops):
    with pytest.raises(NotFoundError):
        await ops.set_verified(
            provider_id=_uid("missing"), verified=True, caller_uid=_uid("admin"), caller_is_admin=True
        )
