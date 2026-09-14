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
from datetime import UTC, datetime

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


def _seed_company(db, company_id: str, *, city: str) -> None:
    db.collection("companies").document(company_id).set({"city": city})


def _seed_organization(db, org_id: str, *, city: str) -> None:
    db.collection("organizations").document(org_id).set({"city": city})


def _fresh_city() -> str:
    """This suite shares one emulator Firestore project across every test
    and never deletes a policy it creates, so a city-scoped policy test
    must use its own unique city string rather than a shared literal like
    "Erbil" -- otherwise two tests' policies could collide, exactly like
    test_alerts_ops.py's _fresh_geo() for areaAlerts."""
    return f"city-{uuid.uuid4().hex[:10]}"


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


# ---- Phase 2: policy engine -- model.py pure functions -----------------------


def test_effective_policy_state_transitions():
    now = datetime(2026, 6, 15, 12, 0, tzinfo=UTC)
    assert model.effective_policy_state(None, now) == "archived"
    assert model.effective_policy_state({"status": "draft"}, now) == "draft"
    assert model.effective_policy_state({"status": "paused"}, now) == "paused"
    assert model.effective_policy_state({"status": "archived"}, now) == "archived"
    assert model.effective_policy_state({"status": "not-a-real-status"}, now) == "draft"
    assert (
        model.effective_policy_state({"status": "active", "startAt": datetime(2026, 6, 20, tzinfo=UTC)}, now)
        == "scheduled"
    )
    # endAt is exclusive: over at exactly endAt, not a millisecond later --
    # same convention as js/offers.js's effectiveState().
    assert (
        model.effective_policy_state({"status": "active", "endAt": datetime(2026, 6, 15, 12, 0, tzinfo=UTC)}, now)
        == "expired"
    )
    assert (
        model.effective_policy_state(
            {"status": "active", "endAt": datetime(2026, 6, 15, 12, 0, 1, tzinfo=UTC)}, now
        )
        == "active"
    )
    assert model.effective_policy_state({"status": "active"}, now) == "active"


def test_match_best_policy_specificity_beats_recency():
    now = datetime(2026, 6, 15, tzinfo=UTC)
    wildcard = {"id": "p-wild", "status": "active", "percent": 5, "updatedAt": datetime(2026, 1, 5, tzinfo=UTC)}
    role_only = {
        "id": "p-role",
        "status": "active",
        "accountType": "real_estate_agent",
        "percent": 10,
        "updatedAt": datetime(2026, 1, 4, tzinfo=UTC),
    }
    city_only = {
        "id": "p-city",
        "status": "active",
        "city": "Erbil",
        "percent": 12,
        "updatedAt": datetime(2026, 1, 3, tzinfo=UTC),
    }
    both = {
        "id": "p-both",
        "status": "active",
        "accountType": "real_estate_agent",
        "city": "Erbil",
        "percent": 20,
        "updatedAt": datetime(2026, 1, 1, tzinfo=UTC),  # oldest of the four -- specificity still wins
    }
    winner = model.match_best_policy(
        [wildcard, role_only, city_only, both], account_type="real_estate_agent", city="Erbil", now=now
    )
    assert winner["id"] == "p-both"


def test_match_best_policy_recency_tiebreaks_equal_specificity():
    now = datetime(2026, 6, 15, tzinfo=UTC)
    older = {
        "id": "p-old",
        "status": "active",
        "accountType": "real_estate_agent",
        "percent": 8,
        "updatedAt": datetime(2026, 1, 1, tzinfo=UTC),
    }
    newer = {
        "id": "p-new",
        "status": "active",
        "accountType": "real_estate_agent",
        "percent": 9,
        "updatedAt": datetime(2026, 1, 5, tzinfo=UTC),
    }
    winner = model.match_best_policy([older, newer], account_type="real_estate_agent", city=None, now=now)
    assert winner["id"] == "p-new"
    # No stacking: match_best_policy always returns exactly one policy (or
    # None), never a combined/summed percent across several matches.
    assert winner["percent"] == 9


def test_match_best_policy_city_scoped_never_matches_unresolvable_city():
    now = datetime(2026, 6, 15, tzinfo=UTC)
    city_policy = {"id": "p-city", "status": "active", "city": "Erbil", "percent": 15, "updatedAt": now}
    assert model.match_best_policy([city_policy], account_type="individual_customer", city=None, now=now) is None
    assert (
        model.match_best_policy([city_policy], account_type="individual_customer", city="Erbil", now=now)
        is not None
    )
    assert (
        model.match_best_policy([city_policy], account_type="individual_customer", city="Sulaymaniyah", now=now)
        is None
    )


def test_match_best_policy_ignores_non_active_effective_state():
    now = datetime(2026, 6, 15, tzinfo=UTC)
    paused = {"id": "p-paused", "status": "paused", "percent": 50, "updatedAt": now}
    scheduled = {
        "id": "p-sched",
        "status": "active",
        "startAt": datetime(2026, 7, 1, tzinfo=UTC),
        "percent": 50,
        "updatedAt": now,
    }
    expired = {
        "id": "p-expired",
        "status": "active",
        "endAt": datetime(2026, 1, 1, tzinfo=UTC),
        "percent": 50,
        "updatedAt": now,
    }
    assert model.match_best_policy([paused, scheduled, expired], account_type=None, city=None, now=now) is None


# ---- Phase 2: policy CRUD -- transactional + versioned history + audit ------


async def test_create_policy_writes_history_and_audit(db, ops):
    # status='draft', not 'active' -- this test's own concern is the
    # create/history/audit write path, not matching, and an unscoped
    # ACTIVE role-only policy left active forever would match every
    # real_estate_agent account with no override for the rest of this
    # shared-emulator suite (see _fresh_city()'s docstring).
    policy = await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="Agents 10%",
        account_type="real_estate_agent",
        city=None,
        percent=10,
        status="draft",
        reason="launch",
    )
    assert policy["percent"] == 10
    assert policy["accountType"] == "real_estate_agent"
    assert policy["status"] == "draft"

    rows = await ops.list_policy_history(policy_id=policy["id"])
    assert len(rows) == 1
    assert rows[0]["action"] == "create"
    assert rows[0]["reason"] == "launch"

    docs = list(
        db.collection("accessAuditLog")
        .where("targetType", "==", "brokerageDiscountPolicy")
        .where("targetId", "==", policy["id"])
        .stream()
    )
    assert len(docs) == 1
    assert docs[0].to_dict()["action"] == "brokerage_policy_create"


async def test_create_policy_rejects_invalid_fields(ops):
    with pytest.raises(ValidationError):
        await ops.create_policy(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, name="", percent=10)
    with pytest.raises(ValidationError):
        await ops.create_policy(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, name="x", percent=200)
    with pytest.raises(ValidationError):
        await ops.create_policy(
            admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, name="x", percent=10, account_type="not_a_real_type"
        )
    with pytest.raises(ValidationError):
        await ops.create_policy(
            admin_uid=ADMIN_UID,
            admin_role=ADMIN_ROLE,
            name="x",
            percent=10,
            start_at="2026-06-20T00:00:00Z",
            end_at="2026-06-10T00:00:00Z",
        )


async def test_update_policy_versions_history_with_previous_values(ops):
    # status stays 'draft' throughout -- an unscoped ACTIVE policy would
    # match every no-override account for the rest of this shared-emulator
    # suite (see _fresh_city()'s docstring); this test's own concern is
    # the update/versioning write path, not matching.
    policy = await ops.create_policy(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, name="Initial", percent=5, status="draft"
    )
    updated = await ops.update_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        policy_id=policy["id"],
        name="Renamed",
        account_type=None,
        city=None,
        percent=15,
        status="draft",
        start_at=None,
        end_at=None,
        reason="raise",
    )
    assert updated["percent"] == 15
    assert updated["name"] == "Renamed"

    rows = await ops.list_policy_history(policy_id=policy["id"])
    assert rows[0]["action"] == "update"
    assert rows[0]["previousValue"]["percent"] == 5
    assert rows[0]["newValue"]["percent"] == 15


async def test_update_policy_rejects_unknown_policy(ops):
    with pytest.raises(NotFoundError):
        await ops.update_policy(
            admin_uid=ADMIN_UID,
            admin_role=ADMIN_ROLE,
            policy_id="does-not-exist",
            name="x",
            account_type=None,
            city=None,
            percent=10,
            status="draft",
            start_at=None,
            end_at=None,
        )


async def test_set_policy_status_transitions_and_versions_history(ops):
    policy = await ops.create_policy(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, name="Toggle", percent=10, status="draft"
    )
    activated = await ops.set_policy_status(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, policy_id=policy["id"], status="active"
    )
    assert activated["status"] == "active"
    paused = await ops.set_policy_status(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, policy_id=policy["id"], status="paused", reason="review"
    )
    assert paused["status"] == "paused"

    rows = await ops.list_policy_history(policy_id=policy["id"])
    assert [r["action"] for r in rows[:2]] == ["status_change", "status_change"]
    assert rows[0]["previousValue"] == "active"
    assert rows[0]["newValue"] == "paused"


async def test_list_policies_orders_by_recency_and_filters_by_status(ops):
    # status='paused' here, deliberately never 'active' with no scope --
    # an unscoped active policy would match every no-override account for
    # the rest of this shared-emulator suite (see _fresh_city()'s docstring
    # for why tests here avoid unscoped shared state).
    p1 = await ops.create_policy(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, name="P1", percent=5, status="draft")
    p2 = await ops.create_policy(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, name="P2", percent=5, status="paused")
    result = await ops.list_policies(status="paused", limit=50)
    ids = {p["id"] for p in result["policies"]}
    assert p2["id"] in ids
    assert p1["id"] not in ids


# ---- Phase 2: precedence -- override always wins, policy is a fallback ------


async def test_get_account_discount_override_always_wins_over_policy(db, ops):
    # Scoped to a fresh unique city (see _fresh_city()'s docstring) so this
    # test's own active policy can never bleed into another test's "no
    # match" assertion for the rest of this shared-emulator suite.
    city = _fresh_city()
    company_id = _uid("company")
    _seed_company(db, company_id, city=city)
    target = _uid("agent")
    _seed_user(db, target, account_type="real_estate_agent", companyId=company_id)
    await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="Agents 10%",
        account_type="real_estate_agent",
        city=city,
        percent=10,
        status="active",
    )
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target, percent=25)

    account = await ops.get_account_discount(uid=target)
    assert account["effectiveDiscountPercent"] == 25
    assert account["discountSource"] == "override"

    # Even a DISABLED override still beats the policy -- an explicit "no
    # discount" is an admin choice, never a gap for a policy to fill.
    await ops.disable_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=target)
    account = await ops.get_account_discount(uid=target)
    assert account["effectiveDiscountPercent"] == 0
    assert account["discountSource"] == "override"


async def test_get_account_discount_falls_back_to_best_matching_policy(db, ops):
    # Scoped to BOTH accountType and a fresh unique city (specificity 2) --
    # the highest specificity always beats any role-only/wildcard policy a
    # different test in this shared-emulator suite may have left active,
    # and the unique city means no other test's policy can ever collide
    # with this one (see _fresh_city()).
    city = _fresh_city()
    company_id = _uid("company")
    _seed_company(db, company_id, city=city)
    target = _uid("agent")
    _seed_user(db, target, account_type="real_estate_agent", companyId=company_id)
    policy = await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="Agents 10%",
        account_type="real_estate_agent",
        city=city,
        percent=10,
        status="active",
    )
    account = await ops.get_account_discount(uid=target)
    assert account["effectiveDiscountPercent"] == 10
    assert account["discountSource"] == "policy"
    assert account["policyId"] == policy["id"]
    assert account["policyName"] == "Agents 10%"


async def test_get_account_discount_policy_effect_changes_live_with_status(db, ops):
    city = _fresh_city()
    company_id = _uid("company")
    _seed_company(db, company_id, city=city)
    target = _uid("agent")
    _seed_user(db, target, account_type="real_estate_agent", companyId=company_id)
    policy = await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="Agents 10%",
        account_type="real_estate_agent",
        city=city,
        percent=10,
        status="active",
    )
    account = await ops.get_account_discount(uid=target)
    assert account["effectiveDiscountPercent"] == 10

    await ops.set_policy_status(
        admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, policy_id=policy["id"], status="paused"
    )
    account = await ops.get_account_discount(uid=target)
    assert account["effectiveDiscountPercent"] == 0
    assert account["discountSource"] == "none"


async def test_get_account_discount_resolves_city_via_company_then_organization(db, ops):
    company_city = _fresh_city()
    company_id = _uid("company")
    _seed_company(db, company_id, city=company_city)
    via_company = _uid("agentwithcompany")
    _seed_user(db, via_company, account_type="real_estate_agent", companyId=company_id)

    # A different accountType than the company-linked account above, and one
    # no other Phase 2 test in this file scopes a role-only policy to --
    # isolates this assertion from any stray "real_estate_agent" leftover.
    org_city = _fresh_city()
    org_id = _uid("org")
    _seed_organization(db, org_id, city=org_city)
    via_org = _uid("agentwithorg")
    _seed_user(db, via_org, account_type="office_owner", activeOrganizationId=org_id)

    await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="City campaign",
        city=company_city,
        percent=15,
        status="active",
    )

    account = await ops.get_account_discount(uid=via_company)
    assert account["effectiveDiscountPercent"] == 15
    assert account["discountSource"] == "policy"

    account_org = await ops.get_account_discount(uid=via_org)
    assert account_org["effectiveDiscountPercent"] == 0  # org_city, not company_city -- no match
    assert account_org["discountSource"] == "none"


async def test_get_account_discount_no_resolvable_city_never_matches_city_scoped_policy(db, ops):
    target = _uid("nocitycustomer")
    _seed_user(db, target, account_type="individual_customer")
    await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="City campaign",
        city=_fresh_city(),
        percent=15,
        status="active",
    )
    account = await ops.get_account_discount(uid=target)
    assert account["effectiveDiscountPercent"] == 0
    assert account["discountSource"] == "none"


async def test_compute_fee_reflects_policy_derived_percent_when_no_override(db, ops):
    city = _fresh_city()
    company_id = _uid("company")
    _seed_company(db, company_id, city=city)
    target = _uid("agent")
    _seed_user(db, target, account_type="real_estate_agent", companyId=company_id)
    await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="Agents 10%",
        account_type="real_estate_agent",
        city=city,
        percent=10,
        status="active",
    )
    result = await ops.compute_fee(admin_uid=ADMIN_UID, target_uid=target, original_fee=1000, currency="USD")
    assert result["discountPercent"] == 10
    assert result["discountAmount"] == 100.0
    assert result["finalFee"] == 900.0
    assert result["discountSource"] == "policy"


# ---- Phase 2: preview_policy_matches is read-only ----------------------------


async def test_preview_policy_matches_never_writes_and_excludes_overridden_accounts(db, ops):
    no_override = _uid("previewagent")
    _seed_user(db, no_override, account_type="real_estate_agent")
    with_override = _uid("previewagentoverride")
    _seed_user(db, with_override, account_type="real_estate_agent")
    await ops.set_discount(admin_uid=ADMIN_UID, admin_role=ADMIN_ROLE, target_uid=with_override, percent=50)
    non_agent = _uid("previewcustomer")
    _seed_user(db, non_agent, account_type="individual_customer")

    result = await ops.preview_policy_matches(account_type="real_estate_agent", percent=10)
    uids = {a["uid"] for a in result["accounts"]}
    assert no_override in uids
    assert with_override not in uids  # has an explicit override -- never affected by any policy
    assert non_agent not in uids

    # Read-only: the previewed account's own stored discount is untouched.
    account = await ops.get_account_discount(uid=no_override)
    assert account["discountPercent"] is None


async def test_preview_policy_matches_excludes_the_policy_being_edited(db, ops):
    city = _fresh_city()
    company_id = _uid("company")
    _seed_company(db, company_id, city=city)
    target = _uid("previewexclude")
    _seed_user(db, target, account_type="real_estate_agent", companyId=company_id)
    policy = await ops.create_policy(
        admin_uid=ADMIN_UID,
        admin_role=ADMIN_ROLE,
        name="Agents 10%",
        account_type="real_estate_agent",
        city=city,
        percent=10,
        status="active",
    )
    result = await ops.preview_policy_matches(
        account_type="real_estate_agent", percent=20, exclude_policy_id=policy["id"]
    )
    uids = {a["uid"] for a in result["accounts"]}
    assert target in uids
