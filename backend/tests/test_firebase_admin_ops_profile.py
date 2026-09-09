"""U1: FirebaseAccountOps.create_user_profile must write the private
fields (email, phone, verification flags) to users/{uid}/privateProfile/main
and NEVER onto the world-readable users/{uid} document -- in one batch, so
the two documents exist together or not at all. Exercised against a fake
Firestore client (no Admin app is initialised), so it runs everywhere."""

from __future__ import annotations

import asyncio

from app.otp.firebase_admin_ops import (
    PRIVATE_PROFILE_COLLECTION,
    PRIVATE_PROFILE_DOC,
    PRIVATE_PROFILE_FIELDS,
    FirebaseAccountOps,
)


class _Doc:
    def __init__(self, path: str) -> None:
        self.path = path

    def collection(self, name: str) -> _Coll:
        return _Coll(f"{self.path}/{name}")


class _Coll:
    def __init__(self, path: str) -> None:
        self.path = path

    def document(self, doc_id: str) -> _Doc:
        return _Doc(f"{self.path}/{doc_id}")


class _Batch:
    def __init__(self) -> None:
        self.sets: list[tuple[str, dict]] = []
        self.committed = False

    def set(self, ref: _Doc, data: dict) -> None:
        assert not self.committed, "set() after commit()"
        self.sets.append((ref.path, dict(data)))

    def commit(self) -> None:
        self.committed = True


class _Db:
    def __init__(self) -> None:
        self.batches: list[_Batch] = []
        self.direct_sets: list[tuple[str, dict]] = []

    def collection(self, name: str) -> _Coll:
        return _Coll(name)

    def batch(self) -> _Batch:
        b = _Batch()
        self.batches.append(b)
        return b


def _ops_with(db: _Db) -> FirebaseAccountOps:
    ops = FirebaseAccountOps.__new__(FirebaseAccountOps)  # skip Admin-app init
    ops._db = db
    return ops


def test_create_user_profile_splits_private_fields_into_the_private_subdocument():
    db = _Db()
    ops = _ops_with(db)
    asyncio.run(
        ops.create_user_profile(
            "uid-1",
            display_name="Ahmed Darwesh",
            email="ahmed@example.com",
            phone_e164="+9647501234567",
            requested_role="agent",
            requested_company_id="acme",
            requested_company_name="Acme",
            account_type="real_estate_agent",
        )
    )
    assert len(db.batches) == 1 and db.batches[0].committed
    writes = dict(db.batches[0].sets)
    assert set(writes) == {"users/uid-1", f"users/uid-1/{PRIVATE_PROFILE_COLLECTION}/{PRIVATE_PROFILE_DOC}"}

    public = writes["users/uid-1"]
    for field in PRIVATE_PROFILE_FIELDS:
        assert field not in public, f"{field} must not be on the public document"
    assert public["displayName"] == "Ahmed Darwesh"
    assert public["role"] == "customer"
    assert public["requestedRole"] == "agent"
    assert public["requestedCompanyId"] == "acme"
    assert public["accountType"] == "real_estate_agent"

    private = writes[f"users/uid-1/{PRIVATE_PROFILE_COLLECTION}/{PRIVATE_PROFILE_DOC}"]
    assert private["email"] == "ahmed@example.com"
    assert private["phone"] == "+9647501234567"
    assert private["phoneVerified"] is True and private["emailVerified"] is True
    assert "role" not in private and "displayName" not in private


def test_create_user_profile_omits_account_type_when_not_given():
    db = _Db()
    ops = _ops_with(db)
    asyncio.run(
        ops.create_user_profile("uid-2", display_name="X", email="x@example.com", phone_e164="+9647500000000")
    )
    public = dict(db.batches[0].sets)["users/uid-2"]
    assert "accountType" not in public
