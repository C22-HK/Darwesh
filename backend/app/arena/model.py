# Darwesh Arena domain model -- the authoritative vocabulary and pure
# logic. js/arena-model.js mirrors this for display only; where the two
# could disagree, THIS one decides (every write goes through arena_ops.py,
# which imports only this module for its rules, never the JS mirror).
#
# THE STEP ENGINE (see arena_ops.py's module docstring for the full
# rationale): a Challenge is authored as an ordered `steps` array on its
# own document -- nothing about a specific real-estate flow is hardcoded
# here. This module only knows how to validate and progress THROUGH
# whatever steps a challenge declares.
from __future__ import annotations

from dataclasses import dataclass

# ---------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------

ARENA_CHALLENGES = "arenaChallenges"
ARENA_SUBMISSIONS = "arenaSubmissions"
ARENA_SUBMISSION_PRIVATE = "private"  # subcollection of a submission, doc id 'ownerInfo'
ARENA_LEDGER = "arenaLedger"
ARENA_RANKS = "arenaRanks"
ARENA_LEADERBOARD_ENTRIES = "arenaLeaderboardEntries"
ARENA_ACTIVITY_FEED = "arenaActivityFeed"
ARENA_CONFIG = "arenaConfig"
USER_ARENA_STATE = "arenaState"  # doc under users/{uid}/private

# Darwesh Arena is a real-estate ACQUISITION AND SALES ENGINE, not a
# points game -- the business value is closed transactions and
# buyer-side commission, and every state below that touches money or a
# real buyer's personal data is admin-verified and kept out of any
# public read (see firestore.rules' arenaDeals block: `private`
# subcollection for buyer PII, the parent doc itself already
# participant+admin-only).
ARENA_DEALS = "arenaDeals"
ARENA_DEAL_PRIVATE = "private"  # subcollection of a deal, doc id 'buyerInfo'
ARENA_COMMISSION_RULES = "arenaCommissionRules"  # doc id = city name

# ---------------------------------------------------------------------
# Step Engine vocabulary
# ---------------------------------------------------------------------

STEP_STATUSES = frozenset({"locked", "available", "in_progress", "verification_pending", "completed", "skipped"})

# A step may only ever move forward along this graph. There is no
# transition back to 'locked' once unlocked (a step that was reachable
# stays reachable, even if a later admin action needs to revisit it --
# see arena_ops.reopen_step for the one exception, which is an explicit
# admin action, not a state-machine transition).
STEP_TRANSITIONS: dict[str, frozenset[str]] = {
    "locked": frozenset(),  # never entered directly by a transition -- only by initialization
    "available": frozenset({"in_progress", "verification_pending", "completed", "skipped"}),
    "in_progress": frozenset({"verification_pending", "completed"}),
    "verification_pending": frozenset({"completed", "available"}),  # 'available' = admin rejected, try again
    "completed": frozenset(),  # terminal
    "skipped": frozenset(),  # terminal (only reachable for an `optional` step)
}

REQUIRED_VERIFICATION_BY = frozenset({"none", "admin"})

OVERALL_STATUSES = frozenset({"joined", "in_progress", "verification_pending", "completed", "won", "rejected"})

POINT_TYPES = frozenset({"lifetimeXp"})  # seasonPoints ledger entries arrive in a later phase

POINT_REASONS = frozenset({"step_completed", "challenge_completion_bonus", "manual_adjustment", "fraud_reversal"})

CHALLENGE_STATUSES = frozenset({"draft", "scheduled", "live", "paused", "ended", "archived"})
EFFECTIVE_CHALLENGE_STATES = frozenset(
    {"draft", "scheduled", "live", "paused", "ending_soon", "ended", "archived"}
)

DIFFICULTIES = frozenset({"easy", "medium", "hard", "elite", "legendary"})
CATEGORIES = frozenset({"residential", "commercial", "land", "projects", "city", "special", "partner"})
VISIBILITIES = frozenset({"public", "private", "invite_only"})

PROPERTY_SOURCES = frozenset({"my_property", "owner_permission", "agency_partner"})
BUYER_STATUSES = frozenset({"searching", "buyer_found", "negotiation", "deal_pending", "sold"})
BUYER_SOURCES = frozenset({"self", "darwesh", "connected"})

# ---------------------------------------------------------------------
# Buyer / deal CRM (the actual business engine -- a Challenge step like
# "Find a Buyer"/"Viewing"/"Sale Verification" is data-driven per the
# Step Engine above; THIS is the real sub-record those steps track
# progress against, kept separate from arenaSubmissions because buyer
# data is a different privacy domain from owner/property data and has
# its own longer lifecycle (a deal can span many step-engine states).
# ---------------------------------------------------------------------

DEAL_STAGES = frozenset(
    {
        "lead",
        "contacted",
        "qualified",
        "matched",
        "viewing_scheduled",
        "viewing_completed",
        "negotiating",
        "deal_pending",
        "closed",
        "lost",
    }
)

# A deal may only move forward, except into 'lost' which is reachable
# from anywhere (a real deal can fall through at any point) and is
# terminal. 'closed' is terminal and is the one stage that can trigger a
# Challenge step's sale-verification points once an admin confirms it.
DEAL_TRANSITIONS: dict[str, frozenset[str]] = {
    "lead": frozenset({"contacted", "lost"}),
    "contacted": frozenset({"qualified", "lost"}),
    "qualified": frozenset({"matched", "lost"}),
    "matched": frozenset({"viewing_scheduled", "lost"}),
    "viewing_scheduled": frozenset({"viewing_completed", "lost"}),
    "viewing_completed": frozenset({"negotiating", "lost"}),
    "negotiating": frozenset({"deal_pending", "lost"}),
    "deal_pending": frozenset({"closed", "lost"}),
    "closed": frozenset(),
    "lost": frozenset(),
}

# Stages a participant may self-report (early-funnel CRM housekeeping --
# never financially meaningful on their own). Every stage from
# 'qualified' onward requires admin confirmation, matching the brief's
# "buyer qualification must be server/admin controlled" and "closed-sale
# achievements must carry substantially more value than upload farming."
SELF_REPORTABLE_DEAL_STAGES = frozenset({"lead", "contacted"})

PAYMENT_STATES = frozenset({"pending", "invoiced", "received", "waived", "disputed"})

ACTIVITY_TYPES = frozenset(
    {
        "property_submitted",
        "property_verified",
        "buyer_found",
        "deal_completed",
        "rank_increased",
        "badge_unlocked",
        "challenge_completed",
    }
)

# A step whose points a client-authored request could plausibly try to
# inflate. Kept as a constant purely for readability at call sites in
# arena_ops.py -- the real defense is that the client never supplies a
# points value at all; every award reads `step['points']` from the
# challenge document the backend itself fetched.
_UNUSED = None


def is_valid_deal_transition(current: str, target: str) -> bool:
    if current not in DEAL_STAGES or target not in DEAL_STAGES:
        return False
    return target in DEAL_TRANSITIONS.get(current, frozenset())


def compute_expected_commission(sale_value: object, commission_percent: object) -> float | None:
    """Pure arithmetic, no I/O -- `commission_percent` is a plain number
    (e.g. 3 for 3%), never a client-supplied dollar amount. Returns None
    for non-numeric input rather than raising, so a caller can decide
    whether that's an error (the ops layer validates before calling)."""
    if not isinstance(sale_value, (int, float)) or not isinstance(commission_percent, (int, float)):
        return None
    if sale_value < 0 or commission_percent < 0:
        return None
    return round(float(sale_value) * (float(commission_percent) / 100.0), 2)


def is_valid_step_transition(current: str, target: str) -> bool:
    if current not in STEP_STATUSES or target not in STEP_STATUSES:
        return False
    return target in STEP_TRANSITIONS.get(current, frozenset())


def find_step(steps: list[dict], step_key: str) -> dict | None:
    for step in steps or []:
        if isinstance(step, dict) and step.get("key") == step_key:
            return step
    return None


def can_unlock_step(step: dict, step_progress: dict) -> bool:
    """True if `step` (identified by its own `unlockAfterStepKey`) is
    allowed to move out of 'locked'. The first step in a challenge has
    `unlockAfterStepKey=None` and is always unlockable (initialized
    'available' at join time -- see arena_ops.join_challenge)."""
    prereq_key = step.get("unlockAfterStepKey")
    if not prereq_key:
        return True
    prereq_progress = (step_progress or {}).get(prereq_key) or {}
    return prereq_progress.get("status") in ("completed", "skipped")


def next_step_after(steps: list[dict], step_key: str) -> dict | None:
    """The step (if any) whose `unlockAfterStepKey` equals `step_key` --
    what should move to 'available' once this step completes. Supports at
    most one direct successor per step, matching a linear step list; a
    future branching design would need a different shape, not a change
    to this function's contract."""
    for step in steps or []:
        if isinstance(step, dict) and step.get("unlockAfterStepKey") == step_key:
            return step
    return None


def all_required_steps_complete(steps: list[dict], step_progress: dict) -> bool:
    for step in steps or []:
        if not isinstance(step, dict):
            continue
        if step.get("optional"):
            continue
        status = (step_progress or {}).get(step.get("key"), {}).get("status")
        if status not in ("completed", "skipped"):
            return False
    return True


def initial_step_progress(steps: list[dict]) -> dict:
    """Called once, at join time. Step 1 (the one entry with no
    `unlockAfterStepKey`) starts 'available'; everything else starts
    'locked'. Supports at most one "first step" -- a challenge authored
    with two steps that both lack `unlockAfterStepKey` is a config error
    the admin builder should prevent, not something this function guesses
    around."""
    progress: dict = {}
    for step in steps or []:
        if not isinstance(step, dict) or not step.get("key"):
            continue
        status = "available" if not step.get("unlockAfterStepKey") else "locked"
        progress[step["key"]] = {
            "status": status,
            "completedAt": None,
            "pointsAwarded": False,
            "ledgerEntryId": None,
        }
    return progress


# ---------------------------------------------------------------------
# Rank ladder
# ---------------------------------------------------------------------


@dataclass(frozen=True)
class RankProgress:
    current_rank_id: str | None
    current_rank_name: str | None
    next_rank_id: str | None
    next_rank_name: str | None
    xp_to_next_rank: int | None  # None when already at the top rank

    def to_dict(self) -> dict:
        return {
            "currentRankId": self.current_rank_id,
            "currentRankName": self.current_rank_name,
            "nextRankId": self.next_rank_id,
            "nextRankName": self.next_rank_name,
            "xpToNextRank": self.xp_to_next_rank,
        }


def compute_rank(lifetime_xp: int, ranks: list[dict]) -> RankProgress:
    """`ranks` is every arenaRanks doc (enabled or not) as
    `{id, name, minXp, maxXp, order, enabled}`; only `enabled` ranks are
    considered, ordered by `order`. A caller below the lowest rank's
    `minXp` (e.g. minXp isn't 0, or no ranks are configured yet) has no
    current rank -- never guessed to the lowest one, since that would
    silently promote someone into a rank an admin has not actually
    configured to start at 0."""
    active = sorted(
        (r for r in (ranks or []) if isinstance(r, dict) and r.get("enabled", True)),
        key=lambda r: r.get("order") if isinstance(r.get("order"), (int, float)) else 0,
    )
    xp = max(0, int(lifetime_xp or 0))

    current: dict | None = None
    nxt: dict | None = None
    for i, rank in enumerate(active):
        min_xp = int(rank.get("minXp") or 0)
        max_xp = rank.get("maxXp")
        max_xp = int(max_xp) if isinstance(max_xp, (int, float)) else None
        in_range = xp >= min_xp and (max_xp is None or xp < max_xp)
        if in_range:
            current = rank
            nxt = active[i + 1] if i + 1 < len(active) else None
            break

    if current is None:
        return RankProgress(
            None, None, active[0].get("id") if active else None, active[0].get("name") if active else None, None
        )

    xp_to_next = None
    if nxt is not None:
        next_min = int(nxt.get("minXp") or 0)
        xp_to_next = max(0, next_min - xp)

    return RankProgress(
        current_rank_id=current.get("id"),
        current_rank_name=current.get("name"),
        next_rank_id=nxt.get("id") if nxt else None,
        next_rank_name=nxt.get("name") if nxt else None,
        xp_to_next_rank=xp_to_next,
    )


# ---------------------------------------------------------------------
# Unlock requirements (challenge eligibility gate)
# ---------------------------------------------------------------------


@dataclass(frozen=True)
class UnlockCheck:
    locked: bool
    reason: str | None  # a short, stable machine code the UI translates, e.g. 'min_xp_not_met'

    def to_dict(self) -> dict:
        return {"locked": self.locked, "reason": self.reason}


def evaluate_unlock_requirements(
    requirements: dict | None,
    *,
    user_arena_state: dict | None,
    user_facts: dict | None,
) -> UnlockCheck:
    """`user_arena_state` is the caller's own recomputed arenaState
    (lifetimeXp, currentRankId). `user_facts` is a small bag of
    additional real facts the caller already looked up server-side
    (accountType, city, verified-account flag, previous-sales count,
    completed-challenge-id set) -- NEVER trusted from the client, always
    read by arena_ops itself before calling this function. Every check is
    a straightforward AND; the first failing requirement is reported
    (there is no product need yet to enumerate every unmet requirement at
    once)."""
    req = requirements or {}
    state = user_arena_state or {}
    facts = user_facts or {}

    min_xp = req.get("minXp")
    if isinstance(min_xp, (int, float)) and min_xp > 0:
        if int(state.get("lifetimeXp") or 0) < min_xp:
            return UnlockCheck(True, "min_xp_not_met")

    min_rank_order = req.get("minRankOrder")
    if isinstance(min_rank_order, (int, float)):
        if int(facts.get("currentRankOrder") or 0) < min_rank_order:
            return UnlockCheck(True, "min_rank_not_met")

    prereqs = req.get("prerequisiteChallengeIds") or []
    if prereqs:
        completed = set(facts.get("completedChallengeIds") or [])
        if not set(prereqs).issubset(completed):
            return UnlockCheck(True, "prerequisite_challenge_incomplete")

    if req.get("verifiedAccountRequired") and not facts.get("isVerifiedAccount"):
        return UnlockCheck(True, "verified_account_required")

    cities = req.get("cities") or []
    if cities and facts.get("city") not in cities:
        return UnlockCheck(True, "city_not_eligible")

    account_types = req.get("accountTypes") or []
    if account_types and facts.get("accountType") not in account_types:
        return UnlockCheck(True, "account_type_not_eligible")

    min_previous_sales = req.get("minPreviousSales")
    if isinstance(min_previous_sales, (int, float)) and min_previous_sales > 0:
        if int(facts.get("soldPropertiesCount") or 0) < min_previous_sales:
            return UnlockCheck(True, "min_previous_sales_not_met")

    return UnlockCheck(False, None)


# ---------------------------------------------------------------------
# Challenge effective state (mirrors js/offers.js's effectiveState --
# stored INTENT + start/end dates, derived at read time, no scheduler)
# ---------------------------------------------------------------------


def effective_challenge_state(challenge: dict, *, now_ms: int) -> str:
    stored = challenge.get("status")
    stored = stored if stored in CHALLENGE_STATUSES else "draft"
    if stored != "live":
        return stored
    start_ms = _to_millis(challenge.get("startDate"))
    end_ms = _to_millis(challenge.get("endDate"))
    if start_ms is not None and now_ms < start_ms:
        return "scheduled"
    if end_ms is not None and now_ms >= end_ms:
        return "ended"
    if end_ms is not None and (end_ms - now_ms) <= (72 * 60 * 60 * 1000):
        return "ending_soon"
    return "live"


def _to_millis(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    to_millis = getattr(value, "timestamp", None)
    if callable(to_millis):
        try:
            return int(to_millis() * 1000)
        except Exception:  # noqa: BLE001
            return None
    return None
