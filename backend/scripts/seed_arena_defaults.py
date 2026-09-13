#!/usr/bin/env python3
"""Seeds Darwesh Arena's one-time defaults: the 8 example ranks, the global
arenaConfig singleton, and the first real Challenge -- Darwesh Arena's own
90-day real-estate acquisition flow (Join -> Submission -> Verification
[admin, +3] -> Find a Buyer -> Sale [admin, +11] -> completion bonus [+5,
"Deal Maker" badge]).

Idempotent and re-runnable: every write goes through app.arena.arena_ops
(the same audited path the real backend uses -- this script never writes a
raw document by hand for anything ArenaOps already validates), and each
step first checks whether its target already exists by name before
creating a duplicate.

WHY THE RANKS/CHALLENGE VALUES HERE ARE ONLY A STARTING POINT: every
number below (rank XP thresholds, step points, the $3,000 example prize
pool, the 90-day duration) is exactly what the brief calls "an initial
example, not hardcoded" -- an admin can edit every one of these fields
afterward through the Admin > Darwesh Arena tab (js/admin-arena.js). This
script's only job is to give a fresh environment a working Challenge to
look at and join, not to be the source of truth going forward.

SAFETY: same emulator-only-by-default gate as scripts/migrate_private_
profile.py. Production requires --allow-production and real
GOOGLE_APPLICATION_CREDENTIALS.

MODES
  seed        (default) create the 8 ranks, arenaConfig/global, and the
              "Kurdistan Property Challenge -- Season 01" Challenge, if
              each does not already exist by name.
  smoke-test  drives one fabricated participant through the seeded
              Challenge's self-reportable steps (join -> submission) and
              has an admin actor complete the two admin-gated steps
              (verification -> sale), printing the ledger/state/badge
              result at each stage. Requires `seed` to have run first
              (or runs it automatically with --auto-seed).

EXAMPLES
  firebase emulators:start --only firestore --project demo-darwesh &
  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 python3 backend/scripts/seed_arena_defaults.py --project demo-darwesh --mode seed
  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 python3 backend/scripts/seed_arena_defaults.py --project demo-darwesh --mode smoke-test
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

ADMIN_UID = "system-seed"

# Illustrative only -- see this file's header docstring. minXp/maxXp are the
# only fields that actually gate anything (model.compute_rank); everything
# else here is display copy an admin can rename freely.
RANK_LADDER = [
    {"name": "Starter", "minXp": 0, "maxXp": 25, "order": 1},
    {"name": "Scout", "minXp": 25, "maxXp": 75, "order": 2},
    {"name": "Property Hunter", "minXp": 75, "maxXp": 175, "order": 3},
    {"name": "Broker", "minXp": 175, "maxXp": 350, "order": 4},
    {"name": "Closer", "minXp": 350, "maxXp": 650, "order": 5},
    {"name": "Elite", "minXp": 650, "maxXp": 1200, "order": 6},
    {"name": "Master", "minXp": 1200, "maxXp": 2200, "order": 7},
    {"name": "Legend", "minXp": 2200, "maxXp": None, "order": 8},
]

# The Step Engine's first real use (brief: "the FIRST use of this engine,
# not the only possible Challenge"). Every points/target value is passed
# straight to ArenaOps.create_challenge, which is the same call the Admin
# Challenge Builder makes -- nothing here bypasses validation.
CHALLENGE_NAME = "Kurdistan Property Challenge — Season 01"
CHALLENGE_STEPS = [
    {
        "key": "join",
        "name": "Join the Challenge",
        "description": "Accept the Challenge rules and eligibility requirements.",
        "requiredAction": "Read and accept the rules to begin.",
        "requiredVerificationBy": "none",
        "requiredPropertyState": None,
        "points": 0,
        "optional": False,
        "unlockAfterStepKey": None,
        "hint": {"enabled": False, "text": ""},
        "reward": "",
    },
    {
        "key": "submission",
        "name": "Submit a Property",
        "description": "Bring a genuine property you own, or have explicit owner permission to market.",
        "requiredAction": "Reference an existing Darwesh listing -- never a duplicate record -- and confirm your right to market it.",
        "requiredVerificationBy": "none",
        "requiredPropertyState": "submitted",
        "points": 0,
        "optional": False,
        "unlockAfterStepKey": "join",
        "hint": {
            "enabled": True,
            "text": "Don't have a listing yet? Create one on Sell first, then come back and submit its ID here.",
        },
        "reward": "",
    },
    {
        "key": "verification",
        "name": "Verification",
        "description": "An admin reviews the property and its ownership evidence.",
        "requiredAction": "Wait for Darwesh Group to verify the property.",
        "requiredVerificationBy": "admin",
        "requiredPropertyState": "verified",
        "points": 3,
        "optional": False,
        "unlockAfterStepKey": "submission",
        "hint": {"enabled": False, "text": ""},
        "reward": "",
    },
    {
        "key": "buyer",
        "name": "Find a Buyer",
        "description": "Bring your own buyer, or request Darwesh Group buyer matching.",
        "requiredAction": "Mark this mission done once you're actively working a buyer lead.",
        "requiredVerificationBy": "none",
        "requiredPropertyState": None,
        "points": 0,
        "optional": False,
        "unlockAfterStepKey": "verification",
        "hint": {
            "enabled": True,
            "text": "Buyer qualification and closing are always admin-verified -- this step just tracks that you've started.",
        },
        "reward": "",
    },
    {
        "key": "sale",
        "name": "Successful Sale",
        "description": "An admin verifies the completed real-world transaction.",
        "requiredAction": "Wait for Darwesh Group to confirm the closed sale.",
        "requiredVerificationBy": "admin",
        "requiredPropertyState": "sold",
        "points": 11,
        "optional": False,
        "unlockAfterStepKey": "buyer",
        "hint": {"enabled": False, "text": ""},
        "reward": "",
    },
]


def build_client(project: str, allow_production: bool):
    emulator = os.environ.get("FIRESTORE_EMULATOR_HOST", "")
    if not emulator and not allow_production:
        print(
            "REFUSING to run: FIRESTORE_EMULATOR_HOST is not set and --allow-production was not given.\n"
            "This tool never touches a real project by accident.",
            file=sys.stderr,
        )
        sys.exit(2)
    from google.cloud import firestore

    if emulator:
        from google.auth.credentials import AnonymousCredentials

        return firestore.Client(project=project, credentials=AnonymousCredentials()), f"emulator {emulator}"
    return firestore.Client(project=project), f"PRODUCTION project {project}"


async def seed_ranks(ops, db) -> dict[str, str]:
    """Returns {rank name: doc id}, creating only the ranks that don't
    already exist by name."""
    existing = {d.to_dict().get("name"): d.id for d in db.collection("arenaRanks").stream()}
    ids: dict[str, str] = dict(existing)
    for rank in RANK_LADDER:
        if rank["name"] in existing:
            print(f"  rank '{rank['name']}' already exists, skipping")
            continue
        rank_id = await ops.create_rank(
            data={
                **rank,
                "iconUrl": "",
                "badgeUrl": "",
                "description": "",
                "privileges": [],
                "visualTreatment": {},
                "enabled": True,
            },
            actor_uid=ADMIN_UID,
            actor_is_admin=True,
        )
        ids[rank["name"]] = rank_id
        print(f"  created rank '{rank['name']}' ({rank_id})")
    return ids


def seed_config(db) -> None:
    ref = db.collection("arenaConfig").document("global")
    if ref.get().exists:
        print("  arenaConfig/global already exists, skipping")
        return
    ref.set({"seasonActive": False, "createdBy": ADMIN_UID})
    print("  created arenaConfig/global")


async def seed_challenge(ops, db) -> str | None:
    existing = list(db.collection("arenaChallenges").where("name", "==", CHALLENGE_NAME).limit(1).stream())
    if existing:
        print(f"  challenge '{CHALLENGE_NAME}' already exists ({existing[0].id}), skipping")
        return existing[0].id

    challenge_id = await ops.create_challenge(
        data={
            "name": CHALLENGE_NAME,
            "description": (
                "Darwesh Arena's first Challenge: a 90-day real-estate acquisition and sales "
                "engine. Bring genuine properties, verify them, find real buyers, and close real "
                "sales -- the leaderboard rewards closed deals far more than uploads."
            ),
            "artworkUrl": "",
            "category": "residential",
            "difficulty": "medium",
            "status": "live",
            "startDate": None,
            "endDate": None,
            "maxParticipants": None,
            "durationDays": 90,
            # Illustrative business targets (brief: never hardcoded assumptions --
            # an admin edits every one of these).
            "prizePool": 3000,
            "revenueTarget": 330000,
            "closedSalesTarget": 90,
            "closedVolumeTarget": 13500000,
            "mainPrize": "$3,000 prize pool",
            "bonusReward": "",
            "rewardsPreview": "Top performers by verified closed sales share the Season 01 prize pool.",
            "steps": CHALLENGE_STEPS,
            "completionReward": {
                "points": 5,
                "badge": {"id": "deal_maker", "name": "Deal Maker"},
                "certificate": False,
                "rankBonusXp": 0,
            },
            "unlockRequirements": {},
        },
        actor_uid=ADMIN_UID,
        actor_is_admin=True,
    )
    print(f"  created challenge '{CHALLENGE_NAME}' ({challenge_id})")
    return challenge_id


async def run_seed(ops, db) -> str | None:
    print("Ranks:")
    await seed_ranks(ops, db)
    print("Config:")
    seed_config(db)
    print("Challenge:")
    challenge_id = await seed_challenge(ops, db)
    print("\nSeed complete.")
    return challenge_id


# ---------------------------------------------------------------------
# Smoke test: drives a fabricated participant through the real
# ArenaOps API -- the same code path js/backend-api.js's handlers call --
# proving a user can actually join and progress through the seeded
# Challenge end to end.
# ---------------------------------------------------------------------


async def run_smoke_test(ops, db, *, auto_seed: bool) -> None:
    from app.access.errors import ForbiddenError

    existing = list(db.collection("arenaChallenges").where("name", "==", CHALLENGE_NAME).limit(1).stream())
    if existing:
        challenge_id = existing[0].id
    elif auto_seed:
        print("No seeded challenge found -- seeding first (--auto-seed).\n")
        challenge_id = await run_seed(ops, db)
        print()
    else:
        print(
            f"No challenge named '{CHALLENGE_NAME}' found. Run --mode seed first (or pass --auto-seed).",
            file=sys.stderr,
        )
        sys.exit(1)

    import uuid

    participant_uid = f"smoke-user-{uuid.uuid4().hex[:8]}"
    listing_id = f"smoke-listing-{uuid.uuid4().hex[:8]}"
    db.collection("listings").document(listing_id).set({"type": "apartment", "city": "Erbil"})

    print(f"=== Smoke test: participant {participant_uid!r} joining {CHALLENGE_NAME!r} ===\n")

    print("1. join_challenge ...")
    join_result = await ops.join_challenge(challenge_id=challenge_id, uid=participant_uid)
    submission_id = join_result["submissionId"]
    sub = db.collection("arenaSubmissions").document(submission_id).get().to_dict()
    assert sub["stepProgress"]["join"]["status"] == "available", "expected step 1 unlocked at join time"
    assert sub["stepProgress"]["submission"]["status"] == "locked", "expected step 2 still locked at join time"
    print(f"   OK -- submission {submission_id}, currentStepKey={sub['currentStepKey']!r}\n")

    print("2. advance_step('join' -> completed) as the participant ...")
    result = await ops.advance_step(
        submission_id=submission_id,
        step_key="join",
        target_status="completed",
        actor_uid=participant_uid,
        actor_is_admin=False,
    )
    assert result["status"] == "completed"
    print("   OK -- 'submission' step now unlocked\n")

    print("3. attach_property (Submit a Property) as the participant ...")
    await ops.attach_property(
        submission_id=submission_id,
        step_key="submission",
        listing_ref={"collection": "listings", "id": listing_id},
        display_fields={"propertyType": "apartment", "city": "Erbil", "priceDisplay": "$180,000", "areaSqm": 120},
        property_source="my_property",
        owner_info=None,
        actor_uid=participant_uid,
    )
    sub = db.collection("arenaSubmissions").document(submission_id).get().to_dict()
    assert sub["overallStatus"] == "verification_pending"
    print("   OK -- property attached, submission now 'verification_pending'\n")

    print("4. participant completes the 'submission' step itself (requiredVerificationBy='none') ...")
    result = await ops.advance_step(
        submission_id=submission_id,
        step_key="submission",
        target_status="completed",
        actor_uid=participant_uid,
        actor_is_admin=False,
    )
    assert result["status"] == "completed"
    print("   OK -- 'verification' step now unlocked\n")

    print("5. a non-admin CANNOT complete the admin-gated 'verification' step (must be refused) ...")
    try:
        await ops.advance_step(
            submission_id=submission_id,
            step_key="verification",
            target_status="completed",
            actor_uid=participant_uid,
            actor_is_admin=False,
        )
        raise AssertionError("expected ForbiddenError -- a participant self-completed an admin-gated step!")
    except ForbiddenError:
        print("   OK -- correctly refused\n")

    print("6. admin verifies the property (+3 XP) ...")
    result = await ops.advance_step(
        submission_id=submission_id,
        step_key="verification",
        target_status="completed",
        actor_uid=ADMIN_UID,
        actor_is_admin=True,
    )
    assert result["pointsAwarded"] == 3
    print(f"   OK -- awarded {result['pointsAwarded']} XP, 'buyer' step now unlocked\n")

    print("7. participant marks 'Find a Buyer' done ...")
    await ops.advance_step(
        submission_id=submission_id,
        step_key="buyer",
        target_status="completed",
        actor_uid=participant_uid,
        actor_is_admin=False,
    )
    print("   OK -- 'sale' step now unlocked\n")

    print("8. admin verifies the closed sale (+11 XP) + challenge completion bonus (+5 XP, badge) ...")
    result = await ops.advance_step(
        submission_id=submission_id,
        step_key="sale",
        target_status="completed",
        actor_uid=ADMIN_UID,
        actor_is_admin=True,
    )
    assert result["pointsAwarded"] == 11
    assert result["completionBonus"] == {"points": 5, "badge": {"id": "deal_maker", "name": "Deal Maker"}}
    print(f"   OK -- awarded {result['pointsAwarded']} XP, completion bonus {result['completionBonus']}\n")

    state = await ops.get_user_arena_state(uid=participant_uid)
    print("=== Final state ===")
    print(f"  lifetimeXp:  {state['lifetimeXp']}  (expected 3 + 11 + 5 = 19)")
    print(f"  currentRank: {state['currentRankName']}")
    print(f"  badgesEarned: {[b['name'] for b in state['badgesEarned']]}")
    assert state["lifetimeXp"] == 19, f"expected 19 XP, got {state['lifetimeXp']}"

    ledger = await ops.list_ledger_for_user(uid=participant_uid)
    print(f"  ledger entries: {len(ledger)}")
    for entry in sorted(ledger, key=lambda e: e.get("stepKey") or "zzz"):
        print(f"    {entry['reason']:<28} step={entry.get('stepKey')!r:<16} +{entry['pointsDelta']}")

    print("\nSMOKE TEST PASSED: a participant can join, self-report steps, be blocked from")
    print("self-completing admin-gated steps, and reach Mission Complete with the correct")
    print("points/badge/rank -- exactly the flow arena.html / arena-challenge.html drive.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="Firebase project id (demo-darwesh for the emulator)")
    parser.add_argument("--mode", choices=["seed", "smoke-test"], default="seed")
    parser.add_argument(
        "--allow-production", action="store_true", help="required to run without FIRESTORE_EMULATOR_HOST"
    )
    parser.add_argument(
        "--auto-seed",
        action="store_true",
        help="smoke-test: seed automatically if the challenge doesn't exist yet",
    )
    args = parser.parse_args()

    db, target = build_client(args.project, args.allow_production)
    print(f"Connected to {target}\n")

    from app.arena.arena_ops import ArenaOps

    ops = ArenaOps(db)

    if args.mode == "seed":
        asyncio.run(run_seed(ops, db))
    else:
        asyncio.run(run_smoke_test(ops, db, auto_seed=args.auto_seed))


if __name__ == "__main__":
    main()
