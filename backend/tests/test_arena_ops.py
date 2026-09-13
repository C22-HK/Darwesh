# Proves app.arena.arena_ops.ArenaOps against a REAL Firestore emulator --
# the Step Engine's server-side transitions, award-once idempotency,
# points-recompute-from-ledger, and the buyer/deal CRM's admin-only
# stage gating can't be meaningfully proven against a fake/mock. Skipped
# automatically when no emulator is reachable, same convention as
# test_access_organization_ops.py:
#
#   firebase emulators:start --only firestore --project demo-darwesh
#   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pytest tests/test_arena_ops.py
from __future__ import annotations

import os
import uuid

import pytest

from app.access.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from app.arena import model
from app.arena.arena_ops import ArenaOps

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
    return ArenaOps(db)


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


ADMIN_UID = "test-admin"

# The user's own real-estate example flow (see model.py's module
# docstring): Join -> Submission -> Verification[admin,+3] -> Sale[admin,+11].
# Deliberately just DATA -- nothing about this flow is special-cased
# anywhere in arena_ops.py.
REAL_ESTATE_STEPS = [
    {
        "key": "join",
        "name": "Join",
        "description": "Accept the rules",
        "requiredAction": "Accept the challenge rules",
        "requiredVerificationBy": "none",
        "points": 0,
        "optional": False,
        "unlockAfterStepKey": None,
    },
    {
        "key": "submission",
        "name": "Submit a property",
        "description": "Attach a real property",
        "requiredAction": "Submit a property you have rights to market",
        "requiredVerificationBy": "none",
        "points": 0,
        "optional": False,
        "unlockAfterStepKey": "join",
    },
    {
        "key": "verification",
        "name": "Verification",
        "description": "Admin verifies the property",
        "requiredAction": "Wait for admin verification",
        "requiredVerificationBy": "admin",
        "points": 3,
        "optional": False,
        "unlockAfterStepKey": "submission",
    },
    {
        "key": "sale",
        "name": "Sale",
        "description": "Admin verifies the closed sale",
        "requiredAction": "Close a real transaction",
        "requiredVerificationBy": "admin",
        "points": 11,
        "optional": False,
        "unlockAfterStepKey": "verification",
    },
]


async def _create_challenge(ops, *, steps=None, unlock_requirements=None, status="live"):
    data = {
        "name": "Kurdistan Property Challenge",
        "category": "residential",
        "difficulty": "medium",
        "status": status,
        "steps": steps if steps is not None else REAL_ESTATE_STEPS,
        "completionReward": {
            "points": 5,
            "badge": {"id": "deal_maker", "name": "Deal Maker"},
            "certificate": False,
            "rankBonusXp": 0,
        },
        "unlockRequirements": unlock_requirements or {},
        "mainPrize": "3000 USD",
    }
    return await ops.create_challenge(data=data, actor_uid=ADMIN_UID, actor_is_admin=True)


def _seed_property(db, prop_id: str) -> dict:
    db.collection("listings").document(prop_id).set({"type": "apartment", "city": "Erbil"})
    return {"collection": "listings", "id": prop_id}


async def _join_and_complete_join_step(ops, challenge_id: str, uid: str) -> str:
    submission_id = (await ops.join_challenge(challenge_id=challenge_id, uid=uid))["submissionId"]
    await ops.advance_step(
        submission_id=submission_id, step_key="join", target_status="completed",
        actor_uid=uid, actor_is_admin=False,
    )
    return submission_id


# ---- join_challenge -------------------------------------------------------


async def test_join_challenge_rejects_when_unlock_requirements_not_met(db, ops):
    challenge_id = await _create_challenge(ops, unlock_requirements={"minXp": 100})
    uid = _uid("user")
    with pytest.raises(ForbiddenError):
        await ops.join_challenge(challenge_id=challenge_id, uid=uid)


async def test_join_challenge_initializes_step_progress_from_challenge_steps(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    result = await ops.join_challenge(challenge_id=challenge_id, uid=uid)

    sub = db.collection(model.ARENA_SUBMISSIONS).document(result["submissionId"]).get()
    assert sub.exists
    data = sub.to_dict()
    assert data["stepProgress"]["join"]["status"] == "available"
    assert data["stepProgress"]["submission"]["status"] == "locked"
    assert data["stepProgress"]["verification"]["status"] == "locked"
    assert data["currentStepKey"] == "join"
    assert data["overallStatus"] == "joined"

    challenge = db.collection(model.ARENA_CHALLENGES).document(challenge_id).get()
    assert challenge.get("participantCount") == 1


async def test_join_challenge_rejects_duplicate_join(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    await ops.join_challenge(challenge_id=challenge_id, uid=uid)
    with pytest.raises(ConflictError):
        await ops.join_challenge(challenge_id=challenge_id, uid=uid)


async def test_join_challenge_rejects_unknown_challenge(db, ops):
    with pytest.raises(NotFoundError):
        await ops.join_challenge(challenge_id="does-not-exist", uid=_uid("user"))


# ---- advance_step (the Step Engine core) -----------------------------------


async def test_advance_step_self_report_completes_none_verification_step(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = (await ops.join_challenge(challenge_id=challenge_id, uid=uid))["submissionId"]

    result = await ops.advance_step(
        submission_id=submission_id, step_key="join", target_status="completed",
        actor_uid=uid, actor_is_admin=False,
    )
    assert result["status"] == "completed"

    sub = db.collection(model.ARENA_SUBMISSIONS).document(submission_id).get().to_dict()
    assert sub["stepProgress"]["join"]["status"] == "completed"
    assert sub["stepProgress"]["submission"]["status"] == "available"


async def test_advance_step_forbids_non_admin_from_completing_admin_gated_step(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = await _join_and_complete_join_step(ops, challenge_id, uid)
    await ops.advance_step(
        submission_id=submission_id, step_key="submission", target_status="completed",
        actor_uid=uid, actor_is_admin=False,
    )

    with pytest.raises(ForbiddenError):
        await ops.advance_step(
            submission_id=submission_id, step_key="verification", target_status="completed",
            actor_uid=uid, actor_is_admin=False,
        )

    # the non-admin path IS allowed to reach 'verification_pending'
    result = await ops.advance_step(
        submission_id=submission_id, step_key="verification", target_status="verification_pending",
        actor_uid=uid, actor_is_admin=False,
    )
    assert result["status"] == "verification_pending"
    assert result["pointsAwarded"] == 0


async def test_advance_step_admin_awards_points_once_and_blocks_double_award(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = await _join_and_complete_join_step(ops, challenge_id, uid)
    await ops.advance_step(
        submission_id=submission_id, step_key="submission", target_status="completed",
        actor_uid=uid, actor_is_admin=False,
    )

    result = await ops.advance_step(
        submission_id=submission_id, step_key="verification", target_status="completed",
        actor_uid=ADMIN_UID, actor_is_admin=True,
    )
    assert result["pointsAwarded"] == 3

    ledger_entries = [
        d.to_dict()
        for d in db.collection(model.ARENA_LEDGER)
        .where("submissionId", "==", submission_id)
        .where("stepKey", "==", "verification")
        .stream()
    ]
    assert len(ledger_entries) == 1
    assert ledger_entries[0]["pointsDelta"] == 3

    # the step is now terminal ('completed' has no outgoing transitions) --
    # the state machine itself is what prevents a double award, not a
    # special-cased re-entrancy guard.
    with pytest.raises(ConflictError):
        await ops.advance_step(
            submission_id=submission_id, step_key="verification", target_status="completed",
            actor_uid=ADMIN_UID, actor_is_admin=True,
        )

    state = await ops.get_user_arena_state(uid=uid)
    assert state["lifetimeXp"] == 3


async def test_advance_step_rejects_a_locked_step(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = (await ops.join_challenge(challenge_id=challenge_id, uid=uid))["submissionId"]

    with pytest.raises(ConflictError):
        await ops.advance_step(
            submission_id=submission_id, step_key="verification", target_status="completed",
            actor_uid=ADMIN_UID, actor_is_admin=True,
        )


async def test_advance_step_rejects_unknown_step_key(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = (await ops.join_challenge(challenge_id=challenge_id, uid=uid))["submissionId"]

    with pytest.raises(ValidationError):
        await ops.advance_step(
            submission_id=submission_id, step_key="not-a-real-step", target_status="completed",
            actor_uid=uid, actor_is_admin=False,
        )


async def test_completing_all_required_steps_triggers_completion_bonus_exactly_once(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = await _join_and_complete_join_step(ops, challenge_id, uid)
    await ops.advance_step(
        submission_id=submission_id, step_key="submission", target_status="completed",
        actor_uid=uid, actor_is_admin=False,
    )
    await ops.advance_step(
        submission_id=submission_id, step_key="verification", target_status="completed",
        actor_uid=ADMIN_UID, actor_is_admin=True,
    )
    result = await ops.advance_step(
        submission_id=submission_id, step_key="sale", target_status="completed",
        actor_uid=ADMIN_UID, actor_is_admin=True,
    )

    assert result["completionBonus"] == {"points": 5, "badge": {"id": "deal_maker", "name": "Deal Maker"}}

    sub = db.collection(model.ARENA_SUBMISSIONS).document(submission_id).get().to_dict()
    assert sub["overallStatus"] == "completed"

    challenge = db.collection(model.ARENA_CHALLENGES).document(challenge_id).get()
    assert challenge.get("completedCount") == 1

    state = await ops.get_user_arena_state(uid=uid)
    assert state["lifetimeXp"] == 3 + 11 + 5
    badge_ids = [b["id"] for b in state["badgesEarned"]]
    assert badge_ids.count("deal_maker") == 1

    # The public leaderboard mirror gets the same badge, id+name only --
    # this is what the public Arena summary component reads (never the
    # private arenaState doc, which also carries earnedAt/challengeId).
    public_entry = db.collection(model.ARENA_LEADERBOARD_ENTRIES).document(uid).get().to_dict()
    assert public_entry["badges"] == [{"id": "deal_maker", "name": "Deal Maker"}]
    assert public_entry["badgeCount"] == 1


# ---- points: recompute + manual adjustment ---------------------------------


async def test_manual_point_adjustment_requires_admin(db, ops):
    uid = _uid("user")
    with pytest.raises(ForbiddenError):
        await ops.manual_point_adjustment(
            uid=uid, points_delta=5, note="x", actor_uid=uid, actor_is_admin=False,
        )


async def test_manual_point_adjustment_reversal_updates_recomputed_total(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = await _join_and_complete_join_step(ops, challenge_id, uid)
    await ops.advance_step(
        submission_id=submission_id, step_key="submission", target_status="completed",
        actor_uid=uid, actor_is_admin=False,
    )
    await ops.advance_step(
        submission_id=submission_id, step_key="verification", target_status="completed",
        actor_uid=ADMIN_UID, actor_is_admin=True,
    )

    state = await ops.get_user_arena_state(uid=uid)
    assert state["lifetimeXp"] == 3

    await ops.manual_point_adjustment(
        uid=uid, points_delta=10, note="bonus", actor_uid=ADMIN_UID, actor_is_admin=True,
    )
    state = await ops.get_user_arena_state(uid=uid)
    assert state["lifetimeXp"] == 13

    # fraud found after the fact -- reverse the original step award. The
    # total must be RECOMPUTED from ledger facts, never decremented in
    # place, so this lands on exactly the right number.
    await ops.manual_point_adjustment(
        uid=uid, points_delta=-3, note="fraud found on review", actor_uid=ADMIN_UID,
        actor_is_admin=True, is_reversal=True,
    )
    state = await ops.get_user_arena_state(uid=uid)
    assert state["lifetimeXp"] == 10

    ledger = await ops.list_ledger_for_user(uid=uid)
    reversal_entries = [e for e in ledger if e["reason"] == "fraud_reversal"]
    assert len(reversal_entries) == 1
    assert reversal_entries[0]["pointsDelta"] == -3


# ---- rank / unlock-requirement pure logic (boundary tests) -----------------


def test_compute_rank_boundaries():
    ranks = [
        {"id": "starter", "name": "Starter", "minXp": 0, "maxXp": 10, "order": 1, "enabled": True},
        {"id": "rising", "name": "Rising Star", "minXp": 10, "maxXp": None, "order": 2, "enabled": True},
    ]
    assert model.compute_rank(0, ranks).current_rank_id == "starter"
    assert model.compute_rank(9, ranks).current_rank_id == "starter"

    at_boundary = model.compute_rank(10, ranks)
    assert at_boundary.current_rank_id == "rising"
    assert at_boundary.xp_to_next_rank is None  # top rank, no ceiling

    below_zero = model.compute_rank(-5, ranks)
    assert below_zero.current_rank_id == "starter"

    no_ranks_configured = model.compute_rank(500, [])
    assert no_ranks_configured.current_rank_id is None


def test_evaluate_unlock_requirements_reports_first_unmet_requirement():
    check = model.evaluate_unlock_requirements(
        {"minXp": 50, "verifiedAccountRequired": True},
        user_arena_state={"lifetimeXp": 10},
        user_facts={"isVerifiedAccount": False},
    )
    assert check.locked is True
    assert check.reason == "min_xp_not_met"

    unlocked = model.evaluate_unlock_requirements(
        {"minXp": 50}, user_arena_state={"lifetimeXp": 50}, user_facts={},
    )
    assert unlocked.locked is False
    assert unlocked.reason is None


async def test_recompute_state_sets_current_rank_order_for_unlock_gating(db, ops):
    """A regression test for a real bug: unlockRequirements.minRankOrder is
    evaluated against facts['currentRankOrder'], which must come from
    users/{uid}/private/arenaState.currentRankOrder -- if recompute_state
    never wrote that field, every minRankOrder-gated challenge would be
    unreachable regardless of a user's actual rank."""
    await ops.create_rank(
        data={"name": "Starter", "minXp": 0, "maxXp": None, "order": 1, "enabled": True},
        actor_uid=ADMIN_UID, actor_is_admin=True,
    )
    uid = _uid("user")
    state = await ops.recompute_state(uid)
    assert state.get("currentRankOrder") == 1


# ---- attach_property (property source + fraud check) -----------------------


async def test_attach_property_hard_rejects_duplicate_listing_ref(db, ops):
    challenge_id = await _create_challenge(ops)
    prop_ref = _seed_property(db, _uid("prop"))
    uid1, uid2 = _uid("user"), _uid("user")
    sub1 = await _join_and_complete_join_step(ops, challenge_id, uid1)
    sub2 = await _join_and_complete_join_step(ops, challenge_id, uid2)

    await ops.attach_property(
        submission_id=sub1, step_key="submission", listing_ref=prop_ref,
        display_fields={"city": "Erbil"}, property_source="my_property",
        owner_info=None, actor_uid=uid1,
    )

    with pytest.raises(ConflictError):
        await ops.attach_property(
            submission_id=sub2, step_key="submission", listing_ref=prop_ref,
            display_fields={"city": "Erbil"}, property_source="my_property",
            owner_info=None, actor_uid=uid2,
        )


# ---- buyer / deal CRM -------------------------------------------------------


async def _submission_with_property(ops, db, challenge_id: str, uid: str, *, city: str = "Erbil") -> str:
    submission_id = await _join_and_complete_join_step(ops, challenge_id, uid)
    prop_ref = _seed_property(db, _uid("prop"))
    await ops.attach_property(
        submission_id=submission_id, step_key="submission", listing_ref=prop_ref,
        display_fields={"city": city}, property_source="my_property",
        owner_info=None, actor_uid=uid,
    )
    return submission_id


async def test_advance_deal_stage_refuses_non_admin_past_contacted(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = await _submission_with_property(ops, db, challenge_id, uid)
    deal_id = (await ops.create_deal(submission_id=submission_id, actor_uid=uid))["dealId"]

    await ops.advance_deal_stage(deal_id=deal_id, target_stage="contacted", actor_uid=uid, actor_is_admin=False)

    with pytest.raises(ForbiddenError):
        await ops.advance_deal_stage(deal_id=deal_id, target_stage="qualified", actor_uid=uid, actor_is_admin=False)


async def test_create_deal_requires_a_property_already_attached(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = await _join_and_complete_join_step(ops, challenge_id, uid)

    with pytest.raises(ConflictError):
        await ops.create_deal(submission_id=submission_id, actor_uid=uid)


async def _close_deal(ops, deal_id: str, *, sale_value: float, city: str) -> dict:
    """Drives a deal through every admin-gated stage to 'closed'."""
    for stage in (
        "qualified", "matched", "viewing_scheduled", "viewing_completed",
        "negotiating", "deal_pending",
    ):
        await ops.advance_deal_stage(deal_id=deal_id, target_stage=stage, actor_uid=ADMIN_UID, actor_is_admin=True)
    return await ops.advance_deal_stage(
        deal_id=deal_id, target_stage="closed", actor_uid=ADMIN_UID, actor_is_admin=True,
        sale_value=sale_value, city=city,
    )


async def test_closing_deal_computes_expected_commission_from_configured_rule(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    city = _uid("city")
    submission_id = await _submission_with_property(ops, db, challenge_id, uid, city=city)
    deal_id = (await ops.create_deal(submission_id=submission_id, actor_uid=uid))["dealId"]
    await ops.set_commission_rule(
        city=city, min_percent=1, max_percent=3, default_percent=2,
        actor_uid=ADMIN_UID, actor_is_admin=True,
    )
    await ops.advance_deal_stage(deal_id=deal_id, target_stage="contacted", actor_uid=uid, actor_is_admin=False)

    result = await _close_deal(ops, deal_id, sale_value=100000, city=city)
    assert result["stage"] == "closed"

    deal = db.collection(model.ARENA_DEALS).document(deal_id).get().to_dict()
    assert deal["commissionPercent"] == 2
    assert deal["expectedCommission"] == 2000.0
    assert deal["paymentState"] == "pending"


async def test_set_payment_state_requires_a_closed_deal(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    submission_id = await _submission_with_property(ops, db, challenge_id, uid)
    deal_id = (await ops.create_deal(submission_id=submission_id, actor_uid=uid))["dealId"]

    with pytest.raises(ConflictError):
        await ops.set_payment_state(
            deal_id=deal_id, payment_state="received", actual_commission=100,
            actor_uid=ADMIN_UID, actor_is_admin=True,
        )


async def test_set_payment_state_requires_admin(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    city = _uid("city")
    submission_id = await _submission_with_property(ops, db, challenge_id, uid, city=city)
    deal_id = (await ops.create_deal(submission_id=submission_id, actor_uid=uid))["dealId"]
    await ops.advance_deal_stage(deal_id=deal_id, target_stage="contacted", actor_uid=uid, actor_is_admin=False)
    await _close_deal(ops, deal_id, sale_value=50000, city=city)

    with pytest.raises(ForbiddenError):
        await ops.set_payment_state(
            deal_id=deal_id, payment_state="received", actual_commission=1000,
            actor_uid=uid, actor_is_admin=False,
        )


async def test_challenge_commercial_summary_aggregates_real_numbers(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    city = _uid("city")
    submission_id = await _submission_with_property(ops, db, challenge_id, uid, city=city)
    deal_id = (await ops.create_deal(submission_id=submission_id, actor_uid=uid))["dealId"]
    await ops.set_commission_rule(
        city=city, min_percent=1, max_percent=3, default_percent=2,
        actor_uid=ADMIN_UID, actor_is_admin=True,
    )
    await ops.advance_deal_stage(deal_id=deal_id, target_stage="contacted", actor_uid=uid, actor_is_admin=False)
    await _close_deal(ops, deal_id, sale_value=50000, city=city)

    summary = await ops.challenge_commercial_summary(challenge_id=challenge_id)
    assert summary["participantCount"] == 1
    assert summary["verifiedProperties"] == 1
    assert summary["closedDeals"] == 1
    assert summary["closedVolume"] == 50000.0
    assert summary["expectedCommission"] == 1000.0
    assert summary["dealStageCounts"] == {"closed": 1}
    assert summary["topParticipants"][0]["uid"] == uid
    assert summary["topParticipants"][0]["closedDeals"] == 1


# ---- admin-only CRUD guardrails --------------------------------------------


async def test_create_challenge_requires_admin(ops):
    with pytest.raises(ForbiddenError):
        await ops.create_challenge(
            data={"name": "x", "steps": REAL_ESTATE_STEPS}, actor_uid="someone", actor_is_admin=False,
        )


async def test_delete_challenge_rejects_when_participants_exist(db, ops):
    challenge_id = await _create_challenge(ops)
    uid = _uid("user")
    await ops.join_challenge(challenge_id=challenge_id, uid=uid)

    with pytest.raises(ConflictError):
        await ops.delete_challenge(challenge_id=challenge_id, actor_uid=ADMIN_UID, actor_is_admin=True)


async def test_set_commission_rule_requires_admin(ops):
    with pytest.raises(ForbiddenError):
        await ops.set_commission_rule(
            city="Erbil", min_percent=1, max_percent=3, default_percent=2,
            actor_uid=_uid("user"), actor_is_admin=False,
        )
