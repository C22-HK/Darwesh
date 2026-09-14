# Proves app.brokerage.brokerage_ops.BrokerageOps against a REAL
# Firestore emulator -- the admin-only write path, the disable/enable
# percent-preservation contract, the immutability of a recorded fee
# snapshot, and the audit trail can't be meaningfully proven against a
# fake/mock. Skipped automatically when no emulator is reachable, same
# convention as test_alerts_ops.py/test_arena_ops.py:
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_brokerage_ops.py
from __future__ import annotations

import os
import uuid

import pytest

from app.access.errors import NotFoundError, ValidationError
from app.brokerage import model
from app.brokerage.brokerage_ops import BrokerageOps

pytestmark = pytest.mark.skipif(
    not os.environ.get("FIRESTORE_EMULATOR_HOST"),
    reason="requires a local Firestore emulator (set FIRESTORE_EMULATOR_HOST)",
)

ADMIN_UID = "admin-" + uuid.uuid4().hex[:8]
ADMIN_ROLE = "admin"


@pytest.fixture(scope="module")
def db():
    from google.cloud import firestore

    return firestore.Client(project="demo-darwesh")


@pytest.fixture()
def ops(db):
    return BrokerageOps(db)


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _seed_user(
    db, uid: str, *, role: str = "customer", account_type: str = "individual_customer", **overrides
) -> None:
    doc = {"role": role, "accountType": account_type, "displayName": f"Test {uid}", "city": "Erbil"}
    doc.update(overrides)
    db.collection("users").document(uid).set(doc)


# ---- model.py pure functions ----------------------------------------------


def test_is_valid_percent_bounds():
    assert model.is_valid_percent(0) is True
    assert model.is_valid_percent(100) is True
    assert model.is_valid_percent(30.5) is True
    assert model.is_valid_percent(-1) is False
    assert model.is_valid_percent(101) is False
    assert model.is_valid_percent("30") is False
    assert model.is_valid_percent(True) is False
    assert model.is_valid_percent(None) is False


def test_effective_percent_disabled_is_zero_and_preserves_nothing_itself():
    assert model.effective_percent(30, True) == 30
    assert model.effective_percent(30, False) == 0
    assert model.effective_percent(None, True) == 0
    assert model.effective_percent(0, True) == 0


def test_compute_discount_worked_example():
    discount_amount, final_fee = model.compute_discount(1000.0, 30.0)
    assert discount_amount == 300.0
    assert final_fee == 700.0


def test_compute_discount_rounds_to_two_decimals():
    discount_amount, final_fee = model.compute_discount(99.99, 33.0)
    assert discount_amount == round(99.99 * 0.33, 2)
    assert final_fee == round(99.99 - discount_amount, 2)


# ---- set_discount: validation -----------------------------------------------


async def test_set_discount_rejects_negative_percent(ops):
    with pytest.raises(ValidationError):
        await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=_uid("u"), percent=-1)


async def test_set_discount_rejects_percent_over_100(ops):
    with pytest.raises(ValidationError):
        await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=_uid("u"), percent=101)


async def test_set_discount_rejects_non_numeric_percent(ops):
    with pytest.raises(ValidationError):
        await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=_uid("u"), percent="30")


async def test_set_discount_rejects_target_that_does_not_exist(ops):
    with pytest.raises(NotFoundError):
        await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=_uid("ghost"), percent=10)


async def test_set_discount_rejects_admin_target(db, ops):
    target = _uid("admintarget")
    _seed_user(db, target, role="admin", account_type="admin")
    with pytest.raises(ValidationError, match="admin accounts"):
        await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=10)


# ---- set_discount / get_account_discount roundtrip --------------------------


async def test_set_discount_and_get_roundtrip(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    result = await ops.set_discount(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=30, reason="loyal customer"
    )
    assert result == {"uid": target, "discountPercent": 30, "discountActive": True}

    account = await ops.get_account_discount(uid=target)
    assert account["discountPercent"] == 30
    assert account["discountActive"] is True
    assert account["effectiveDiscountPercent"] == 30
    assert account["discountUpdatedBy"] == ADMIN_UID
    assert account["discountUpdatedAt"] is not None


async def test_get_account_discount_never_configured_is_null(db, ops):
    target = _uid("fresh")
    _seed_user(db, target)
    account = await ops.get_account_discount(uid=target)
    assert account["discountPercent"] is None
    assert account["discountActive"] is None
    assert account["effectiveDiscountPercent"] == 0


# ---- disable / enable: percent preservation ----------------------------------


async def test_disable_preserves_percent_and_enable_restores_it_exactly(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=30)

    disabled = await ops.disable_discount(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, reason="fraud review"
    )
    assert disabled["discountPercent"] == 30
    assert disabled["discountActive"] is False
    account = await ops.get_account_discount(uid=target)
    assert account["discountPercent"] == 30
    assert account["discountActive"] is False
    assert account["effectiveDiscountPercent"] == 0

    enabled = await ops.enable_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target)
    assert enabled["discountPercent"] == 30
    assert enabled["discountActive"] is True
    account = await ops.get_account_discount(uid=target)
    assert account["effectiveDiscountPercent"] == 30


async def test_disable_rejects_account_with_no_discount_configured(db, ops):
    target = _uid("never")
    _seed_user(db, target)
    with pytest.raises(ValidationError):
        await ops.disable_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target)


# ---- remove_discount ----------------------------------------------------------


async def test_remove_discount_sets_explicit_zero_and_inactive(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=20)
    removed = await ops.remove_discount(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, reason="no longer eligible"
    )
    assert removed == {"uid": target, "discountPercent": 0, "discountActive": False}
    account = await ops.get_account_discount(uid=target)
    assert account["discountPercent"] == 0
    assert account["discountActive"] is False


# ---- bulk_set_discount: partial failure is visible, never silent -----------


async def test_bulk_set_discount_reports_per_uid_success_and_failure(db, ops):
    good = _uid("bulkgood")
    _seed_user(db, good)
    ghost = _uid("bulkghost")  # never seeded -- must fail, not be silently dropped

    result = await ops.bulk_set_discount(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uids=[good, ghost], percent=20, reason="spring promo"
    )
    results_by_uid = {r["uid"]: r for r in result["results"]}
    assert len(result["results"]) == 2
    assert results_by_uid[good]["ok"] is True
    assert "error" not in results_by_uid[good]
    assert results_by_uid[ghost]["ok"] is False
    assert results_by_uid[ghost].get("error")

    account = await ops.get_account_discount(uid=good)
    assert account["discountPercent"] == 20


async def test_bulk_set_discount_rejects_empty_or_oversized_list(ops):
    with pytest.raises(ValidationError):
        await ops.bulk_set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uids=[], percent=10)
    with pytest.raises(ValidationError):
        await ops.bulk_set_discount(
            admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uids=[_uid("x") for _ in range(101)], percent=10
        )


# ---- brokerageDiscountHistory: correct previous/new values ------------------


async def test_history_entries_carry_correct_previous_and_new_values(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    await ops.set_discount(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=10, reason="first set"
    )
    await ops.set_discount(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=25, reason="bumped up"
    )

    rows = await ops.list_history(uid=target)
    assert len(rows) == 2
    newest, oldest = rows[0], rows[1]
    assert oldest["previousPercent"] is None
    assert oldest["previousActive"] is None
    assert oldest["newPercent"] == 10
    assert oldest["newActive"] is True
    assert oldest["reason"] == "first set"
    assert oldest["changedBy"] == ADMIN_UID
    assert oldest["action"] == "set"
    assert newest["previousPercent"] == 10
    assert newest["newPercent"] == 25
    assert newest["reason"] == "bumped up"


async def test_history_records_disable_and_enable_actions(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=15)
    await ops.disable_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, reason="pause")
    await ops.enable_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, reason="resume")

    rows = await ops.list_history(uid=target)
    actions = [r["action"] for r in rows]
    assert actions[:2] == ["enable", "disable"]  # newest first
    disable_row = rows[1]
    assert disable_row["previousActive"] is True
    assert disable_row["newActive"] is False
    assert disable_row["previousPercent"] == 15
    assert disable_row["newPercent"] == 15
    enable_row = rows[0]
    assert enable_row["previousActive"] is False
    assert enable_row["newActive"] is True


# ---- accessAuditLog: every history entry has a matching audit entry ---------


async def test_set_discount_writes_a_matching_access_audit_log_entry(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=5)

    docs = list(
        db.collection("accessAuditLog")
        .where("targetType", "==", "brokerageDiscount")
        .where("targetId", "==", target)
        .stream()
    )
    assert len(docs) == 1
    entry = docs[0].to_dict()
    assert entry["adminUid"] == ADMIN_UID
    assert entry["action"] == "brokerage_discount_set"
    assert entry["result"] == "success"
    assert entry["newValue"] == 5


# ---- compute_fee: arithmetic + immutable snapshot ----------------------------


async def test_compute_fee_matches_worked_example(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=30)

    result = await ops.compute_fee(admin_uid=ADMIN_UID, target_uid=target, original_fee=1000, currency="USD")
    assert result["discountPercent"] == 30
    assert result["discountAmount"] == 300.0
    assert result["finalFee"] == 700.0
    assert "snapshotId" not in result  # record defaults to False


async def test_compute_fee_snapshot_is_immutable_after_the_discount_changes(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=30)

    recorded = await ops.compute_fee(
        admin_uid=ADMIN_UID, target_uid=target, original_fee=1000, currency="USD", record=True, note="deal preview"
    )
    snapshot_id = recorded["snapshotId"]
    assert recorded["discountAmount"] == 300.0
    assert recorded["finalFee"] == 700.0

    # Change the account's discount AFTER the snapshot was recorded.
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=5)
    account = await ops.get_account_discount(uid=target)
    assert account["discountPercent"] == 5  # sanity: the account really did change

    # The snapshot doc, read directly, must still show the ORIGINAL figures.
    snap = db.collection(model.BROKERAGE_FEE_SNAPSHOTS).document(snapshot_id).get()
    assert snap.exists
    data = snap.to_dict()
    assert data["discountPercent"] == 30
    assert data["discountAmount"] == 300.0
    assert data["finalFee"] == 700.0
    assert data["note"] == "deal preview"


async def test_compute_fee_rejects_negative_fee_and_unsupported_currency(db, ops):
    target = _uid("owner")
    _seed_user(db, target)
    with pytest.raises(ValidationError):
        await ops.compute_fee(admin_uid=ADMIN_UID, target_uid=target, original_fee=-1, currency="USD")
    with pytest.raises(ValidationError):
        await ops.compute_fee(admin_uid=ADMIN_UID, target_uid=target, original_fee=1000, currency="EUR")


# ---- list_accounts: admin accounts are excluded, filters apply --------------


async def test_list_accounts_excludes_admin_role_and_filters_by_no_discount_only(db, ops):
    plain = _uid("listplain")
    discounted = _uid("listdiscounted")
    admin_account = _uid("listadmin")
    _seed_user(db, plain)
    _seed_user(db, discounted)
    _seed_user(db, admin_account, role="admin", account_type="admin")
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=discounted, percent=15)

    res = await ops.list_accounts(no_discount_only=True, limit=100)
    uids = {a["uid"] for a in res["accounts"]}
    assert plain in uids
    assert discounted not in uids
    assert admin_account not in uids
